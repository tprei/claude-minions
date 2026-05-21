import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Connection } from "../../connections/store.js";

vi.mock("../../transport/rest.js", () => ({
  getVapidPublicKey: vi.fn(),
  listPushSubscriptions: vi.fn(),
  subscribePush: vi.fn(),
  unsubscribePush: vi.fn(),
}));

import { isPushRegisteredForWorkflow, registerPush, unregisterPush } from "../push.js";
import { getVapidPublicKey, listPushSubscriptions, subscribePush, unsubscribePush } from "../../transport/rest.js";

const CONN: Connection = {
  id: "conn-push",
  label: "push",
  baseUrl: "http://engine-push",
  token: "tok",
  color: "#fff",
};

describe("push registration", () => {
  beforeEach(() => {
    vi.mocked(getVapidPublicKey).mockResolvedValue({ publicKey: "AQID" });
    vi.mocked(listPushSubscriptions).mockResolvedValue({ subscriptions: [] });
    vi.mocked(subscribePush).mockResolvedValue({ ok: true });
    vi.mocked(unsubscribePush).mockResolvedValue({ ok: true });
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: vi.fn(async () => "granted"),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(getVapidPublicKey).mockReset();
    vi.mocked(listPushSubscriptions).mockReset();
    vi.mocked(subscribePush).mockReset();
    vi.mocked(unsubscribePush).mockReset();
  });

  it("uses typed subscribe helper with workflowId and browser subscription", async () => {
    const subscription = {
      endpoint: "https://push.example/sub",
      toJSON: () => ({
        endpoint: "https://push.example/sub",
        keys: { p256dh: "p256dh", auth: "auth" },
      }),
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: vi.fn(async () => null),
            subscribe: vi.fn(async () => subscription),
          },
        }),
      },
    });

    await expect(registerPush(CONN, "wf-1")).resolves.toBe(true);

    expect(getVapidPublicKey).toHaveBeenCalledWith(CONN);
    expect(subscribePush).toHaveBeenCalledWith(CONN, {
      workflowId: "wf-1",
      subscription: {
        endpoint: "https://push.example/sub",
        keys: { p256dh: "p256dh", auth: "auth" },
      },
    });
  });

  it("reuses an existing browser subscription when binding another workflow", async () => {
    const existingSubscription = {
      endpoint: "https://push.example/sub",
      options: {
        applicationServerKey: Uint8Array.from([1, 2, 3]).buffer,
      },
      toJSON: () => ({
        endpoint: "https://push.example/sub",
        keys: { p256dh: "p256dh", auth: "auth" },
      }),
    };
    const subscribe = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: vi.fn(async () => existingSubscription),
            subscribe,
          },
        }),
      },
    });

    await expect(registerPush(CONN, "wf-2")).resolves.toBe(true);

    expect(subscribe).not.toHaveBeenCalled();
    expect(subscribePush).toHaveBeenCalledWith(CONN, {
      workflowId: "wf-2",
      subscription: {
        endpoint: "https://push.example/sub",
        keys: { p256dh: "p256dh", auth: "auth" },
      },
    });
  });

  it("re-subscribes when the existing browser subscription uses a different VAPID key", async () => {
    const unsubscribe = vi.fn(async () => true);
    const existingSubscription = {
      endpoint: "https://push.example/old",
      options: {
        applicationServerKey: Uint8Array.from([9, 9, 9]).buffer,
      },
      unsubscribe,
      toJSON: () => ({
        endpoint: "https://push.example/old",
        keys: { p256dh: "old-p256dh", auth: "old-auth" },
      }),
    };
    const replacementSubscription = {
      endpoint: "https://push.example/new",
      toJSON: () => ({
        endpoint: "https://push.example/new",
        keys: { p256dh: "new-p256dh", auth: "new-auth" },
      }),
    };
    const subscribe = vi.fn(async () => replacementSubscription);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: vi.fn(async () => existingSubscription),
            subscribe,
          },
        }),
      },
    });

    await expect(registerPush(CONN, "wf-3")).resolves.toBe(true);

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(subscribePush).toHaveBeenCalledWith(CONN, {
      workflowId: "wf-3",
      subscription: {
        endpoint: "https://push.example/new",
        keys: { p256dh: "new-p256dh", auth: "new-auth" },
      },
    });
  });

  it("reports subscribed only when the current workflow is bound to the browser endpoint", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: vi.fn(async () => ({
              endpoint: "https://push.example/sub",
            })),
          },
        }),
      },
    });
    vi.mocked(listPushSubscriptions).mockResolvedValue({
      subscriptions: [{ endpoint: "https://push.example/sub" }],
    });

    await expect(isPushRegisteredForWorkflow(CONN, "wf-1")).resolves.toBe(true);
    expect(listPushSubscriptions).toHaveBeenCalledWith(CONN, "wf-1");
  });

  it("reports unsubscribed when the browser endpoint is bound to a different workflow only", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: vi.fn(async () => ({
              endpoint: "https://push.example/sub",
            })),
          },
        }),
      },
    });
    vi.mocked(listPushSubscriptions).mockResolvedValue({
      subscriptions: [{ endpoint: "https://push.example/other" }],
    });

    await expect(isPushRegisteredForWorkflow(CONN, "wf-2")).resolves.toBe(false);
  });

  it("uses typed unsubscribe helper with workflowId and endpoint without tearing down the shared browser subscription", async () => {
    const unsubscribe = vi.fn(async () => true);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: vi.fn(async () => ({
              endpoint: "https://push.example/sub",
              unsubscribe,
            })),
          },
        }),
      },
    });

    await unregisterPush(CONN, "wf-1");

    expect(unsubscribePush).toHaveBeenCalledWith(CONN, "https://push.example/sub", "wf-1");
    expect(unsubscribe).not.toHaveBeenCalled();
  });
});
