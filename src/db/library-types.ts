import { z } from 'zod';
import { taiNs } from './types.js';

/**
 * The library: what an operator keeps between replays. Marks, clips and playlists.
 *
 * - A mark is a moment on a group's timeline. `t` is on the group's axis (the same axis as
 *   Strom's replay API), in nanoseconds as a decimal string.
 * - A clip belongs to a group and has a server-given `number` and a list of `tags`. It has no speed:
 *   a single clip plays at the speed the caller sends, and a playlist entry keeps its own.
 * - A clip is a range on the group's axis (`inT`/`outT`, the same axis as Strom's replay API) with a
 *   default camera, `streamId`. Strom keeps one sync offset per camera and applies it to every player
 *   that shows it, so a clip needs no offset of its own and stays in sync if the offsets are trimmed.
 *   Another camera can be cued at the same range.
 * - A playlist is an ordered list of clips with a speed per item.
 *
 * Nothing here copies media. All three point into the recording.
 */

const name = z.string().min(1).max(200);
const groupId = z.string().min(1).max(100);
const tagName = z.string().trim().min(1).max(50);
/** A clip's tags: a list of words, each once. */
const tagList = z.array(tagName).max(50).transform((l) => [...new Set(l)]);
/** Wall-clock time of the moment (milliseconds since the epoch, UTC), kept for showing it to a person. The exact time is `t` or `inT`. */
const utcMs = z.number().finite().nonnegative().optional();
/** A caller may choose the id (`<kind>:<letters, digits, dashes>`) so it can show the item before the server answers. A taken id is a conflict. */
const idFor = (kind: string) => z.string().regex(new RegExp(`^${kind}:[A-Za-z0-9-]{1,80}$`), `${kind}:<letters, digits, dashes>`).optional();

export const markInput = z.object({
  id: idFor('mark'),
  groupId,
  t: taiNs,
  utcMs,
});

export const clipInput = z.object({
  id: idFor('clip'),
  groupId,
  name,
  /** The default camera: the stream (Open Replay source) the clip plays from. */
  streamId: z.string().min(1).max(100),
  /** The range on the group's axis, nanoseconds as decimal strings. */
  inT: taiNs,
  outT: taiNs,
  /** Wall-clock time of the in point, for display. */
  utcMs,
  tags: tagList.default([]),
  notes: z.string().max(2000).optional(),
});

export const playlistItem = z.object({
  clipId: z.string().min(1),
  speed: z.number().gt(0).lte(1).default(1),
});

export const playlistInput = z.object({
  id: idFor('playlist'),
  name,
  /** Set when the playlist belongs to one group's session; otherwise it is shared. */
  groupId: groupId.optional(),
  items: z.array(playlistItem).max(500).default([]),
  /** What happens after the last item: hold the last frame, play the list again, or go live. */
  endAction: z.enum(['freeze', 'loop', 'live']).default('freeze'),
});

/** A patch may carry the `rev` it was read at; a mismatch is a conflict instead of a silent overwrite. */
const withRev = { rev: z.string().optional() };
export const markPatch = markInput.omit({ id: true }).partial().extend(withRev);
/** A clip's number is per group, so its group can't change. */
export const clipPatch = clipInput.omit({ id: true, groupId: true }).partial().extend(withRev);
export const playlistPatch = playlistInput.omit({ id: true }).partial().extend(withRev);

const stored = { id: z.string(), rev: z.string(), createdAt: z.string(), updatedAt: z.string() };
export const markSchema = markInput.omit({ id: true }).extend(stored);
/** `number` is given by the server: a running number per group, never reused. */
export const clipSchema = clipInput.omit({ id: true }).extend({ number: z.number().int().positive(), ...stored });

export const tagNameSchema = tagName;
export const tagSchema = z.object({ name: tagName, count: z.number().int().nonnegative() });
export const playlistSchema = playlistInput.omit({ id: true }).extend(stored);

export type Mark = z.infer<typeof markSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type Playlist = z.infer<typeof playlistSchema>;

export type LibraryKind = 'mark' | 'clip' | 'playlist';

/** Bookkeeping documents of a group: the clip counter and the stored tag list. */
export const counterId = (groupId: string) => `counter:clip:${groupId}`;
export const tagListId = (groupId: string) => `taglist:${groupId}`;

/** The stored CouchDB document: the API shape without `id`/`rev`, plus CouchDB's own fields. */
export type LibraryDoc<T> = Omit<T, 'id' | 'rev'> & {
  _id: string;
  _rev?: string;
  type: LibraryKind;
};
