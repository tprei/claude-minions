import type { Session } from "@minions/shared";

type StackEntry = {
  session: Session;
  depth: number;
};

function statusIcon(status: Session["status"], prState?: string): string {
  if (prState === "merged") return "✅";
  switch (status) {
    case "completed":
      return "✅";
    case "failed":
      return "❌";
    case "cancelled":
      return "🚫";
    case "running":
      return "🔄";
    case "waiting_input":
      return "⏸️";
    default:
      return "⏳";
  }
}

function collectDescendants(rootSession: Session, descendants: Session[]): StackEntry[] {
  const entries: StackEntry[] = [{ session: rootSession, depth: 0 }];
  const byParent = new Map<string, Session[]>();
  for (const d of descendants) {
    const parent = d.parentSlug ?? "";
    const bucket = byParent.get(parent) ?? [];
    bucket.push(d);
    byParent.set(parent, bucket);
  }

  function walk(slug: string, depth: number): void {
    const children = byParent.get(slug) ?? [];
    for (const child of children) {
      entries.push({ session: child, depth });
      walk(child.slug, depth + 1);
    }
  }

  walk(rootSession.slug, 1);
  return entries;
}

export function formatStackComment(rootSession: Session, descendants: Session[]): string {
  const entries = collectDescendants(rootSession, descendants);
  const lines: string[] = [
    "## Stack Status",
    "",
    "| | Branch | Status | PR |",
    "|---|---|---|---|",
  ];

  for (const { session, depth } of entries) {
    const indent = "  ".repeat(depth);
    const icon = statusIcon(session.status, session.pr?.state);
    const branch = session.branch ?? session.baseBranch ?? "—";
    const prLink = session.pr ? `[#${session.pr.number}](${session.pr.url})` : "—";
    const label = session.title || session.slug;
    lines.push(`| ${icon} | ${indent}\`${branch}\` | ${label} | ${prLink} |`);
  }

  lines.push("");
  lines.push(`_Updated at ${new Date().toISOString()}_`);

  return lines.join("\n");
}
