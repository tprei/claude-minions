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
  constructor(private readonly commandPrefix: readonly string[]) {}

  private exec(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const [bin, ...args] = [...this.commandPrefix, "sh", "-c", cmd];
      if (!bin) {
        reject(new Error("DockerFs: commandPrefix is empty"));
        return;
      }
      const proc = spawn(bin, args);
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      proc.stdout.on("data", (c: Buffer) => chunks.push(c));
      proc.stderr.on("data", (c: Buffer) => errChunks.push(c));
      proc.on("close", (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks).toString("utf8").trim());
        } else {
          reject(new Error(`docker exec sh -c ${JSON.stringify(cmd)} exited ${code}: ${Buffer.concat(errChunks).toString("utf8").trim()}`));
        }
      });
      proc.on("error", reject);
    });
  }

  async pathExists(path: string): Promise<boolean> {
    try {
      await this.exec(`test -e ${JSON.stringify(path)} && echo y`);
      return true;
    } catch {
      return false;
    }
  }

  async gitMarkerExists(path: string): Promise<boolean> {
    try {
      await this.exec(`test -e ${JSON.stringify(path + "/.git")} && echo y`);
      return true;
    } catch {
      return false;
    }
  }

  async removeRecursive(path: string): Promise<void> {
    await this.exec(`rm -rf ${JSON.stringify(path)}`);
  }

  async ensureDir(_path: string): Promise<void> {
    // In docker mode the operator owns container-side directory setup.
    // The engine does not create directories inside the container.
  }
}
