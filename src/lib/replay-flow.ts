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

/** The id of the mixer block, which the preview and take calls address. */
export const MIXER_BLOCK = 'vm';

/**
 * A second mixer whose program is always the first mixer's preview. Strom's mixer has no preview video output, and
 * pointing the browser at a different source's video on every click would open a new connection each time; this keeps
 * one preview connection and switches inside Strom.
 */
export const PREVIEW_BLOCK = 'pvw';

/** The WHEP endpoint of the preview, or of one source (`cam1`, `cam2`, ...). The program has none: it goes out over SRT. */
export const endpointOf = (groupId: string, kind: 'pvw' | `cam${number}`) => `or-${groupId.replace(/[^a-z0-9]/gi, '').slice(-10)}-${kind}`;

/**
 * The Strom flow that replays one group: a media player per stream, each with its own WHEP video; a mixer with a
 * preview and a program bus; the program goes out over SRT only. `encoderPreference` is passed to every encoder.
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
  const labels = Object.fromEntries(req.members.map((m, i) => [`input_${i}_label`, m.label]));
  blocks.push(
    { id: MIXER_BLOCK, block_definition_id: 'builtin.vision_mixer', name: 'Replay mixer', properties: { num_inputs: req.members.length, pgm_framerate: '25/1', pgm_resolution: '1280x720', ...labels }, position: { x: 400, y: 160 } },
    // The preview mixer starts on the same source the main mixer previews first (its second input).
    { id: PREVIEW_BLOCK, block_definition_id: 'builtin.vision_mixer', name: 'Preview mixer', properties: { num_inputs: req.members.length, pgm_framerate: '25/1', pgm_resolution: '1280x720', initial_pgm_input: Math.min(1, req.members.length - 1), ...labels }, position: { x: 400, y: 320 } },
    { id: 'enc_pvw', block_definition_id: 'builtin.videoenc', name: 'Enc preview', properties: { encoder_preference: encoderPreference, bitrate: 3000 }, position: { x: 700, y: 340 } },
    { id: 'whep_pvw', block_definition_id: 'builtin.whep_output', name: 'Preview WHEP', properties: { num_audio_tracks: 0, endpoint_id: endpointOf(req.groupId, 'pvw') }, position: { x: 950, y: 340 } },
    { id: 'enc_air', block_definition_id: 'builtin.videoenc', name: 'Enc air', properties: { bitrate: 10000, encoder_preference: encoderPreference, keyframe_interval: 50, quality_preset: 'medium', rate_control: 'cbr' }, position: { x: 700, y: 420 } },
    { id: 'srt_air', block_definition_id: 'builtin.mpegtssrt_output', name: 'SRT out', properties: { latency: 200, num_audio_tracks: 0, num_video_tracks: 1, srt_uri: req.srtUri }, position: { x: 950, y: 420 } },
  );
  links.push(
    { from: `${PREVIEW_BLOCK}:pgm_out`, to: 'enc_pvw:video_in' },
    { from: 'enc_pvw:encoded_out', to: 'whep_pvw:video_in' },
    { from: `${MIXER_BLOCK}:pgm_out`, to: 'q_air:sink' },
    { from: 'q_air:src', to: 'enc_air:video_in' },
    { from: 'enc_air:encoded_out', to: 'srt_air:video_in' },
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
