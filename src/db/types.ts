import { z } from 'zod';

/**
 * A replay: a marked stretch of one angle on the TAI timeline.
 * Times are TAI nanoseconds, kept as decimal strings (JSON numbers lose
 * precision above 2^53, and TAI ns since 1970 is about 1.8e18).
 */
export const taiNs = z.string().regex(/^\d+$/, 'TAI nanoseconds as a decimal string');

export const replayInput = z.object({
  name: z.string().min(1).max(200),
  /** Open Replay angle (source) id. */
  angleId: z.string().min(1).max(100),
  inTai: taiNs,
  outTai: taiNs,
  /** Playback speed as a fraction of real time, 0 < speed <= 1 in v1. */
  speed: z.number().gt(0).lte(1).default(1),
  /** Clip flow in TAMS once the replay has been saved as a clip. */
  clipFlowId: z.string().optional(),
  notes: z.string().max(2000).optional(),
});
export type ReplayInput = z.infer<typeof replayInput>;

export const replayPatch = replayInput.partial();

export const replaySchema = replayInput.extend({
  id: z.string(),
  rev: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Replay = z.infer<typeof replaySchema>;

/** The stored CouchDB document. */
export interface ReplayDoc extends ReplayInput {
  _id: string;
  _rev?: string;
  type: 'replay';
  createdAt: string;
  updatedAt: string;
}
