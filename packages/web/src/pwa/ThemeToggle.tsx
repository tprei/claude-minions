import { useState, useEffect } from "react";
import { setTheme, currentTheme, subscribeTheme } from "./theme.js";
import type { Theme } from "./theme.js";
import { cx } from "../util/classnames.js";

const THEMES: { id: Theme; label: string }[] = [
  { id: "light", label: "☀" },
  { id: "dark", label: "☾" },
  { id: "system", label: "⊙" },
];

export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(() => currentTheme());

  useEffect(() => {
    return subscribeTheme(t => setThemeState(t));
  }, []);

  return (
    <div
      className="flex items-center gap-0.5 rounded-lg border border-border bg-bg-soft p-0.5"
      role="group"
      aria-label="Theme"
    >
      {THEMES.map(t => (
        <button
          key={t.id}
          className={cx(
            "px-2 py-1 rounded-md text-sm transition-colors",
            theme === t.id
              ? "bg-bg-elev text-zinc-200"
              : "text-zinc-500 hover:text-zinc-300"
          )}
          onClick={() => setTheme(t.id)}
          aria-pressed={theme === t.id}
          title={t.id.charAt(0).toUpperCase() + t.id.slice(1)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
