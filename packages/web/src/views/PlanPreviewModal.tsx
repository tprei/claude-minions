import type { ReactElement } from "react";
import type { WorkflowSpec } from "@minions/engine";
import { Modal } from "../components/Modal.js";
import { Button } from "../components/Button.js";

interface PlanPreviewModalProps {
  open: boolean;
  spec: WorkflowSpec | null;
  onConfirm: (spec: WorkflowSpec) => void;
  onCancel: () => void;
  confirming: boolean;
}

export function PlanPreviewModal({
  open,
  spec,
  onConfirm,
  onCancel,
  confirming,
}: PlanPreviewModalProps): ReactElement {
  return (
    <Modal open={open} onClose={onCancel} title="Review plan before dispatching" className="max-w-2xl">
      <div className="flex flex-col gap-4">
        {spec && (
          <>
            <div className="flex items-center gap-2 text-xs text-fg-muted">
              <span className="font-medium text-fg">Kind:</span>
              <span className="pill bg-bg-elev px-2 py-0.5 text-fg-subtle">{spec.kind}</span>
              <span className="font-medium text-fg ml-2">Tasks:</span>
              <span className="text-fg-subtle">{spec.tasks.length}</span>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-bg-elev">
                    <th className="px-3 py-2 text-left font-medium text-fg-muted">ID</th>
                    <th className="px-3 py-2 text-left font-medium text-fg-muted">Title</th>
                    <th className="px-3 py-2 text-left font-medium text-fg-muted">Depends on</th>
                  </tr>
                </thead>
                <tbody>
                  {spec.tasks.map((task) => (
                    <tr key={task.id} className="border-b border-border last:border-0 hover:bg-bg-elev/50 transition-colors">
                      <td className="px-3 py-2 font-mono text-fg-subtle">{task.id.slice(0, 16)}</td>
                      <td className="px-3 py-2 text-fg">{task.title}</td>
                      <td className="px-3 py-2 text-fg-muted">
                        {task.dependsOn && task.dependsOn.length > 0
                          ? task.dependsOn.map((dep) => dep.slice(0, 16)).join(", ")
                          : <span className="text-fg-subtle italic">none</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onCancel} disabled={confirming}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => spec && onConfirm(spec)}
            disabled={confirming || !spec}
          >
            {confirming ? "Dispatching…" : "Confirm & dispatch"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
