import { randomUUID } from 'node:crypto';

export interface PlaybackMember {
  streamId: string;
  label: string;
}

export interface PlaybackRequest {
  groupId: string;
  name: string;
  /** Where the program goes, an SRT address such as srt://127.0.0.1:5031?mode=caller. */
  srtUri: string;
  members: PlaybackMember[];
}

/** The replay group of a studio group's media players. Unique per group, so two replays never share a timeline. */
export const replayGroupOf = (groupId: string) => `studio-${groupId}`;

/** The two clip players of a replay flow (ADR-0002): they play clips and playlists, each in a replay group of its own. */
export type ClipPlayer = 'a' | 'b';
export const CLIP_PLAYERS: ClipPlayer[] = ['a', 'b'];
export const clipBlockOf = (p: ClipPlayer) => `clip${p.toUpperCase()}`;
export const clipGroupOf = (groupId: string, p: ClipPlayer) => `${replayGroupOf(groupId)}-${p}`;
/** A camera's block id: `cam1`, `cam2`, ... The clip players are not cameras. */
export const isCameraBlock = (id: string | undefined) => /^cam\d+$/.test(id ?? '');
/** The mixer input of a clip player: after the N cameras, A then B. */
export const clipInputOf = (cameras: number, p: ClipPlayer) => cameras + CLIP_PLAYERS.indexOf(p);
/** The most cameras a replay can have: the vision mixer has 16 inputs and the two clip players take two. */
export const MAX_CAMERAS = 14;

/** The id of the mixer block, which the preview and take calls address. */
export const MIXER_BLOCK = 'vm';

/**
 * A second mixer whose program is always the first mixer's preview. Strom's mixer has no preview video output, and
 * pointing the browser at a different source's video on every click would open a new connection each time; this keeps
 * one preview connection and switches inside Strom.
 */
export const PREVIEW_BLOCK = 'pvw';

/** The WHEP endpoint of the program (`pgm`), of the preview, or of one source (`cam1`, `cam2`, ...). */
export const endpointOf = (groupId: string, kind: 'pgm' | 'pvw' | `cam${number}`) => `or-${groupId.replace(/[^a-z0-9]/gi, '').slice(-10)}-${kind}`;

/**
 * The Strom flow that replays one group: a media player per stream, each with its own WHEP video; two clip players
 * (A and B) for clips and playlists; a mixer with a preview and a program bus, which takes the cameras and the two clip
 * players; the program goes out over SRT and as WHEP video for the browser. `encoderPreference` is passed to every encoder.
 */
export type EncoderPreference = 'auto' | 'hardware' | 'software';

