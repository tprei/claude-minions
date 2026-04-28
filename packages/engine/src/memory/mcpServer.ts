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
  handleLine(line: string): string | null;
}

const TOOL_DEFINITIONS = [
  {
    name: "propose_memory",
    description: "Propose a new operator memory. The memory enters review queue with status=pending; an operator approves before it influences future sessions.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["engineering", "product", "incident", "convention", "other"] },
        title: { type: "string", description: "Short subject (under 80 chars)" },
        body: { type: "string", description: "1-3 sentences explaining WHY and HOW to apply" },
        scope: { type: "string", enum: ["global", "repo"] },
        repoId: { type: "string", description: "required when scope=repo" },
      },
      required: ["kind", "title", "body", "scope"],
    },
  },
  {
    name: "list_memories",
    description: "List existing operator memories, optionally filtered by status or kind.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "approved", "rejected"] },
        kind: { type: "string" },
      },
    },
  },
  {
    name: "get_memory",
    description: "Fetch a single memory by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
] as const;

function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  id: number | string | null,
  sessionSlug: string,
  ctx: EngineContext,
): string {
  switch (name) {
    case "list_memories": {
      const filter = {
        status: typeof args["status"] === "string" ? (args["status"] as import("@minions/shared").MemoryStatus) : undefined,
        kind: typeof args["kind"] === "string" ? (args["kind"] as MemoryKind) : undefined,
      };
      const memories = ctx.memory.list(filter);
      return ok(id, { content: [{ type: "text", text: JSON.stringify({ memories }, null, 2) }] });
    }
    case "get_memory": {
      if (typeof args["id"] !== "string") return err(id, -32602, "id is required");
      const memory = ctx.memory.get(args["id"]);
      if (!memory) return err(id, -32001, `Memory ${args["id"]} not found`);
      return ok(id, { content: [{ type: "text", text: JSON.stringify({ memory }, null, 2) }] });
    }
    case "propose_memory": {
      if (typeof args["kind"] !== "string") return err(id, -32602, "kind is required");
      if (typeof args["title"] !== "string") return err(id, -32602, "title is required");
      if (typeof args["body"] !== "string") return err(id, -32602, "body is required");
      if (args["scope"] !== "global" && args["scope"] !== "repo") return err(id, -32602, "scope must be global or repo");

      ctx.memory
        .create({
          kind: args["kind"] as MemoryKind,
          title: args["title"],
          body: args["body"],
          scope: args["scope"],
          repoId: typeof args["repoId"] === "string" ? args["repoId"] : undefined,
          proposedFromSession: sessionSlug,
        })
        .then((memory) => {
          ctx.bus.emit({ kind: "memory_proposed", memory });
        })
        .catch(() => {});

      return ok(id, { content: [{ type: "text", text: "queued" }] });
    }
    default:
      return err(id, -32601, `Tool not found: ${name}`);
  }
}

export function serveMcpStdio(sessionSlug: string, ctx: EngineContext): McpSessionHandle {
  return {
    handleLine(line: string): string | null {
      const req = parseRequest(line.trim());
      if (!req) {
        return err(null, -32700, "Parse error");
      }

      try {
        switch (req.method) {
          case "initialize":
            return ok(req.id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "minions-memory", version: "1.0.0" },
            });

          case "notifications/initialized":
          case "notifications/cancelled":
            return null;

          case "ping":
            return ok(req.id, {});

          case "tools/list":
            return ok(req.id, { tools: TOOL_DEFINITIONS });

          case "tools/call": {
            const params = (req.params ?? {}) as Record<string, unknown>;
            const name = params["name"];
            const argsRaw = params["arguments"];
            if (typeof name !== "string") return err(req.id, -32602, "tools/call requires name");
            const args = (argsRaw && typeof argsRaw === "object" ? argsRaw : {}) as Record<string, unknown>;
            return dispatchTool(name, args, req.id, sessionSlug, ctx);
          }

          case "resources/list":
            return ok(req.id, { resources: [] });

          case "prompts/list":
            return ok(req.id, { prompts: [] });

          case "list_memories":
          case "get_memory":
          case "propose_memory":
            return dispatchTool(req.method, (req.params ?? {}) as Record<string, unknown>, req.id, sessionSlug, ctx);

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
