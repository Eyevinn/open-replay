import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { StromClient } from '../lib/strom.js';
import type { TamsClient } from '../lib/tams.js';
import { buildServer } from '../server.js';
import { MockStrom } from './mock-strom.js';

/** In-memory nano stand-in that honours equality selectors. */
function fakeDb(): Db {
  const store = new Map<string, Record<string, unknown>>();
  let n = 0;
  const err = (statusCode: number) => Object.assign(new Error(String(statusCode)), { statusCode });
  const docs = {
    config: { db: 'test' },
    insert: async (doc: Record<string, unknown>) => {
      const cur = store.get(doc['_id'] as string);
      if (cur && cur['_rev'] !== doc['_rev']) throw err(409);
      const rev = `${++n}-x`;
      store.set(doc['_id'] as string, { ...doc, _rev: rev });
      return { ok: true, id: doc['_id'], rev };
    },
    get: async (id: string) => {
      const d = store.get(id);
      if (!d) throw err(404);
      return { ...d };
    },
    destroy: async (id: string) => {
      if (!store.delete(id)) throw err(404);
      return { ok: true };
    },
    find: async ({ selector }: { selector: Record<string, unknown> }) => ({
      docs: [...store.values()].filter((d) => Object.entries(selector).every(([k, v]) => (typeof v === 'object' && v !== null ? true : d[k] === v))),
    }),
  };
  return { server: { db: { get: async () => ({}) } }, docs } as unknown as Db;
}

const sec = (s: number) => (BigInt(s) * 1_000_000_000n).toString();
const T0 = 1_800_000_000;
const until = async (check: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let mock: MockStrom;
let db: Db;
let app: Awaited<ReturnType<typeof buildServer>>;
const url = (p: string) => `/api/v1/groups/g1/playback/playlist${p}`;
type Reply = { statusCode: number; json: () => Record<string, any> };
const post = async (path: string, payload: object): Promise<Reply> => (await app.inject({ method: 'POST', url: `/api/v1${path}`, payload })) as unknown as Reply;

async function setup(withClipPlayer: boolean, features?: string[]) {
  mock = new MockStrom({ timeScale: 0.02, ...(features ? { features } : {}) });
  mock.addGroup('f1', 'studio-g1');
  if (withClipPlayer) {
    mock.addGroup('f1', 'studio-g1-a');
    mock.addGroup('f1', 'studio-g1-b');
  }
  const strom = new StromClient({ url: await mock.listen(), key: undefined });
  db = fakeDb();
  app = await buildServer({ apiKey: undefined, corsOrigin: undefined, logLevel: 'silent' }, db, { strom, tams: { host: 'gw.test' } as TamsClient });
}

async function library() {
  const clip = async (name: string, streamId: string, from: number, len: number) =>
    (await post('/clips', { groupId: 'g1', name, streamId, inT: sec(T0 + from), outT: sec(T0 + from + len) })).json().id as string;
  const a = await clip('A', 'cam-1', 0, 4);
  const b = await clip('B', 'cam-2', 10, 6);
  const pl = (await post('/playlists', { name: 'Highlights', items: [{ clipId: a }, { clipId: b, speed: 0.5 }] })).json();
  return { a, b, playlist: pl.id as string };
}

afterEach(async () => {
  await mock?.close();
});

describe('playing a playlist', () => {
  beforeEach(() => setup(true));

  it('plays the clips from their cameras through the clip player, then finishes', async () => {
    const { playlist } = await library();
    const started = await app.inject({ method: 'PUT', url: url(''), payload: { playlistId: playlist } });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ running: true, state: 'running', total: 2, playlistId: playlist });
    await until(async () => (await app.inject(url(''))).json().state === 'finished');
    // One camera, so clip player A is mixer input 1: it is put in preview, and Take sends it to air.
    expect(mock.mixerCalls).toContain('pvw cut 1');
    const cues = mock.commands.filter((c) => c['cmd'] === 'cue' || c['cmd'] === 'cue_next');
    expect(cues.map((c) => c['source'])).toEqual(['tams+https://gw.test/flows/cam-1', 'tams+https://gw.test/flows/cam-2']);
    expect(cues[1]).toMatchObject({ in: { t: sec(T0 + 10) }, out: { t: sec(T0 + 16) }, speed: 0.5 });
  });

  it('leaves out a clip that is gone, and says which', async () => {
    const { a } = await library();
    // A playlist that still names a clip that no longer exists: the cleanup after a delete can lose a race, so the runner must cope.
    const now = new Date().toISOString();
    await (db.docs as unknown as { insert: (d: object) => Promise<unknown> }).insert({
      _id: 'playlist:ghost', type: 'playlist', name: 'Ghost', endAction: 'freeze', createdAt: now, updatedAt: now,
      items: [{ clipId: 'clip:gone', speed: 1 }, { clipId: a, speed: 1 }],
    });
    const res = await app.inject({ method: 'PUT', url: url(''), payload: { playlistId: 'playlist:ghost' } });
    expect(res.json()).toMatchObject({ running: true, total: 1, skipped: ['clip:gone'] });
    await app.inject({ method: 'DELETE', url: url('') });
  });

  it('refuses a second playlist on a player that is busy, then allows it after a stop', async () => {
    const { playlist } = await library();
    await app.inject({ method: 'PUT', url: url(''), payload: { playlistId: playlist } });
    const again = await app.inject({ method: 'PUT', url: url(''), payload: { playlistId: playlist } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/already playing/);
    expect((await app.inject({ method: 'DELETE', url: url('') })).json()).toMatchObject({ running: false, state: 'stopped' });
    expect((await app.inject({ method: 'PUT', url: url(''), payload: { playlistId: playlist } })).statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: url('') });
  });

  it('answers 404 for a playlist that does not exist and 409 for one with nothing to play', async () => {
    expect((await app.inject({ method: 'PUT', url: url(''), payload: { playlistId: 'playlist:nope' } })).statusCode).toBe(404);
    const empty = (await post('/playlists', { name: 'Empty' })).json().id;
    expect((await app.inject({ method: 'PUT', url: url(''), payload: { playlistId: empty } })).statusCode).toBe(409);
  });

  it('reports nothing running for a player that was never started', async () => {
    expect((await app.inject(url('?player=b'))).json()).toEqual({ running: false });
  });
});

