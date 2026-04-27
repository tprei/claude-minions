import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runMigrations } from "../store/sqlite.js";
import { createLogger } from "../logger.js";
import { MemoryStore } from "./store.js";

describe("MemoryStore", () => {
  let db: Database.Database;
  let store: MemoryStore;

  before(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, createLogger("error"));
    store = new MemoryStore(db);
  });

  after(() => {
    db.close();
  });

  test("insert and get by id", () => {
    const memory = store.insert({
      kind: "user",
      status: "pending",
      scope: "global",
      repoId: undefined,
      pinned: false,
      title: "Test memory",
      body: "This is a test",
      proposedBy: undefined,
      proposedFromSession: undefined,
      reviewedBy: undefined,
      reviewedAt: undefined,
      rejectionReason: undefined,
      supersedes: undefined,
    });

    assert.ok(memory.id);
    assert.equal(memory.kind, "user");
    assert.equal(memory.status, "pending");
    assert.equal(memory.title, "Test memory");
    assert.equal(memory.body, "This is a test");
    assert.equal(memory.pinned, false);

    const fetched = store.getById(memory.id);
    assert.ok(fetched);
    assert.equal(fetched.id, memory.id);
    assert.equal(fetched.title, "Test memory");
  });

  test("list returns all memories", () => {
    const before = store.list();

    store.insert({
      kind: "project",
      status: "approved",
      scope: "global",
      repoId: undefined,
      pinned: true,
      title: "Project memory",
      body: "Project details",
      proposedBy: undefined,
      proposedFromSession: undefined,
      reviewedBy: undefined,
      reviewedAt: undefined,
      rejectionReason: undefined,
      supersedes: undefined,
    });

    const after = store.list();
    assert.equal(after.length, before.length + 1);
  });

  test("filter by status", () => {
    store.insert({
      kind: "feedback",
      status: "rejected",
      scope: "global",
      repoId: undefined,
      pinned: false,
      title: "Rejected memory",
      body: "Bad feedback",
      proposedBy: undefined,
      proposedFromSession: undefined,
      reviewedBy: undefined,
      reviewedAt: undefined,
      rejectionReason: "Not relevant",
      supersedes: undefined,
    });

    const pending = store.list({ status: "pending" });
    const rejected = store.list({ status: "rejected" });

    for (const m of pending) {
      assert.equal(m.status, "pending");
    }
    for (const m of rejected) {
      assert.equal(m.status, "rejected");
    }
    assert.ok(rejected.length >= 1);
  });

  test("filter by kind", () => {
    store.insert({
      kind: "reference",
      status: "approved",
      scope: "global",
      repoId: undefined,
      pinned: false,
      title: "A reference",
      body: "Reference body",
      proposedBy: undefined,
      proposedFromSession: undefined,
      reviewedBy: undefined,
      reviewedAt: undefined,
      rejectionReason: undefined,
      supersedes: undefined,
    });

    const references = store.list({ kind: "reference" });
    for (const m of references) {
      assert.equal(m.kind, "reference");
    }
    assert.ok(references.length >= 1);
  });

  test("filter by scope and repoId", () => {
    store.insert({
      kind: "project",
      status: "approved",
      scope: "repo",
      repoId: "repo-abc",
      pinned: false,
      title: "Repo memory",
      body: "Repo-scoped",
      proposedBy: undefined,
      proposedFromSession: undefined,
      reviewedBy: undefined,
      reviewedAt: undefined,
      rejectionReason: undefined,
      supersedes: undefined,
    });

    const repoMemories = store.list({ scope: "repo", repoId: "repo-abc" });
    for (const m of repoMemories) {
      assert.equal(m.scope, "repo");
      assert.equal(m.repoId, "repo-abc");
    }
    assert.ok(repoMemories.length >= 1);
  });

  test("save updates memory", () => {
    const memory = store.insert({
      kind: "user",
      status: "pending",
      scope: "global",
      repoId: undefined,
      pinned: false,
      title: "Original title",
      body: "Original body",
      proposedBy: undefined,
      proposedFromSession: undefined,
      reviewedBy: undefined,
      reviewedAt: undefined,
      rejectionReason: undefined,
      supersedes: undefined,
    });

    const updated = store.save({ ...memory, title: "Updated title", status: "approved" });
    assert.equal(updated.title, "Updated title");
    assert.equal(updated.status, "approved");
  });

  test("remove deletes memory", () => {
    const memory = store.insert({
      kind: "user",
      status: "pending",
      scope: "global",
      repoId: undefined,
      pinned: false,
      title: "To delete",
      body: "Will be deleted",
      proposedBy: undefined,
      proposedFromSession: undefined,
      reviewedBy: undefined,
      reviewedAt: undefined,
      rejectionReason: undefined,
      supersedes: undefined,
    });

    store.remove(memory.id);
    const fetched = store.getById(memory.id);
    assert.equal(fetched, null);
  });
});
