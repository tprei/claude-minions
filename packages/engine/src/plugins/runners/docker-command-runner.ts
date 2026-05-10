import type { CommandRunner, CommandRunOptions, CommandRunResult } from "../command-runner.js";
import { HostCommandRunner } from "./host-command-runner.js";

export class DockerCommandRunner implements CommandRunner {
  private readonly host: CommandRunner;

  constructor(private readonly commandPrefix: readonly string[], host?: CommandRunner) {
    this.host = host ?? new HostCommandRunner();
  }

  run(opts: CommandRunOptions): Promise<CommandRunResult> {
    const inner = `cd ${shQuote(opts.cwd)} && ${opts.command}`;
    const argv = [...this.commandPrefix, "sh", "-c", inner];
    const composed = argv.map(shQuote).join(" ");
    const next: CommandRunOptions = {
      cwd: process.cwd(),
      command: composed,
    };
    if (opts.timeoutMs !== undefined) next.timeoutMs = opts.timeoutMs;
    if (opts.env) next.env = opts.env;
    if (opts.signal) next.signal = opts.signal;
    return this.host.run(next);
  }
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
