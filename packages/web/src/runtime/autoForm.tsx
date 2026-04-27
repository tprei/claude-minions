import { useState } from "react";
import type { RuntimeField, RuntimeOverrides } from "@minions/shared";
import { cx } from "../util/classnames.js";

interface Props {
  field: RuntimeField;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  onReset: (key: string) => void;
}

export function AutoFormField({ field, value, onChange, onReset }: Props) {
  const [tagInput, setTagInput] = useState("");

  const currentValue = value ?? field.default;

  function addTag() {
    const trimmed = tagInput.trim();
    if (!trimmed) return;
    const list = Array.isArray(currentValue) ? (currentValue as string[]) : [];
    if (!list.includes(trimmed)) {
      onChange(field.key, [...list, trimmed]);
    }
    setTagInput("");
  }

  function removeTag(tag: string) {
    const list = Array.isArray(currentValue) ? (currentValue as string[]) : [];
    onChange(field.key, list.filter(t => t !== tag));
  }

  return (
    <div className="flex flex-col gap-1.5 py-3 border-b border-border last:border-0">
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium text-zinc-200 flex-1">{field.label}</label>
        {field.requiresRestart && (
          <span className="pill bg-orange-900/40 text-orange-300 text-[10px]">restart</span>
        )}
        <button
          type="button"
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          onClick={() => onReset(field.key)}
          title="Reset to default"
        >
          reset
        </button>
      </div>

      {field.description && (
        <p className="text-xs text-zinc-500">{field.description}</p>
      )}

      {field.type === "boolean" && (
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(currentValue)}
          className={cx(
            "w-10 h-5 rounded-full transition-colors relative",
            Boolean(currentValue) ? "bg-accent" : "bg-zinc-700"
          )}
          onClick={() => onChange(field.key, !Boolean(currentValue))}
        >
          <span className={cx(
            "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform",
            Boolean(currentValue) ? "translate-x-5" : "translate-x-0.5"
          )} />
        </button>
      )}

      {field.type === "number" && (
        <input
          type="number"
          className="input w-40"
          value={typeof currentValue === "number" ? currentValue : ""}
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          onChange={e => onChange(field.key, e.target.valueAsNumber)}
        />
      )}

      {field.type === "string" && (
        <input
          type="text"
          className="input"
          value={typeof currentValue === "string" ? currentValue : ""}
          onChange={e => onChange(field.key, e.target.value)}
        />
      )}

      {field.type === "enum" && (
        <select
          className="input w-auto max-w-xs"
          value={typeof currentValue === "string" ? currentValue : ""}
          onChange={e => onChange(field.key, e.target.value)}
        >
          {(field.enumValues ?? []).map(v => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      )}

      {field.type === "string-list" && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {(Array.isArray(currentValue) ? (currentValue as string[]) : []).map(tag => (
              <span
                key={tag}
                className="pill bg-bg-soft border border-border text-zinc-300 gap-1"
              >
                {tag}
                <button
                  type="button"
                  className="text-zinc-500 hover:text-zinc-200 ml-0.5"
                  onClick={() => removeTag(tag)}
                  aria-label={`Remove ${tag}`}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              className="input flex-1 text-sm"
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
              placeholder="Add value…"
            />
            <button type="button" className="btn text-sm" onClick={addTag}>Add</button>
          </div>
        </div>
      )}
    </div>
  );
}

interface GroupedFormProps {
  groups: { id: string; label: string }[];
  fields: RuntimeField[];
  values: RuntimeOverrides;
  onChange: (key: string, value: unknown) => void;
  onReset: (key: string) => void;
}

export function AutoForm({ groups, fields, values, onChange, onReset }: GroupedFormProps) {
  const ungrouped = fields.filter(f => !f.group);
  const groupedFields = groups.map(g => ({
    group: g,
    fields: fields.filter(f => f.group === g.id),
  })).filter(g => g.fields.length > 0);

  return (
    <div className="flex flex-col gap-0">
      {ungrouped.length > 0 && (
        <div className="px-4">
          {ungrouped.map(f => (
            <AutoFormField
              key={f.key}
              field={f}
              value={values[f.key]}
              onChange={onChange}
              onReset={onReset}
            />
          ))}
        </div>
      )}

      {groupedFields.map(({ group, fields: gFields }) => (
        <div key={group.id} className="mt-2">
          <h3 className="px-4 py-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider bg-bg-soft border-y border-border">
            {group.label}
          </h3>
          <div className="px-4">
            {gFields.map(f => (
              <AutoFormField
                key={f.key}
                field={f}
                value={values[f.key]}
                onChange={onChange}
                onReset={onReset}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
