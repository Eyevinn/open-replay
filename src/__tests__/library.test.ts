import { describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { migrateLibrary } from '../db/migrate-library.js';
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
const clipBody = { groupId: 'g1', name: 'Goal', streamId: 'cam-1', inT: '1800000000000000000', outT: '1800000008000000000' };

describe('marks', () => {
  it('keeps the exact time as a string and filters by group', async () => {
    const app = await make();
    const t = '1800000000123456789';
    const res = await app.inject({ method: 'POST', url: '/api/v1/marks', payload: { groupId: 'g1', t, name: 'ignored', tag: 'ignored' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().t).toBe(t);
    await app.inject({ method: 'POST', url: '/api/v1/marks', payload: { groupId: 'g2', t } });
    const list = await app.inject('/api/v1/marks?groupId=g1');
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toEqual({ id: res.json().id, rev: res.json().rev, groupId: 'g1', t, createdAt: res.json().createdAt, updatedAt: res.json().updatedAt });
    expect(res.json()).not.toHaveProperty('name');
    expect(res.json()).not.toHaveProperty('tag');
  });

  it('rejects a time that is not a decimal string', async () => {
    const app = await make();
    const res = await app.inject({ method: 'POST', url: '/api/v1/marks', payload: { groupId: 'g1', t: 1.8e18 } });
    expect(res.statusCode).toBe(400);
  });
});

describe('clips', () => {
  it('creates with defaults, patches and deletes', async () => {
    const app = await make();
    const created = await app.inject({ method: 'POST', url: '/api/v1/clips', payload: { ...clipBody, speed: 0.5, starred: true, tag: 'x' } });
    expect(created.statusCode).toBe(201);
    const clip = created.json();
    expect(clip).toMatchObject({ number: 1, tags: [] });
    for (const k of ['speed', 'starred', 'tag']) expect(clip).not.toHaveProperty(k);
    const patched = await app.inject({ method: 'PATCH', url: `/api/v1/clips/${clip.id}`, payload: { tags: ['goal', 'goal', 'home'], number: 99, groupId: 'g9' } });
    expect(patched.json()).toMatchObject({ number: 1, groupId: 'g1', tags: ['goal', 'home'], inT: clipBody.inT });
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
    const mark = (await app.inject({ method: 'POST', url: '/api/v1/marks', payload: { groupId: 'g1', t: '1' } })).json();
    expect((await app.inject(`/api/v1/clips/${mark.id}`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/clips/${mark.id}` })).statusCode).toBe(404);
  });
});

describe('clip numbers', () => {
  const mk = async (app: Awaited<ReturnType<typeof make>>, groupId: string) =>
    (await app.inject({ method: 'POST', url: '/api/v1/clips', payload: { ...clipBody, groupId } })).json();

  it('counts per group and never reuses a number after a delete', async () => {
    const app = await make();
    const a = await mk(app, 'g1');
    const b = await mk(app, 'g1');
    const other = await mk(app, 'g2');
    expect([a.number, b.number, other.number]).toEqual([1, 2, 1]);
    await app.inject({ method: 'DELETE', url: `/api/v1/clips/${b.id}` });
    expect((await mk(app, 'g1')).number).toBe(3);
  });

  it('gives concurrent creates different numbers', async () => {
    const app = await make();
    const made = await Promise.all(Array.from({ length: 8 }, () => mk(app, 'g1')));
    expect(made.map((c) => c.number).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('tags of a group', () => {
  const tagsUrl = (g = 'g1', name?: string) => `/api/v1/groups/${g}/tags${name ? `/${encodeURIComponent(name)}` : ''}`;
  const clip = async (app: Awaited<ReturnType<typeof make>>, tags: string[], groupId = 'g1') =>
    (await app.inject({ method: 'POST', url: '/api/v1/clips', payload: { ...clipBody, groupId, tags } })).json();

  it('lists stored tags and tags clips carry, with counts', async () => {
    const app = await make();
    expect((await app.inject({ method: 'POST', url: tagsUrl(), payload: { name: 'unused' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: tagsUrl(), payload: { name: 'unused' } })).statusCode).toBe(409);
    await clip(app, ['goal', 'home']);
    await clip(app, ['goal']);
    await clip(app, ['other-group'], 'g2');
    expect((await app.inject(tagsUrl())).json()).toEqual([{ name: 'goal', count: 2 }, { name: 'home', count: 1 }, { name: 'unused', count: 0 }]);
    expect((await app.inject({ method: 'POST', url: tagsUrl(), payload: { name: 'goal' } })).statusCode).toBe(409);
  });

  it('renames a tag on every clip of the group only', async () => {
    const app = await make();
    const a = await clip(app, ['goal', 'home']);
    const b = await clip(app, ['goal']);
    const o = await clip(app, ['goal'], 'g2');
    await app.inject({ method: 'POST', url: tagsUrl(), payload: { name: 'goal' } });
    const res = await app.inject({ method: 'PATCH', url: tagsUrl('g1', 'goal'), payload: { name: 'score' } });
    expect(res.json()).toEqual({ name: 'score', count: 2 });
    expect((await app.inject(`/api/v1/clips/${a.id}`)).json().tags).toEqual(['score', 'home']);
    expect((await app.inject(`/api/v1/clips/${b.id}`)).json().tags).toEqual(['score']);
    expect((await app.inject(`/api/v1/clips/${o.id}`)).json().tags).toEqual(['goal']);
    expect((await app.inject(tagsUrl())).json().map((t: { name: string }) => t.name)).toEqual(['home', 'score']);
    expect((await app.inject({ method: 'PATCH', url: tagsUrl('g1', 'nope'), payload: { name: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: tagsUrl('g1', 'score'), payload: { name: 'home' } })).statusCode).toBe(409);
  });

  it('deletes a tag from every clip and from the list', async () => {
    const app = await make();
    const a = await clip(app, ['goal', 'home']);
    await app.inject({ method: 'POST', url: tagsUrl(), payload: { name: 'goal' } });
    expect((await app.inject({ method: 'DELETE', url: tagsUrl('g1', 'goal') })).statusCode).toBe(204);
    expect((await app.inject(`/api/v1/clips/${a.id}`)).json().tags).toEqual(['home']);
    expect((await app.inject(tagsUrl())).json()).toEqual([{ name: 'home', count: 1 }]);
    expect((await app.inject({ method: 'DELETE', url: tagsUrl('g1', 'goal') })).statusCode).toBe(404);
  });
});

describe('records saved in the first shape', () => {
  it('are migrated: tag becomes tags, numbers follow creation order, speed and star go', async () => {
    const db = fakeDb();
    const put = (d: Record<string, unknown>) => db.docs.insert(d as never);
    const base = { type: 'clip', groupId: 'g1', name: 'c', streamId: 'cam-1', inT: '1', outT: '2', speed: 0.5, starred: true };
    await put({ ...base, _id: 'clip:b', createdAt: '2026-01-02T00:00:00Z', updatedAt: 'x', tag: 'goal' });
    await put({ ...base, _id: 'clip:a', createdAt: '2026-01-01T00:00:00Z', updatedAt: 'x', tag: null });
    await put({ type: 'mark', _id: 'mark:m', groupId: 'g1', name: 'Offside', t: '5', tag: 'foul', createdAt: '2026-01-01T00:00:00Z', updatedAt: 'x' });
    expect(await migrateLibrary(db.docs)).toEqual({ marks: 1, clips: 2 });
    const app = await buildServer({ apiKey: undefined, corsOrigin: undefined, logLevel: 'silent' }, db);
    const a = (await app.inject('/api/v1/clips/clip:a')).json();
    const b = (await app.inject('/api/v1/clips/clip:b')).json();
    expect([a.number, a.tags, b.number, b.tags]).toEqual([1, [], 2, ['goal']]);
    expect(b).not.toHaveProperty('speed');
    expect((await app.inject('/api/v1/marks/mark:m')).json()).not.toHaveProperty('name');
    expect((await app.inject({ method: 'POST', url: '/api/v1/clips', payload: clipBody })).json().number).toBe(3);
    expect(await migrateLibrary(db.docs)).toEqual({ marks: 0, clips: 0 });
  });
});

describe('caller-chosen ids', () => {
  it('uses the id it is given, refuses a taken one, and refuses one of the wrong kind', async () => {
    const app = await make();
    const mk = (id: string) => app.inject({ method: 'POST', url: '/api/v1/marks', payload: { id, groupId: 'g1', t: '1', utcMs: 1800000000000 } });
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
