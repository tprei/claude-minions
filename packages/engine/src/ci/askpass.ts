import { writeFile, chmod } from "node:fs/promises";
import path from "node:path";

export function askpassScript(): string {
  const token = process.env["GITHUB_TOKEN"] ?? "";
  return `#!/bin/sh\necho '${token.replace(/'/g, "'\\''")}'`;
}

export async function installAskpass(workspaceDir: string): Promise<void> {
  const scriptPath = path.join(workspaceDir, ".git-askpass.sh");
  await writeFile(scriptPath, askpassScript(), { encoding: "utf-8" });
  await chmod(scriptPath, 0o700);
  process.env["GIT_ASKPASS"] = scriptPath;
}