describe('cueing one clip', () => {
  beforeEach(() => setup(true));
  const clipUrl = (q = '') => `/api/v1/groups/g1/playback/clip${q}`;

  it('cues the clip on player B from its own camera and waits on the first frame', async () => {
    const { a } = await library();
    const res = await app.inject({ method: 'PUT', url: clipUrl(), payload: { clipId: a } });
    expect(res.json()).toEqual({ player: 'b', clipId: a, streamId: 'cam-1', playing: false });
    expect(mock.mixerCalls).toContain('pvw cut 2'); // player B is the second clip input, after the one camera
    expect(mock.commands).toHaveLength(1);
    expect(mock.commands[0]).toMatchObject({ cmd: 'cue', source: 'tams+https://gw.test/flows/cam-1', in: { t: sec(T0) }, out: { t: sec(T0 + 4) } });
  });

  it('plays from another camera at the same range when asked to check an angle', async () => {
    const { a } = await library();
    const res = await app.inject({ method: 'PUT', url: clipUrl(), payload: { clipId: a, streamId: 'cam-3', play: true } });
    expect(res.json()).toMatchObject({ streamId: 'cam-3', playing: true });
    expect(mock.commands.map((c) => c['cmd'])).toEqual(['cue', 'play']);
    expect(mock.commands[0]).toMatchObject({ source: 'tams+https://gw.test/flows/cam-3', in: { t: sec(T0) }, out: { t: sec(T0 + 4) } });
  });

  it('clears the player, and refuses to touch one that is running a playlist', async () => {
    const { a, playlist } = await library();
    await app.inject({ method: 'PUT', url: clipUrl(), payload: { clipId: a } });
    expect((await app.inject({ method: 'DELETE', url: clipUrl() })).json()).toEqual({ cleared: true });
    expect(mock.commands.slice(-3).map((c) => c['cmd'])).toEqual(['clear_queue', 'uncue', 'pause']);
    await app.inject({ method: 'PUT', url: url(''), payload: { playlistId: playlist } });
    const busy = await app.inject({ method: 'PUT', url: clipUrl('?player=a'), payload: { clipId: a } });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatch(/playing a playlist/);
    await app.inject({ method: 'DELETE', url: url('') });
  });

  it('leaves the preview alone when asked not to show the clip', async () => {
    const { a } = await library();
    await app.inject({ method: 'PUT', url: clipUrl(), payload: { clipId: a, preview: false } });
    expect(mock.mixerCalls).toEqual([]);
  });

  it('answers 404 for a clip that does not exist', async () => {
    expect((await app.inject({ method: 'PUT', url: clipUrl(), payload: { clipId: 'clip:nope' } })).statusCode).toBe(404);
  });
});

describe("a Strom that cannot switch a clip player's source or queue clips yet", () => {
  it('says which feature is missing instead of sending a command it would refuse', async () => {
    await setup(true, []);
    const { a, playlist } = await library();
    const pl = await app.inject({ method: 'PUT', url: url(''), payload: { playlistId: playlist } });
    expect(pl.statusCode).toBe(409);
    expect(pl.json().error).toMatch(/cannot queue clips.*source_switch/);
    const clip = await app.inject({ method: 'PUT', url: '/api/v1/groups/g1/playback/clip', payload: { clipId: a } });
    expect(clip.statusCode).toBe(409);
    expect(clip.json().error).toMatch(/cannot switch a clip player's source.*source_switch/);
    expect(mock.commands).toEqual([]);
    await mock.close();
    await setup(true, ['source_switch']); // can switch a source but not queue
    const lib = await library();
    expect((await app.inject({ method: 'PUT', url: '/api/v1/groups/g1/playback/clip', payload: { clipId: lib.a } })).statusCode).toBe(200);
    const queue = await app.inject({ method: 'PUT', url: url(''), payload: { playlistId: lib.playlist } });
    expect(queue.statusCode).toBe(409);
    expect(queue.json().error).toMatch(/cannot queue clips.*cue_next/);
  });
});

describe('a replay flow without clip players (what Strom flows are built with today)', () => {
  beforeEach(() => setup(false));

  it('says so instead of failing in Strom', async () => {
    const { playlist } = await library();
    const res = await app.inject({ method: 'PUT', url: url(''), payload: { playlistId: playlist } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/no clip player A/);
    expect(mock.commands).toEqual([]);
  });
});

describe('a group with no running replay', () => {
  it('says to start it first', async () => {
    mock = new MockStrom();
    const strom = new StromClient({ url: await mock.listen(), key: undefined });
    app = await buildServer({ apiKey: undefined, corsOrigin: undefined, logLevel: 'silent' }, fakeDb(), { strom, tams: { host: 'gw.test' } as TamsClient });
    const { playlist } = await library();
    const res = await app.inject({ method: 'PUT', url: url(''), payload: { playlistId: playlist } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/no running replay/);
  });
});
