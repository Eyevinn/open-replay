/**
 * Plays a playlist on one clip player of a replay flow, by keeping Strom's queue filled.
 *
 * Built against Strom's planned clip queue (ADR-0002, from the Strom author's description, NOT yet in pushed
 * code): `cue` + `play` start the first item, `cue_next` queues the others, and `item_started` and `ended`
 * events carry each item's `client_ref`. Everything specific to Strom's wire format is in `replay-link.ts`;
 * this file only knows the ReplayLink below, so it can be tested without Strom and adjusted in one place.
 */

export type EndAction = 'freeze' | 'loop' | 'live';

/** One item of the queue, as Strom takes it. Times are on the group's axis, nanosecond strings. */
export interface QueueItem {
  /** The TAMS source the item plays from. */
  source: string;
  in: string;
  out: string;
  /** Fraction of real time for this item only. */
  speed: number;
  end_action: EndAction;
  client_ref: string;
}

/** What a clip player reports about itself. `null` when the state does not say. */
export interface ClipPlayerState {
  /** The `client_ref` of the item that is playing. */
  currentRef: string | null;
  /** How many items wait behind the current one. */
  queued: number | null;
  /** The playing speed; 0 when held or frozen. `null` before there is media. */
  speed: number | null;
}

export type LinkEvent = { type: 'item_started' | 'ended' | 'source_failed'; clientRef: string | null; seq: number | null };

/** The runner's view of one clip player. */
export interface ReplayLink {
  /** Cue the item and hold it. Replaces whatever the player had. */
  cue(item: QueueItem): Promise<void>;
  /** Play the cued item at `speed`. */
  play(speed: number): Promise<void>;
  /** Add an item behind the current one. */
  queue(item: QueueItem): Promise<void>;
  /** Stop where it is: drop the queue and the cue. */
  stop(): Promise<void>;
  state(): Promise<ClipPlayerState>;
  /** Events as they come; `onResync` is called when some may have been missed (a reconnect, or Strom saying so). Returns an unsubscribe. */
  subscribe(onEvent: (e: LinkEvent) => void, onResync: () => void): () => void;
}

/** An item of the playlist, resolved from its clip. */
export interface RunnerItem {
  clipId: string;
  name: string;
  source: string;
  inT: string;
  outT: string;
  speed: number;
}

export type RunnerState = 'running' | 'finished' | 'stopped' | 'failed';

export interface RunnerStatus {
  state: RunnerState;
  /** Position in the playlist of the item playing now, from 0. `null` before the first starts. */
  index: number | null;
  /** Items in the playlist. */
  total: number;
  /** How many items have been sent to Strom and have not started yet. */
  queued: number;
  /** Times the whole playlist has been played through when looping. */
  round: number;
  error?: string;
}

export interface RunnerOptions {
  /** Items kept queued behind the one playing. */
  ahead?: number;
  /** How often to read the state to catch an event that did not arrive, in ms. 0 turns it off. */
  pollMs?: number;
  /** The playlist's end behaviour. `loop` is done here by queueing the first item again; Strom gets `freeze`. */
  endAction?: EndAction;
  onChange?: (status: RunnerStatus) => void;
}

const SEP = '-';

export class PlaylistRunner {
  private readonly ahead: number;
  private readonly pollMs: number;
  private readonly endAction: EndAction;
  private readonly runId = Math.random().toString(36).slice(2, 8);
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  /** Number of items sent so far. Item `n` is items[n % length], and its ref is `<run>-<n>`. */
  private sent = 0;
  /** Highest `n` seen starting. */
  private startedN = -1;
  private state: RunnerState = 'running';
  private error?: string;
  private busy: Promise<unknown> = Promise.resolve();
  /** Polls in a row that saw the last item frozen with nothing behind it. */
  private idlePolls = 0;

  constructor(
    private readonly link: ReplayLink,
    private readonly items: RunnerItem[],
    private readonly opts: RunnerOptions = {},
  ) {
    this.ahead = opts.ahead ?? 2;
    this.pollMs = opts.pollMs ?? 1000;
    this.endAction = opts.endAction ?? 'freeze';
  }

