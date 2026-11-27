import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { DocumentScope } from 'nano';
import { z } from 'zod';
import { isNotFound, type Db } from '../db/index.js';
import { PlaylistRunner, type EndAction, type RunnerItem, type RunnerStatus } from '../lib/playlist-runner.js';
import { readQueueFeatures, StromReplayLink } from '../lib/replay-link.js';
import { clipGroupOf, type ClipPlayer } from '../lib/replay-flow.js';
import type { StromClient } from '../lib/strom.js';
import type { Services } from '../services.js';
import { clipInputIn, flowOf, listFlows, showInPreview, type StromFlow } from './playback.js';

type Doc = Record<string, unknown> & { _id: string; type?: string };

const statusSchema = z.object({
  running: z.boolean(),
  /** `running`, `finished`, `stopped` or `failed`. Absent when nothing was started. */
  state: z.enum(['running', 'finished', 'stopped', 'failed']).optional(),
  playlistId: z.string().optional(),
  /** The item playing, from 0. */
  index: z.number().int().nullable().optional(),
  total: z.number().int().optional(),
  queued: z.number().int().optional(),
  round: z.number().int().optional(),
  /** Clips the playlist names that no longer exist; they are left out. */
  skipped: z.array(z.string()).optional(),
  error: z.string().optional(),
});
type Status = z.infer<typeof statusSchema>;

interface Entry {
  runner: PlaylistRunner;
  playlistId: string;
  skipped: string[];
}

type Found = { flow: StromFlow; flowId: string; group: string; input: number } | { status: 409 | 502; error: string };

/**
 * Play a playlist, or cue one clip, on a clip player of a group's replay flow.
 *
 * The clip players (A and B, ADR-0002) are not in the flows this API builds yet, so on today's Strom these routes
 * answer 409 "no clip player". They are built and tested against a mock of Strom's planned clip queue.
 * The runners live in memory: a restart of this API forgets them, and the player keeps playing what it has queued.
 */
