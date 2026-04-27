import type { ReactElement } from "react";
import { useConnectionStore } from "./store.js";

interface QrImportProps {
  onDone: () => void;
}

export function QrImport({ onDone }: QrImportProps): ReactElement {
  const add = useConnectionStore(s => s.add);
  const setActive = useConnectionStore(s => s.setActive);

  function handleCandidate(candidate: { label: string; baseUrl: string; token: string; color: string }): void {
    const conn = add(candidate);
    setActive(conn.id);
    onDone();
  }

  return (
    <div className="card p-6 flex flex-col items-center gap-4 text-center">
      <p className="text-sm font-medium text-fg-muted">QR import</p>
      <p className="text-xs text-fg-subtle">
        QR scanning is provided by the pwa module (Web C).
        This slot emits a Connection candidate when a code is scanned.
      </p>
      <button
        className="btn text-xs"
        onClick={() => {
          handleCandidate({ label: "Scanned", baseUrl: "", token: "", color: "#7c5cff" });
        }}
      >
        Simulate scan
      </button>
    </div>
  );
}
