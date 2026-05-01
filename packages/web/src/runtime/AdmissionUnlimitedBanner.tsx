import { type ReactElement } from "react";
import { useConnectionStore } from "../connections/store.js";
import { useRuntimeStore } from "../store/runtimeStore.js";

interface Props {
  onOpenRuntime?: () => void;
}

export function AdmissionUnlimitedBanner({ onOpenRuntime }: Props): ReactElement | null {
  const activeId = useConnectionStore((s) => s.activeId);
  const slice = useRuntimeStore((s) => (activeId ? s.byConnection.get(activeId) : undefined));
  const enabled = slice?.effective?.["admissionUnlimited"] === true;

  if (!enabled) return null;

  return (
    <div
      role="alert"
      data-testid="admission-unlimited-banner"
      className="w-full flex items-center justify-center gap-3 px-4 py-1.5 bg-tone-err-bg text-tone-err-fg text-xs backdrop-blur border-b border-tone-err-border"
    >
      <span aria-hidden="true">⚠</span>
      <span>
        <span className="font-semibold">Admission caps disabled.</span>{" "}
        Engine accepting unlimited concurrent sessions — only the OS bounds
        resource usage.
      </span>
      {onOpenRuntime && (
        <button
          type="button"
          onClick={onOpenRuntime}
          className="underline underline-offset-2 hover:text-white"
        >
          Open runtime config
        </button>
      )}
    </div>
  );
}
