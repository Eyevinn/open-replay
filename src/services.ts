import type { Config } from './config.js';
import { StromClient } from './lib/strom.js';
import { TamsClient } from './lib/tams.js';

/** What Open Replay talks to besides its own database. Each is optional; its routes answer 503 without it. */
export interface Services {
  tams?: TamsClient;
  strom?: StromClient;
  /** OSC access token, handed to Strom so its media players can read the store. */
  oscAccessToken?: string;
  /** Encoder preference written into replay flows. */
  encoderPreference?: 'auto' | 'hardware' | 'software';
  /** How far behind the live edge a started replay plays, in ms. */
  liveMarginMs?: number;
}

export function buildServices(config: Pick<Config, 'tamsUrl' | 'tamsServiceId' | 'oscAccessToken' | 'stromUrl' | 'stromAuthToken' | 'encoderPreference' | 'liveMarginMs'>): Services {
  return {
    tams: config.tamsUrl && config.oscAccessToken
      ? new TamsClient({ url: config.tamsUrl, serviceId: config.tamsServiceId, accessToken: config.oscAccessToken })
      : undefined,
    strom: config.stromUrl ? new StromClient({ url: config.stromUrl, key: config.stromAuthToken }) : undefined,
    oscAccessToken: config.oscAccessToken,
    encoderPreference: config.encoderPreference,
    liveMarginMs: config.liveMarginMs,
  };
}
