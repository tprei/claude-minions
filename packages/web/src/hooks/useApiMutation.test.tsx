import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useApiMutation, type UseApiMutationResult } from "./useApiMutation.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface PendingRequest {
  arg: string;
  signal: AbortSignal;
  resolve: (value: string) => void;
}

let container: HTMLDivElement;
let root: Root;
let current: UseApiMutationResult<string, string>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function Harness(props: {
  fn: (arg: string, signal: AbortSignal) => Promise<string>;
  onSuccess?: (result: string, arg: string) => void;
}) {
  current = useApiMutation(props.fn, { onSuccess: props.onSuccess });
  return null;
}

describe("useApiMutation", () => {
  it("aborts superseded requests and ignores stale resolutions", async () => {
    const requests: PendingRequest[] = [];
    const onSuccess = vi.fn();
    const fn = vi.fn((arg: string, signal: AbortSignal) => new Promise<string>((resolve) => {
      requests.push({ arg, signal, resolve });
    }));

    act(() => {
      root.render(createElement(Harness, { fn, onSuccess }));
    });

    let firstPromise: Promise<string | undefined> = Promise.resolve(undefined);
    act(() => {
      firstPromise = current.run("first");
    });
    expect(requests[0]?.arg).toBe("first");

    let secondPromise: Promise<string | undefined> = Promise.resolve(undefined);
    act(() => {
      secondPromise = current.run("second");
    });
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(requests[1]?.arg).toBe("second");

    await act(async () => {
      requests[1]?.resolve("second-result");
      await secondPromise;
    });

    expect(current.data).toBe("second-result");
    expect(current.loading).toBe(false);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith("second-result", "second");

    await act(async () => {
      requests[0]?.resolve("first-result");
      await firstPromise;
    });
    await flush();

    expect(current.data).toBe("second-result");
    expect(current.error).toBeNull();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
