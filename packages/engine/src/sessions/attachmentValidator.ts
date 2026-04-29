import path from "node:path";
import { ALLOWED_ATTACHMENT_MIME_TYPES, type AllowedAttachmentMimeType } from "@minions/shared";
import { EngineError } from "../errors.js";

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME_SET: ReadonlySet<string> = new Set(ALLOWED_ATTACHMENT_MIME_TYPES);

export function sanitizeAttachmentName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new EngineError("bad_request", "attachment name is required");
  }
  if (name.includes("\0")) {
    throw new EngineError("bad_request", "attachment name must not contain null bytes");
  }
  if (path.isAbsolute(name)) {
    throw new EngineError("bad_request", "attachment name must not be an absolute path");
  }
  const parts = name.split(/[/\\]/);
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new EngineError("bad_request", "attachment name must not contain path traversal");
  }
  const base = path.basename(name);
  if (!base || base !== name) {
    throw new EngineError("bad_request", "attachment name must be a single basename");
  }
  return base;
}

export function assertAllowedMime(mimeType: unknown): AllowedAttachmentMimeType {
  if (typeof mimeType !== "string" || !ALLOWED_MIME_SET.has(mimeType)) {
    throw new EngineError("bad_request", `unsupported attachment mime type: ${String(mimeType)}`, {
      allowed: [...ALLOWED_ATTACHMENT_MIME_TYPES],
    });
  }
  return mimeType as AllowedAttachmentMimeType;
}

export function assertWithinSize(byteSize: number): void {
  if (!Number.isFinite(byteSize) || byteSize < 0) {
    throw new EngineError("bad_request", "attachment size is invalid");
  }
  if (byteSize > MAX_ATTACHMENT_BYTES) {
    throw new EngineError("bad_request", `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`, {
      byteSize,
      max: MAX_ATTACHMENT_BYTES,
    });
  }
}
