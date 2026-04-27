import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ALLOWED_ATTACHMENT_MIME_TYPES, type AllowedAttachmentMimeType } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import { ensureDir } from "../../util/fs.js";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const MIME_TO_EXT: Record<AllowedAttachmentMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const ALLOWED_MIME_SET: ReadonlySet<string> = new Set(ALLOWED_ATTACHMENT_MIME_TYPES);

export function uploadsDir(workspaceDir: string): string {
  return path.join(workspaceDir, "uploads");
}

function isValidUploadFilename(filename: string): boolean {
  if (!filename || filename.startsWith(".")) return false;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) return false;
  return /^[0-9a-f]{64}\.(png|jpg|webp)$/.test(filename);
}

export function registerUploadsRoute(app: FastifyInstance, ctx: EngineContext): void {
  app.post("/api/uploads", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: "bad_request", message: "Expected multipart/form-data" });
    }

    let part;
    try {
      part = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
    } catch {
      return reply.code(400).send({ error: "bad_request", message: "Invalid multipart payload" });
    }

    if (!part) {
      return reply.code(400).send({ error: "bad_request", message: "No file part in upload" });
    }

    const mimeType = part.mimetype;
    if (!ALLOWED_MIME_SET.has(mimeType)) {
      return reply.code(415).send({
        error: "unsupported_media_type",
        message: `Unsupported mime type: ${mimeType}`,
        detail: { allowed: [...ALLOWED_ATTACHMENT_MIME_TYPES] },
      });
    }

    let buf: Buffer;
    try {
      buf = await part.toBuffer();
    } catch {
      return reply.code(413).send({
        error: "payload_too_large",
        message: `File exceeds ${MAX_UPLOAD_BYTES} bytes`,
      });
    }

    if (part.file.truncated || buf.byteLength > MAX_UPLOAD_BYTES) {
      return reply.code(413).send({
        error: "payload_too_large",
        message: `File exceeds ${MAX_UPLOAD_BYTES} bytes`,
      });
    }

    const ext = MIME_TO_EXT[mimeType as AllowedAttachmentMimeType];
    const hash = createHash("sha256").update(buf).digest("hex");
    const filename = `${hash}.${ext}`;
    const dir = uploadsDir(ctx.workspaceDir);
    await ensureDir(dir);
    const target = path.join(dir, filename);
    await fs.writeFile(target, buf);

    return reply.code(201).send({
      url: `/api/uploads/${filename}`,
      name: part.filename,
      mimeType,
      byteSize: buf.byteLength,
    });
  });

  app.get(
    "/api/uploads/:filename",
    async (req: FastifyRequest<{ Params: { filename: string } }>, reply: FastifyReply) => {
      const { filename } = req.params;
      if (!isValidUploadFilename(filename)) {
        return reply.code(400).send({ error: "bad_request", message: "Invalid filename" });
      }

      const filePath = path.join(uploadsDir(ctx.workspaceDir), filename);
      const ext = filename.slice(filename.lastIndexOf(".") + 1) as "png" | "jpg" | "webp";
      const contentType: AllowedAttachmentMimeType =
        ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";

      const stream = createReadStream(filePath);
      stream.on("error", () => {
        reply.code(404).send({ error: "not_found", message: "Upload not found" });
      });
      return reply.type(contentType).send(stream);
    },
  );
}
