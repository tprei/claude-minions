const HAPTICS_OPT_OUT_KEY = "haptics_disabled";

function isReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isOptedOut(): boolean {
  try {
    return localStorage.getItem(HAPTICS_OPT_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

export function vibrate(pattern: number | number[]): void {
  if (isReducedMotion()) return;
  if (isOptedOut()) return;
  if (!("vibrate" in navigator)) return;
  navigator.vibrate(pattern);
}

export function setHapticsEnabled(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.removeItem(HAPTICS_OPT_OUT_KEY);
    } else {
      localStorage.setItem(HAPTICS_OPT_OUT_KEY, "1");
    }
  } catch {
    // storage unavailable, ignore
  }
}

export function isHapticsEnabled(): boolean {
  return !isReducedMotion() && !isOptedOut();
}
