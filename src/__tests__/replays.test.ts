import { describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { buildServer } from '../server.js';

/** In-memory stand-in for the nano document scope. */
function fakeDb(): Db {
  const store = new Map<string, Record<string, unknown>>();
  let rev = 0;
  const notFound = () => Object.assign(new Error('missing'), { statusCode: 404 });
  const docs = {
    config: { db: 'test' },
    insert: async (doc: Record<string, unknown>) => {
      const next = `${++rev}-x`;
      store.set(doc['_id'] as string, { ...doc, _rev: next });
      return { ok: true, id: doc['_id'], rev: next };
    },
    get: async (id: string) => {
      const d = store.get(id);
      if (!d) throw notFound();
      return d;
    },
    destroy: async (id: string) => {
      if (!store.delete(id)) throw notFound();
      return { ok: true };
    },
    find: async () => ({ docs: [...store.values()] }),
  };
  return { server: { db: { get: async () => ({}) } }, docs } as unknown as Db;
}

const body = { name: 'Goal 1', angleId: 'cam-3', inTai: '1800000000000000000', outTai: '1800000008000000000', speed: 0.5 };

describe('replays API', () => {
  it('requires the API key', async () => {
    const app = await buildServer({ apiKey: 'k', corsOrigin: undefined, logLevel: 'silent' }, fakeDb());
    expect((await app.inject('/api/v1/replays')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/replays', headers: { 'x-api-key': 'k' } })).statusCode).toBe(200);
    expect((await app.inject('/health')).statusCode).toBe(200);
  });

  it('creates, reads, patches and deletes', async () => {
    const app = await buildServer({ apiKey: undefined, corsOrigin: undefined, logLevel: 'silent' }, fakeDb());
    const created = await app.inject({ method: 'POST', url: '/api/v1/replays', payload: body });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();
    expect((await app.inject(`/api/v1/replays/${id}`)).json().name).toBe('Goal 1');
    const patched = await app.inject({ method: 'PATCH', url: `/api/v1/replays/${id}`, payload: { speed: 0.25 } });
    expect(patched.json().speed).toBe(0.25);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/replays/${id}` })).statusCode).toBe(204);
    expect((await app.inject(`/api/v1/replays/${id}`)).statusCode).toBe(404);
  });

  it('rejects an out point before the in point', async () => {
    const app = await buildServer({ apiKey: undefined, corsOrigin: undefined, logLevel: 'silent' }, fakeDb());
    const res = await app.inject({ method: 'POST', url: '/api/v1/replays', payload: { ...body, outTai: '1' } });
    expect(res.statusCode).toBe(400);
  });
});
