import { describe, expect, it, vi, beforeEach } from "vitest";
import webpush from "web-push";

vi.mock("web-push", () => {
  return {
    default: {
      sendNotification: vi.fn().mockResolvedValue({}),
      setVapidDetails: vi.fn(),
    },
  };
});

const VAPID: import("../../src/plugins/push-sender.js").VapidConfig = {
  subject: "mailto:test@example.com",
  publicKey: "BFakePublicKey",
  privateKey: "FakePrivateKey",
};

describe("WebPushSender", () => {
  beforeEach(() => {
    vi.mocked(webpush.sendNotification).mockResolvedValue({} as never);
    vi.mocked(webpush.setVapidDetails).mockReset();
  });

  it("calls sendNotification with timeout and per-send vapidDetails", async () => {
    const { WebPushSender } = await import("../../src/plugins/push-sender.js");
    const sender = new WebPushSender(VAPID);

    await sender.send(
      { endpoint: "https://push.example.com/s1", keys: { p256dh: "key", auth: "auth" } },
      "payload",
    );

    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    const [, , options] = vi.mocked(webpush.sendNotification).mock.calls[0]!;
    expect(options).toMatchObject({
      timeout: 10_000,
      vapidDetails: {
        subject: VAPID.subject,
        publicKey: VAPID.publicKey,
        privateKey: VAPID.privateKey,
      },
    });
  });

  it("does not call setVapidDetails globally", async () => {
    const { WebPushSender } = await import("../../src/plugins/push-sender.js");
    new WebPushSender(VAPID);
    expect(webpush.setVapidDetails).not.toHaveBeenCalled();
  });

  it("returns ok:false with statusCode on WebPushError", async () => {
    const { WebPushSender } = await import("../../src/plugins/push-sender.js");
    const wpError = Object.assign(new Error("gone"), { statusCode: 410, body: "" });
    vi.mocked(webpush.sendNotification).mockRejectedValue(wpError);

    const sender = new WebPushSender(VAPID);
    const result = await sender.send(
      { endpoint: "https://push.example.com/s1", keys: { p256dh: "key", auth: "auth" } },
      "payload",
    );

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(410);
  });
});
