import { describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { buildReplayFlow, endpointOf, replayGroupOf } from '../lib/replay-flow.js';
import { parseTimerange } from '../lib/streams.js';
import { StromClient } from '../lib/strom.js';
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
    const players = flow.blocks.filter((b) => b['block_definition_id'] === 'builtin.media_player');
    expect(players).toHaveLength(2);
    for (const p of players) expect((p['properties'] as Record<string, unknown>)['group']).toBe(replayGroupOf('g-5696da24'));
    expect((players[0]!['properties'] as Record<string, unknown>)['source']).toBe('tams+https://tams.example/flows/abc');
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
