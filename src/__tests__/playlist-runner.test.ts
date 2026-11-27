import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlaylistRunner, type RunnerItem, type RunnerStatus } from '../lib/playlist-runner.js';
import { readClipState, readEvent, StromReplayLink } from '../lib/replay-link.js';
import { StromClient } from '../lib/strom.js';
import { MockStrom } from './mock-strom.js';

const sec = (s: number) => (BigInt(s) * 1_000_000_000n).toString();
const T0 = 1_800_000_000;
/** Three clips of 4, 6 and 2 seconds. */
const items: RunnerItem[] = [
  { clipId: 'clip:a', name: 'A', source: 'tams+https://g/flows/cam1', inT: sec(T0), outT: sec(T0 + 4), speed: 1 },
  { clipId: 'clip:b', name: 'B', source: 'tams+https://g/flows/cam2', inT: sec(T0 + 10), outT: sec(T0 + 16), speed: 0.5 },
  { clipId: 'clip:c', name: 'C', source: 'tams+https://g/flows/cam1', inT: sec(T0 + 20), outT: sec(T0 + 22), speed: 1 },
];

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let mock: MockStrom;
let strom: StromClient;
const GROUP = 'studio-g1-a';
const link = () => new StromReplayLink(strom, 'f1', GROUP, 50);

async function setup(opts: ConstructorParameters<typeof MockStrom>[0] = {}) {
  mock = new MockStrom(opts);
  mock.addGroup('f1', GROUP);
  strom = new StromClient({ url: await mock.listen(), key: undefined });
}
afterEach(async () => {
  await mock?.close();
});

describe('playlist runner against the mock Strom', () => {
  beforeEach(() => setup());

  it('plays the items in order with no gap, queueing only two ahead', async () => {
    const seen: RunnerStatus[] = [];
    const runner = new PlaylistRunner(link(), items, { pollMs: 0, onChange: (s) => seen.push(s) });
    await runner.start();
    expect(mock.commands.map((c) => c['cmd'])).toEqual(['cue', 'play', 'cue_next', 'cue_next']);
    await until(() => runner.status().state === 'finished');
    expect(mock.happened).toEqual([0, 1, 2].flatMap((n) => [`item_started:${n}`, `ended:${n}`]).map((e) => e.replace(/:(\d)/, (_, n) => `:${runnerRef(mock, n)}`)));
    expect(Math.max(...seen.map((s) => s.queued))).toBeLessThanOrEqual(2);
    expect(runner.status()).toMatchObject({ state: 'finished', total: 3, index: 2 });
  });

  it('sends each item with its own source, range and speed, and holds the last frame', async () => {
    const runner = new PlaylistRunner(link(), items, { pollMs: 0 });
    await runner.start();
    await until(() => runner.status().state === 'finished');
    const queued = mock.commands.filter((c) => c['cmd'] === 'cue_next');
    expect(queued[0]).toMatchObject({ source: items[1]!.source, in: { t: items[1]!.inT }, out: { t: items[1]!.outT }, speed: 0.5, end_action: 'freeze' });
    expect(mock.commands[0]).toMatchObject({ cmd: 'cue', source: items[0]!.source, end_action: 'freeze' });
  });

  it('gives the last item the playlist\'s end action and no other', async () => {
    const runner = new PlaylistRunner(link(), items, { pollMs: 0, endAction: 'live' });
    await runner.start();
    await until(() => runner.status().state === 'finished');
    const actions = mock.commands.filter((c) => c['cmd'] === 'cue' || c['cmd'] === 'cue_next').map((c) => c['end_action']);
    expect(actions).toEqual(['freeze', 'freeze', 'live']);
  });

  it('never has more queued than it was asked to, on a longer playlist', async () => {
    const long = Array.from({ length: 8 }, (_, i) => ({ ...items[2]!, clipId: `clip:${i}` }));
    const seen: RunnerStatus[] = [];
    const runner = new PlaylistRunner(link(), long, { pollMs: 0, ahead: 2, onChange: (s) => seen.push(s) });
    await runner.start();
    await until(() => runner.status().state === 'finished');
    expect(Math.max(...seen.map((s) => s.queued))).toBe(2);
    expect(mock.commands.filter((c) => c['cmd'] === 'cue_next')).toHaveLength(7);
    expect(new Set(mock.commands.filter((c) => c['client_ref']).map((c) => c['client_ref'])).size).toBe(8); // each item sent once
  });

  it('refuses an empty playlist', async () => {
    await expect(new PlaylistRunner(link(), [], { pollMs: 0 }).start()).rejects.toThrow(/no clips/);
  });

  it('stops: clears the player and ignores what comes later', async () => {
    const runner = new PlaylistRunner(link(), items, { pollMs: 0 });
    await runner.start();
    await runner.stop();
    // `uncue` alone keeps the queue and the speed: the queue is cleared first and the player paused last.
    expect(mock.commands.slice(-3)).toMatchObject([{ cmd: 'clear_queue' }, { cmd: 'uncue' }, { cmd: 'pause' }]);
    expect(mock.waiting(GROUP)).toBe(0);
    expect(mock.playingRef(GROUP)).toBeNull();
    expect(runner.status().state).toBe('stopped');
    await new Promise((r) => setTimeout(r, 100));
    expect(runner.status().state).toBe('stopped');
  });

  it('fails clearly when Strom refuses a command', async () => {
    const bad = [{ ...items[0]!, outT: items[0]!.inT }];
    const runner = new PlaylistRunner(link(), bad, { pollMs: 0 });
    await expect(runner.start()).rejects.toThrow(/refused cue.*out is not after in/);
    expect(runner.status()).toMatchObject({ state: 'failed' });
  });

  it('loops by queueing the first item again, and stops when told to', async () => {
    const runner = new PlaylistRunner(link(), items, { pollMs: 0, endAction: 'loop' });
    await runner.start();
    await until(() => (runner.status().round ?? 0) >= 1);
    expect(runner.status().state).toBe('running');
    await runner.stop();
  });
});

