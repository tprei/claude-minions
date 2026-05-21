import { useState } from "react";
import { registerPush, usePushPermission } from "./push.js";
import type { Connection } from "../connections/store.js";

interface Props {
  conn: Connection;
  workflowId: string;
}

export function PushOptIn({ conn, workflowId }: Props) {
  const permission = usePushPermission();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (permission === "granted" || permission === "unsupported") return null;

  async function enable() {
    setLoading(true);
    setError(null);
    try {
      await registerPush(conn, workflowId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to enable notifications");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        className="btn text-xs"
        onClick={() => void enable()}
        disabled={loading}
      >
        {loading ? "Enabling…" : "Enable notifications"}
      </button>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
    </div>
  );
}
