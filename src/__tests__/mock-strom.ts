import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * A stand-in for Strom's replay API with the clip queue of ADR-0002: `cue {source}`, `cue_next`, `clear_queue`,
 * `uncue`, the events `{type: "event", event: "item_started" | "ended" | "source_failed", client_ref}` and a state
 * with `queue.clip_ref` and `queue.waiting`, as the Strom author described them on 2026-11-27 (branch
 * `feat/open-replay-integration` at 15390f51). It is written from that description, not from Strom's code.
 * Where it is silent (whether `cue` clears the queue, whether the cue is still held after the last item freezes) this
 * mock chooses, and `replay-link.ts` is the one place to change when the real thing differs.
 *
 * Clip time runs at `timeScale` times real time, so a test can play minutes of clips in milliseconds.
 */

interface Item {
  source: string;
  in: string;
  out: string;
  speed: number;
  end_action: string;
  client_ref: string;
}

interface Group {
  flowId: string;
  name: string;
  current: Item | null;
  playing: boolean;
  queue: Item[];
  timer?: ReturnType<typeof setTimeout>;
  seq: number;
  sockets: Set<WebSocket>;
}

export interface MockOptions {
  /** Real milliseconds per clip millisecond. 0.02 plays a 10 s clip in 200 ms. */
  timeScale?: number;
  /** Do not send `item_started` / `ended` over the WebSocket, as if they were lost. The state still tells the truth. */
  dropEvents?: boolean;
  /** The replay API's `features`. */
  features?: string[];
  /** After the last item freezes the cue is still held (the default), or released. */
  holdAtEnd?: boolean;
  /** A source Strom cannot switch to: starting an item with it sends `source_failed` and stops the chain. */
  failSource?: string;
}

const MS = 1_000_000n;

export class MockStrom {
  readonly commands: Record<string, unknown>[] = [];
  /** `item_started` and `ended` as they happened, in order, whether or not they were sent. */
  readonly happened: string[] = [];
  /** The mixer calls it saw, as `<mixer> preview <input>` and `<mixer> cut <input>`, and what each mixer shows. */
  readonly mixerCalls: string[] = [];
  private readonly program = new Map<string, number>();
  dropEvents: boolean;
  private readonly timeScale: number;
  private readonly features: string[];
  private readonly holdAtEnd: boolean;
  private readonly failSource: string | undefined;
  private readonly groups = new Map<string, Group>();
  private server?: Server;
  private wss?: WebSocketServer;

  constructor(opts: MockOptions = {}) {
    this.timeScale = opts.timeScale ?? 0.02;
    this.dropEvents = opts.dropEvents ?? false;
    this.features = opts.features ?? ['source_switch', 'cue_next'];
    this.holdAtEnd = opts.holdAtEnd ?? true;
    this.failSource = opts.failSource;
  }

  addGroup(flowId: string, name: string): void {
    this.groups.set(`${flowId}/${name}`, { flowId, name, current: null, playing: false, queue: [], seq: 0, sockets: new Set() });
  }

