import type { ReactElement } from "react";
import { applyUpdate, useSwState } from "./sw.js";

export function UpdateBanner(): ReactElement | null {
  const { needRefresh, registrationError } = useSwState();

  if (registrationError) {
    return (
      <div
        role="alert"
        data-testid="sw-error-banner"
        className="fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-2 py-2 px-4 bg-tone-err-bg text-tone-err-fg text-sm backdrop-blur border-b border-tone-err-border"
      >
        <span>Service worker registration failed: {registrationError}</span>
      </div>
    );
  }

  if (!needRefresh) return null;

  return (
    <button
      type="button"
      data-testid="sw-update-banner"
      onClick={() => void applyUpdate()}
      className="fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-3 py-2 px-4 bg-accent/90 text-bg text-sm font-medium backdrop-blur border-b border-accent hover:bg-accent transition-colors"
    >
      <span>New version available</span>
      <span className="underline">click to reload</span>
    </button>
  );
}