export async function playlistPlayRoutes(app: FastifyInstance, opts: { db: Db; services: Services }) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const docs = opts.db.docs as unknown as DocumentScope<Doc>;
  const { strom, tams } = opts.services;
  const params = z.object({ groupId: z.string().min(1) });
  const playerQuery = z.object({ player: z.enum(['a', 'b']).default('a') });
  const error = z.object({ error: z.string() });
  const runners = new Map<string, Entry>();
  const keyOf = (groupId: string, player: string) => `${groupId}/${player}`;
  const notConfigured = 'Set STROM_URL, TAMS_GATEWAY_URL and OSC_ACCESS_TOKEN to play playlists and clips.';

  const statusOf = (e: Entry | undefined): Status => {
    if (!e) return { running: false };
    const s: RunnerStatus = e.runner.status();
    return { running: s.state === 'running', state: s.state, playlistId: e.playlistId, index: s.index, total: s.total, queued: s.queued, round: s.round, skipped: e.skipped, ...(s.error ? { error: s.error } : {}) };
  };

  /** The flow of the group's replay and the name of its clip player's group, or why there is none. */
  const clipPlayerOf = async (s: StromClient, groupId: string, player: string, needQueue: boolean): Promise<Found> => {
    const group = clipGroupOf(groupId, player as ClipPlayer);
    try {
      const flow = flowOf(await listFlows(s), groupId);
      if (!flow) return { status: 409, error: 'This group has no running replay. Start it first.' };
      // Strom says what it can do: switching a player's source in a cue, and queueing the next clip.
      const can = await readQueueFeatures(s);
      if (!can.sourceSwitch || (needQueue && !can.cueNext)) return { status: 409, error: `This Strom cannot ${needQueue ? 'queue clips' : 'switch a clip player\'s source'} yet: it does not report the ${can.sourceSwitch ? 'cue_next' : 'source_switch'} feature.` };
      const input = clipInputIn(flow, player as ClipPlayer);
      const there = input === null ? null : await s.request(`/api/replay/${flow.id}/${encodeURIComponent(group)}`);
      if (input === null || !there?.ok) return { status: 409, error: `This replay has no clip player ${player.toUpperCase()}. It was started before clip players existed: start it again.` };
      return { flow, flowId: flow.id, group, input };
    } catch (err) {
      return { status: 502, error: `Strom could not be reached: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  const getDoc = async (id: string, type: string): Promise<Doc | null> => {
    try {
      const d = await docs.get(id);
      return d.type === type ? d : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  };

  const sourceOf = (streamId: string) => `tams+https://${tams!.host}/flows/${streamId}`;
  const busy = (groupId: string, player: string) => runners.get(keyOf(groupId, player))?.runner.status().state === 'running';

  // ---- a playlist ----

  r.get('/groups/:groupId/playback/playlist', {
    schema: { tags: ['playback'], params, querystring: playerQuery, response: { 200: statusSchema } },
  }, async (req) => statusOf(runners.get(keyOf(req.params.groupId, req.query.player))));

  r.put('/groups/:groupId/playback/playlist', {
    schema: {
      tags: ['playback'], params, querystring: playerQuery,
      body: z.object({
        playlistId: z.string().min(1),
        /** Show the clip player in preview, so Take sends it to air. */
        preview: z.boolean().default(true),
      }),
      response: { 200: statusSchema, 404: error, 409: error, 502: error, 503: error },
    },
  }, async (req, reply) => {
    if (!strom || !tams) return reply.code(503).send({ error: notConfigured });
    const { groupId } = req.params;
    const { player } = req.query;
    if (busy(groupId, player)) return reply.code(409).send({ error: `Clip player ${player.toUpperCase()} is already playing a playlist. Stop it first.` });

    const playlist = await getDoc(req.body.playlistId, 'playlist');
    if (!playlist) return reply.code(404).send({ error: 'No such playlist.' });
    const found = await clipPlayerOf(strom, groupId, player, true);
    if ('error' in found) return reply.code(found.status).send({ error: found.error });

    // The clips in order. One that was deleted since is left out, and the answer says so.
    const skipped: string[] = [];
    const items: RunnerItem[] = [];
    for (const it of (playlist['items'] as { clipId: string; speed: number }[]) ?? []) {
      const clip = await getDoc(it.clipId, 'clip');
      if (!clip) {
        skipped.push(it.clipId);
        continue;
      }
      items.push({ clipId: it.clipId, name: String(clip['name']), source: sourceOf(String(clip['streamId'])), inT: String(clip['inT']), outT: String(clip['outT']), speed: it.speed });
    }
    if (items.length === 0) return reply.code(409).send({ error: 'The playlist has no clips to play.' });

    const runner = new PlaylistRunner(new StromReplayLink(strom, found.flowId, found.group), items, { endAction: (playlist['endAction'] as EndAction | undefined) ?? 'freeze' });
    try {
      await runner.start();
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
    if (req.body.preview) await showInPreview(strom, found.flow, found.input).catch(() => undefined);
    const entry = { runner, playlistId: req.body.playlistId, skipped };
    runners.set(keyOf(groupId, player), entry);
    return statusOf(entry);
  });

  r.delete('/groups/:groupId/playback/playlist', {
    schema: { tags: ['playback'], params, querystring: playerQuery, response: { 200: statusSchema } },
  }, async (req) => {
    const entry = runners.get(keyOf(req.params.groupId, req.query.player));
    await entry?.runner.stop();
    return statusOf(entry);
  });

  // ---- one clip ----

  const clipReply = z.object({ player: z.enum(['a', 'b']), clipId: z.string(), streamId: z.string(), playing: z.boolean() });

  /** Put a clip on a clip player, from its own camera or another one at the same range, held on its first frame or playing. */
  r.put('/groups/:groupId/playback/clip', {
    schema: {
      tags: ['playback'], params, querystring: z.object({ player: z.enum(['a', 'b']).default('b') }),
      body: z.object({
        clipId: z.string().min(1),
        /** Another camera of the group at the clip's range ("check another angle"). The clip's own camera when left out. */
        streamId: z.string().min(1).optional(),
        /** Play at the clip's speed at once. Otherwise it waits on its first frame. */
        play: z.boolean().default(false),
        /** Show the clip player in preview, so Take sends it to air. */
        preview: z.boolean().default(true),
      }),
      response: { 200: clipReply, 404: error, 409: error, 502: error, 503: error },
    },
  }, async (req, reply) => {
    if (!strom || !tams) return reply.code(503).send({ error: notConfigured });
    const { groupId } = req.params;
    const { player } = req.query;
    if (busy(groupId, player)) return reply.code(409).send({ error: `Clip player ${player.toUpperCase()} is playing a playlist. Stop it or use the other player.` });
    const clip = await getDoc(req.body.clipId, 'clip');
    if (!clip) return reply.code(404).send({ error: 'No such clip.' });
    const found = await clipPlayerOf(strom, groupId, player, false);
    if ('error' in found) return reply.code(found.status).send({ error: found.error });

    const streamId = req.body.streamId ?? String(clip['streamId']);
    const speed = typeof clip['speed'] === 'number' ? clip['speed'] : 1;
    const link = new StromReplayLink(strom, found.flowId, found.group);
    try {
      await link.cue({ source: sourceOf(streamId), in: String(clip['inT']), out: String(clip['outT']), speed, end_action: 'freeze', client_ref: `clip-${req.body.clipId}` });
      if (req.body.play) await link.play(speed);
      if (req.body.preview) await showInPreview(strom, found.flow, found.input);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
    return { player, clipId: req.body.clipId, streamId, playing: req.body.play };
  });

  r.delete('/groups/:groupId/playback/clip', {
    schema: {
      tags: ['playback'], params, querystring: z.object({ player: z.enum(['a', 'b']).default('b') }),
      response: { 200: z.object({ cleared: z.boolean() }), 409: error, 502: error, 503: error },
    },
  }, async (req, reply) => {
    if (!strom || !tams) return reply.code(503).send({ error: notConfigured });
    const { groupId } = req.params;
    const { player } = req.query;
    if (busy(groupId, player)) return reply.code(409).send({ error: `Clip player ${player.toUpperCase()} is playing a playlist. Stop that instead.` });
    const found = await clipPlayerOf(strom, groupId, player, false);
    if ('error' in found) return reply.code(found.status).send({ error: found.error });
    try {
      await new StromReplayLink(strom, found.flowId, found.group).stop();
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
    return { cleared: true };
  });
}
