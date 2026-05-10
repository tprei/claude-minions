export type ScanHandler = () => Promise<void>;

export class ScanLoop {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly handler: ScanHandler,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    this.inFlight = (async () => {
      try {
        await this.handler();
      } catch {
        // per-rule try/catch is the handler's responsibility; swallow unexpected errors
      }
    })();
    await this.inFlight;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }
}
