import { describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { buildReplayFlow, endpointOf, replayGroupOf } from '../lib/replay-flow.js';
import { parseTimerange } from '../lib/streams.js';
import { StromClient } from '../lib/strom.js';
import { goLiveWhenReady } from '../lib/replay-live.js';
import { buildServer } from '../server.js';

const db = { server: { db: { get: async () => ({}) } }, docs: { config: { db: 'test' } } } as unknown as Db;
const base = { apiKey: undefined, corsOrigin: undefined, logLevel: 'silent' };

describe('parseTimerange', () => {
  it('reads a range as epoch milliseconds', () => {
    expect(parseTimerange('[1764165000:500000000_1764165001:0)')).toEqual({ start: 1764165000500, end: 1764165001000 });
  });
  it('rejects text that is not a timerange', () => {
    expect(parseTimerange('nonsense')).toBeNull();
  });
});

describe('buildReplayFlow', () => {
  const req = { groupId: 'g-5696da24', name: 'Second replay', srtUri: 'srt://127.0.0.1:5031?mode=caller', members: [{ streamId: 'abc', label: 'Cam 1' }, { streamId: 'def', label: 'Cam 2' }] };
  const flow = buildReplayFlow(req, 'tams.example');

  it('has a player per stream, all in the group replay group, reading the store', () => {
    const players = flow.blocks.filter((b) => b['block_definition_id'] === 'builtin.media_player' && /^cam\d+$/.test(String(b['id'])));
    expect(players).toHaveLength(2);
    for (const p of players) expect((p['properties'] as Record<string, unknown>)['group']).toBe(replayGroupOf('g-5696da24'));
    expect((players[0]!['properties'] as Record<string, unknown>)['source']).toBe('tams+https://tams.example/flows/abc');
  });
  it('adds two clip players, each in a group of its own, after the cameras on both mixers', () => {
    const byId = (id: string) => flow.blocks.find((b) => b['id'] === id)!;
    for (const [id, group, input] of [['clipA', 'studio-g-5696da24-a', 2], ['clipB', 'studio-g-5696da24-b', 3]] as const) {
      const props = byId(id)['properties'] as Record<string, unknown>;
      expect(props).toMatchObject({ mode: 'timeline', group, auth_mode: 'osc', output_framerate: '25/1', source: 'tams+https://tams.example/flows/abc' });
      expect(flow.links).toEqual(expect.arrayContaining([{ from: `${id}:video_out`, to: `vm:video_in_${input}` }, { from: `${id}:video_out`, to: `pvw:video_in_${input}` }]));
    }
    // Cameras and clip players: both mixers take N + 2 inputs, labelled.
    for (const m of ['vm', 'pvw']) expect(byId(m)['properties']).toMatchObject({ num_inputs: 4, input_2_label: 'Clip A', input_3_label: 'Clip B' });
  });
  it('does not give the clip players a video of their own: the preview shows them', () => {
    const ids = flow.blocks.map((b) => b['id']);
    expect(ids).not.toContain('whep_clipA');
    expect(ids).not.toContain('enc_clipA');
  });
  it('gives every source its own WHEP video and leaves out the multiview', () => {
    const ids = flow.blocks.map((b) => b['id']);
    expect(ids).toContain('whep_cam1');
    expect(ids).toContain('whep_cam2');
    expect(ids).not.toContain('whep_mv');
    expect(flow.links.some((l) => l.from.endsWith('multiview_out'))).toBe(false);
  });
  it('has one preview video that a preview mixer feeds from every source', () => {
    expect(flow.blocks.map((b) => b['id'])).toEqual(expect.arrayContaining(['pvw', 'enc_pvw', 'whep_pvw']));
    expect(flow.links).toEqual(expect.arrayContaining([{ from: 'cam1:video_out', to: 'pvw:video_in_0' }, { from: 'cam2:video_out', to: 'pvw:video_in_1' }, { from: 'pvw:pgm_out', to: 'enc_pvw:video_in' }]));
  });
  it('has a program WHEP video fed by the program bus, next to the unchanged SRT output', () => {
    const whep = flow.blocks.find((b) => b['id'] === 'whep_pgm')!;
    expect(whep['block_definition_id']).toBe('builtin.whep_output');
    expect((whep['properties'] as Record<string, unknown>)['endpoint_id']).toBe(endpointOf('g-5696da24', 'pgm'));
    expect(endpointOf('g-5696da24', 'pgm')).not.toBe(endpointOf('g-5696da24', 'pvw'));
    expect(flow.links).toEqual(expect.arrayContaining([
      { from: 'vm:pgm_out', to: 'enc_pgm:video_in' }, { from: 'enc_pgm:encoded_out', to: 'whep_pgm:video_in' },
      { from: 'vm:pgm_out', to: 'q_air:sink' }, { from: 'enc_air:encoded_out', to: 'srt_air:video_in' },
    ]));
  });
  it('lets Strom pick hardware encoders when it has them', () => {
    const encoders = flow.blocks.filter((b) => b['block_definition_id'] === 'builtin.videoenc');
    expect(encoders.length).toBeGreaterThan(0);
    for (const e of encoders) expect((e['properties'] as Record<string, unknown>)['encoder_preference']).toBe('auto');
  });
  it('plays every source at the 25 fps the mixers run at', () => {
    for (const p of flow.blocks.filter((b) => b['block_definition_id'] === 'builtin.media_player')) expect((p['properties'] as Record<string, unknown>)['output_framerate']).toBe('25/1');
  });
  it('sends the program to the SRT address', () => {
    const out = flow.blocks.find((b) => b['id'] === 'srt_air')!;
    expect((out['properties'] as Record<string, unknown>)['srt_uri']).toBe(req.srtUri);
  });
  it('gives two groups different groups and endpoints', () => {
    expect(replayGroupOf('a')).not.toBe(replayGroupOf('b'));
    expect(endpointOf('g-aaaaaaaa', 'pvw')).not.toBe(endpointOf('g-bbbbbbbb', 'pvw'));
  });
});

describe('without a store or a Strom', () => {
  it('answers 503 instead of failing', async () => {
    const app = await buildServer(base, db, {});
    expect((await app.inject('/api/v1/streams')).statusCode).toBe(503);
    expect((await app.inject('/api/v1/groups/g-1/playback')).statusCode).toBe(503);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/groups/g-1/playback' })).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: '/api/v1/groups/g-1/playback/take' })).statusCode).toBe(503);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/groups/g-1/playback/preview', payload: { source: 0 } })).statusCode).toBe(503);
  });
});

