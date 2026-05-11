import type { ReactElement } from "react";
import type { Workflow } from "@minions/engine";
import { Modal } from "../components/Modal.js";

interface Props {
  workflow: Workflow;
  onClose: () => void;
}

export function CostModal({ workflow, onClose }: Props): ReactElement {
  const taskCount = Object.keys(workflow.graph).length;

  return (
    <Modal open onClose={onClose} title="Workflow info">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-fg-subtle">Workflow ID</dt>
        <dd className="font-mono text-fg text-xs truncate">{workflow.id}</dd>
        <dt className="text-fg-subtle">Kind</dt>
        <dd className="font-mono text-fg">{workflow.kind}</dd>
        <dt className="text-fg-subtle">Status</dt>
        <dd className="font-mono text-fg">{workflow.status}</dd>
        <dt className="text-fg-subtle">Tasks</dt>
        <dd className="font-mono text-fg">{taskCount}</dd>
        <dt className="text-fg-subtle">Version</dt>
        <dd className="font-mono text-fg">{workflow.version}</dd>
      </dl>
    </Modal>
  );
}
