import WebSocket from 'ws';
import type { ClipPlayerState, LinkEvent, QueueItem, ReplayLink } from './playlist-runner.js';
import type { StromClient } from './strom.js';

/**
 * A clip player of a Strom flow, over Strom's replay API: commands and state by REST, events by the group's WebSocket.
 *
 * The queue commands are Strom's (ADR-0002), as its author confirmed on 2026-11-27 for `feat/open-replay-integration`
 * at 15390f51: `cue {source, in, out, end_action, client_ref}`, `cue_next` with the same fields plus `speed`, events
 * `{type: "event", event: "item_started" | "ended" | "source_failed" | ..., client_ref, event_seq}`, and a state
 * with `queue.clip_ref` and `queue.waiting`. This file is the only place that knows those names.
 */
export class StromReplayLink implements ReplayLink {
  private readonly base: string;

  constructor(
    private readonly strom: StromClient,
    flowId: string,
    private readonly group: string,
    private readonly reconnectMs = 1000,
  ) {
    this.base = `/api/replay/${flowId}/${encodeURIComponent(group)}`;
  }

  private async command(cmd: Record<string, unknown>): Promise<void> {
    const r = await this.strom.request(`${this.base}/command`, { method: 'POST', json: cmd });
    if (!r.ok) {
      const detail = typeof r.body['message'] === 'string' ? r.body['message'] : typeof r.body['error'] === 'string' ? r.body['error'] : `status ${r.status}`;
      const hint = (cmd['cmd'] === 'cue' || cmd['cmd'] === 'cue_next') && 'source' in cmd && r.status === 400 ? ' (this Strom may not take a source in a cue yet)' : '';
      throw new Error(`Strom refused ${String(cmd['cmd'])} on ${this.group}: ${detail}${hint}`);
    }
  }

  cue(item: QueueItem): Promise<void> {
    return this.command({ cmd: 'cue', source: item.source, in: { t: item.in }, out: { t: item.out }, end_action: item.end_action, client_ref: item.client_ref });
  }

  play(speed: number): Promise<void> {
    return this.command({ cmd: 'play', speed });
  }

  queue(item: QueueItem): Promise<void> {
    return this.command({ cmd: 'cue_next', source: item.source, in: { t: item.in }, out: { t: item.out }, speed: item.speed, end_action: item.end_action, client_ref: item.client_ref });
  }

  /**
   * Stop where it is. `uncue` drops the cue but keeps the queue, and keeps the cursor and the speed too (Strom's
   * REPLAY_API.md at 15390f51), so the queue goes first and the player is paused last: otherwise it plays on past the clip.
   */
  async stop(): Promise<void> {
    await this.command({ cmd: 'clear_queue' });
    await this.command({ cmd: 'uncue' });
    await this.command({ cmd: 'pause' });
  }

  async state(): Promise<ClipPlayerState> {
    const r = await this.strom.request(`${this.base}/state`);
    if (!r.ok) throw new Error(`Strom answered ${r.status}`);
    return readClipState(r.body);
  }

  subscribe(onEvent: (e: LinkEvent) => void, onResync: () => void): () => void {
    const wsUrl = `${this.strom.url.replace(/^http/, 'ws')}${this.base}/ws`;
    let ws: WebSocket | undefined;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      ws = new WebSocket(wsUrl, { headers: this.strom.authHeaders });
      ws.on('message', (raw) => {
        const e = readEvent(raw.toString());
        if (e === 'lagged') onResync();
        else if (e) onEvent(e);
      });
      ws.on('error', () => undefined); // 'close' follows
      ws.on('close', () => {
        if (closed) return;
        retry = setTimeout(() => {
          open();
          onResync(); // events may have been missed while it was down
        }, this.reconnectMs);
      });
    };
    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined);

/** `queue.clip_ref` is the clip the group holds as its cue (else null), `queue.waiting` how many are queued behind it. `motion` is null until there is media. */
export function readClipState(body: Record<string, unknown>): ClipPlayerState {
  const q = obj(body['queue']);
  return {
    currentRef: str(q?.['clip_ref']),
    queued: num(q?.['waiting']),
    speed: num(obj(body['motion'])?.['speed']),
  };
}

/** Whether this Strom can switch a player's source in a cue (`source_switch`) and queue the next clip (`cue_next`): the replay API's `features`. */
export async function readQueueFeatures(strom: StromClient): Promise<{ sourceSwitch: boolean; cueNext: boolean }> {
  const r = await strom.request('/api/replay');
  const features = Array.isArray(r.body['features']) ? (r.body['features'] as unknown[]) : [];
  return { sourceSwitch: features.includes('source_switch'), cueNext: features.includes('cue_next') };
}

/** One WebSocket message as an event the runner understands, `'lagged'` when events were dropped, or null when it is not an event. */
export function readEvent(text: string): LinkEvent | 'lagged' | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (str(m['type']) === 'lagged') return 'lagged';
  if (str(m['type']) !== 'event') return null;
  const event = str(m['event']);
  if (event === 'item_started' || event === 'ended' || event === 'source_failed') return { type: event, clientRef: str(m['client_ref']), seq: num(m['event_seq']) };
  return null;
}
