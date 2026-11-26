import { loadConfig } from './config.js';
import { connectDb, initDb } from './db/index.js';
import { buildServer } from './server.js';
import { buildServices } from './services.js';

async function main() {
  const config = loadConfig();
  if (!config.apiKey) {
    console.warn('[security] API_KEY is not set: all /api/v1 routes are unauthenticated.');
  }
  const db = connectDb(config);
  await initDb(db, config.couchdbName);
  const app = await buildServer(config, db, buildServices(config));
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
