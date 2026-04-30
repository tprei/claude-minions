import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import type { RepoBinding } from "@minions/shared";
import {
  registerRepoRoutes,
  fuzzyMatch,
  __resetFileCache,
  type GitRunner,
} from "../repos.js";
import { isEngineError } from "../../../errors.js";
import type { EngineContext } from "../../../context.js";

const REPO: RepoBinding = {
  id: "r1",
  label: "Repo 1",
  defaultBranch: "main",
};

const FIXTURE_FILES = [
  "src/utils.ts",
  "src/index.ts",
  "vendor/utils-helper.ts",
  "README.md",
  "packages/web/src/App.tsx",
  "packages/web/src/main.tsx",
  "packages/engine/src/cli.ts",
];

function buildContext(): EngineContext {
  const stub = {
    workspaceDir: "/tmp/minions-repos-test-workspace",
    getRepo: (id: string) => (id === REPO.id ? REPO : null),
  } as unknown as EngineContext;
  return stub;
}

interface BuildAppResult {
  app: FastifyInstance;
  callCount: () => number;
}

async function buildApp(runner?: GitRunner): Promise<BuildAppResult> {
  let calls = 0;
  const wrapped: GitRunner = async (bare, args) => {
    calls += 1;
    if (runner) return runner(bare, args);
    return FIXTURE_FILES.join("\n") + "\n";
  };
  const app = Fastify({ logger: false });
  app.setErrorHandler(async (err, _req, reply) => {
    if (isEngineError(err)) {
      await reply.status(err.status).send(err.toJSON());
      return;
    }
    await reply.status(500).send({ error: "internal", message: (err as Error).message });
  });
  registerRepoRoutes(app, buildContext(), { runner: wrapped });
  await app.ready();
  return { app, callCount: () => calls };
}

describe("repos route GET /api/repos/:id/files", () => {
  beforeEach(() => {
    __resetFileCache();
  });
  afterEach(() => {
    __resetFileCache();
  });

  it("ranks src/utils.ts above vendor/utils-helper.ts for q=utils", async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/repos/r1/files?q=utils" });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { items: string[] };
      const srcIdx = body.items.indexOf("src/utils.ts");
      const vendorIdx = body.items.indexOf("vendor/utils-helper.ts");
      assert.ok(srcIdx >= 0, "src/utils.ts should be present");
      assert.ok(vendorIdx >= 0, "vendor/utils-helper.ts should be present");
      assert.ok(srcIdx < vendorIdx, "src/utils.ts should rank above vendor/utils-helper.ts");
    } finally {
      await app.close();
    }
  });

  it("returns 404 when repo is missing", async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/repos/missing/files" });
      assert.equal(res.statusCode, 404);
      const body = res.json() as { error: string };
      assert.equal(body.error, "not_found");
    } finally {
      await app.close();
    }
  });

  it("clamps results to ?limit=5", async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/repos/r1/files?limit=5" });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { items: string[] };
      assert.equal(body.items.length, 5);
    } finally {
      await app.close();
    }
  });

  it("rejects ?limit=999 with 400", async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/repos/r1/files?limit=999" });
      assert.equal(res.statusCode, 400);
      const body = res.json() as { error: string };
      assert.equal(body.error, "bad_request");
    } finally {
      await app.close();
    }
  });

  it("caches the file list across requests within the TTL", async () => {
    const { app, callCount } = await buildApp();
    try {
      const r1 = await app.inject({ method: "GET", url: "/api/repos/r1/files?q=utils" });
      assert.equal(r1.statusCode, 200);
      const r2 = await app.inject({ method: "GET", url: "/api/repos/r1/files?q=index" });
      assert.equal(r2.statusCode, 200);
      assert.equal(callCount(), 1, "git runner should be invoked only once thanks to the cache");
    } finally {
      await app.close();
    }
  });
});

describe("fuzzyMatch", () => {
  it("returns prefix slice when query is empty", () => {
    const out = fuzzyMatch(["a", "b", "c", "d"], undefined, 2);
    assert.deepEqual(out, ["a", "b"]);
  });

  it("scores by indexOf * 1000 + length and drops misses", () => {
    const out = fuzzyMatch(
      ["src/utils.ts", "vendor/utils-helper.ts", "README.md"],
      "utils",
      10,
    );
    assert.deepEqual(out, ["src/utils.ts", "vendor/utils-helper.ts"]);
  });

  it("respects the limit argument when filtering", () => {
    const out = fuzzyMatch(["a-x.ts", "x-a.ts", "x-b.ts"], "x", 2);
    assert.equal(out.length, 2);
  });

  it("is case-insensitive", () => {
    const out = fuzzyMatch(["Src/Utils.ts"], "utils", 10);
    assert.deepEqual(out, ["Src/Utils.ts"]);
  });
});
