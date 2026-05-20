import type { CommandRunner, CommandRunOptions, CommandRunResult } from "../command-runner.js";
import { HostCommandRunner } from "./host-command-runner.js";

export class DockerCommandRunner implements CommandRunner {
  private readonly host: CommandRunner;

  constructor(private readonly commandPrefix: readonly string[], host?: CommandRunner) {
    this.host = host ?? new HostCommandRunner();
  }

  run(opts: CommandRunOptions): Promise<CommandRunResult> {
    if (this.commandPrefix.length < 3) {
      return Promise.reject(new Error("docker command prefix must include the docker exec command and target container"));
    }
    const container = this.commandPrefix[this.commandPrefix.length - 1]!;
    const prefix = this.commandPrefix.slice(0, -1);
    const envArgs = Object.entries(opts.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    const next: CommandRunOptions = {
      cwd: process.cwd(),
      argv: [...prefix, ...envArgs, "--workdir", opts.cwd, container, ...opts.argv],
    };
    if (opts.timeoutMs !== undefined) next.timeoutMs = opts.timeoutMs;
    if (opts.signal) next.signal = opts.signal;
    return this.host.run(next);
  }
}
