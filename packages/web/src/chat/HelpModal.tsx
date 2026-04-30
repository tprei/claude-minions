import type { ReactElement } from "react";
import { Modal } from "../components/Modal.js";
import { slashCommands } from "./slashCommands.js";

interface Props {
  onClose: () => void;
}

function formatArgs(cmd: { args: { name: string; required?: boolean }[] }): string {
  return cmd.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
}

export function HelpModal({ onClose }: Props): ReactElement {
  return (
    <Modal open onClose={onClose} title="Slash commands" className="max-w-2xl">
      <ul className="max-h-[60vh] overflow-y-auto divide-y divide-border">
        {slashCommands.map((cmd) => (
          <li
            key={cmd.name}
            data-testid={`help-row-${cmd.name}`}
            className="flex items-baseline gap-3 py-2 text-sm"
          >
            <span className="font-mono text-accent-soft whitespace-nowrap">
              /{cmd.name}
              {cmd.args.length > 0 && (
                <span className="ml-1 text-fg-subtle text-xs">{formatArgs(cmd)}</span>
              )}
            </span>
            <span className="text-fg-muted text-xs ml-auto truncate">{cmd.hint}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
