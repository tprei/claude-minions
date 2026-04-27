export type RuntimeFieldType =
  | "boolean"
  | "number"
  | "string"
  | "enum"
  | "string-list";

export interface RuntimeField {
  key: string;
  label: string;
  description?: string;
  type: RuntimeFieldType;
  default: unknown;
  enumValues?: string[];
  min?: number;
  max?: number;
  step?: number;
  group?: string;
  requiresRestart?: boolean;
}

export interface RuntimeConfigSchema {
  groups: { id: string; label: string }[];
  fields: RuntimeField[];
}

export type RuntimeOverrides = Record<string, unknown>;

export interface RuntimeConfigResponse {
  schema: RuntimeConfigSchema;
  values: RuntimeOverrides;
  effective: RuntimeOverrides;
}
