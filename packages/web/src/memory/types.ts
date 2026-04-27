import type { Memory, MemoryStatus } from "@minions/shared";

export type MemoryTab = "all" | MemoryStatus;

export interface MemoryFilter {
  tab: MemoryTab;
  search: string;
}

export interface MemoryEditTarget {
  memory?: Memory;
}
