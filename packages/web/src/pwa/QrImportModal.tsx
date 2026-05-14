import { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
import QrScanner from "qr-scanner";
import type { VersionInfo } from "@minions/shared";

interface ConnectionPayload {
  label: string;
  baseUrl: string;
  token: string;
  color?: string;
}

interface Props {
  onImport: (payload: ConnectionPayload) => void;
  onClose: () => void;
}

function isConnectionPayload(v: unknown): v is ConnectionPayload {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj["label"] === "string" &&
    typeof obj["baseUrl"] === "string" &&
    typeof obj["token"] === "string"
  );
}

export function QrImportModal({ onImport, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const statusRef = useRef<"scanning" | "validating" | "error" | "done">("scanning");
  const [status, setStatus] = useState<"scanning" | "validating" | "error" | "done">("scanning");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [manualPayload, setManualPayload] = useState("");

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const importPayload = useCallback(async (data: string): Promise<void> => {
    setStatus("validating");
    setErrorMsg(null);

    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new Error("QR code is not valid JSON");
      }

      if (!isConnectionPayload(parsed)) {
        throw new Error("QR payload missing required fields: label, baseUrl, token");
      }

      const url = `${parsed.baseUrl.replace(/\/$/, "")}/version`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${parsed.token}` },
      });

      if (!res.ok) {
        throw new Error(`Server responded ${res.status} - check baseUrl and token`);
      }

      await res.json() as VersionInfo;

      setStatus("done");
      onImport(parsed);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Validation failed");
      setStatus("error");
    }
  }, [onImport]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const scanner = new QrScanner(
      video,
      async (result) => {
        if (statusRef.current !== "scanning") return;
        scanner.stop();
        await importPayload(result.data);
      },
      {
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        highlightCodeOutline: true,
      }
    );

    scannerRef.current = scanner;

    scanner.start().catch(err => {
      setErrorMsg(err instanceof Error ? err.message : "Camera unavailable");
      setStatus("error");
    });

    return () => {
      scanner.stop();
      scanner.destroy();
    };
  }, [importPayload]);

  function retry() {
    setErrorMsg(null);
    setStatus("scanning");
    scannerRef.current?.start().catch(() => {
      setStatus("error");
      setErrorMsg("Camera unavailable");
    });
  }

  function submitManualPayload(e: FormEvent): void {
    e.preventDefault();
    const data = manualPayload.trim();
    if (!data) return;
    void importPayload(data);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal
      aria-label="Scan QR code"
    >
      <div className="card flex flex-col gap-4 w-full max-w-sm p-4">
        <div className="flex items-center">
          <h2 className="text-sm font-semibold text-fg-muted flex-1">Import via QR</h2>
          <button className="btn p-1.5" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="relative rounded-lg overflow-hidden bg-black aspect-square">
          <video
            ref={videoRef}
            className="w-full h-full object-cover"
            muted
            playsInline
          />
          {status === "validating" && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60">
              <div className="w-6 h-6 rounded-full border-2 border-accent border-t-transparent animate-spin" />
            </div>
          )}
          {status === "done" && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60">
              <span className="text-4xl">✓</span>
            </div>
          )}
        </div>

        {status === "error" && (
          <div className="flex flex-col gap-2">
            <p className="text-red-400 text-sm">{errorMsg}</p>
            <button className="btn text-sm" onClick={retry}>Try again</button>
          </div>
        )}

        {status === "scanning" && (
          <p className="text-xs text-fg-subtle text-center">
            Point camera at a Minions connection QR code
          </p>
        )}

        <form className="flex flex-col gap-2" onSubmit={submitManualPayload}>
          <label className="text-xs text-fg-muted" htmlFor="qr-payload">QR payload</label>
          <textarea
            id="qr-payload"
            data-testid="qr-payload-input"
            className="input min-h-20 text-xs"
            value={manualPayload}
            onChange={e => setManualPayload(e.target.value)}
            spellCheck={false}
          />
          <ButtonLikeSubmit disabled={status === "validating"} />
        </form>
      </div>
    </div>
  );
}

function ButtonLikeSubmit({ disabled }: { disabled: boolean }) {
  return (
    <button
      type="submit"
      data-testid="qr-payload-submit"
      disabled={disabled}
      className="btn text-sm justify-center"
    >
      Import payload
    </button>
  );
}
