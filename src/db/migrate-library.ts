import type { DocumentScope } from 'nano';
import { counterId, defaultAudioTracks } from './library-types.js';

type Doc = Record<string, unknown> & { _id: string; _rev?: string };

/**
 * Brings records saved in the first library shape to the current one (ADR-0004 in the dev team repo):
 * a mark loses `name` and `tag`; a clip loses `speed`, `starred` and the single `tag`, gets `tags` (the old
 * tag, if any) and a per-group `number` (in order of creation), and the group's counter is set past the highest.
 * A playlist gets `groupId` (the group of its first clip that still exists; a playlist with none is dropped, as
 * it is empty or names only deleted clips), `autoPlay` false, and its entries get the default audio tracks.
 * Safe to run on every start: a record already in the new shape is left alone.
 */
export async function migrateLibrary(docs: DocumentScope<any>): Promise<{ marks: number; clips: number; playlists: number }> {
  const find = async (type: string): Promise<Doc[]> =>
    (await docs.find({ selector: { type, createdAt: { $gt: null } }, limit: 1_000_000 })).docs as Doc[];
  const done = { marks: 0, clips: 0, playlists: 0 };

  for (const m of await find('mark')) {
    if (!('name' in m) && !('tag' in m)) continue;
    const { name: _name, tag: _tag, ...rest } = m;
    await docs.insert(rest);
    done.marks++;
  }

  const clips = (await find('clip')).sort((a, b) => String(a['createdAt']).localeCompare(String(b['createdAt'])));
  const next = new Map<string, number>();
  const highest = (g: string) => next.get(g) ?? 0;
  for (const c of clips) {
    if (typeof c['number'] === 'number') next.set(String(c['groupId']), Math.max(highest(String(c['groupId'])), c['number'] as number));
  }
  for (const c of clips) {
    const old = 'speed' in c || 'starred' in c || 'tag' in c || typeof c['number'] !== 'number' || !Array.isArray(c['tags']);
    if (!old) continue;
    const g = String(c['groupId']);
    const { speed: _s, starred: _st, tag, ...rest } = c;
    const number = typeof c['number'] === 'number' ? (c['number'] as number) : highest(g) + 1;
    next.set(g, Math.max(highest(g), number));
    const tags = Array.isArray(c['tags']) ? (c['tags'] as string[]) : typeof tag === 'string' && tag ? [tag] : [];
    await docs.insert({ ...rest, number, tags });
    done.clips++;
  }

  const groupOfClip = new Map(clips.map((c) => [c._id, String(c['groupId'])]));
  for (const p of await find('playlist')) {
    const items = Array.isArray(p['items']) ? (p['items'] as Record<string, unknown>[]) : [];
    const current = typeof p['groupId'] === 'string' && typeof p['autoPlay'] === 'boolean' && items.every((i) => Array.isArray(i['audioTracks']));
    if (current) continue;
    const groupId = typeof p['groupId'] === 'string' ? p['groupId'] : items.map((i) => groupOfClip.get(String(i['clipId']))).find((g) => g !== undefined);
    if (!groupId) {
      await docs.destroy(p._id, p._rev!);
    } else {
      await docs.insert({
        ...p, groupId, autoPlay: p['autoPlay'] === true,
        items: items.map((i) => ({ ...i, speed: typeof i['speed'] === 'number' ? i['speed'] : 1, audioTracks: Array.isArray(i['audioTracks']) ? i['audioTracks'] : defaultAudioTracks })),
      });
    }
    done.playlists++;
  }

  for (const [g, n] of next) {
    let cur: Doc | undefined;
    try {
      cur = (await docs.get(counterId(g))) as Doc;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
    if (cur && Number(cur['n']) >= n) continue;
    await docs.insert({ ...(cur ?? { _id: counterId(g) }), n, type: 'counter' });
  }
  return done;
}
