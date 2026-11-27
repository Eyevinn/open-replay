import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { buildReplayFlow, endpointOf, MIXER_BLOCK, PREVIEW_BLOCK, replayGroupOf } from '../lib/replay-flow.js';
import type { StromClient } from '../lib/strom.js';
import type { Services } from '../services.js';

/** Where Strom is reachable through this API, for the operator screen's WebSocket and WHEP video. */
export const STROM_PROXY_PREFIX = '/api/v1/strom';

interface StromBlock {
  id: string;
  block_definition_id?: string;
  name?: string;
  properties?: Record<string, unknown>;
}
interface StromFlow {
  id: string;
  gst_state?: string;
  blocks?: StromBlock[];
}

const mixerSchema = z.object({
  /** Index of the source on air, from 0, in the order of `sources`. */
  program: z.number().int().nullable(),
  /** Index of the source in preview. */
  preview: z.number().int().nullable(),
});

const playbackSchema = z.discriminatedUnion('running', [
  z.object({ running: z.literal(false) }),
  z.object({
    running: z.literal(true),
    flowId: z.string(),
    state: z.string(),
    /** The replay group of the flow's media players, which the controller WebSocket is addressed by. */
    group: z.string(),
    /** Base path of Strom as this API serves it. */
    stromPath: z.string(),
    /** The preview as WHEP video: one connection that follows whichever source is in preview. */
    previewPath: z.string(),
    /** The program as WHEP video: the same picture as the SRT output. */
    programPath: z.string(),
    /** Each source with its own WHEP video, in mixer input order. */
    sources: z.array(z.object({ index: z.number().int(), label: z.string(), path: z.string() })),
    mixer: mixerSchema,
    /** The SRT address the program goes to. */
    srtUri: z.string().nullable(),
    /** True for a replay started before it had source, preview and program video: it has to be started again to be driven here. */
    outdated: z.boolean(),
  }),
]);
type Playback = z.infer<typeof playbackSchema>;

const startBody = z.object({
  name: z.string().min(1).max(200),
  srtUri: z.string().regex(/^srt:\/\/\S+$/, 'An SRT address, such as srt://127.0.0.1:5031?mode=caller'),
  members: z.array(z.object({ streamId: z.string().min(1), label: z.string().min(1) })).min(1).max(20),
});

async function listFlows(strom: StromClient): Promise<StromFlow[]> {
  const r = await strom.request('/api/flows');
  const flows = r.body['flows'] as StromFlow[] | undefined;
  if (!r.ok || !flows) throw new Error(`Strom answered ${r.status}`);
  return flows;
}

/** A player's replay group is `group` in Strom 0.8, `replay_group` in older versions. */
const flowOf = (flows: StromFlow[], groupId: string) =>
  flows.find((f) => f.blocks?.some((b) => b.properties?.['group'] === replayGroupOf(groupId) || b.properties?.['replay_group'] === replayGroupOf(groupId)));

const mixerPath = (flow: StromFlow) => `/api/flows/${flow.id}/blocks/${MIXER_BLOCK}`;
const previewMixerPath = (flow: StromFlow) => `/api/flows/${flow.id}/blocks/${PREVIEW_BLOCK}`;

/** Make the preview show `source`: a cut on the preview mixer, which has no other job. */
async function showInPreview(strom: StromClient, flow: StromFlow, source: number | null): Promise<void> {
  if (source === null) return;
  const state = await strom.request(`${previewMixerPath(flow)}/state`);
  const current = typeof state.body['program_input'] === 'number' ? state.body['program_input'] : null;
  if (!state.ok || current === source) return;
  await strom.request(`${previewMixerPath(flow)}/preview`, { method: 'PUT', json: { source: { input: source } } });
  await strom.request(`${previewMixerPath(flow)}/transition`, { method: 'POST', json: { from_input: current ?? 0, to_input: source, transition_type: 'cut' } });
}

const hasPreviewMixer = (flow: StromFlow) => (flow.blocks ?? []).some((b) => b.id === PREVIEW_BLOCK);
const num = (v: unknown) => (typeof v === 'number' ? v : null);

