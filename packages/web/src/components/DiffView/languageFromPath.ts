const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  javascript: "javascript",
  json: "json",
  sh: "bash",
  zsh: "bash",
  bash: "bash",
  py: "python",
  python: "python",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  xml: "xml",
  html: "xml",
  htm: "xml",
  svg: "xml",
  css: "css",
};

export function languageFromPath(path: string): string | undefined {
  const m = path.match(/\.([a-z0-9]+)$/i);
  if (!m || !m[1]) return undefined;
  return EXT_TO_LANG[m[1].toLowerCase()];
}