export function buildReplayFlow(req: PlaybackRequest, tamsHost: string, encoderPreference: EncoderPreference = 'auto') {
  const group = replayGroupOf(req.groupId);
  const blocks: Record<string, unknown>[] = [];
  const links: { from: string; to: string }[] = [];
  req.members.forEach((m, i) => {
    blocks.push({
      id: `cam${i + 1}`,
      block_definition_id: 'builtin.media_player',
      name: m.label,
      // 25 fps is what the mixers run at. A 50 or 60 fps source would otherwise push frames the mixers discard into every consumer.
      properties: { mode: 'timeline', group, source: `tams+https://${tamsHost}/flows/${m.streamId}`, auth_mode: 'osc', output_framerate: '25/1', num_audio_tracks: 0 },
      position: { x: 100, y: 80 + i * 160 },
    });
    links.push({ from: `cam${i + 1}:video_out`, to: `${MIXER_BLOCK}:video_in_${i}` }, { from: `cam${i + 1}:video_out`, to: `${PREVIEW_BLOCK}:video_in_${i}` });
    // The same picture to the operator's browser: the strip of sources, and the preview window.
    blocks.push(
      { id: `enc_cam${i + 1}`, block_definition_id: 'builtin.videoenc', name: `Enc ${m.label}`, properties: { encoder_preference: encoderPreference, bitrate: 3000 }, position: { x: 400, y: 80 + i * 160 } },
      { id: `whep_cam${i + 1}`, block_definition_id: 'builtin.whep_output', name: `${m.label} WHEP`, properties: { num_audio_tracks: 0, endpoint_id: endpointOf(req.groupId, `cam${i + 1}`) }, position: { x: 650, y: 80 + i * 160 } },
    );
    links.push({ from: `cam${i + 1}:video_out`, to: `enc_cam${i + 1}:video_in` }, { from: `enc_cam${i + 1}:encoded_out`, to: `whep_cam${i + 1}:video_in` });
  });
  // The clip players. A new group starts paused, and a clip is cued onto it later, so the source here is only a place to start: the first camera.
  const first = req.members[0]!;
  const n = req.members.length;
  CLIP_PLAYERS.forEach((p, k) => {
    const id = clipBlockOf(p);
    blocks.push({
      id,
      block_definition_id: 'builtin.media_player',
      name: `Clip ${p.toUpperCase()}`,
      properties: { mode: 'timeline', group: clipGroupOf(req.groupId, p), source: `tams+https://${tamsHost}/flows/${first.streamId}`, auth_mode: 'osc', output_framerate: '25/1', num_audio_tracks: 0,
        // A clip player is not live: with the default (true), forward play after an uncue or a seek out of the cue could pull its group to live. It starts paused.
        follow_live: false },
      position: { x: 100, y: 80 + (n + k) * 160 },
    });
    links.push({ from: `${id}:video_out`, to: `${MIXER_BLOCK}:video_in_${clipInputOf(n, p)}` }, { from: `${id}:video_out`, to: `${PREVIEW_BLOCK}:video_in_${clipInputOf(n, p)}` });
  });
  const labels = Object.fromEntries([...req.members.map((m) => m.label), ...CLIP_PLAYERS.map((p) => `Clip ${p.toUpperCase()}`)].map((l, i) => [`input_${i}_label`, l]));
  blocks.push(
    { id: MIXER_BLOCK, block_definition_id: 'builtin.vision_mixer', name: 'Replay mixer', properties: { num_inputs: n + CLIP_PLAYERS.length, pgm_framerate: '25/1', pgm_resolution: '1280x720', ...labels }, position: { x: 400, y: 160 } },
    // The preview mixer starts on the same source the main mixer previews first (its second input).
    { id: PREVIEW_BLOCK, block_definition_id: 'builtin.vision_mixer', name: 'Preview mixer', properties: { num_inputs: n + CLIP_PLAYERS.length, pgm_framerate: '25/1', pgm_resolution: '1280x720', initial_pgm_input: Math.min(1, n - 1), ...labels }, position: { x: 400, y: 320 } },
    { id: 'enc_pvw', block_definition_id: 'builtin.videoenc', name: 'Enc preview', properties: { encoder_preference: encoderPreference, bitrate: 3000 }, position: { x: 700, y: 340 } },
    { id: 'whep_pvw', block_definition_id: 'builtin.whep_output', name: 'Preview WHEP', properties: { num_audio_tracks: 0, endpoint_id: endpointOf(req.groupId, 'pvw') }, position: { x: 950, y: 340 } },
    { id: 'enc_pgm', block_definition_id: 'builtin.videoenc', name: 'Enc program', properties: { encoder_preference: encoderPreference, bitrate: 3000 }, position: { x: 700, y: 500 } },
    { id: 'whep_pgm', block_definition_id: 'builtin.whep_output', name: 'Program WHEP', properties: { num_audio_tracks: 0, endpoint_id: endpointOf(req.groupId, 'pgm') }, position: { x: 950, y: 500 } },
    { id: 'enc_air', block_definition_id: 'builtin.videoenc', name: 'Enc air', properties: { bitrate: 10000, encoder_preference: encoderPreference, keyframe_interval: 50, quality_preset: 'medium', rate_control: 'cbr' }, position: { x: 700, y: 420 } },
    { id: 'srt_air', block_definition_id: 'builtin.mpegtssrt_output', name: 'SRT out', properties: { latency: 200, num_audio_tracks: 0, num_video_tracks: 1, srt_uri: req.srtUri }, position: { x: 950, y: 420 } },
  );
  links.push(
    { from: `${PREVIEW_BLOCK}:pgm_out`, to: 'enc_pvw:video_in' },
    { from: 'enc_pvw:encoded_out', to: 'whep_pvw:video_in' },
    { from: `${MIXER_BLOCK}:pgm_out`, to: 'q_air:sink' },
    { from: 'q_air:src', to: 'enc_air:video_in' },
    { from: 'enc_air:encoded_out', to: 'srt_air:video_in' },
    // The same program picture for the browser, from its own lower-bitrate encoder: the SRT encoder is untouched.
    { from: `${MIXER_BLOCK}:pgm_out`, to: 'enc_pgm:video_in' },
    { from: 'enc_pgm:encoded_out', to: 'whep_pgm:video_in' },
  );
  const elements = [{ id: 'q_air', element_type: 'queue', properties: { leaky: 'downstream', 'max-size-buffers': 0, 'max-size-bytes': 0, 'max-size-time': 1_000_000_000 }, position: [560, 420] }];
  return {
    id: randomUUID(),
    name: `Open Replay: ${req.name}`,
    properties: { description: `Open Replay group ${req.groupId}`, ephemeral: false },
    elements,
    blocks,
    links,
  };
}
