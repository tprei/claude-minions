import * as fsp from "node:fs/promises";
import { spawn } from "node:child_process";

/**
 * Abstracts filesystem operations that differ between local mode (host paths are real)
 * and docker mode (paths only exist inside the worker container, accessed via docker exec).
 *
 * Local mode: fsp operates directly on the host filesystem.
 * Docker mode: the engine never touches container-internal paths with fsp; instead it shells
 * out to `docker exec` for the operations that must cross the container boundary. Git commands
 * already cross that boundary via GitClient's commandPrefix — this handles the non-git fs ops.
 */
export interface WorkspaceFs {
  pathExists(path: string): Promise<boolean>;
  gitMarkerExists(path: string): Promise<boolean>;
  removeRecursive(path: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
}

export class HostFs implements WorkspaceFs {
  async pathExists(path: string): Promise<boolean> {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async gitMarkerExists(path: string): Promise<boolean> {
    try {
      await fsp.access(`${path}/.git`);
      return true;
    } catch {
      return false;
    }
  }

  async removeRecursive(path: string): Promise<void> {
    await fsp.rm(path, { recursive: true, force: true });
  }

  async ensureDir(path: string): Promise<void> {
    await fsp.mkdir(path, { recursive: true });
  }
}

export class DockerFs implements WorkspaceFs {
  private static readonly DEFAULT_TIMEOUT_MS = 30_000;

  constructor(
    private readonly commandPrefix: readonly string[],
    private readonly timeoutMs = DockerFs.DEFAULT_TIMEOUT_MS,
  ) {}

  private exec(args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const [bin, ...spawnArgs] = [...this.commandPrefix, ...args];
      if (!bin) {
        reject(new Error("DockerFs: commandPrefix is empty"));
        return;
      }
      const proc = spawn(bin, spawnArgs);
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let timedOut = false;
      let sigkillTimer: NodeJS.Timeout | undefined;
      const killTimer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        sigkillTimer = setTimeout(() => proc.kill("SIGKILL"), 1_000);
      }, this.timeoutMs);
      proc.stdout.on("data", (c: Buffer) => chunks.push(c));
      proc.stderr.on("data", (c: Buffer) => errChunks.push(c));
      proc.on("close", (code) => {
        clearTimeout(killTimer);
        if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
        if (code === 0) {
          resolve(Buffer.concat(chunks).toString("utf8").trim());
        } else {
          const cmd = [bin, ...spawnArgs].map((part) => JSON.stringify(part)).join(" ");
          const stderr = Buffer.concat(errChunks).toString("utf8").trim();
          const status = timedOut ? `timed out after ${this.timeoutMs}ms` : `exited ${code}`;
          reject(new Error(`${cmd} ${status}: ${stderr}`));
        }
      });
      proc.on("error", (err) => {
        clearTimeout(killTimer);
        if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
        reject(err);
      });
    });
  }

  async pathExists(path: string): Promise<boolean> {
    try {
      await this.exec(["test", "-e", path]);
      return true;
    } catch {
      return false;
    }
  }

  async gitMarkerExists(path: string): Promise<boolean> {
    try {
      await this.exec(["test", "-e", `${path}/.git`]);
      return true;
    } catch {
      return false;
    }
  }

  async removeRecursive(path: string): Promise<void> {
    await this.exec(["rm", "-rf", "--", path]);
  }

  async ensureDir(_path: string): Promise<void> {
    // In docker mode the operator owns container-side directory setup.
    // The engine does not create directories inside the container.
  }
}
