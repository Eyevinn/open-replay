import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isConflict, isNotFound, type Db } from '../db/index.js';
import { replayInput, replayPatch, replaySchema, type Replay, type ReplayDoc } from '../db/types.js';

function toReplay(doc: ReplayDoc): Replay {
  const { _id, _rev, type: _type, ...rest } = doc;
  return { ...rest, id: _id, rev: _rev ?? '' };
}

function checkRange(inTai: string, outTai: string): boolean {
  return BigInt(outTai) > BigInt(inTai);
}

export async function replayRoutes(app: FastifyInstance, opts: { db: Db }) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { docs } = opts.db;
  const idParams = z.object({ id: z.string().min(1) });
  const error = z.object({ error: z.string() });

  r.get('/replays', {
    schema: {
      tags: ['replays'],
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      response: { 200: z.array(replaySchema) },
    },
  }, async (req) => {
    const res = await docs.find({
      selector: { type: 'replay', createdAt: { $gt: null } },
      sort: [{ type: 'desc' }, { createdAt: 'desc' }],
      limit: req.query.limit,
    });
    return res.docs.map(toReplay);
  });

  r.post('/replays', {
    schema: { tags: ['replays'], body: replayInput, response: { 201: replaySchema, 400: error } },
  }, async (req, reply) => {
    if (!checkRange(req.body.inTai, req.body.outTai)) {
      return reply.code(400).send({ error: 'outTai must be after inTai' });
    }
    const now = new Date().toISOString();
    const doc: ReplayDoc = { ...req.body, _id: `replay:${randomUUID()}`, type: 'replay', createdAt: now, updatedAt: now };
    const res = await docs.insert(doc);
    return reply.code(201).send(toReplay({ ...doc, _rev: res.rev }));
  });

  r.get('/replays/:id', {
    schema: { tags: ['replays'], params: idParams, response: { 200: replaySchema, 404: error } },
  }, async (req, reply) => {
    try {
      return toReplay(await docs.get(req.params.id));
    } catch (err) {
      if (isNotFound(err)) return reply.code(404).send({ error: 'not found' });
      throw err;
    }
  });

  r.patch('/replays/:id', {
    schema: {
      tags: ['replays'], params: idParams, body: replayPatch,
      response: { 200: replaySchema, 400: error, 404: error, 409: error },
    },
  }, async (req, reply) => {
    try {
      const cur = await docs.get(req.params.id);
      const next: ReplayDoc = { ...cur, ...req.body, updatedAt: new Date().toISOString() };
      if (!checkRange(next.inTai, next.outTai)) return reply.code(400).send({ error: 'outTai must be after inTai' });
      const res = await docs.insert(next);
      return toReplay({ ...next, _rev: res.rev });
    } catch (err) {
      if (isNotFound(err)) return reply.code(404).send({ error: 'not found' });
      if (isConflict(err)) return reply.code(409).send({ error: 'conflict, retry' });
      throw err;
    }
  });

  r.delete('/replays/:id', {
    schema: { tags: ['replays'], params: idParams, response: { 204: z.null(), 404: error, 409: error } },
  }, async (req, reply) => {
    try {
      const cur = await docs.get(req.params.id);
      await docs.destroy(cur._id, cur._rev!);
      return reply.code(204).send(null);
    } catch (err) {
      if (isNotFound(err)) return reply.code(404).send({ error: 'not found' });
      if (isConflict(err)) return reply.code(409).send({ error: 'conflict, retry' });
      throw err;
    }
  });
}
