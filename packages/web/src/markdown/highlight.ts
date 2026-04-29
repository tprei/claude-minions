import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import shell from "highlight.js/lib/languages/shell";
import python from "highlight.js/lib/languages/python";
import diff from "highlight.js/lib/languages/diff";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("python", python);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);

const ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  sh: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  html: "xml",
  svg: "xml",
  py: "python",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function highlight(code: string, lang?: string): string {
  try {
    const normalized = lang ? (ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()) : undefined;
    if (normalized && hljs.getLanguage(normalized)) {
      return hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}
