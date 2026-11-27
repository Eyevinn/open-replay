import { timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform, serializerCompiler, validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { healthRoutes } from './routes/health.js';
import { libraryRoutes } from './routes/library.js';
import { playlistPlayRoutes } from './routes/playlist-play.js';
import { playbackRoutes, STROM_PROXY_PREFIX } from './routes/playback.js';
import { replayRoutes } from './routes/replays.js';
import { streamRoutes } from './routes/streams.js';
import type { Services } from './services.js';
import httpProxy from '@fastify/http-proxy';

function keyMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function buildServer(config: Pick<Config, 'apiKey' | 'corsOrigin' | 'logLevel'>, db: Db, services: Services = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel } });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet);
  await app.register(cors, { origin: config.corsOrigin ?? false });
  await app.register(swagger, {
    openapi: { info: { title: 'Open Replay API', version: '0.1.0' } },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(healthRoutes, { db });

  await app.register(async (v1) => {
    if (config.apiKey) {
      const expected = config.apiKey;
      v1.addHook('onRequest', async (req, reply) => {
        const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
        const header = req.headers['x-api-key'];
        if (!keyMatches(bearer, expected) && !keyMatches(typeof header === 'string' ? header : undefined, expected)) {
          return reply.code(401).send({ error: 'unauthorized' });
        }
      });
    }
    await v1.register(replayRoutes, { db });
    await v1.register(libraryRoutes, { db });
    await v1.register(streamRoutes, { services });
    await v1.register(playbackRoutes, { services });
    await v1.register(playlistPlayRoutes, { db, services });
    // Strom for the browser: the operator screen's WebSocket and WHEP video go through here, so the key stays on this side.
    if (services.strom) {
      await v1.register(httpProxy, {
        upstream: services.strom.url,
        prefix: STROM_PROXY_PREFIX.replace('/api/v1', ''),
        rewritePrefix: '',
        websocket: true,
        replyOptions: {
          // The caller's own credentials are for this API, not for Strom.
          rewriteRequestHeaders: (_req, { authorization: _own, ...headers }) => ({ ...headers, ...services.strom!.authHeaders }),
        },
        wsClientOptions: { headers: services.strom.authHeaders },
      });
    }
  }, { prefix: '/api/v1' });

  return app;
}
