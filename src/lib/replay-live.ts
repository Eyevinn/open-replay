import type { StromClient } from './strom.js';

export type GoLiveResult = 'sent' | 'already-moving' | 'timeout';

export interface GoLiveOptions {
  /** How long to keep trying before giving up, in ms. */
  timeoutMs?: number;
  /** Pause between looks at the group's state, in ms. */
  everyMs?: number;
  /** How far behind the live edge `live` parks the cursor, in ms. */
  marginMs: number;
  log?: (message: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The live edge and the speed from a group's state. The replay API reports them as `range.live_edge` and
 * `motion.speed` (API version 2, Strom 0.8.4 build 719c9cab and later); an earlier build had them at the top level.
 */
function readState(body: Record<string, unknown>): { liveEdge: unknown; speed: unknown } {
  const range = body['range'] as Record<string, unknown> | undefined;
  const motion = body['motion'] as Record<string, unknown> | undefined;
  return { liveEdge: range?.['live_edge'] ?? body['live_edge'], speed: motion?.['speed'] ?? body['speed'] };
}

/**
 * Send `live` to a replay group once its players have found the live edge.
 *
 * A group of media players starts paused at the first recorded segment (Strom 0.8.4 and later), so a replay that no
 * browser is attached to would stay frozen and send a still picture out over SRT. This waits for the group to be
 * ready, then asks Strom to play from the live edge minus the margin. A group that is already moving, because an
 * operator got there first, is left alone.
 */
export async function goLiveWhenReady(strom: StromClient, flowId: string, group: string, opts: GoLiveOptions): Promise<GoLiveResult> {
  const { timeoutMs = 120_000, everyMs = 2_000, marginMs, log } = opts;
  const base = `/api/replay/${flowId}/${encodeURIComponent(group)}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(everyMs);
    let state: Awaited<ReturnType<StromClient['request']>>;
    try {
      state = await strom.request(`${base}/state`);
    } catch {
      continue; // Strom did not answer this time
    }
    // Not ready yet: the group does not exist until its players are up, and has no live edge until one is indexed.
    const { liveEdge, speed } = readState(state.body);
    if (!state.ok || !liveEdge) continue;
    if (speed !== 0) {
      log?.(`replay ${flowId}: already playing, no live command needed`);
      return 'already-moving';
    }
    const sent = await strom.request(`${base}/command`, { method: 'POST', json: { cmd: 'live', margin_ms: marginMs } }).catch(() => null);
    if (sent?.ok) {
      log?.(`replay ${flowId}: sent live (margin ${marginMs} ms)`);
      return 'sent';
    }
  }
  log?.(`replay ${flowId}: no live command sent, the group was not ready within ${Math.round(timeoutMs / 1000)} s`);
  return 'timeout';
}
