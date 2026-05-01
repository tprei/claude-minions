import type {
  Alert,
  AlertKind,
  AlertSeverity,
  DoctorCheck,
  ResourceSnapshot,
  Session,
} from "@minions/shared";

const STALLED_PENDING_MS = 10 * 60 * 1000;
const HUMAN_INPUT_STUCK_MS = 5 * 60 * 1000;
const REPEATED_CI_FAIL_WINDOW_MS = 60 * 60 * 1000;
const REPEATED_CI_FAIL_MIN_ATTEMPTS = 3;

export interface AlertsInput {
  sessions: Session[];
  resource: ResourceSnapshot | null;
  checks: DoctorCheck[];
  diskFloorBytes: number;
  ciSelfHealMaxAttempts: number;
  now: Date;
}

export function computeAlerts(input: AlertsInput): Alert[] {
  return [
    stalledPendingAlert(input),
    humanInputStuckAlert(input),
    automationExhaustedAlert(input),
    diskPressureAlert(input),
    authAlertFromCheck("github-auth", input.checks),
    authAlertFromCheck("provider-auth", input.checks),
    repeatedCiFailAlert(input),
  ];
}

function alert(kind: AlertKind, severity: AlertSeverity, count?: number, detail?: string): Alert {
  const out: Alert = { kind, severity };
  if (count !== undefined) out.count = count;
  if (detail !== undefined) out.detail = detail;
  return out;
}

function parseDate(value: string | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function stalledPendingAlert(input: AlertsInput): Alert {
  const cutoff = input.now.getTime() - STALLED_PENDING_MS;
  let count = 0;
  for (const s of input.sessions) {
    if (s.status !== "pending") continue;
    const created = parseDate(s.createdAt);
    if (created === null) continue;
    if (created < cutoff) count += 1;
  }
  if (count === 0) return alert("stalled-pending", "info", 0);
  if (count > 5) {
    return alert("stalled-pending", "error", count, `${count} sessions pending >10m`);
  }
  return alert("stalled-pending", "warn", count, `${count} session${count === 1 ? "" : "s"} pending >10m`);
}

function humanInputStuckAlert(input: AlertsInput): Alert {
  const cutoff = input.now.getTime() - HUMAN_INPUT_STUCK_MS;
  let count = 0;
  for (const s of input.sessions) {
    if (s.status !== "waiting_input") continue;
    const stuck = s.attention.some((a) => {
      if (a.kind !== "manual_intervention") return false;
      const raised = parseDate(a.raisedAt);
      return raised !== null && raised < cutoff;
    });
    if (stuck) count += 1;
  }
  if (count === 0) return alert("human-input-stuck", "info", 0);
  return alert(
    "human-input-stuck",
    "warn",
    count,
    `${count} session${count === 1 ? "" : "s"} awaiting manual intervention >5m`,
  );
}

function automationExhaustedAlert(input: AlertsInput): Alert {
  const max = input.ciSelfHealMaxAttempts;
  let count = 0;
  for (const s of input.sessions) {
    const hasCiFailed = s.attention.some((a) => a.kind === "ci_failed");
    if (!hasCiFailed) continue;
    const raw = s.metadata["ciSelfHealAttempts"];
    const attempts = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    if (attempts >= max) count += 1;
  }
  if (count === 0) return alert("automation-exhausted", "info", 0);
  return alert(
    "automation-exhausted",
    "warn",
    count,
    `${count} session${count === 1 ? "" : "s"} with CI self-heal exhausted (max ${max})`,
  );
}

function diskPressureAlert(input: AlertsInput): Alert {
  const sample = input.resource;
  if (!sample || sample.disk.totalBytes <= 0) {
    return alert("disk-pressure", "info", 0, "no disk sample");
  }
  const free = Math.max(0, sample.disk.totalBytes - sample.disk.usedBytes);
  if (free < input.diskFloorBytes) {
    return alert(
      "disk-pressure",
      "error",
      undefined,
      `disk free ${free} below floor ${input.diskFloorBytes}`,
    );
  }
  return alert("disk-pressure", "info", 0, `disk free ${free} above floor ${input.diskFloorBytes}`);
}

function authAlertFromCheck(kind: "github-auth" | "provider-auth", checks: DoctorCheck[]): Alert {
  const check = checks.find((c) => c.name === kind);
  if (!check) return alert(kind, "info", 0, "check not run");
  if (check.status === "ok") return alert(kind, "info", 0, check.detail);
  if (check.status === "error") return alert(kind, "error", undefined, check.detail);
  return alert(kind, "warn", undefined, check.detail);
}

function repeatedCiFailAlert(input: AlertsInput): Alert {
  const cutoff = input.now.getTime() - REPEATED_CI_FAIL_WINDOW_MS;
  const prs = new Set<string>();
  for (const s of input.sessions) {
    if (!s.pr) continue;
    const ciFailed = s.attention.find((a) => a.kind === "ci_failed");
    if (!ciFailed) continue;
    const raised = parseDate(ciFailed.raisedAt);
    if (raised === null || raised < cutoff) continue;
    const raw = s.metadata["ciSelfHealAttempts"];
    const attempts = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    if (attempts >= REPEATED_CI_FAIL_MIN_ATTEMPTS) {
      prs.add(s.pr.url);
    }
  }
  const count = prs.size;
  if (count === 0) return alert("repeated-ci-fail", "info", 0);
  return alert(
    "repeated-ci-fail",
    "warn",
    count,
    `${count} PR${count === 1 ? "" : "s"} with ≥${REPEATED_CI_FAIL_MIN_ATTEMPTS} failed CI runs in last 1h`,
  );
}
