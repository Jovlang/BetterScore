export type SaveOperation<T> = (payload: T) => Promise<void>;
export type SaveErrorHandler = (error: unknown) => void;

interface SaveRequest<T> {
  revision: number;
  payload: T;
  attempted: boolean;
}

/**
 * Debounces save requests while guaranteeing that writes run sequentially.
 * If a new revision is requested during a write, the drain loop writes again
 * before it resolves.
 */
export class SaveCoordinator<T = void> {
  private requestedRevision = 0;
  private persistedRevision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<void> | null = null;
  private disposed = false;
  private queue: Array<SaveRequest<T>> = [];

  constructor(
    private readonly save: SaveOperation<T>,
    private readonly debounceMs = 500,
    private readonly onBackgroundError: SaveErrorHandler = () => undefined
  ) {}

  schedule(payload?: T): void {
    if (this.disposed) return;
    this.requestedRevision += 1;
    const request = {
      revision: this.requestedRevision,
      payload: payload as T,
      attempted: false
    };
    const pending = this.queue[this.queue.length - 1];
    if (pending && !pending.attempted) {
      // Only the newest not-yet-started snapshot matters. An attempted request
      // remains queued until it succeeds, even if another file is opened.
      this.queue[this.queue.length - 1] = request;
    } else {
      this.queue.push(request);
    }
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.ensureDrain().catch(this.onBackgroundError);
    }, this.debounceMs);
  }

  async flush(): Promise<void> {
    this.clearTimer();
    await this.ensureDrain();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.ensureDrain();
      return;
    }
    this.disposed = true;
    await this.flush();
  }

  private ensureDrain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    if (this.queue.length === 0) return Promise.resolve();

    const drain = this.drain();
    this.drainPromise = drain;
    void drain.finally(() => {
      if (this.drainPromise === drain) this.drainPromise = null;
    }).catch(() => undefined);
    return drain;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const request = this.queue[0];
      if (!request) return;
      request.attempted = true;
      await this.save(request.payload);
      this.persistedRevision = request.revision;
      this.queue.shift();
    }
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
