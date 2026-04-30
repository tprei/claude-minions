import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { DagNodeCiSummary, ServerEvent } from "@minions/shared";
import { DagRepo } from "./model.js";
import { EventBus } from "../bus/eventBus.js";
import { openStore } from "../store/sqlite.js";
import { createLogger } from "../logger.js";

function newDb(): ReturnType<typeof openStore> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-dag-model-"));
  return openStore({ path: path.join(dir, "engine.db"), log: createLogger("error") });
}

function seedDagWithNode(): { repo: DagRepo; bus: EventBus; nodeId: string; dagId: string } {
  const db = newDb();
  const bus = new EventBus();
  const repo = new DagRepo(db, bus);
  const dagId = "dag1";
  const now = new Date().toISOString();
  repo.insert({
    id: dagId,
    title: "t",
    goal: "g",
    status: "active",
    metadata: {},
    createdAt: now,
    updatedAt: now,
  });
  const node = repo.insertNode(
    dagId,
    {
      title: "n1",
      prompt: "p",
      status: "pending",
      dependsOn: [],
      metadata: {},
    },
    0,
  );
  return { repo, bus, nodeId: node.id, dagId };
}

describe("DagRepo ci_summary", () => {
  test("setNodeCiSummary persists summary and emits dag_node_updated", () => {
    const { repo, bus, nodeId, dagId } = seedDagWithNode();
    const events: ServerEvent[] = [];
    bus.onAny((e) => events.push(e));

    const summary: DagNodeCiSummary = {
      state: "failing",
      counts: { passed: 1, failed: 2, pending: 0 },
      checks: [
        { name: "build", bucket: "pass" },
        { name: "test", bucket: "fail" },
        { name: "lint", bucket: "fail" },
      ],
      prNumber: 42,
      prUrl: "https://example.test/pull/42",
      updatedAt: "2026-04-30T12:00:00.000Z",
    };

    repo.setNodeCiSummary(nodeId, summary);

    const reread = repo.getNode(nodeId);
    assert.deepEqual(reread?.ciSummary, summary);

    const emitted = events.filter((e) => e.kind === "dag_node_updated");
    assert.equal(emitted.length, 1);
    const ev = emitted[0]!;
    assert.equal(ev.kind, "dag_node_updated");
    if (ev.kind !== "dag_node_updated") return;
    assert.equal(ev.dagId, dagId);
    assert.equal(ev.node.id, nodeId);
    assert.deepEqual(ev.node.ciSummary, summary);
  });

  test("setNodeCiSummary(null) clears the summary", () => {
    const { repo, nodeId } = seedDagWithNode();
    repo.setNodeCiSummary(nodeId, {
      state: "passing",
      counts: { passed: 2, failed: 0, pending: 0 },
      checks: [],
      updatedAt: "2026-04-30T12:00:00.000Z",
    });
    assert.ok(repo.getNode(nodeId)?.ciSummary);
    repo.setNodeCiSummary(nodeId, null);
    assert.equal(repo.getNode(nodeId)?.ciSummary ?? null, null);
  });

  test("updateNode preserves existing ci_summary when patch omits it", () => {
    const { repo, nodeId } = seedDagWithNode();
    const summary: DagNodeCiSummary = {
      state: "passing",
      counts: { passed: 3, failed: 0, pending: 0 },
      checks: [{ name: "build", bucket: "pass" }],
      updatedAt: "2026-04-30T12:00:00.000Z",
    };
    repo.setNodeCiSummary(nodeId, summary);
    repo.updateNode(nodeId, { status: "running" });
    const reread = repo.getNode(nodeId);
    assert.equal(reread?.status, "running");
    assert.deepEqual(reread?.ciSummary, summary);
  });
});
