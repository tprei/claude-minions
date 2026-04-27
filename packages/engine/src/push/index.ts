import type { PushSubscriptionInfo } from "@minions/shared";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { PushNotifier } from "./notifier.js";

export interface PushSubsystem {
  vapidPublicKey: () => string | null;
  subscribe: (sub: PushSubscriptionInfo) => Promise<void>;
  unsubscribe: (endpoint: string) => Promise<void>;
  notify: (sessionSlug: string, title: string, body: string, data?: Record<string, unknown>) => Promise<void>;
}

export function createPushSubsystem(deps: SubsystemDeps): SubsystemResult<PushSubsystem> {
  if (!deps.env.vapid) {
    const api: PushSubsystem = {
      vapidPublicKey: () => null,
      async subscribe() {},
      async unsubscribe() {},
      async notify() {},
    };
    return { api };
  }

  const notifier = new PushNotifier({
    db: deps.db,
    log: deps.log,
    vapid: deps.env.vapid,
  });

  const seenAttentionPerSession = new Map<string, Set<string>>();

  deps.bus.on("session_updated", (event) => {
    const session = event.session;
    if (!session.attention || session.attention.length === 0) return;

    let seen = seenAttentionPerSession.get(session.slug);
    if (!seen) {
      seen = new Set();
      seenAttentionPerSession.set(session.slug, seen);
    }

    for (const flag of session.attention) {
      const key = `${flag.kind}:${flag.raisedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);

      notifier
        .notify(
          `${flag.kind} · ${session.title}`,
          flag.message,
          { slug: session.slug }
        )
        .catch((e: unknown) => {
          deps.log.warn("push notify failed on session_updated", { error: (e as Error).message });
        });
    }
  });

  const api: PushSubsystem = {
    vapidPublicKey() {
      return deps.env.vapid?.publicKey ?? null;
    },

    async subscribe(sub) {
      notifier.subscribe(sub);
    },

    async unsubscribe(endpoint) {
      notifier.unsubscribe(endpoint);
    },

    async notify(_sessionSlug, title, body, data) {
      await notifier.notify(title, body, data);
    },
  };

  return { api };
}
