function optional(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function required(name: string): string {
  const v = optional(name);
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function encoderPreference(v: string | undefined): 'auto' | 'hardware' | 'software' {
  if (v === undefined) return 'auto';
  if (v === 'auto' || v === 'hardware' || v === 'software') return v;
  throw new Error(`ENCODER_PREFERENCE must be auto, hardware or software, got "${v}"`);
}

export interface Config {
  port: number;
  logLevel: string;
  corsOrigin: string | undefined;
  apiKey: string | undefined;
  couchdbUrl: string;
  couchdbName: string;
  /** The TAMS gateway recordings are read from. Optional: without it the store routes answer 503. */
  tamsUrl: string | undefined;
  /** The OSC service the gateway is registered as, for the token exchange. */
  tamsServiceId: string;
  /** OSC access token. Exchanged for the short-lived tokens TAMS and Strom (when it sits behind OSC) want. */
  oscAccessToken: string | undefined;
  /** The Strom that runs replays. Optional: without it the playback routes answer 503. */
  stromUrl: string | undefined;
  /** Key for a Strom that needs one, sent as a Bearer token. Empty for a local Strom without authentication. */
  stromAuthToken: string | undefined;
  /** Which encoders replay flows ask Strom for: `auto` (hardware first, then software), `hardware` or `software`. */
  encoderPreference: 'auto' | 'hardware' | 'software';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const prev = process.env;
  process.env = env;
  try {
    const port = Number(optional('PORT') ?? '3000');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`PORT must be an integer from 1 to 65535, got "${env['PORT']}"`);
    }
    const apiKey = optional('API_KEY');
    if (!apiKey && env['NODE_ENV'] === 'production') {
      throw new Error('API_KEY must be set in production: without it all /api/v1 routes are unauthenticated.');
    }
    return {
      port,
      logLevel: optional('LOG_LEVEL') ?? 'info',
      corsOrigin: optional('CORS_ORIGIN'),
      apiKey,
      couchdbUrl: required('COUCHDB_URL'),
      couchdbName: optional('COUCHDB_NAME') ?? 'open-replay',
      tamsUrl: optional('TAMS_GATEWAY_URL')?.replace(/\/+$/, ''),
      tamsServiceId: optional('TAMS_SERVICE_ID') ?? 'eyevinn-tams-gateway',
      oscAccessToken: optional('OSC_ACCESS_TOKEN'),
      stromUrl: optional('STROM_URL')?.replace(/\/+$/, ''),
      stromAuthToken: optional('STROM_AUTH_TOKEN'),
      encoderPreference: encoderPreference(optional('ENCODER_PREFERENCE')),
    };
  } finally {
    process.env = prev;
  }
}
