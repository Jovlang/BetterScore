type ScreenLock = Pick<WakeLockSentinel, "released" | "release">;

/** Best effort. Never let an unavailable or delayed lock block the score. */
export class PerformanceWakeLock {
  private wanted = false;
  private pending = false;
  private lock: ScreenLock | undefined;

  constructor(private readonly request: () => Promise<ScreenLock | undefined>) {}

  setWanted(wanted: boolean): void {
    this.wanted = wanted;
    if (!wanted) {
      const lock = this.lock;
      this.lock = undefined;
      if (lock && !lock.released) void this.release(lock);
    } else if (!this.pending && (!this.lock || this.lock.released)) {
      void this.acquire();
    }
  }

  private async acquire(): Promise<void> {
    this.pending = true;
    try {
      const lock = await this.request();
      if (!lock || lock.released) return;
      if (this.wanted) this.lock = lock;
      else void this.release(lock);
    } catch {
      // Unsupported, denied, or suspended by the platform.
    } finally {
      this.pending = false;
    }
  }

  private async release(lock: ScreenLock): Promise<void> {
    try {
      await lock.release();
    } catch {
      // The platform may already have released it.
    }
  }
}
