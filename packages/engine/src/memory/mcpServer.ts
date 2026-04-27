import type { EngineContext } from "../context.js";
import type { MemoryKind } from "@minions/shared";
import { EngineError } from "../errors.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function ok(id: number | string | null, result: unknown): string {
  const res: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  return JSON.stringify(res);
}

function err(id: number | string | null, code: number, message: string): string {
  const res: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message } };
  return JSON.stringify(res);
}

function parseRequest(line: string): JsonRpcRequest | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (obj["jsonrpc"] !== "2.0" || typeof obj["method"] !== "string") return null;
    return {
      jsonrpc: "2.0",
      id: (obj["id"] as number | string | null) ?? null,
      method: obj["method"] as string,
      params: obj["params"],
    };
  } catch {
    return null;
  }
}

export interface McpSessionHandle {
  handleLine(line: string): string;
}

export function serveMcpStdio(sessionSlug: string, ctx: EngineContext): McpSessionHandle {
  return {
    handleLine(line: string): string {
      const req = parseRequest(line.trim());
      if (!req) {
        return err(null, -32700, "Parse error");
      }

      try {
        switch (req.method) {
          case "list_memories": {
            const params = (req.params ?? {}) as Record<string, unknown>;
            const filter = {
              status: typeof params["status"] === "string" ? (params["status"] as import("@minions/shared").MemoryStatus) : undefined,
              kind: typeof params["kind"] === "string" ? (params["kind"] as MemoryKind) : undefined,
            };
            const memories = ctx.memory.list(filter);
            return ok(req.id, { memories });
          }

          case "get_memory": {
            const params = (req.params ?? {}) as Record<string, unknown>;
            if (typeof params["id"] !== "string") {
              return err(req.id, -32602, "id is required");
            }
            const memory = ctx.memory.get(params["id"]);
            if (!memory) {
              return err(req.id, -32001, `Memory ${params["id"]} not found`);
            }
            return ok(req.id, { memory });
          }

          case "propose_memory": {
            const params = (req.params ?? {}) as Record<string, unknown>;
            if (typeof params["kind"] !== "string") {
              return err(req.id, -32602, "kind is required");
            }
            if (typeof params["title"] !== "string") {
              return err(req.id, -32602, "title is required");
            }
            if (typeof params["body"] !== "string") {
              return err(req.id, -32602, "body is required");
            }
            if (params["scope"] !== "global" && params["scope"] !== "repo") {
              return err(req.id, -32602, "scope must be global or repo");
            }

            ctx.memory
              .create({
                kind: params["kind"] as MemoryKind,
                title: params["title"],
                body: params["body"],
                scope: params["scope"],
                repoId: typeof params["repoId"] === "string" ? params["repoId"] : undefined,
                proposedFromSession: sessionSlug,
              })
              .then((memory) => {
                ctx.bus.emit({ kind: "memory_proposed", memory });
              })
              .catch(() => {});

            return ok(req.id, { queued: true });
          }

          default:
            return err(req.id, -32601, `Method not found: ${req.method}`);
        }
      } catch (e) {
        const message = e instanceof EngineError ? e.message : "Internal error";
        return err(req.id, -32603, message);
      }
    },
  };
}
