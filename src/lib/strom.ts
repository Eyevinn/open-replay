export interface StromOptions {
  url: string;
  /** Sent as a Bearer token when set. */
  key: string | undefined;
}

export interface StromReply {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

/** The Strom flow engine's REST API, with the key added. */
export class StromClient {
  constructor(private readonly opts: StromOptions) {}

  get url(): string {
    return this.opts.url;
  }

  /** Headers that authenticate a request to Strom. Used by the proxy as well. */
  get authHeaders(): Record<string, string> {
    return this.opts.key ? { authorization: `Bearer ${this.opts.key}` } : {};
  }

  async request(path: string, init: { method?: string; json?: unknown } = {}): Promise<StromReply> {
    const res = await fetch(`${this.opts.url}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...this.authHeaders, ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { raw: text.slice(0, 200) };
    }
    return { ok: res.ok, status: res.status, body };
  }
}
