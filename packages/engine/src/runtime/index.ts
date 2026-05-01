import type { RuntimeConfigSchema, RuntimeField, RuntimeOverrides } from "@minions/shared";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { RuntimeRepo } from "../store/repos/runtimeRepo.js";
import { runtimeConfigSchema } from "./schema.js";
import { registerRuntimeRoutes } from "./routes.js";
import { EngineError } from "../errors.js";

export interface RuntimeSubsystem {
  schema: () => RuntimeConfigSchema;
  values: () => RuntimeOverrides;
  effective: () => RuntimeOverrides;
  update: (patch: RuntimeOverrides) => Promise<void>;
}

const REDACTED = "[redacted]";

function buildDefaults(): RuntimeOverrides {
  const defaults: RuntimeOverrides = {};
  for (const field of runtimeConfigSchema.fields) {
    defaults[field.key] = field.default;
  }
  return defaults;
}

function isSecretField(field: RuntimeField): boolean {
  return (field as RuntimeField & { secret?: boolean }).secret === true;
}

function validatePatch(patch: RuntimeOverrides): void {
  const fieldMap = new Map(runtimeConfigSchema.fields.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(patch)) {
    const field = fieldMap.get(key);
    if (!field) {
      throw new EngineError("bad_request", `Unknown runtime config key: ${key}`);
    }
    if (field.type === "number") {
      if (typeof value !== "number") {
        throw new EngineError("bad_request", `${key} must be a number`);
      }
      if (field.min !== undefined && value < field.min) {
        throw new EngineError("bad_request", `${key} must be >= ${field.min}`);
      }
      if (field.max !== undefined && value > field.max) {
        throw new EngineError("bad_request", `${key} must be <= ${field.max}`);
      }
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new EngineError("bad_request", `${key} must be a boolean`);
      }
    } else if (field.type === "string") {
      if (typeof value !== "string") {
        throw new EngineError("bad_request", `${key} must be a string`);
      }
    } else if (field.type === "enum") {
      if (typeof value !== "string") {
        throw new EngineError("bad_request", `${key} must be a string`);
      }
      if (field.enumValues && !field.enumValues.includes(value)) {
        throw new EngineError("bad_request", `${key} must be one of: ${field.enumValues.join(", ")}`);
      }
    }
  }
}

export function createRuntimeSubsystem(deps: SubsystemDeps): SubsystemResult<RuntimeSubsystem> {
  const { db, ctx, bus } = deps;

  const repo = new RuntimeRepo(db);
  const defaults = buildDefaults();

  function schema(): RuntimeConfigSchema {
    return runtimeConfigSchema;
  }

  function values(): RuntimeOverrides {
    return repo.read();
  }

  function effective(): RuntimeOverrides {
    const overrides = repo.read();
    const merged: RuntimeOverrides = { ...defaults, ...overrides };
    if (merged.overnightProfile === true) {
      merged.admissionTotalSlots = merged.overnightAdmissionTotalSlots;
      merged.cleanupOlderThanDays = merged.overnightCleanupRetentionDays;
      merged.ciSelfHealMaxAttempts = merged.overnightCiSelfHealMaxAttempts;
    }
    return merged;
  }

  async function update(patch: RuntimeOverrides): Promise<void> {
    validatePatch(patch);
    const current = repo.read();
    const effectiveBefore = { ...defaults, ...current };
    const next = { ...current, ...patch };
    repo.write(next);

    const fieldMap = new Map(runtimeConfigSchema.fields.map((f) => [f.key, f]));
    for (const [key, value] of Object.entries(patch)) {
      const before = effectiveBefore[key];
      if (JSON.stringify(before) === JSON.stringify(value)) continue;
      const field = fieldMap.get(key);
      const secret = field ? isSecretField(field) : false;
      ctx.audit.record(
        "operator",
        "runtime.override",
        { kind: "runtime-field", id: key },
        {
          fieldPath: key,
          oldValue: secret ? REDACTED : before,
          newValue: secret ? REDACTED : value,
        },
      );

      if (key === "admissionUnlimited") {
        ctx.audit.record(
          "operator",
          value === true
            ? "runtime.admission.unlimited.enabled"
            : "runtime.admission.unlimited.disabled",
          { kind: "runtime-field", id: key },
          { previous: before === true },
        );
      }
    }

    const sessions = ctx.sessions.list();
    if (sessions.length > 0) {
      const s = sessions[0];
      if (s) {
        bus.emit({ kind: "session_updated", session: s });
      }
    }
  }

  return {
    api: { schema, values, effective, update },
    registerRoutes(app) {
      registerRuntimeRoutes(app, ctx);
    },
  };
}
