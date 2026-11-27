import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { DocumentScope, MangoSelector } from 'nano';
import { z } from 'zod';
import { isConflict, isNotFound, type Db } from '../db/index.js';
import {
  clipInput, clipPatch, clipSchema, counterId, tagListId, tagNameSchema, tagSchema, markInput, markPatch, markSchema,
  playlistInput, playlistPatch, playlistSchema,
  type LibraryDoc, type LibraryKind,
} from '../db/library-types.js';

type Doc = LibraryDoc<Record<string, unknown>>;

/** `message` carries the detail of a failed validation, which would otherwise be cut from the reply. */
const error = z.object({ error: z.string(), message: z.string().optional() });
const idParams = z.object({ id: z.string().min(1) });

function toApi(doc: Doc): Record<string, unknown> {
  const { _id, _rev, type: _type, ...rest } = doc;
  return { ...rest, id: _id, rev: _rev ?? '' };
}

/** Checks a body against the rules a schema can't express. Returns an error message, or null when fine. */
type Check = (next: Record<string, unknown>) => Promise<string | null> | string | null;

interface Resource {
  kind: LibraryKind;
  path: string;
  input: z.ZodTypeAny;
  patch: z.ZodTypeAny;
  output: z.ZodTypeAny;
  /** Query filters that map to document fields, for example `groupId`. */
  filters: string[];
  check?: Check;
  /** Adds server-given fields to a new document, before it is stored. */
  beforeInsert?: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Runs after a delete, to keep other documents consistent. */
  afterDelete?: (id: string) => Promise<void>;
}

