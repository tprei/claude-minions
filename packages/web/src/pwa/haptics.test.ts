import { afterEach, describe, expect, it, vi } from "vitest";
import { hapticTap, isHapticsEnabled, setHapticsEnabled, vibrate } from "./haptics.js";
import { isReducedMotion } from "./motion.js";

vi.mock("./motion.js", () => ({
  isReducedMotion: vi.fn(() => false),
}));

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("haptics", () => {
  it("vibrates when haptics are enabled", () => {
    const vibrateMock = vi.fn();
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: vibrateMock,
    });

    vibrate([10, 20]);
    hapticTap();

    expect(vibrateMock).toHaveBeenNthCalledWith(1, [10, 20]);
    expect(vibrateMock).toHaveBeenNthCalledWith(2, 10);
  });

  it("suppresses vibration when disabled or reduced motion is active", () => {
    const vibrateMock = vi.fn();
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: vibrateMock,
    });

    setHapticsEnabled(false);
    expect(isHapticsEnabled()).toBe(false);
    vibrate(10);

    vi.mocked(isReducedMotion).mockReturnValue(true);
    setHapticsEnabled(true);
    expect(isHapticsEnabled()).toBe(false);
    vibrate(20);

    expect(vibrateMock).not.toHaveBeenCalled();
  });
});
