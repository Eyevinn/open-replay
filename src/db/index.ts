import nano from 'nano';
import type { DocumentScope, ServerScope } from 'nano';
import type { Config } from '../config.js';
import type { ReplayDoc } from './types.js';

export interface Db {
  server: ServerScope;
  docs: DocumentScope<ReplayDoc>;
}

export function connectDb(config: Pick<Config, 'couchdbUrl' | 'couchdbName'>): Db {
  const server = nano(config.couchdbUrl);
  return { server, docs: server.db.use<ReplayDoc>(config.couchdbName) };
}

/** Creates the database and indexes if missing. Safe to run on every start. */
export async function initDb(db: Db, name: string): Promise<void> {
  try {
    await db.server.db.create(name);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 412) throw err; // 412 = exists
  }
  await db.docs.createIndex({
    index: { fields: ['type', 'createdAt'] },
    name: 'type-createdAt',
    ddoc: 'indexes',
  });
}

export async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.server.db.get(db.docs.config.db);
    return true;
  } catch {
    return false;
  }
}

export function isNotFound(err: unknown): boolean {
  return (err as { statusCode?: number }).statusCode === 404;
}
export function isConflict(err: unknown): boolean {
  return (err as { statusCode?: number }).statusCode === 409;
}