export async function libraryRoutes(app: FastifyInstance, opts: { db: Db }) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const docs = opts.db.docs as unknown as DocumentScope<Doc>;

  const rangeCheck: Check = (b) =>
    BigInt(b['outT'] as string) > BigInt(b['inT'] as string) ? null : 'outT must be after inT';

  /** A playlist can only hold clips that exist. */
  const itemsCheck: Check = async (b) => {
    const ids = [...new Set((b['items'] as { clipId: string }[]).map((i) => i.clipId))];
    for (const id of ids) {
      try {
        const clip = await docs.get(id);
        if (clip.type !== 'clip') return `${id} is not a clip`;
      } catch (err) {
        if (isNotFound(err)) return `clip ${id} does not exist`;
        throw err;
      }
    }
    return null;
  };

  /** Deleting a clip takes it out of every playlist that held it. */
  const dropClipFromPlaylists = async (clipId: string) => {
    const res = await docs.find({ selector: { type: 'playlist', createdAt: { $gt: null } }, limit: 1000 });
    for (const p of res.docs) {
      const items = (p['items'] as { clipId: string }[]) ?? [];
      if (!items.some((i) => i.clipId === clipId)) continue;
      try {
        await docs.insert({ ...p, items: items.filter((i) => i.clipId !== clipId), updatedAt: new Date().toISOString() });
      } catch (err) {
        if (!isConflict(err)) throw err; // someone else edited it; their copy is newer, so skip
      }
    }
  };

  /** The next clip number of a group. A counter document per group; a 409 means another create got in first, so retry. A delete never lowers it. */
  const nextClipNumber = async (groupId: string): Promise<number> => {
    for (let attempt = 0; attempt < 50; attempt++) {
      let cur: Doc | undefined;
      try {
        cur = await docs.get(counterId(groupId));
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      const n = (cur ? Number(cur['n']) : 0) + 1;
      try {
        await docs.insert({ ...(cur ?? { _id: counterId(groupId) }), n, type: 'counter' } as unknown as Doc);
        return n;
      } catch (err) {
        if (!isConflict(err)) throw err;
      }
    }
    throw new Error('could not number the clip, too many concurrent creates');
  };

  const resources: Resource[] = [
    { kind: 'mark', path: '/marks', input: markInput, patch: markPatch, output: markSchema, filters: ['groupId'] },
    { kind: 'clip', path: '/clips', input: clipInput, patch: clipPatch, output: clipSchema, filters: ['groupId', 'streamId'], check: rangeCheck,
      beforeInsert: async (b) => ({ ...b, number: await nextClipNumber(b['groupId'] as string) }), afterDelete: dropClipFromPlaylists },
    { kind: 'playlist', path: '/playlists', input: playlistInput, patch: playlistPatch, output: playlistSchema, filters: ['groupId'], check: itemsCheck },
  ];

  // ---- tags of a group ----

  const tagParams = z.object({ groupId: z.string().min(1).max(100), name: z.string().min(1).max(50) });
  const groupParams = z.object({ groupId: z.string().min(1).max(100) });

  const clipsOf = async (groupId: string): Promise<Doc[]> =>
    (await docs.find({ selector: { type: 'clip', groupId, createdAt: { $gt: null } }, limit: 100000 })).docs;
  const storedTags = async (groupId: string): Promise<{ doc?: Doc; names: string[] }> => {
    try {
      const doc = await docs.get(tagListId(groupId));
      return { doc, names: (doc['names'] as string[]) ?? [] };
    } catch (err) {
      if (isNotFound(err)) return { names: [] };
      throw err;
    }
  };
  const saveTags = async (groupId: string, cur: Doc | undefined, names: string[]) =>
    docs.insert({ ...(cur ?? { _id: tagListId(groupId) }), names, type: 'taglist' } as unknown as Doc);
  /** The stored names plus any tag a clip carries, with the number of clips for each. Counted here, not by the database. */
  const tagsOf = async (groupId: string) => {
    const counts = new Map<string, number>();
    for (const n of (await storedTags(groupId)).names) counts.set(n, 0);
    for (const c of await clipsOf(groupId)) {
      for (const t of new Set((c['tags'] as string[] | undefined) ?? [])) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  };
  /** Rewrites the tags of every clip that carries `from`: to `to`, or just removed when `to` is null. */
  const retag = (tags: string[], from: string, to: string | null) =>
    [...new Set(tags.flatMap((t) => (t === from ? (to === null ? [] : [to]) : [t])))];
  const retagClips = async (groupId: string, from: string, to: string | null) => {
    for (const listed of await clipsOf(groupId)) {
      let c: Doc = listed;
      for (let attempt = 0; attempt < 5; attempt++) {
        const tags = (c['tags'] as string[] | undefined) ?? [];
        if (!tags.includes(from)) break;
        try {
          await docs.insert({ ...c, tags: retag(tags, from, to), updatedAt: new Date().toISOString() });
          break;
        } catch (err) {
          if (!isConflict(err) || attempt === 4) throw err;
          c = await docs.get(c._id); // edited meanwhile: work from the newer copy
        }
      }
    }
  };

  r.get('/groups/:groupId/tags', {
    schema: { tags: ['library'], params: groupParams, response: { 200: z.array(tagSchema) } },
  }, async (req) => tagsOf(req.params.groupId));

  r.post('/groups/:groupId/tags', {
    schema: { tags: ['library'], params: groupParams, body: z.object({ name: tagNameSchema }), response: { 201: tagSchema, 409: error } },
  }, async (req, reply) => {
    const { groupId } = req.params;
    const { name } = req.body;
    if ((await tagsOf(groupId)).some((t) => t.name === name)) return reply.code(409).send({ error: 'that tag exists' });
    for (let attempt = 0; attempt < 5; attempt++) {
      const { doc, names } = await storedTags(groupId);
      try {
        await saveTags(groupId, doc, [...names, name]);
        return reply.code(201).send({ name, count: 0 });
      } catch (err) {
        if (!isConflict(err)) throw err;
      }
    }
    return reply.code(409).send({ error: 'conflict, retry' });
  });

  r.patch('/groups/:groupId/tags/:name', {
    schema: { tags: ['library'], params: tagParams, body: z.object({ name: tagNameSchema }), response: { 200: tagSchema, 404: error, 409: error } },
  }, async (req, reply) => {
    const { groupId, name: from } = req.params;
    const to = req.body.name;
    const all = await tagsOf(groupId);
    const cur = all.find((t) => t.name === from);
    if (!cur) return reply.code(404).send({ error: 'no such tag' });
    if (to === from) return cur;
    if (all.some((t) => t.name === to)) return reply.code(409).send({ error: 'a tag with that name exists' });
    for (let attempt = 0; attempt < 5; attempt++) {
      const { doc, names } = await storedTags(groupId);
      try {
        await saveTags(groupId, doc, names.map((n) => (n === from ? to : n)));
        break;
      } catch (err) {
        if (!isConflict(err) || attempt === 4) throw err;
      }
    }
    await retagClips(groupId, from, to);
    return { name: to, count: cur.count };
  });

  r.delete('/groups/:groupId/tags/:name', {
    schema: { tags: ['library'], params: tagParams, response: { 204: z.null(), 404: error, 409: error } },
  }, async (req, reply) => {
    const { groupId, name } = req.params;
    if (!(await tagsOf(groupId)).some((t) => t.name === name)) return reply.code(404).send({ error: 'no such tag' });
    for (let attempt = 0; attempt < 5; attempt++) {
      const { doc, names } = await storedTags(groupId);
      if (!doc) break;
      try {
        await saveTags(groupId, doc, names.filter((n) => n !== name));
        break;
      } catch (err) {
        if (!isConflict(err) || attempt === 4) throw err;
      }
    }
    await retagClips(groupId, name, null);
    return reply.code(204).send(null);
  });

  const bad = (reply: FastifyReply, message: string) => reply.code(400).send({ error: message });

  for (const res of resources) {
    const tags = ['library'];
    const filterShape = Object.fromEntries(res.filters.map((f) => [f, z.string().optional()]));

    r.get(res.path, {
      schema: {
        tags,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200), ...filterShape }),
        response: { 200: z.array(res.output) },
      },
    }, async (req) => {
      const { limit, ...filters } = req.query as Record<string, string | number | undefined>;
      const selector: MangoSelector = { type: res.kind, createdAt: { $gt: null } };
      for (const f of res.filters) {
        const v = filters[f];
        if (v !== undefined) selector[f] = v;
      }
      const found = await docs.find({ selector, sort: [{ type: 'desc' }, { createdAt: 'desc' }], limit: limit as number });
      return found.docs.map(toApi);
    });

    r.post(res.path, {
      schema: { tags, body: res.input, response: { 201: res.output, 400: error, 409: error } },
    }, async (req, reply) => {
      const { id, ...body } = req.body as Record<string, unknown> & { id?: string };
      const problem = await res.check?.(body);
      if (problem) return bad(reply, problem);
      const now = new Date().toISOString();
      const full = (await res.beforeInsert?.(body)) ?? body;
      const doc = { ...full, _id: id ?? `${res.kind}:${randomUUID()}`, type: res.kind, createdAt: now, updatedAt: now } as Doc;
      try {
        const saved = await docs.insert(doc);
        return reply.code(201).send(toApi({ ...doc, _rev: saved.rev }));
      } catch (err) {
        if (isConflict(err)) return reply.code(409).send({ error: 'that id is taken' });
        throw err;
      }
    });

    r.get(`${res.path}/:id`, {
      schema: { tags, params: idParams, response: { 200: res.output, 404: error } },
    }, async (req, reply) => {
      try {
        const doc = await docs.get(req.params.id);
        if (doc.type !== res.kind) return reply.code(404).send({ error: 'not found' });
        return toApi(doc);
      } catch (err) {
        if (isNotFound(err)) return reply.code(404).send({ error: 'not found' });
        throw err;
      }
    });

    r.patch(`${res.path}/:id`, {
      schema: { tags, params: idParams, body: res.patch, response: { 200: res.output, 400: error, 404: error, 409: error } },
    }, async (req, reply) => {
      const { rev, ...patch } = req.body as Record<string, unknown> & { rev?: string };
      try {
        const cur = await docs.get(req.params.id);
        if (cur.type !== res.kind) return reply.code(404).send({ error: 'not found' });
        if (rev !== undefined && rev !== cur._rev) return reply.code(409).send({ error: 'changed since it was read, reload and retry' });
        const next = { ...cur, ...patch, updatedAt: new Date().toISOString() } as Doc;
        const problem = await res.check?.(next);
        if (problem) return bad(reply, problem);
        const saved = await docs.insert(next);
        return toApi({ ...next, _rev: saved.rev });
      } catch (err) {
        if (isNotFound(err)) return reply.code(404).send({ error: 'not found' });
        if (isConflict(err)) return reply.code(409).send({ error: 'conflict, retry' });
        throw err;
      }
    });

    r.delete(`${res.path}/:id`, {
      schema: { tags, params: idParams, response: { 204: z.null(), 404: error, 409: error } },
    }, async (req, reply) => {
      try {
        const cur = await docs.get(req.params.id);
        if (cur.type !== res.kind) return reply.code(404).send({ error: 'not found' });
        await docs.destroy(cur._id, cur._rev!);
        await res.afterDelete?.(cur._id);
        return reply.code(204).send(null);
      } catch (err) {
        if (isNotFound(err)) return reply.code(404).send({ error: 'not found' });
        if (isConflict(err)) return reply.code(409).send({ error: 'conflict, retry' });
        throw err;
      }
    });
  }
}
