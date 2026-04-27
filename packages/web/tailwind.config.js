import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: "#0b0d12", soft: "#11141b", elev: "#161a23" },
        border: { DEFAULT: "#262a36", soft: "#1c2030" },
        accent: { DEFAULT: "#7c5cff", soft: "#a78bfa", muted: "#3a2c80" },
        ok: "#34d399",
        warn: "#f59e0b",
        err: "#f87171"
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"]
      }
    }
  },
  plugins: [typography]
};
