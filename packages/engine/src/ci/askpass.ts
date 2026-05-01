import { writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { GithubAppAuth, loadAppConfigFromEnv } from "../github/app.js";

const SHIM_DIR = ".askpass";
const PAT_SHIM = "gh-pat.sh";
const APP_SHIM = "gh-app.sh";
const TOKEN_FILE = "token";

let installedShimPath: string | null = null;

function patShim(): string {
  const token = process.env["GITHUB_TOKEN"] ?? "";
  return `#!/bin/sh\nprintf '%s' '${token.replace(/'/g, "'\\''")}'\n`;
}

function appShim(tokenPath: string): string {
  const safe = tokenPath.replace(/'/g, "'\\''");
  return `#!/bin/sh\ncat '${safe}'\n`;
}

export async function installAskpass(workspaceDir: string): Promise<string> {
  const dir = path.join(workspaceDir, SHIM_DIR);
  await mkdir(dir, { recursive: true });

  const appConfig = loadAppConfigFromEnv();
  if (appConfig) {
    const tokenPath = path.join(dir, TOKEN_FILE);
    const auth = new GithubAppAuth(appConfig);
    const token = await auth.getInstallationToken();
    await writeFile(tokenPath, token, { encoding: "utf-8", mode: 0o600 });

    const scriptPath = path.join(dir, APP_SHIM);
    await writeFile(scriptPath, appShim(tokenPath), { encoding: "utf-8" });
    await chmod(scriptPath, 0o700);
    installedShimPath = scriptPath;
    return scriptPath;
  }

  const scriptPath = path.join(dir, PAT_SHIM);
  await writeFile(scriptPath, patShim(), { encoding: "utf-8" });
  await chmod(scriptPath, 0o700);
  installedShimPath = scriptPath;
  return scriptPath;
}

export function getAskpassPath(): string | null {
  return installedShimPath;
}

export function gitAuthEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!installedShimPath) return { ...base };
  return { ...base, GIT_ASKPASS: installedShimPath };
}
