import type {
  ProviderCapabilities,
  ProviderEvent,
  ProviderInvocation,
  ProviderPlugin,
  ProviderPrepareSpec,
  ProviderResumeSpec,
} from "../provider-plugin.js";

export class StubProviderPlugin implements ProviderPlugin {
  readonly name = "stub";

  readonly capabilities: ProviderCapabilities = {
    resume: true,
    mcp: false,
    structuredOutput: false,
    oauthLogin: false,
    streamJson: true,
    sessionRefFormat: "opaque",
  };

  private counter = 0;
  private readonly frames: ProviderEvent[][];

  constructor({ frames }: { frames: ProviderEvent[][] }) {
    this.frames = frames;
  }

  async prepare(spec: ProviderPrepareSpec): Promise<ProviderInvocation> {
    if (spec.prompt.trim() === "") throw new Error("prompt must be non-empty");
    return { command: ["echo", "stub"], providerType: "stub" };
  }

  async resume(spec: ProviderResumeSpec): Promise<ProviderInvocation> {
    if (spec.prompt.trim() === "") throw new Error("prompt must be non-empty");
    return { command: ["echo", "stub"], providerType: "stub" };
  }

  parseFrame(_line: string): ProviderEvent[] {
    return this.frames[this.counter++] ?? [];
  }

  async loginStatus(): Promise<{ loggedIn: boolean }> {
    return { loggedIn: true };
  }
}
