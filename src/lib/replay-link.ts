import WebSocket from 'ws';
import type { ClipPlayerState, LinkEvent, QueueItem, ReplayLink } from './playlist-runner.js';
import type { StromClient } from './strom.js';

/**
 * A clip player of a Strom flow, over Strom's replay API: commands and state by REST, events by the group's WebSocket.
 *
 * The queue commands are the Strom author's description of work that is NOT yet in pushed code (ADR-0002):
 * `cue {source, in, out, end_action, client_ref}`, `cue_next` with the same fields plus `speed`, and
 * `item_started` / `ended` events with the item's `client_ref`. This file is the only place that knows those
 * names, and it reads the state tolerantly because the field names are a guess until Strom publishes them.
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

  stop(): Promise<void> {
    return this.command({ cmd: 'uncue' });
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

/** The state's own words for the current item and the queue. Names are a guess: `queue.current_ref` and `queue.length`, or the same at the top. */
export function readClipState(body: Record<string, unknown>): ClipPlayerState {
  const q = obj(body['queue']);
  const cue = obj(obj(body['motion'])?.['cue']);
  return {
    currentRef: str(q?.['current_ref']) ?? str(body['current_ref']) ?? str(cue?.['client_ref']),
    queued: num(q?.['length']) ?? num(q?.['queued']) ?? num(body['queued']),
  };
}

/** One WebSocket message as an event the runner understands, `'lagged'` when events were dropped, or null when it is not an event. */
export function readEvent(text: string): LinkEvent | 'lagged' | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = str(m['type']);
  if (type === 'lagged') return 'lagged';
  if (type === 'item_started' || type === 'ended') return { type, clientRef: str(m['client_ref']), seq: num(m['event_seq']) };
  return null;
}
