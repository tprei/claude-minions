import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runMigrations } from "../store/sqlite.js";
import { createLogger } from "../logger.js";
import { MemoryStore } from "./store.js";
import { renderPreamble } from "./preamble.js";

describe("renderPreamble", () => {
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

  test("returns empty string when no approved or pinned memories", () => {
    const result = renderPreamble(store);
    assert.equal(result, "");
  });

  test("renders approved memories grouped by kind", () => {
    store.insert({
      kind: "user",
      status: "approved",
      scope: "global",
      repoId: undefined,
      pinned: false,
      title: "User pref",
      body: "Always use TypeScript",
      proposedBy: undefined,
      proposedFromSession: undefined,
      reviewedBy: undefined,
      reviewedAt: undefined,
      rejectionReason: undefined,
      supersedes: undefined,
    });
    store.insert({
      kind: "project",
      status: "approved",
      scope: "global",
      repoId: undefined,
      pinned: false,
      title: "Project rule",
      body: "Use pnpm workspaces",
      proposedBy: undefined,
      proposedFromSession: undefined,
      reviewedBy: undefined,
      reviewedAt: undefined,
      rejectionReason: undefined,
      supersedes: undefined,
    });

    const result = renderPreamble(store);
    assert.ok(result.includes("## User memories"));
    assert.ok(result.includes("User pref"));
    assert.ok(result.includes("## Project memories"));
    assert.ok(result.includes("Project rule"));
  });

  test("renders pinned memories even if not approved", () => {
    store.insert({
      kind: "reference",
      status: "pending",
      scope: "global",
      repoId: undefined,
      pinned: true,
      title: "Pinned reference",
      body: "Important reference",
      proposedBy: undefined,
      proposedFromSession: undefined,
      reviewedBy: undefined,
      reviewedAt: undefined,
      rejectionReason: undefined,
      supersedes: undefined,
    });

    const result = renderPreamble(store);
    assert.ok(result.includes("Pinned reference"));
    assert.ok(result.includes("## References"));
  });

  test("excludes rejected memories", () => {
    store.insert({
      kind: "feedback",
      status: "rejected",
      scope: "global",
      repoId: undefined,
      pinned: false,
      title: "Rejected feedback",
      body: "This should not appear",
      proposedBy: undefined,
      proposedFromSession: undefined,
      reviewedBy: undefined,
      reviewedAt: undefined,
      rejectionReason: "Not useful",
      supersedes: undefined,
    });

    const result = renderPreamble(store);
    assert.ok(!result.includes("Rejected feedback"));
  });

  test("includes repo-scoped approved memories when repoId provided", () => {
    store.insert({
      kind: "project",
      status: "approved",
      scope: "repo",
      repoId: "my-repo",
      pinned: false,
      title: "Repo-specific rule",
      body: "Use Jest for testing",
      proposedBy: undefined,
      proposedFromSession: undefined,
      reviewedBy: undefined,
      reviewedAt: undefined,
      rejectionReason: undefined,
      supersedes: undefined,
    });

    const withRepo = renderPreamble(store, "my-repo");
    assert.ok(withRepo.includes("Repo-specific rule"));

    const withoutRepo = renderPreamble(store);
    assert.ok(!withoutRepo.includes("Repo-specific rule"));
  });
});
