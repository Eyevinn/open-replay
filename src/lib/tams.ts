const TOKEN_URL = 'https://token.svc.prod.osaas.io/servicetoken';

export interface TamsOptions {
  url: string;
  serviceId: string;
  /** OSC access token, exchanged for the gateway's short-lived token. */
  accessToken: string;
}

/** Reads a TAMS gateway. The token exchange is cached and retried: the token service answers badly now and then. */
export class TamsClient {
  private cached: { token: string; until: number } | null = null;

  constructor(private readonly opts: TamsOptions) {}

  get host(): string {
    return new URL(this.opts.url).host;
  }

  private async token(): Promise<string> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.token;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-pat-jwt': `Bearer ${this.opts.accessToken}` },
          body: JSON.stringify({ serviceId: this.opts.serviceId }),
        });
        if (!res.ok) throw new Error(`token service answered ${res.status}`);
        const body = (await res.json()) as { token: string; expiry: number };
        this.cached = { token: body.token, until: Math.min(body.expiry * 1000, Date.now() + 10 * 60_000) - 30_000 };
        return this.cached.token;
      } catch (err) {
        if (attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.opts.url}${path}`, { headers: { 'x-jwt': `Bearer ${await this.token()}` } });
    if (!res.ok) throw new Error(`the store answered ${res.status} for ${path}`);
    return (await res.json()) as T;
  }
}
