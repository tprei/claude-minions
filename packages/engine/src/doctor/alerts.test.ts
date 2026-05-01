import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  Alert,
  AlertKind,
  AttentionFlag,
  DoctorCheck,
  ResourceSnapshot,
  Session,
  SessionStatus,
} from "@minions/shared";
import { computeAlerts, type AlertsInput } from "./alerts.js";

const NOW = new Date("2026-05-01T12:00:00.000Z");

function minutesAgo(mins: number): string {
  return new Date(NOW.getTime() - mins * 60_000).toISOString();
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const base: Session = {
    slug: overrides.slug ?? "s1",
    title: "t",
    prompt: "p",
    mode: "task",
    status: (overrides.status ?? "running") as SessionStatus,
    childSlugs: [],
    attention: [],
    quickActions: [],
    stats: {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 0,
      toolCalls: 0,
    },
    provider: "mock",
    createdAt: minutesAgo(0),
    updatedAt: minutesAgo(0),
    metadata: {},
  };
  return { ...base, ...overrides };
}

function attention(kind: AttentionFlag["kind"], raisedAt: string, message = "x"): AttentionFlag {
  return { kind, message, raisedAt };
}

function makeResource(overrides: Partial<ResourceSnapshot["disk"]> = {}): ResourceSnapshot {
  return {
    timestamp: NOW.toISOString(),
    cgroupAware: false,
    cpu: { usagePct: 0, limitCores: 1, cores: 1 },
    memory: { usedBytes: 0, limitBytes: 0, rssBytes: 0 },
    disk: {
      usedBytes: 0,
      totalBytes: 100_000_000_000,
      workspacePath: "/tmp",
      workspaceUsedBytes: 0,
      ...overrides,
    },
    eventLoop: { lagMs: 0 },
    sessions: { total: 0, running: 0, waiting: 0 },
  };
}

const OK_CHECK = (name: DoctorCheck["name"]): DoctorCheck => ({
  name,
  status: "ok",
  detail: "fine",
  checkedAt: NOW.toISOString(),
});

function baseInput(over: Partial<AlertsInput> = {}): AlertsInput {
  return {
    sessions: [],
    resource: makeResource(),
    checks: [OK_CHECK("provider-auth"), OK_CHECK("github-auth")],
    diskFloorBytes: 5_000_000_000,
    ciSelfHealMaxAttempts: 3,
    now: NOW,
    ...over,
  };
}

function findAlert(alerts: Alert[], kind: AlertKind): Alert {
  const a = alerts.find((x) => x.kind === kind);
  if (!a) throw new Error(`alert ${kind} missing`);
  return a;
}