  status(): RunnerStatus {
    const total = this.items.length;
    return {
      state: this.state,
      index: this.startedN >= 0 ? this.startedN % total : null,
      total,
      queued: Math.max(0, this.sent - 1 - this.startedN),
      round: this.startedN >= 0 ? Math.floor(this.startedN / total) : 0,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Start playing. Resolves once the first item is cued and playing and the queue is filled; rejects if Strom refuses. */
  async start(): Promise<void> {
    if (this.items.length === 0) throw new Error('The playlist has no clips to play.');
    this.unsubscribe = this.link.subscribe((e) => this.onEvent(e), () => void this.resync());
    try {
      const first = this.itemAt(0);
      await this.link.cue(first);
      this.sent = 1;
      await this.link.play(first.speed);
      this.startedN = 0; // playing now; its item_started event may or may not come first
      await this.fill();
    } catch (err) {
      this.fail(err);
      throw err;
    }
    if (this.pollMs > 0) this.timer = setInterval(() => void this.resync(), this.pollMs);
  }

  /** Stop playing and clear the player. Safe to call twice. */
  async stop(): Promise<void> {
    if (this.state !== 'running') return;
    this.state = 'stopped';
    this.cleanup();
    await this.link.stop().catch(() => undefined);
    this.changed();
  }

  // ---- internals ----

  private total(): number {
    return this.endAction === 'loop' ? Infinity : this.items.length;
  }

  private itemAt(n: number): QueueItem {
    const it = this.items[n % this.items.length]!;
    const last = n === this.items.length - 1 && this.endAction !== 'loop';
    return {
      source: it.source,
      in: it.inT,
      out: it.outT,
      speed: it.speed,
      // Only the last item of a playlist that ends may do anything but hold: a runner that falls behind freezes, it never goes live by surprise.
      end_action: last && this.endAction === 'live' ? 'live' : 'freeze',
      client_ref: `${this.runId}${SEP}${n}`,
    };
  }

  private parse(ref: string | null): number | null {
    if (!ref?.startsWith(`${this.runId}${SEP}`)) return null; // not ours: another run, or an operator's own cue
    const n = Number(ref.slice(this.runId.length + 1));
    return Number.isInteger(n) ? n : null;
  }

  /** Keep `ahead` items queued behind the one playing. Serialised, so two triggers cannot send the same item twice. */
  private fill(): Promise<void> {
    const run = this.busy.then(async () => {
      while (this.state === 'running' && this.sent < this.total() && this.sent - 1 - this.startedN < this.ahead) {
        await this.link.queue(this.itemAt(this.sent));
        this.sent++;
        this.changed();
      }
    });
    this.busy = run.catch(() => undefined);
    return run.catch((err) => this.fail(err));
  }

  private onEvent(e: LinkEvent): void {
    if (this.state !== 'running') return;
    const n = this.parse(e.clientRef);
    if (n === null) return;
    if (e.type === 'source_failed') {
      this.fail(new Error(`Strom could not switch to the source of item ${(n % this.items.length) + 1} (${this.items[n % this.items.length]!.name}).`));
    } else if (e.type === 'item_started') {
      this.started(n);
    } else if (e.type === 'ended' && n === this.items.length - 1 && this.endAction !== 'loop' && n >= this.startedN) {
      this.finish();
    }
  }

  private started(n: number): void {
    if (n > this.startedN) this.startedN = n;
    this.changed();
    void this.fill();
  }

  /** Read the state to catch what an event would have said. */
  private async resync(): Promise<void> {
    if (this.state !== 'running') return;
    let s: ClipPlayerState;
    try {
      s = await this.link.state();
    } catch {
      return; // Strom did not answer this time
    }
    const n = this.parse(s.currentRef);
    if (n !== null && n > this.startedN) this.started(n);
    else void this.fill();
    // The last item sent, nothing behind it, and the player not moving, twice in a row: it ended and the event was missed.
    // (A held cue may still name the last item, or the player may hold none; either way it is idle.)
    const last = this.items.length - 1;
    const idle = s.queued === 0 && (s.speed === 0 || s.speed === null) && (s.currentRef === null || this.parse(s.currentRef) === last);
    this.idlePolls = idle && this.sent >= this.total() && this.startedN >= last ? this.idlePolls + 1 : 0;
    if (this.idlePolls >= 2) this.finish();
  }

  private finish(): void {
    if (this.state !== 'running') return;
    this.state = 'finished';
    this.cleanup();
    this.changed();
  }

  private fail(err: unknown): void {
    if (this.state !== 'running') return;
    this.state = 'failed';
    this.error = err instanceof Error ? err.message : String(err);
    this.cleanup();
    this.changed();
  }

  private cleanup(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private changed(): void {
    this.opts.onChange?.(this.status());
  }
}
