import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { EngineError } from "../errors.js";

export interface GithubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}

export function appConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env["MINIONS_GH_APP_ID"] &&
      env["MINIONS_GH_APP_PRIVATE_KEY"] &&
      env["MINIONS_GH_APP_INSTALLATION_ID"],
  );
}

export function loadAppConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GithubAppConfig | null {
  const appId = env["MINIONS_GH_APP_ID"];
  const privateKey = env["MINIONS_GH_APP_PRIVATE_KEY"];
  const installationId = env["MINIONS_GH_APP_INSTALLATION_ID"];
  if (!appId || !privateKey || !installationId) return null;
  return { appId, privateKey, installationId };
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function resolvePrivateKey(privateKey: string): string {
  if (privateKey.startsWith("-----BEGIN")) return privateKey;
  return readFileSync(privateKey, "utf8");
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

export class GithubAppAuth {
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(private readonly config: GithubAppConfig) {}

  async getInstallationToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - now > 60_000) {
      return this.cached.token;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const jwt = this.mintJwt();
    const res = await fetch(
      `https://api.github.com/app/installations/${this.config.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new EngineError(
        "upstream",
        `GitHub App installation token request failed: ${res.status} ${res.statusText} ${text}`,
      );
    }
    const data = (await res.json()) as InstallationTokenResponse;
    const expiresAt = Date.parse(data.expires_at);
    this.cached = {
      token: data.token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60 * 60 * 1000,
    };
    return data.token;
  }

  mintJwt(now: number = Math.floor(Date.now() / 1000)): string {
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iat: now - 60,
      exp: now + 9 * 60,
      iss: this.config.appId,
    };
    const encodedHeader = base64url(JSON.stringify(header));
    const encodedPayload = base64url(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const pem = resolvePrivateKey(this.config.privateKey);
    const keyObject = createPrivateKey(pem);
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = base64url(signer.sign(keyObject));
    return `${signingInput}.${signature}`;
  }
}