/**
 * Which source is on air and which is in preview. The program is the main mixer's. The preview is what the preview
 * mixer shows: Strom's main mixer cannot hold the source that is on air as its preview, but the preview mixer can show
 * any source, so an operator may look at the source on air too.
 */
async function mixerState(strom: StromClient, flow: StromFlow): Promise<z.infer<typeof mixerSchema>> {
  const main = await strom.request(`${mixerPath(flow)}/state`);
  const program = num(main.body['program_input']);
  if (!hasPreviewMixer(flow)) return { program, preview: num(main.body['preview_input']) };
  const pvw = await strom.request(`${previewMixerPath(flow)}/state`);
  return { program, preview: num(pvw.body['program_input']) };
}

async function describe(strom: StromClient, flow: StromFlow | undefined, groupId: string): Promise<Playback> {
  if (!flow) return { running: false };
  const mixer = await mixerState(strom, flow);
  const blocks = flow.blocks ?? [];
  const players = blocks.filter((b) => b.block_definition_id === 'builtin.media_player');
  const hasVideo = (i: number) => blocks.some((b) => b.id === `whep_cam${i + 1}`);
  const sources = players.flatMap((b, i) => (hasVideo(i) ? [{ index: i, label: b.name ?? `Source ${i + 1}`, path: `${STROM_PROXY_PREFIX}/whep/${endpointOf(groupId, `cam${i + 1}`)}` }] : []));
  const hasPreview = blocks.some((b) => b.id === 'whep_pvw');
  const hasProgram = blocks.some((b) => b.id === 'whep_pgm');
  const srt = blocks.find((b) => b.block_definition_id === 'builtin.mpegtssrt_output')?.properties?.['srt_uri'];
  return {
    running: true,
    flowId: flow.id,
    state: flow.gst_state ?? 'unknown',
    group: replayGroupOf(groupId),
    stromPath: STROM_PROXY_PREFIX,
    previewPath: `${STROM_PROXY_PREFIX}/whep/${endpointOf(groupId, 'pvw')}`,
    programPath: `${STROM_PROXY_PREFIX}/whep/${endpointOf(groupId, 'pgm')}`,
    sources,
    mixer,
    srtUri: typeof srt === 'string' ? srt : null,
    outdated: players.length > 0 && (sources.length === 0 || !hasPreview || !hasProgram),
  };
}

async function removeFlow(strom: StromClient, id: string) {
  await strom.request(`/api/flows/${id}/stop`, { method: 'POST' });
  await strom.request(`/api/flows/${id}`, { method: 'DELETE' });
}

