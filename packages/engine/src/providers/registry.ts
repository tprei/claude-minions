import type { AgentProvider } from "./provider.js";
import { claudeCodeProvider } from "./claudeCode.js";
import { mockProvider } from "./mock.js";
import { EngineError } from "../errors.js";

const providers = new Map<string, AgentProvider>([
  ["claude-code", claudeCodeProvider],
  ["mock", mockProvider],
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
