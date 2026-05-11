export interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandRunOptions {
  cwd: string;
  command: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CommandRunner {
  run(opts: CommandRunOptions): Promise<CommandRunResult>;
}
