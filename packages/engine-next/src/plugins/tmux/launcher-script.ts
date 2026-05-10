export interface LauncherSpec {
  command: string[];
  env?: Record<string, string>;
  cwd?: string;
  socketName: string;
  releaseToken: string;
  tmuxBin?: string;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quoteShellArg(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function buildLauncherScript(spec: LauncherSpec): string {
  const tmux = spec.tmuxBin ?? "tmux";
  const lines: string[] = ["#!/bin/sh"];

  // wait-for runs BEFORE cd so the engine can finish setup (set remain-on-exit,
  // pipe-pane) and release us atomically. If cd then fails, the pane dies with
  // remain-on-exit already set — the failure is captured in the log instead of
  // hanging the engine on a wait-for that never gets sent.
  if (spec.env !== undefined) {
    for (const [key, value] of Object.entries(spec.env)) {
      if (!ENV_KEY_RE.test(key)) {
        throw new Error(`invalid env var name: ${JSON.stringify(key)}`);
      }
      lines.push(`export ${key}=${quoteShellArg(value)}`);
    }
  }

  lines.push(
    `${quoteShellArg(tmux)} -L ${quoteShellArg(spec.socketName)} wait-for ${quoteShellArg(spec.releaseToken)}`,
  );

  if (spec.cwd !== undefined) {
    // Fail fast if the workspace is missing — never run the user command in tmux's default cwd.
    lines.push(`cd ${quoteShellArg(spec.cwd)} || exit $?`);
  }

  const quotedArgv = spec.command.map(quoteShellArg).join(" ");
  lines.push(`exec ${quotedArgv}`);

  return lines.join("\n") + "\n";
}
