export class LineBuffer {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private residual = "";

  push(chunk: Uint8Array): string[] {
    const decoded = this.decoder.decode(chunk, { stream: true });
    const combined = this.residual + decoded;
    const parts = combined.split("\n");
    this.residual = parts[parts.length - 1] ?? "";
    return parts.slice(0, -1);
  }

  flush(): string[] {
    const tail = this.residual;
    this.residual = "";
    return tail.length > 0 ? [tail] : [];
  }
}
