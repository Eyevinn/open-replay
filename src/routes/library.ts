import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { DocumentScope, MangoSelector } from 'nano';
import { z } from 'zod';
import { isConflict, isNotFound, type Db } from '../db/index.js';
import {
  clipInput, clipPatch, clipSchema, markInput, markPatch, markSchema,
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

  const resources: Resource[] = [
    { kind: 'mark', path: '/marks', input: markInput, patch: markPatch, output: markSchema, filters: ['groupId'] },
    { kind: 'clip', path: '/clips', input: clipInput, patch: clipPatch, output: clipSchema, filters: ['groupId', 'streamId'], check: rangeCheck, afterDelete: dropClipFromPlaylists },
    { kind: 'playlist', path: '/playlists', input: playlistInput, patch: playlistPatch, output: playlistSchema, filters: ['groupId'], check: itemsCheck },
  ];

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
      const doc = { ...body, _id: id ?? `${res.kind}:${randomUUID()}`, type: res.kind, createdAt: now, updatedAt: now } as Doc;
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