describe("computeAlerts", () => {
  it("always returns one alert per kind, info severity at zero counts", () => {
    const alerts = computeAlerts(baseInput());
    const kinds: AlertKind[] = [
      "stalled-pending",
      "human-input-stuck",
      "automation-exhausted",
      "disk-pressure",
      "github-auth",
      "provider-auth",
      "repeated-ci-fail",
    ];
    assert.equal(alerts.length, kinds.length);
    for (const k of kinds) {
      const a = findAlert(alerts, k);
      assert.equal(a.severity, "info", `${k} should be info on a clean baseline`);
    }
  });

  it("stalled-pending: warn when >0, error when >5", () => {
    const stalled = (i: number) =>
      makeSession({ slug: `p${i}`, status: "pending", createdAt: minutesAgo(15) });
    const fresh = makeSession({ slug: "fresh", status: "pending", createdAt: minutesAgo(2) });

    const warn = computeAlerts(baseInput({ sessions: [stalled(1), stalled(2), fresh] }));
    const a1 = findAlert(warn, "stalled-pending");
    assert.equal(a1.severity, "warn");
    assert.equal(a1.count, 2);

    const err = computeAlerts(
      baseInput({ sessions: [stalled(1), stalled(2), stalled(3), stalled(4), stalled(5), stalled(6)] }),
    );
    const a2 = findAlert(err, "stalled-pending");
    assert.equal(a2.severity, "error");
    assert.equal(a2.count, 6);
  });

  it("human-input-stuck: warn for waiting_input + manual_intervention older than 5m", () => {
    const stuck = makeSession({
      slug: "stuck",
      status: "waiting_input",
      attention: [attention("manual_intervention", minutesAgo(7))],
    });
    const recentlyRaised = makeSession({
      slug: "fresh",
      status: "waiting_input",
      attention: [attention("manual_intervention", minutesAgo(2))],
    });
    const wrongStatus = makeSession({
      slug: "running",
      status: "running",
      attention: [attention("manual_intervention", minutesAgo(30))],
    });
    const wrongKind = makeSession({
      slug: "needs",
      status: "waiting_input",
      attention: [attention("needs_input", minutesAgo(30))],
    });

    const alerts = computeAlerts(
      baseInput({ sessions: [stuck, recentlyRaised, wrongStatus, wrongKind] }),
    );
    const a = findAlert(alerts, "human-input-stuck");
    assert.equal(a.severity, "warn");
    assert.equal(a.count, 1);
  });

  it("automation-exhausted: warn when ci_failed AND attempts >= max", () => {
    const exhausted = makeSession({
      slug: "ex",
      attention: [attention("ci_failed", minutesAgo(1))],
      metadata: { ciSelfHealAttempts: 3 },
    });
    const stillRetrying = makeSession({
      slug: "rt",
      attention: [attention("ci_failed", minutesAgo(1))],
      metadata: { ciSelfHealAttempts: 1 },
    });
    const noCiFailed = makeSession({
      slug: "ok",
      attention: [],
      metadata: { ciSelfHealAttempts: 5 },
    });

    const alerts = computeAlerts(
      baseInput({
        sessions: [exhausted, stillRetrying, noCiFailed],
        ciSelfHealMaxAttempts: 3,
      }),
    );
    const a = findAlert(alerts, "automation-exhausted");
    assert.equal(a.severity, "warn");
    assert.equal(a.count, 1);
  });

  it("disk-pressure: error when free disk < floor", () => {
    const tightInput = baseInput({
      resource: makeResource({ totalBytes: 10_000_000_000, usedBytes: 9_000_000_000 }),
      diskFloorBytes: 5_000_000_000,
    });
    const tight = findAlert(computeAlerts(tightInput), "disk-pressure");
    assert.equal(tight.severity, "error");
    assert.match(tight.detail ?? "", /below floor/);

    const roomyInput = baseInput({
      resource: makeResource({ totalBytes: 100_000_000_000, usedBytes: 1_000_000_000 }),
      diskFloorBytes: 5_000_000_000,
    });
    const roomy = findAlert(computeAlerts(roomyInput), "disk-pressure");
    assert.equal(roomy.severity, "info");
  });

  it("github-auth and provider-auth: warn when underlying check is degraded, error when error", () => {
    const degraded: DoctorCheck = {
      name: "github-auth",
      status: "degraded",
      detail: "no token",
      checkedAt: NOW.toISOString(),
    };
    const errored: DoctorCheck = {
      name: "provider-auth",
      status: "error",
      detail: "boom",
      checkedAt: NOW.toISOString(),
    };

    const alerts = computeAlerts(baseInput({ checks: [degraded, errored] }));
    const gh = findAlert(alerts, "github-auth");
    assert.equal(gh.severity, "warn");
    assert.equal(gh.detail, "no token");

    const prov = findAlert(alerts, "provider-auth");
    assert.equal(prov.severity, "error");
    assert.equal(prov.detail, "boom");
  });

  it("repeated-ci-fail: counts distinct PRs with ≥3 fails in last 1h", () => {
    const sessionWithPr = (
      slug: string,
      prUrl: string,
      attempts: number,
      raisedMinsAgo: number,
    ): Session =>
      makeSession({
        slug,
        attention: [attention("ci_failed", minutesAgo(raisedMinsAgo))],
        metadata: { ciSelfHealAttempts: attempts },
        pr: {
          number: 1,
          url: prUrl,
          state: "open",
          draft: false,
          base: "main",
          head: "feat",
          title: "t",
        },
      });

    const a1 = sessionWithPr("a1", "https://gh/test/pr/1", 3, 5);
    const a2 = sessionWithPr("a2", "https://gh/test/pr/1", 4, 10);
    const b = sessionWithPr("b", "https://gh/test/pr/2", 5, 20);
    const oldFail = sessionWithPr("old", "https://gh/test/pr/3", 4, 120);
    const tooFew = sessionWithPr("few", "https://gh/test/pr/4", 2, 5);

    const alerts = computeAlerts(baseInput({ sessions: [a1, a2, b, oldFail, tooFew] }));
    const r = findAlert(alerts, "repeated-ci-fail");
    assert.equal(r.severity, "warn");
    assert.equal(r.count, 2, "PRs 1 and 2 qualify; 3 (old) and 4 (too few) do not");
  });
});
