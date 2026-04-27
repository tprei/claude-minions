import type { Memory, MemoryKind } from "@minions/shared";
import type { MemoryStore } from "./store.js";

const SECTION_LABELS: Record<MemoryKind, string> = {
  user: "User memories",
  project: "Project memories",
  feedback: "Feedback",
  reference: "References",
};

const KIND_ORDER: MemoryKind[] = ["user", "project", "feedback", "reference"];

export function renderPreamble(store: MemoryStore, repoId?: string): string {
  const global = store.list({ status: "approved", scope: "global" });
  const pinned = store.list({ scope: "global" }).filter((m) => m.pinned && m.status !== "rejected" && m.status !== "pending_deletion");

  let repoMemories: Memory[] = [];
  if (repoId) {
    repoMemories = store.list({ status: "approved", scope: "repo", repoId });
    const repoPinned = store.list({ scope: "repo", repoId }).filter(
      (m) => m.pinned && m.status !== "rejected" && m.status !== "pending_deletion"
    );
    for (const m of repoPinned) {
      if (!repoMemories.find((x) => x.id === m.id)) {
        repoMemories.push(m);
      }
    }
  }

  const allPinnedIds = new Set(pinned.map((m) => m.id));
  const combined: Memory[] = [];

  for (const m of pinned) {
    combined.push(m);
  }
  for (const m of global) {
    if (!allPinnedIds.has(m.id)) {
      combined.push(m);
    }
  }
  for (const m of repoMemories) {
    if (!combined.find((x) => x.id === m.id)) {
      combined.push(m);
    }
  }

  if (combined.length === 0) {
    return "";
  }

  const byKind = new Map<MemoryKind, Memory[]>();
  for (const kind of KIND_ORDER) {
    byKind.set(kind, []);
  }
  for (const m of combined) {
    byKind.get(m.kind)?.push(m);
  }

  const sections: string[] = [];
  for (const kind of KIND_ORDER) {
    const items = byKind.get(kind);
    if (!items || items.length === 0) continue;
    const header = `## ${SECTION_LABELS[kind]}`;
    const lines = items.map((m) => `- **${m.title}**: ${m.body}`);
    sections.push([header, ...lines].join("\n"));
  }

  if (sections.length === 0) {
    return "";
  }

  return sections.join("\n\n");
}
