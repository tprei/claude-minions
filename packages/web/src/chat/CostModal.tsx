import type { ReactElement } from "react";
import type { Session } from "@minions/shared";
import { Modal } from "../components/Modal.js";

interface Props {
  session: Session;
  onClose: () => void;
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function CostModal({ session, onClose }: Props): ReactElement {
  const costUsd = session.stats?.costUsd ?? 0;
  const budget = session.costBudgetUsd ?? null;
  const pctText =
    budget !== null && budget > 0
      ? `${Math.round((costUsd / budget) * 100)}%`
      : "no budget set";

  return (
    <Modal open onClose={onClose} title="Session cost">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-fg-subtle">Cost</dt>
        <dd className="font-mono text-fg" data-testid="cost-value">{formatUsd(costUsd)}</dd>
        <dt className="text-fg-subtle">Budget</dt>
        <dd className="font-mono text-fg" data-testid="cost-budget">
          {budget !== null ? formatUsd(budget) : "—"}
        </dd>
        <dt className="text-fg-subtle">Used</dt>
        <dd className="font-mono text-fg" data-testid="cost-pct">{pctText}</dd>
      </dl>
    </Modal>
  );
}