  async listen(port = 0): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const g = this.find(new URL(req.url ?? '/', 'http://x').pathname);
      if (!g) return socket.destroy();
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        g.sockets.add(ws);
        ws.on('close', () => g.sockets.delete(ws));
        ws.send(JSON.stringify({ type: 'state', ...this.state(g) }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const g of this.groups.values()) {
      if (g.timer) clearTimeout(g.timer);
      for (const s of g.sockets) s.terminate();
    }
    this.wss?.close();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  /** What the group is doing now. */
  playingRef(group: string): string | null {
    for (const g of this.groups.values()) if (g.name === group) return g.current?.client_ref ?? null;
    return null;
  }

  /** Items waiting in a group's queue. */
  waiting(group: string): number {
    for (const g of this.groups.values()) if (g.name === group) return g.queue.length;
    return 0;
  }

  // ---- HTTP ----

  private find(path: string): Group | undefined {
    const m = /^\/api\/replay\/([^/]+)\/([^/]+)/.exec(path);
    return m ? this.groups.get(`${m[1]}/${decodeURIComponent(m[2]!)}`) : undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (path === '/api/replay') return send(200, { api_version: 2, features: this.features, groups: [...this.groups.values()].map((g) => ({ flow_id: g.flowId, group: g.name })) });
    if (path === '/api/flows') {
      const flows = new Map<string, { id: string; gst_state: string; blocks: unknown[] }>();
      for (const g of this.groups.values()) {
        const f = flows.get(g.flowId) ?? { id: g.flowId, gst_state: 'Playing', blocks: [] };
        const clip = /-([ab])$/.exec(g.name);
        f.blocks.push({ id: clip ? `clip${clip[1]!.toUpperCase()}` : 'cam1', block_definition_id: 'builtin.media_player', properties: { group: g.name, mode: 'timeline' } });
        flows.set(g.flowId, f);
      }
      return send(200, { flows: [...flows.values()] });
    }
    const mixer = /^\/api\/flows\/[^/]+\/blocks\/(vm|pvw)\/(state|preview|transition)$/.exec(path);
    if (mixer) {
      const [, name, what] = mixer as unknown as [string, string, string];
      let body: Record<string, any> = {};
      if (req.method !== 'GET') {
        let text = '';
        for await (const chunk of req) text += chunk;
        body = text ? (JSON.parse(text) as Record<string, any>) : {};
      }
      if (what === 'preview') this.mixerCalls.push(`${name} preview ${body['source']?.input}`);
      if (what === 'transition') {
        this.mixerCalls.push(`${name} cut ${body['to_input']}`);
        this.program.set(name, body['to_input']);
      }
      return send(200, { program_input: this.program.get(name) ?? 0, preview_input: 1 });
    }
    const g = this.find(path);
    if (!g) return send(404, { error: 'no such group' });
    if (req.method === 'GET' && path.endsWith('/state')) return send(200, this.state(g));
    if (req.method === 'POST' && path.endsWith('/command')) {
      let text = '';
      for await (const chunk of req) text += chunk;
      const cmd = JSON.parse(text) as Record<string, unknown>;
      this.commands.push(cmd);
      const refused = this.apply(g, cmd);
      return refused ? send(refused.status, { error: refused.error, message: refused.message }) : send(200, this.state(g));
    }
    return send(200, { group: g.name, flow_id: g.flowId });
  }

  private state(g: Group) {
    return {
      ready: 'ready',
      time_domain: 'tai',
      // `motion` is null until there is media; the cue is {in, out, end_action}.
      motion: g.current ? { speed: g.playing ? g.current.speed : 0, live: false, cue: { in: g.current.in, out: g.current.out, end_action: g.current.end_action }, ramp: null } : null,
      queue: { clip_ref: g.current?.client_ref ?? null, waiting: g.queue.length },
    };
  }

  // ---- commands ----

  private item(cmd: Record<string, unknown>, speed: number): Item | { status: number; error: string; message: string } {
    const t = (v: unknown) => ((v as { t?: unknown } | undefined)?.t);
    const inT = t(cmd['in']);
    const outT = t(cmd['out']);
    if (typeof cmd['source'] !== 'string' || typeof inT !== 'string' || typeof outT !== 'string') return { status: 400, error: 'invalid', message: 'source, in.t and out.t are required' };
    if (BigInt(outT) <= BigInt(inT)) return { status: 400, error: 'invalid', message: 'out is not after in' };
    return { source: cmd['source'], in: inT, out: outT, speed, end_action: String(cmd['end_action'] ?? 'freeze'), client_ref: String(cmd['client_ref'] ?? '') };
  }

  private apply(g: Group, cmd: Record<string, unknown>): { status: number; error: string; message: string } | null {
    switch (cmd['cmd']) {
      case 'cue': {
        const it = this.item(cmd, 1);
        if ('status' in it) return it;
        this.halt(g);
        g.current = it;
        g.queue = []; // a new cue replaces the old and the queue behind it (a choice of this mock)
        return null;
      }
      case 'play': {
        if (!g.current) return { status: 409, error: 'conflict', message: 'nothing is cued' };
        g.current.speed = typeof cmd['speed'] === 'number' ? cmd['speed'] : 1;
        this.start(g);
        return null;
      }
      case 'cue_next': {
        if (!g.current) return { status: 409, error: 'conflict', message: 'nothing to queue behind' };
        const it = this.item(cmd, typeof cmd['speed'] === 'number' ? cmd['speed'] : 1);
        if ('status' in it) return it;
        g.queue.push(it);
        return null;
      }
      case 'clear_queue':
        g.queue = [];
        return null;
      case 'pause':
        this.halt(g);
        return null;
      case 'uncue': // drops the cue and keeps the queue, as Strom does today
        this.halt(g);
        g.current = null;
        return null;
      default:
        return { status: 400, error: 'invalid', message: `unknown cmd ${String(cmd['cmd'])}` };
    }
  }

  private halt(g: Group): void {
    if (g.timer) clearTimeout(g.timer);
    g.timer = undefined;
    g.playing = false;
  }

  /** Play the current item and, when it ends, the next one with no gap. */
  private start(g: Group): void {
    const it = g.current!;
    if (this.failSource && it.source === this.failSource) {
      g.playing = false;
      this.emit(g, 'source_failed', it.client_ref);
      return;
    }
    g.playing = true;
    this.emit(g, 'item_started', it.client_ref);
    const clipMs = Number((BigInt(it.out) - BigInt(it.in)) / MS);
    g.timer = setTimeout(() => {
      this.emit(g, 'ended', it.client_ref);
      const next = g.queue.shift();
      if (next) {
        g.current = next;
        this.start(g);
      } else {
        g.playing = false; // freeze on the last frame: nothing plays, nothing is queued
        if (!this.holdAtEnd) g.current = null;
      }
    }, Math.max(1, (clipMs / it.speed) * this.timeScale));
  }

  private emit(g: Group, event: 'item_started' | 'ended' | 'source_failed', ref: string): void {
    this.happened.push(`${event}:${ref}`);
    if (this.dropEvents) return;
    const msg = JSON.stringify({ type: 'event', event_seq: ++g.seq, event, cause: event === 'ended' ? 'cue_end' : 'cue_end', client_ref: ref, ...(event === 'item_started' ? { waiting: g.queue.length } : {}) });
    for (const s of g.sockets) if (s.readyState === 1) s.send(msg);
  }
}
