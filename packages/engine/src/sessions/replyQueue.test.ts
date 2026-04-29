import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrations } from "../store/migrations.js";
import { ReplyQueue } from "./replyQueue.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

interface Row {
  id: string;
  payload: string;
  claim_token: string | null;
  claimed_at: string | null;
}

function readRows(db: Database.Database, slug: string): Row[] {
  return db
    .prepare(
      `SELECT id, payload, claim_token, claimed_at FROM reply_queue
        WHERE session_slug = ? AND delivered_at IS NULL
        ORDER BY queued_at ASC`,
    )
    .all(slug) as Row[];
}

describe("ReplyQueue claim/confirm/release", () => {
  let db: Database.Database;
  let queue: ReplyQueue;

  beforeEach(() => {
    db = makeDb();
    queue = new ReplyQueue(db);
  });

  afterEach(() => {
    db.close();
  });

  test("claim returns null when there are no pending entries", () => {
    assert.equal(queue.claim("sess-empty"), null);
  });

  test("claim marks pending rows in_flight with a claim token and preserves order", () => {
    queue.enqueue("sess-a", "first");
    queue.enqueue("sess-a", "second");
    queue.enqueue("sess-b", "other-slug");

    const claim = queue.claim("sess-a");
    assert.ok(claim);
    assert.equal(claim.entries.length, 2);
    assert.deepEqual(
      claim.entries.map((e) => e.payload),
      ["first", "second"],
    );
    assert.match(claim.claimToken, /.+/);

    const sessARows = readRows(db, "sess-a");
    assert.equal(sessARows.length, 2);
    for (const row of sessARows) {
      assert.equal(row.claim_token, claim.claimToken);
      assert.ok(row.claimed_at);
    }

    const sessBRows = readRows(db, "sess-b");
    assert.equal(sessBRows.length, 1);
    assert.equal(sessBRows[0]?.claim_token, null);
  });

  test("a second claim while one is in_flight returns null (no double-claim)", () => {
    queue.enqueue("sess-c", "only");
    const first = queue.claim("sess-c");
    assert.ok(first);

    const second = queue.claim("sess-c");
    assert.equal(second, null, "in-flight rows must not be re-claimed by another caller");
  });

  test("confirm deletes only the claimed rows and not later enqueues", () => {
    queue.enqueue("sess-d", "first");
    const claim = queue.claim("sess-d");
    assert.ok(claim);

    queue.enqueue("sess-d", "arrived-after-claim");

    queue.confirm(claim.claimToken);

    const remaining = readRows(db, "sess-d");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.payload, "arrived-after-claim");
    assert.equal(remaining[0]?.claim_token, null);
  });

  test("release returns claimed rows back to pending so the next claim picks them up", () => {
    queue.enqueue("sess-e", "alpha");
    queue.enqueue("sess-e", "beta");

    const first = queue.claim("sess-e");
    assert.ok(first);
    queue.release(first.claimToken);

    const rowsAfterRelease = readRows(db, "sess-e");
    assert.equal(rowsAfterRelease.length, 2);
    for (const row of rowsAfterRelease) {
      assert.equal(row.claim_token, null);
      assert.equal(row.claimed_at, null);
    }

    const second = queue.claim("sess-e");
    assert.ok(second);
    assert.equal(second.entries.length, 2);
    assert.deepEqual(
      second.entries.map((e) => e.payload),
      ["alpha", "beta"],
    );
  });

  test("recoverInFlight releases claims older than the cutoff, leaves fresh claims alone", () => {
    queue.enqueue("sess-f", "stale");
    const stale = queue.claim("sess-f");
    assert.ok(stale);

    const stalePast = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`UPDATE reply_queue SET claimed_at = ? WHERE claim_token = ?`).run(
      stalePast,
      stale.claimToken,
    );

    queue.enqueue("sess-g", "fresh");
    const fresh = queue.claim("sess-g");
    assert.ok(fresh);

    const released = queue.recoverInFlight(30_000);
    assert.equal(released, 1, "only the stale claim should be released");

    const reclaimedStale = queue.claim("sess-f");
    assert.ok(reclaimedStale, "stale row is now claimable again after recovery");
    assert.equal(reclaimedStale.entries[0]?.payload, "stale");

    const freshRows = readRows(db, "sess-g");
    assert.equal(freshRows[0]?.claim_token, fresh.claimToken, "fresh claim is untouched");
  });

  test("confirm followed by recoverInFlight is a no-op", () => {
    queue.enqueue("sess-h", "done");
    const claim = queue.claim("sess-h");
    assert.ok(claim);
    queue.confirm(claim.claimToken);

    const released = queue.recoverInFlight(0);
    assert.equal(released, 0);
    assert.equal(readRows(db, "sess-h").length, 0);
  });
});
