import type { QualityPlugin, QualityGateConfig, QualityRunResult } from "../quality-plugin.js";

export class StubQualityPlugin implements QualityPlugin {
  private readonly configs: QualityGateConfig[];
  private readonly result: QualityRunResult;
  private readonly overrides: Map<string, QualityRunResult["status"]>;
  private readonly rejectOnAbort: boolean;

  constructor(opts: {
    configs?: QualityGateConfig[];
    result?: QualityRunResult;
    overrides?: Record<string, QualityRunResult["status"]>;
    rejectOnAbort?: boolean;
  } = {}) {
    this.configs = opts.configs ?? [];
    this.result = opts.result ?? { status: "passed", checks: [] };
    this.overrides = new Map(Object.entries(opts.overrides ?? {}));
    this.rejectOnAbort = opts.rejectOnAbort ?? false;
  }

  async loadConfig(_workspacePath: string): Promise<QualityGateConfig[]> {
    return this.configs;
  }

  run(
    _configs: QualityGateConfig[],
    _workspacePath: string,
    opts: { signal?: AbortSignal; defaultTimeoutMs?: number },
  ): Promise<QualityRunResult> {
    if (this.rejectOnAbort && opts.signal) {
      return new Promise<QualityRunResult>((resolve, reject) => {
        if (opts.signal!.aborted) { reject(new Error("aborted")); return; }
        opts.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        void Promise.resolve().then(() => {
          if (!opts.signal!.aborted) {
            const result = this.buildResult();
            resolve(result);
          }
        });
      });
    }
    return Promise.resolve(this.buildResult());
  }

  private buildResult(): QualityRunResult {
    if (this.overrides.size === 0) return this.result;
    const checks = this.result.checks.map((c) => {
      const override = this.overrides.get(c.name);
      return override !== undefined ? { ...c, status: override as "passed" | "failed" | "skipped" } : c;
    });
    return { ...this.result, checks };
  }
}
