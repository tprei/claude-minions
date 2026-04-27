import fs from "node:fs/promises";
import os from "node:os";

async function readFile(p: string): Promise<string | null> {
  try {
    return (await fs.readFile(p, "utf8")).trim();
  } catch {
    return null;
  }
}

export interface CpuLimit {
  limitCores: number;
  cores: number;
  cgroupAware: boolean;
}

export interface MemoryLimit {
  usedBytes: number;
  limitBytes: number;
  cgroupAware: boolean;
}

export interface CpuUsageSample {
  usageUsec: number;
  timestampMs: number;
}

export async function readCpuLimit(): Promise<CpuLimit> {
  const cpuMax = await readFile("/sys/fs/cgroup/cpu.max");
  const cores = os.cpus().length;

  if (cpuMax !== null) {
    const parts = cpuMax.split(" ");
    const quota = parts[0];
    const period = parts[1];
    if (quota && period && quota !== "max") {
      const quotaNum = Number.parseInt(quota, 10);
      const periodNum = Number.parseInt(period, 10);
      if (Number.isFinite(quotaNum) && Number.isFinite(periodNum) && periodNum > 0) {
        return { limitCores: quotaNum / periodNum, cores, cgroupAware: true };
      }
    }
    return { limitCores: cores, cores, cgroupAware: true };
  }

  return { limitCores: cores, cores, cgroupAware: false };
}

export async function readMemoryLimit(): Promise<MemoryLimit> {
  const [memMax, memCurrent] = await Promise.all([
    readFile("/sys/fs/cgroup/memory.max"),
    readFile("/sys/fs/cgroup/memory.current"),
  ]);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  if (memCurrent !== null) {
    const used = Number.parseInt(memCurrent, 10);
    let limit = totalMem;
    if (memMax !== null && memMax !== "max") {
      const parsed = Number.parseInt(memMax, 10);
      if (Number.isFinite(parsed)) limit = parsed;
    }
    if (Number.isFinite(used)) {
      return { usedBytes: used, limitBytes: limit, cgroupAware: true };
    }
  }

  return {
    usedBytes: totalMem - freeMem,
    limitBytes: totalMem,
    cgroupAware: false,
  };
}

export async function readCpuUsageSample(): Promise<CpuUsageSample | null> {
  const stat = await readFile("/sys/fs/cgroup/cpu.stat");
  if (stat === null) return null;

  for (const line of stat.split("\n")) {
    if (line.startsWith("usage_usec ")) {
      const val = Number.parseInt(line.slice("usage_usec ".length).trim(), 10);
      if (Number.isFinite(val)) {
        return { usageUsec: val, timestampMs: Date.now() };
      }
    }
  }
  return null;
}
