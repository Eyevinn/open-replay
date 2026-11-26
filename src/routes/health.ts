import type { FastifyInstance } from 'fastify';
import { pingDb, type Db } from '../db/index.js';

export async function healthRoutes(app: FastifyInstance, opts: { db: Db }) {
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    const ok = await pingDb(opts.db);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'database unavailable' });
  });
}
