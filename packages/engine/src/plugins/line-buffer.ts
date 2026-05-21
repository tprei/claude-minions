export class LineBuffer {
  private static readonly DEFAULT_MAX_RESIDUAL_CHARS = 1_000_000;

  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private residual = "";

  constructor(private readonly maxResidualChars = LineBuffer.DEFAULT_MAX_RESIDUAL_CHARS) {}

  push(chunk: Uint8Array): string[] {
    const decoded = this.decoder.decode(chunk, { stream: true });
    const combined = this.residual + decoded;
    const parts = combined.split("\n");
    this.residual = parts[parts.length - 1] ?? "";
    if (this.residual.length > this.maxResidualChars) {
      throw new Error(`line buffer residual exceeded ${this.maxResidualChars} characters`);
    }
    return parts.slice(0, -1);
  }

  flush(): string[] {
    const tail = this.residual;
    this.residual = "";
    return tail.length > 0 ? [tail] : [];
  }
}
