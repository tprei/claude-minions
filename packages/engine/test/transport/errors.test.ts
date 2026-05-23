import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { domainErrorToHttp } from "../../src/transport/errors.js";

describe("domainErrorToHttp", () => {
  it("maps not_found to 404", () => {
    const err = new DomainError("not_found", "missing");
    expect(domainErrorToHttp(err).status).toBe(404);
  });

  it("maps invalid_workflow to 400", () => {
    const err = new DomainError("invalid_workflow", "bad");
    expect(domainErrorToHttp(err).status).toBe(400);
  });

  it("maps version_conflict to 409", () => {
    const err = new DomainError("version_conflict", "conflict");
    expect(domainErrorToHttp(err).status).toBe(409);
  });

  it("maps invalid_plan to 422", () => {
    const err = new DomainError("invalid_plan", "bad plan");
    expect(domainErrorToHttp(err).status).toBe(422);
  });

  it("onError handler returns mapped status for DomainError and does not crash", async () => {
    const { NoopRestackExecutor } = await import("../../src/application/restack-executor.js");
    const { InMemoryWorkflowRepository } = await import("../../src/application/repository.js");
    const { createRecoveryService } = await import("../../src/application/recovery-service.js");
    const { silentLogger } = await import("../test-helpers.js");
    const { StubRuntimeBackend } = await import("../../src/plugins/stub-runtime.js");
    const { createServer } = await import("../../src/transport/server.js");

    const repo = new InMemoryWorkflowRepository();
    const executor = new NoopRestackExecutor();
    const runtime = new StubRuntimeBackend();
    const recoveryService = createRecoveryService(repo, executor, runtime, () => "2026-05-10T00:00:00.000Z", silentLogger());
    const app = createServer({ repo, recoveryService, executor });

    app.get("/test/invalid-plan-error", () => {
      throw new DomainError("invalid_plan", "bad plan body");
    });

    const res = await app.request("/test/invalid-plan-error");
    expect(res.status).toBe(422);
    const body = await res.json() as { code: string; message: string };
    expect(body.code).toBe("invalid_plan");
    expect(body.message).toBe("bad plan body");
  });
});
