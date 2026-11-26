import type { TamsClient } from './tams.js';

/** A recorded stream found in the store: a TAMS flow with the extent of its segments. */
export interface Stream {
  id: string;
  label: string;
  tags: Record<string, string>;
  /** For example "1080p50", else the container. */
  format: string;
  hasAudio: boolean;
  /** When the first segment starts, epoch ms. */
  startedAt: number;
  /** When the last segment ends, epoch ms. `null` while the stream is still being written. */
  endedAt: number | null;
  /** How far the newest segment is behind the clock while live, in ms. */
  lagMs: number;
}

interface Flow {
  id: string;
  label?: string;
  description?: string;
  tags?: Record<string, string>;
  codec?: string;
  container?: string;
  frame_height?: number;
  frame_rate?: { numerator: number; denominator?: number };
}
interface Segment {
  timerange: string;
}

/** `[1764165000:0_1764165001:0)` as start and end in epoch ms. */
export function parseTimerange(tr: string): { start: number; end: number } | null {
  const m = /^[[(]?(-?\d+):(\d+)(?:_(-?\d+):(\d+))?/.exec(tr);
  if (!m) return null;
  const start = Number(m[1]) * 1000 + Number(m[2]) / 1e6;
  return { start, end: m[3] !== undefined ? Number(m[3]) * 1000 + Number(m[4]) / 1e6 : start };
}

function formatOf(f: Flow): string {
  if (f.frame_height) {
    const fps = f.frame_rate ? Math.round(f.frame_rate.numerator / (f.frame_rate.denominator || 1)) : '';
    return `${f.frame_height}p${fps}`;
  }
  return f.container?.split('/').pop() ?? f.codec?.split('/').pop() ?? 'media';
}

/** A stream counts as still being written while its newest segment ends within this much of the clock. */
export const LIVE_WITHIN_MS = 15_000;

async function toStream(tams: TamsClient, f: Flow, now: number): Promise<Stream | null> {
  const [first, last] = await Promise.all([
    tams.get<Segment[]>(`/flows/${f.id}/segments?limit=1`),
    tams.get<Segment[]>(`/flows/${f.id}/segments?limit=1&reverse_order=true`),
  ]);
  const a = first[0] && parseTimerange(first[0].timerange);
  const b = last[0] && parseTimerange(last[0].timerange);
  // A flow with no segments holds nothing to replay.
  if (!a || !b) return null;
  const live = now - b.end < LIVE_WITHIN_MS;
  return {
    id: f.id,
    label: f.label || f.description || f.id.slice(0, 8),
    tags: f.tags ?? {},
    format: formatOf(f),
    hasAudio: true,
    startedAt: a.start,
    endedAt: live ? null : b.end,
    lagMs: live ? Math.max(0, now - b.end) : 0,
  };
}

/** Every flow of the store that has recordings, newest first. */
export async function listStreams(tams: TamsClient, now = Date.now()): Promise<Stream[]> {
  const flows = await tams.get<Flow[]>('/flows');
  const streams = await Promise.all(flows.map((f) => toStream(tams, f, now)));
  return streams.flatMap((s) => s ?? []).sort((x, y) => y.startedAt - x.startedAt || x.label.localeCompare(y.label));
}
