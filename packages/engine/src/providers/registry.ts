import type { AgentProvider } from "./provider.js";
import { claudeCodeProvider, findClaudeBinary } from "./claudeCode.js";
import { mockProvider } from "./mock.js";
import { EngineError } from "../errors.js";

export interface ProviderRegistryEntry {
  name: string;
  ready: () => Promise<true | string>;
}

const providers = new Map<string, AgentProvider>([
  ["claude-code", claudeCodeProvider],
  ["mock", mockProvider],
]);

const readiness = new Map<string, () => Promise<true | string>>([
  [
    "claude-code",
    async () => {
      const bin = await findClaudeBinary();
      return bin ? true : "claude CLI not found in $PATH";
    },
  ],
  ["mock", async () => true],
]);

export function getProvider(name: string): AgentProvider {
  const p = providers.get(name);
  if (!p) {
    throw new EngineError("not_found", `Unknown provider: ${name}`);
  }
  return p;
}

export function registerProvider(provider: AgentProvider): void {
  providers.set(provider.name, provider);
}

export function listProviders(): ProviderRegistryEntry[] {
  return Array.from(providers.keys()).map((name) => ({
    name,
    ready: readiness.get(name) ?? (async () => true),
  }));
}
