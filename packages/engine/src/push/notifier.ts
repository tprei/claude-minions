import webpush from "web-push";
import type Database from "better-sqlite3";
import type { PushSubscriptionInfo } from "@minions/shared";
import type { Logger } from "../logger.js";

interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
}

export interface PushNotifierDeps {
  db: Database.Database;
  log: Logger;
  vapid: { publicKey: string; privateKey: string; subject: string };
}

export class PushNotifier {
  private readonly stmtInsert: import("better-sqlite3").Statement;
  private readonly stmtDelete: import("better-sqlite3").Statement;
  private readonly stmtList: import("better-sqlite3").Statement;
  private readonly stmtDeleteByEndpoint: import("better-sqlite3").Statement;

  constructor(private readonly deps: PushNotifierDeps) {
    webpush.setVapidDetails(
      deps.vapid.subject,
      deps.vapid.publicKey,
      deps.vapid.privateKey
    );

    this.stmtInsert = deps.db.prepare(
      `INSERT OR REPLACE INTO push_subscriptions(endpoint, p256dh, auth, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.stmtDelete = deps.db.prepare(
      `DELETE FROM push_subscriptions WHERE endpoint = ?`
    );
    this.stmtList = deps.db.prepare(
      `SELECT endpoint, p256dh, auth, user_agent, created_at FROM push_subscriptions`
    );
    this.stmtDeleteByEndpoint = this.stmtDelete;
  }

  subscribe(sub: PushSubscriptionInfo): void {
    this.stmtInsert.run(
      sub.endpoint,
      sub.keys.p256dh,
      sub.keys.auth,
      sub.userAgent ?? null,
      new Date().toISOString()
    );
  }

  unsubscribe(endpoint: string): void {
    this.stmtDelete.run(endpoint);
  }

  async notify(title: string, body: string, data?: Record<string, unknown>): Promise<void> {
    const rows = this.stmtList.all() as PushSubscriptionRow[];
    const payload = JSON.stringify({ title, body, data: data ?? {} });

    await Promise.all(
      rows.map(async (row) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: row.endpoint,
              keys: { p256dh: row.p256dh, auth: row.auth },
            },
            payload
          );
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 410) {
            this.stmtDeleteByEndpoint.run(row.endpoint);
            this.deps.log.info("push subscription expired, removed", { endpoint: row.endpoint.slice(0, 40) });
          } else {
            this.deps.log.warn("push notification failed", {
              endpoint: row.endpoint.slice(0, 40),
              error: (e as Error).message,
            });
          }
        }
      })
    );
  }
}
