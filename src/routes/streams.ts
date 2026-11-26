import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { listStreams } from '../lib/streams.js';
import type { Services } from '../services.js';

const streamSchema = z.object({
  id: z.string(),
  label: z.string(),
  tags: z.record(z.string()),
  format: z.string(),
  hasAudio: z.boolean(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  lagMs: z.number(),
});

export async function streamRoutes(app: FastifyInstance, opts: { services: Services }) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const error = z.object({ error: z.string() });

  r.get('/streams', {
    schema: {
      tags: ['store'],
      description: 'The recorded streams in the TAMS store: every flow that has segments, with its tags and extent.',
      response: { 200: z.array(streamSchema), 502: error, 503: error },
    },
  }, async (_req, reply) => {
    const { tams } = opts.services;
    if (!tams) return reply.code(503).send({ error: 'Set TAMS_GATEWAY_URL and OSC_ACCESS_TOKEN to read a TAMS store.' });
    try {
      return await listStreams(tams);
    } catch (err) {
      return reply.code(502).send({ error: `The store could not be read: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}
