import { monitorEventLoopDelay } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import type { ResourceSnapshot } from "@minions/shared";
import { bytesAvailable } from "../util/fs.js";

const execFileAsync = promisify(execFile);

async function workspaceUsedBytes(path: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("du", ["-sb", path], { timeout: 5_000 });
    const n = Number.parseInt(stdout.split(/\s+/)[0] ?? "0", 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
import {
  readCpuLimit,
  readMemoryLimit,
  readCpuUsageSample,
  type CpuUsageSample,
} from "./cgroup.js";

interface SessionCounts {
  total: number;
  running: number;
  waiting: number;
}

function querySessions(db: Database.Database): SessionCounts {
  const rows = db
    .prepare("SELECT status, COUNT(*) as cnt FROM sessions GROUP BY status")
    .all() as { status: string; cnt: number }[];

  let total = 0;
  let running = 0;
  let waiting = 0;
  for (const row of rows) {
    total += row.cnt;
    if (row.status === "running") running += row.cnt;
    if (row.status === "waiting_input") waiting += row.cnt;
  }
  return { total, running, waiting };
}

export class ResourceMonitor {
  private lagMonitor = monitorEventLoopDelay({ resolution: 20 });
  private prevCpuSample: CpuUsageSample | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly workspaceDir: string
  ) {}

  async sample(): Promise<ResourceSnapshot> {
    this.lagMonitor.enable();

    const [cpuLimit, memLimit, diskInfo, workspaceBytes, currentCpuSample] = await Promise.all([
      readCpuLimit(),
      readMemoryLimit(),
      bytesAvailable(this.workspaceDir),
      workspaceUsedBytes(this.workspaceDir),
      readCpuUsageSample(),
    ]);

    const lagMs = this.lagMonitor.mean / 1e6;
    this.lagMonitor.reset();
    this.lagMonitor.disable();
    this.lagMonitor = monitorEventLoopDelay({ resolution: 20 });

    let cpuUsagePct = 0;
    if (currentCpuSample && this.prevCpuSample) {
      const deltaUsecMs = (currentCpuSample.usageUsec - this.prevCpuSample.usageUsec) / 1000;
      const deltaMs = currentCpuSample.timestampMs - this.prevCpuSample.timestampMs;
      if (deltaMs > 0) {
        cpuUsagePct = Math.min(100, (deltaUsecMs / deltaMs) * 100);
      }
    }
    this.prevCpuSample = currentCpuSample;

    const sessions = querySessions(this.db);
    const cgroupAware = cpuLimit.cgroupAware || memLimit.cgroupAware;

    return {
      timestamp: new Date().toISOString(),
      cgroupAware,
      cpu: {
        usagePct: cpuUsagePct,
        limitCores: cpuLimit.limitCores,
        cores: cpuLimit.cores,
      },
      memory: {
        usedBytes: memLimit.usedBytes,
        limitBytes: memLimit.limitBytes,
        rssBytes: process.memoryUsage().rss,
      },
      disk: {
        usedBytes: diskInfo.used,
        totalBytes: diskInfo.total,
        workspacePath: this.workspaceDir,
        workspaceUsedBytes: workspaceBytes,
      },
      eventLoop: {
        lagMs: Number.isFinite(lagMs) ? lagMs : 0,
      },
      sessions,
    };
  }
}
