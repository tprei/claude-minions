import type { UsageEvent } from "@minions/shared";

function formatCost(costUsd: number): string {
  return costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2);
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="pill border border-border bg-bg-soft text-fg-muted text-[10px] font-mono tabular-nums">
      <span className="text-fg-subtle">{label}</span>
      <span>{value}</span>
    </span>
  );
}

interface Props {
  event: UsageEvent;
}

export function Usage({ event }: Props) {
  return (
    <div className="my-1 flex items-center gap-2 rounded-md border border-border bg-bg-elev px-2 py-1.5 text-[11px]">
      <span className="text-fg-subtle">∑</span>
      <div className="flex flex-wrap gap-1.5">
        <Metric label="in" value={event.inputTokens} />
        <Metric label="out" value={event.outputTokens} />
        {event.cachedInputTokens !== undefined && (
          <Metric label="cached" value={event.cachedInputTokens} />
        )}
        {event.reasoningTokens !== undefined && (
          <Metric label="reasoning" value={event.reasoningTokens} />
        )}
        {event.costUsd !== undefined && (
          <Metric label="usd" value={formatCost(event.costUsd)} />
        )}
      </div>
    </div>
  );
}