describe('a replay started before sources had their own video', () => {
  it('is reported as outdated, with no sources to ask for', async () => {
    const flows = { flows: [{ id: 'f1', gst_state: 'Playing', blocks: [
      { id: 'cam1', block_definition_id: 'builtin.media_player', name: 'A', properties: { group: 'studio-g-1' } },
      { id: 'whep_pgm', block_definition_id: 'builtin.whep_output', properties: {} },
      { id: 'srt_air', block_definition_id: 'builtin.mpegtssrt_output', properties: { srt_uri: 'srt://127.0.0.1:5030?mode=caller' } },
    ] }] };
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => new Response(JSON.stringify(String(url).endsWith('/state') ? { program_input: 0, preview_input: 1 } : flows), { status: 200 })) as unknown as typeof fetch;
    try {
      const app = await buildServer(base, db, { strom: new StromClient({ url: 'http://strom.test', key: undefined }) });
      const body = (await app.inject('/api/v1/groups/g-1/playback')).json();
      expect(body.outdated).toBe(true);
      expect(body.liveMarginMs).toBe(1500);
      expect(body.sources).toEqual([]);
      expect(body.srtUri).toBe('srt://127.0.0.1:5030?mode=caller');
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('a replay that has source videos but no preview mixer', () => {
  it('is outdated too, since its preview could not follow the mixer', async () => {
    const flows = { flows: [{ id: 'f1', blocks: [
      { id: 'cam1', block_definition_id: 'builtin.media_player', name: 'A', properties: { group: 'studio-g-1' } },
      { id: 'whep_cam1', block_definition_id: 'builtin.whep_output', properties: {} },
    ] }] };
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => new Response(JSON.stringify(String(url).endsWith('/state') ? { program_input: 0, preview_input: 1 } : flows), { status: 200 })) as unknown as typeof fetch;
    try {
      const app = await buildServer(base, db, { strom: new StromClient({ url: 'http://strom.test', key: undefined }) });
      const body = (await app.inject('/api/v1/groups/g-1/playback')).json();
      expect(body.outdated).toBe(true);
      expect(body.sources).toHaveLength(1);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('the program WHEP video in the status', () => {
  const blocks = (extra: object[]) => [
    { id: 'cam1', block_definition_id: 'builtin.media_player', name: 'A', properties: { group: 'studio-g-1' } },
    { id: 'whep_cam1', block_definition_id: 'builtin.whep_output', properties: {} },
    { id: 'pvw', block_definition_id: 'builtin.vision_mixer', properties: {} },
    { id: 'whep_pvw', block_definition_id: 'builtin.whep_output', properties: {} },
    ...extra,
  ];
  const status = async (b: object[]) => {
    const flows = { flows: [{ id: 'f1', blocks: b }] };
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => new Response(JSON.stringify(String(url).endsWith('/state') ? { program_input: 0, preview_input: 1 } : flows), { status: 200 })) as unknown as typeof fetch;
    try {
      const app = await buildServer(base, db, { strom: new StromClient({ url: 'http://strom.test', key: undefined }) });
      return (await app.inject('/api/v1/groups/g-1/playback')).json();
    } finally {
      globalThis.fetch = real;
    }
  };
  it('returns the program path through the Strom proxy for a current flow', async () => {
    const body = await status(blocks([{ id: 'whep_pgm', block_definition_id: 'builtin.whep_output', properties: {} }]));
    expect(body.programPath).toBe(`/api/v1/strom/whep/${endpointOf('g-1', 'pgm')}`);
    expect(body.outdated).toBe(false);
  });
  it('reports a flow from before the program WHEP as outdated', async () => {
    const body = await status(blocks([]));
    expect(body.outdated).toBe(true);
  });
});

describe('playback with a Strom', () => {
  it('reports a group with no flow as stopped, and sends the Strom key', async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const strom = new StromClient({ url: 'http://strom.test', key: 'secret' });
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers);
      return new Response(JSON.stringify({ flows: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const app = await buildServer(base, db, { strom });
      const res = await app.inject('/api/v1/groups/g-1/playback');
      expect(res.json()).toEqual({ running: false });
      expect(seen[0]?.['authorization']).toBe('Bearer secret');
    } finally {
      globalThis.fetch = real;
    }
  });
  it('refuses a replay without streams or with a bad address', async () => {
    const app = await buildServer(base, db, { strom: new StromClient({ url: 'http://strom.test', key: undefined }) });
    const put = (body: unknown) => app.inject({ method: 'PUT', url: '/api/v1/groups/g-1/playback', payload: body as object });
    expect((await put({ name: 'x', srtUri: 'srt://h:1', members: [] })).statusCode).toBe(400);
    expect((await put({ name: 'x', srtUri: 'http://h', members: [{ streamId: 'a', label: 'A' }] })).statusCode).toBe(400);
  });
});

describe('goLiveWhenReady', () => {
  /** A Strom that answers each state request from a script, and records the commands it is sent. */
  const fakeStrom = (states: { ok: boolean; body: Record<string, unknown> }[]) => {
    const commands: unknown[] = [];
    let i = 0;
    const strom = {
      request: async (path: string, init?: { json?: unknown }) => {
        if (path.endsWith('/command')) {
          commands.push(init?.json);
          return { ok: true, status: 200, body: {} };
        }
        return { status: 200, ...(states[Math.min(i++, states.length - 1)] as object) };
      },
    } as unknown as StromClient;
    return { strom, commands };
  };
  const opts = { everyMs: 0, timeoutMs: 1000, marginMs: 800 };

  it('waits for the live edge, then sends live once', async () => {
    const { strom, commands } = fakeStrom([
      { ok: false, body: {} },
      { ok: true, body: { speed: 0 } },
      { ok: true, body: { speed: 0, live_edge: { frame: 1 } } },
    ]);
    expect(await goLiveWhenReady(strom, 'f1', 'studio-g-1', opts)).toBe('sent');
    expect(commands).toEqual([{ cmd: 'live', margin_ms: 800 }]);
  });
  it('reads the live edge and speed from the typed state of the deployed Strom', async () => {
    const { strom, commands } = fakeStrom([
      { ok: true, body: { ready: 'warming', range: { start: { t: '1' }, live_edge: null }, motion: { speed: 0 } } },
      { ok: true, body: { ready: 'ready', range: { start: { t: '1' }, live_edge: { t: '9' } }, motion: { speed: 0, live: false } } },
    ]);
    expect(await goLiveWhenReady(strom, 'f1', 'studio-g-1', opts)).toBe('sent');
    expect(commands).toEqual([{ cmd: 'live', margin_ms: 800 }]);
  });
  it('leaves a typed-state group alone that is already moving', async () => {
    const { strom, commands } = fakeStrom([{ ok: true, body: { range: { live_edge: { t: '9' } }, motion: { speed: 0.56 } } }]);
    expect(await goLiveWhenReady(strom, 'f1', 'studio-g-1', opts)).toBe('already-moving');
    expect(commands).toEqual([]);
  });
  it('leaves a group alone that is already moving', async () => {
    const { strom, commands } = fakeStrom([{ ok: true, body: { speed: 1, live_edge: { frame: 1 } } }]);
    expect(await goLiveWhenReady(strom, 'f1', 'studio-g-1', opts)).toBe('already-moving');
    expect(commands).toEqual([]);
  });
  it('gives up when the group never becomes ready', async () => {
    const { strom, commands } = fakeStrom([{ ok: false, body: {} }]);
    expect(await goLiveWhenReady(strom, 'f1', 'studio-g-1', { ...opts, timeoutMs: 30 })).toBe('timeout');
    expect(commands).toEqual([]);
  });
});