describe('playlist runner when events are lost', () => {
  it('keeps the queue filled and notices the end by reading the state', async () => {
    await setup({ dropEvents: true });
    const runner = new PlaylistRunner(link(), items, { pollMs: 10 });
    await runner.start();
    await until(() => runner.status().state === 'finished');
    expect(mock.commands.filter((c) => c['cmd'] === 'cue_next')).toHaveLength(2);
  });
});

describe('playlist runner against other behaviour of Strom', () => {
  it('notices the end by reading the state when the player releases its cue at the end', async () => {
    await setup({ dropEvents: true, holdAtEnd: false });
    const runner = new PlaylistRunner(link(), items, { pollMs: 10 });
    await runner.start();
    await until(() => runner.status().state === 'finished');
  });

  it('fails when Strom cannot switch to an item\'s source, and says which item', async () => {
    await setup({ failSource: items[1]!.source });
    const runner = new PlaylistRunner(link(), items, { pollMs: 0 });
    await runner.start();
    await until(() => runner.status().state === 'failed');
    expect(runner.status().error).toMatch(/item 2 \(B\)/);
  });
});

describe('what the link reads from Strom', () => {
  it('reads the held clip, the number waiting and the speed from the state', () => {
    expect(readClipState({ queue: { clip_ref: 'r-1', waiting: 2 }, motion: { speed: 0.5 } })).toEqual({ currentRef: 'r-1', queued: 2, speed: 0.5 });
    expect(readClipState({ queue: { clip_ref: null, waiting: 0 }, motion: null })).toEqual({ currentRef: null, queued: 0, speed: null });
    // The names it used to guess are gone: they do not exist.
    expect(readClipState({ queue: { current_ref: 'r-2', length: 3 }, current_ref: 'r-2' })).toEqual({ currentRef: null, queued: null, speed: null });
  });

  it('reads events by their name, and a lagged message', () => {
    expect(readEvent('{"type":"event","event_seq":42,"event":"item_started","cause":"cue_end","client_ref":"clip-18","waiting":0}')).toEqual({ type: 'item_started', clientRef: 'clip-18', seq: 42 });
    expect(readEvent('{"type":"event","event_seq":41,"event":"ended","cause":"cue_end","client_ref":"clip-17"}')).toMatchObject({ type: 'ended', clientRef: 'clip-17' });
    expect(readEvent('{"type":"event","event":"source_failed","client_ref":"clip-19"}')).toMatchObject({ type: 'source_failed' });
    expect(readEvent('{"type":"event","event":"ended"}')).toMatchObject({ clientRef: null }); // no client_ref when none was given
    expect(readEvent('{"type":"event","event":"source_changed","client_ref":"x"}')).toBeNull();
    expect(readEvent('{"type":"lagged"}')).toBe('lagged');
    expect(readEvent('{"type":"ended","client_ref":"r-1"}')).toBeNull(); // the old shape
    expect(readEvent('{"type":"state"}')).toBeNull();
    expect(readEvent('not json')).toBeNull();
  });
});

/** The ref the runner gave item `n`, read back from what the mock saw. */
function runnerRef(m: MockStrom, n: string): string {
  const cmd = m.commands.filter((c) => c['cmd'] === 'cue' || c['cmd'] === 'cue_next')[Number(n)];
  return String(cmd?.['client_ref']);
}
