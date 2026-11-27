import { describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { buildServer } from '../server.js';

/** In-memory nano stand-in that honours equality selectors and CouchDB's _rev rule. */
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
    destroy: async (id: string, rev: string) => {
      const d = store.get(id);
      if (!d) throw err(404);
      if (d['_rev'] !== rev) throw err(409);
      store.delete(id);
      return { ok: true };
    },
    find: async ({ selector }: { selector: Record<string, unknown> }) => ({
      docs: [...store.values()].filter((d) =>
        Object.entries(selector).every(([k, v]) => (typeof v === 'object' && v !== null ? true : d[k] === v))),
    }),
  };
  return { server: { db: { get: async () => ({}) } }, docs } as unknown as Db;
}

const make = async () => buildServer({ apiKey: undefined, corsOrigin: undefined, logLevel: 'silent' }, fakeDb());
const clipBody = { groupId: 'g1', name: 'Goal', streamId: 'cam-1', inT: '1800000000000000000', outT: '1800000008000000000', speed: 0.5 };

describe('marks', () => {
  it('keeps the exact time as a string and filters by group', async () => {
    const app = await make();
    const t = '1800000000123456789';
    const res = await app.inject({ method: 'POST', url: '/api/v1/marks', payload: { groupId: 'g1', name: 'Offside', t, tag: 'foul' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().t).toBe(t);
    await app.inject({ method: 'POST', url: '/api/v1/marks', payload: { groupId: 'g2', name: 'Other', t } });
    const list = await app.inject('/api/v1/marks?groupId=g1');
    expect(list.json().map((m: { name: string }) => m.name)).toEqual(['Offside']);
  });

  it('rejects a time that is not a decimal string', async () => {
    const app = await make();
    const res = await app.inject({ method: 'POST', url: '/api/v1/marks', payload: { groupId: 'g1', name: 'x', t: 1.8e18 } });
    expect(res.statusCode).toBe(400);
  });
});

describe('clips', () => {
  it('creates with defaults, patches and deletes', async () => {
    const app = await make();
    const created = await app.inject({ method: 'POST', url: '/api/v1/clips', payload: { ...clipBody, speed: undefined } });
    expect(created.statusCode).toBe(201);
    const clip = created.json();
    expect(clip).toMatchObject({ speed: 1, starred: false, tag: null });
    const patched = await app.inject({ method: 'PATCH', url: `/api/v1/clips/${clip.id}`, payload: { starred: true, speed: 0.25 } });
    expect(patched.json()).toMatchObject({ starred: true, speed: 0.25, inT: clipBody.inT });
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/clips/${clip.id}` })).statusCode).toBe(204);
    expect((await app.inject(`/api/v1/clips/${clip.id}`)).statusCode).toBe(404);
  });

  it('rejects an out point at or before the in point, on create and on patch', async () => {
    const app = await make();
    expect((await app.inject({ method: 'POST', url: '/api/v1/clips', payload: { ...clipBody, outT: clipBody.inT } })).statusCode).toBe(400);
    const { id } = (await app.inject({ method: 'POST', url: '/api/v1/clips', payload: clipBody })).json();
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/clips/${id}`, payload: { outT: '1' } })).statusCode).toBe(400);
  });

  it('answers 409 when the patch carries a stale rev', async () => {
    const app = await make();
    const clip = (await app.inject({ method: 'POST', url: '/api/v1/clips', payload: clipBody })).json();
    await app.inject({ method: 'PATCH', url: `/api/v1/clips/${clip.id}`, payload: { name: 'Edited elsewhere' } });
    const stale = await app.inject({ method: 'PATCH', url: `/api/v1/clips/${clip.id}`, payload: { name: 'Mine', rev: clip.rev } });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject(`/api/v1/clips/${clip.id}`)).json().name).toBe('Edited elsewhere');
  });

  it('does not serve one kind under another kind\'s path', async () => {
    const app = await make();
    const mark = (await app.inject({ method: 'POST', url: '/api/v1/marks', payload: { groupId: 'g1', name: 'm', t: '1' } })).json();
    expect((await app.inject(`/api/v1/clips/${mark.id}`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/clips/${mark.id}` })).statusCode).toBe(404);
  });
});

describe('caller-chosen ids', () => {
  it('uses the id it is given, refuses a taken one, and refuses one of the wrong kind', async () => {
    const app = await make();
    const mk = (id: string) => app.inject({ method: 'POST', url: '/api/v1/marks', payload: { id, groupId: 'g1', name: 'm', t: '1', utcMs: 1800000000000 } });
    const first = await mk('mark:abc-123');
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ id: 'mark:abc-123', utcMs: 1800000000000 });
    expect((await mk('mark:abc-123')).statusCode).toBe(409);
    expect((await mk('clip:abc-123')).statusCode).toBe(400);
  });
});

describe('playlists', () => {
  it('holds clips in order and refuses a clip that does not exist', async () => {
    const app = await make();
    const a = (await app.inject({ method: 'POST', url: '/api/v1/clips', payload: clipBody })).json();
    const b = (await app.inject({ method: 'POST', url: '/api/v1/clips', payload: { ...clipBody, name: 'Save' } })).json();
    const ok = await app.inject({ method: 'POST', url: '/api/v1/playlists', payload: { name: 'Highlights', items: [{ clipId: b.id }, { clipId: a.id, speed: 0.5 }] } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().items).toEqual([{ clipId: b.id, speed: 1 }, { clipId: a.id, speed: 0.5 }]);
    const missing = await app.inject({ method: 'POST', url: '/api/v1/playlists', payload: { name: 'Bad', items: [{ clipId: 'clip:nope' }] } });
    expect(missing.statusCode).toBe(400);
  });

  it('reorders by patching the items', async () => {
    const app = await make();
    const a = (await app.inject({ method: 'POST', url: '/api/v1/clips', payload: clipBody })).json();
    const b = (await app.inject({ method: 'POST', url: '/api/v1/clips', payload: clipBody })).json();
    const pl = (await app.inject({ method: 'POST', url: '/api/v1/playlists', payload: { name: 'P', items: [{ clipId: a.id }, { clipId: b.id }] } })).json();
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/playlists/${pl.id}`, payload: { items: [{ clipId: b.id }, { clipId: a.id }] } });
    expect(res.json().items.map((i: { clipId: string }) => i.clipId)).toEqual([b.id, a.id]);
  });

  it('drops a deleted clip from the playlists that held it', async () => {
    const app = await make();
    const a = (await app.inject({ method: 'POST', url: '/api/v1/clips', payload: clipBody })).json();
    const b = (await app.inject({ method: 'POST', url: '/api/v1/clips', payload: clipBody })).json();
    const pl = (await app.inject({ method: 'POST', url: '/api/v1/playlists', payload: { name: 'P', items: [{ clipId: a.id }, { clipId: b.id }] } })).json();
    await app.inject({ method: 'DELETE', url: `/api/v1/clips/${a.id}` });
    const after = (await app.inject(`/api/v1/playlists/${pl.id}`)).json();
    expect(after.items.map((i: { clipId: string }) => i.clipId)).toEqual([b.id]);
  });
});
