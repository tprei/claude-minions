import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useConnectionStore } from "../connections/store.js";
import { useVersionStore } from "../store/version.js";
import { useFeature } from "./useFeature.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  if (container) document.body.removeChild(container);
  root = undefined;
  container = undefined;
  useConnectionStore.setState({ connections: [], activeId: null, _hydrated: false });
  useVersionStore.setState({ byConnection: new Map(), workflowVersions: new Map() });
});

function Probe({ feature, onValue }: { feature: string; onValue: (value: boolean) => void }) {
  onValue(useFeature(feature));
  return null;
}

describe("useFeature", () => {
  it("reads features from the active connection metadata", () => {
    const values: boolean[] = [];
    useConnectionStore.setState({ activeId: "conn-1", connections: [], _hydrated: true });
    useVersionStore.getState().setConnectionMeta("conn-1", {
      apiVersion: "workflow-v1",
      libraryVersion: "0.1.0",
      buildSha: "test",
      provider: "stub",
      features: ["voice-input"],
      repos: [],
      pluginSet: [],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(createElement(Probe, { feature: "voice-input", onValue: (value) => values.push(value) }));
    });

    expect(values.at(-1)).toBe(true);
  });
});