/** Run the replay of a group on Strom: its sources side by side, a preview and a program, the program going out over SRT. */
export async function playbackRoutes(app: FastifyInstance, opts: { services: Services }) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ groupId: z.string().min(1) });
  const error = z.object({ error: z.string() });
  const { strom, tams, oscAccessToken, encoderPreference } = opts.services;
  const notReady = 'Set STROM_URL, TAMS_GATEWAY_URL and OSC_ACCESS_TOKEN to run replays.';
  const failed = (err: unknown) => `Strom could not be reached: ${err instanceof Error ? err.message : String(err)}`;

  r.get('/groups/:groupId/playback', {
    schema: { tags: ['playback'], params, response: { 200: playbackSchema, 502: error, 503: error } },
  }, async (req, reply) => {
    if (!strom) return reply.code(503).send({ error: notReady });
    try {
      return await describe(strom, flowOf(await listFlows(strom), req.params.groupId), req.params.groupId);
    } catch (err) {
      return reply.code(502).send({ error: failed(err) });
    }
  });

  r.put('/groups/:groupId/playback', {
    schema: {
      tags: ['playback'],
      description: 'Start the replay of a group, replacing one that is already running. Takes about 10 seconds to come up.',
      params, body: startBody, response: { 200: playbackSchema, 502: error, 503: error },
    },
  }, async (req, reply) => {
    if (!strom || !tams || !oscAccessToken) return reply.code(503).send({ error: notReady });
    const { groupId } = req.params;
    try {
      const old = flowOf(await listFlows(strom), groupId);
      if (old) await removeFlow(strom, old.id);
      const flow = buildReplayFlow({ groupId, ...req.body }, tams.host, encoderPreference);
      const created = await strom.request('/api/flows', { method: 'POST', json: flow });
      const id = ((created.body['flow'] as { id?: string } | undefined)?.id ?? created.body['id']) as string | undefined;
      if (!id) return reply.code(502).send({ error: `Strom would not create the replay: ${JSON.stringify(created.body).slice(0, 200)}` });
      await strom.request(`/api/osc/pat/${id}`, { method: 'PUT', json: { pat: oscAccessToken } });
      const started = await strom.request(`/api/flows/${id}/start`, { method: 'POST' });
      if (!started.ok) return reply.code(502).send({ error: `Strom would not start the replay (${started.status}).` });
      return await describe(strom, flowOf(await listFlows(strom), groupId), groupId);
    } catch (err) {
      return reply.code(502).send({ error: failed(err) });
    }
  });

  r.delete('/groups/:groupId/playback', {
    schema: { tags: ['playback'], description: 'Stop the replay of a group and remove its flow.', params, response: { 200: playbackSchema, 502: error, 503: error } },
  }, async (req, reply) => {
    if (!strom) return reply.code(503).send({ error: notReady });
    try {
      const flow = flowOf(await listFlows(strom), req.params.groupId);
      if (flow) await removeFlow(strom, flow.id);
      return { running: false as const };
    } catch (err) {
      return reply.code(502).send({ error: failed(err) });
    }
  });

  r.put('/groups/:groupId/playback/preview', {
    schema: {
      tags: ['playback'],
      description: 'Put a source in preview, including the one that is on air. It stays off air until it is taken.',
      params, body: z.object({ source: z.number().int().min(0) }),
      response: { 200: mixerSchema, 404: error, 409: error, 502: error, 503: error },
    },
  }, async (req, reply) => {
    if (!strom) return reply.code(503).send({ error: notReady });
    try {
      const flow = flowOf(await listFlows(strom), req.params.groupId);
      if (!flow) return reply.code(404).send({ error: 'This group has no replay running.' });
      if (!hasPreviewMixer(flow)) return reply.code(409).send({ error: 'This replay was started with an older version. Restart it.' });
      const sources = (flow.blocks ?? []).filter((b) => b.block_definition_id === 'builtin.media_player').length;
      if (req.body.source >= sources) return reply.code(409).send({ error: `There is no source ${req.body.source + 1}.` });
      await showInPreview(strom, flow, req.body.source);
      return await mixerState(strom, flow);
    } catch (err) {
      return reply.code(502).send({ error: failed(err) });
    }
  });

  r.post('/groups/:groupId/playback/take', {
    schema: {
      tags: ['playback'],
      description: 'Send the source in preview out as the program, with a cut.',
      params, response: { 200: mixerSchema, 404: error, 409: error, 502: error, 503: error },
    },
  }, async (req, reply) => {
    if (!strom) return reply.code(503).send({ error: notReady });
    try {
      const flow = flowOf(await listFlows(strom), req.params.groupId);
      if (!flow) return reply.code(404).send({ error: 'This group has no replay running.' });
      const now = await mixerState(strom, flow);
      if (now.preview === null || now.program === null) return reply.code(409).send({ error: 'Nothing is in preview.' });
      if (now.preview === now.program) return reply.code(409).send({ error: 'The source in preview is on air already.' });
      // The main mixer takes whatever is on its own preview bus, so put the previewed source there first.
      await strom.request(`${mixerPath(flow)}/preview`, { method: 'PUT', json: { source: { input: now.preview } } });
      const took = await strom.request(`${mixerPath(flow)}/transition`, {
        method: 'POST',
        json: { from_input: now.program, to_input: now.preview, transition_type: 'cut' },
      });
      if (!took.ok) return reply.code(502).send({ error: `Strom would not take: ${JSON.stringify(took.body).slice(0, 160)}` });
      // The take hands the old program back to the main mixer's preview: the preview shows it, as a mixer would.
      const main = await strom.request(`${mixerPath(flow)}/state`);
      await showInPreview(strom, flow, num(main.body['preview_input']));
      return await mixerState(strom, flow);
    } catch (err) {
      return reply.code(502).send({ error: failed(err) });
    }
  });
}
