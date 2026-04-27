import path from "node:path";
import fs from "node:fs/promises";
import type Database from "better-sqlite3";
import type { Screenshot } from "@minions/shared";
import type { EventBus } from "../bus/eventBus.js";
import { EngineError } from "../errors.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { ensureDir } from "../util/fs.js";

export type ScreenshotSource = "turn_end" | "readiness_change" | "failure";

export interface CaptureOptions {
  source: ScreenshotSource;
  pngBuffer: Buffer;
  description?: string;
}

interface ScreenshotRow {
  id: string;
  session_slug: string;
  filename: string;
  byte_size: number;
  description: string | null;
  captured_at: string;
}

export interface ScreenshotsDeps {
  db: Database.Database;
  bus: EventBus;
  screenshotsDir: (slug: string) => string;
}

function rowToScreenshot(row: ScreenshotRow): Screenshot {
  return {
    filename: row.filename,
    url: `/api/sessions/${row.session_slug}/screenshots/${row.filename}`,
    capturedAt: row.captured_at,
    byteSize: row.byte_size,
    description: row.description ?? undefined,
  };
}

function rejectInvalidFilename(filename: string): void {
  if (
    filename.length === 0 ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..") ||
    filename.startsWith(".")
  ) {
    throw new EngineError("bad_request", "invalid filename");
  }
}

export class Screenshots {
  private readonly listStmt: Database.Statement;
  private readonly insertStmt: Database.Statement;

  constructor(private readonly deps: ScreenshotsDeps) {
    const { db } = deps;
    this.listStmt = db.prepare(
      `SELECT * FROM screenshots WHERE session_slug = ? ORDER BY captured_at DESC`,
    );
    this.insertStmt = db.prepare(
      `INSERT OR REPLACE INTO screenshots(id, session_slug, filename, byte_size, description, captured_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
  }

  list(slug: string): Screenshot[] {
    return (this.listStmt.all(slug) as ScreenshotRow[]).map(rowToScreenshot);
  }

  async capture(slug: string, opts: CaptureOptions): Promise<Screenshot> {
    const { bus, screenshotsDir } = this.deps;
    const dir = screenshotsDir(slug);
    await ensureDir(dir);

    const capturedAt = nowIso();
    const filename = `${capturedAt.replace(/[:.]/g, "-")}-${opts.source}.png`;
    const filePath = path.join(dir, filename);

    await fs.writeFile(filePath, opts.pngBuffer);

    const id = newId();
    this.insertStmt.run(
      id,
      slug,
      filename,
      opts.pngBuffer.byteLength,
      opts.description ?? null,
      capturedAt,
    );

    const screenshot: Screenshot = {
      filename,
      url: `/api/sessions/${slug}/screenshots/${filename}`,
      capturedAt,
      byteSize: opts.pngBuffer.byteLength,
      description: opts.description,
    };

    bus.emit({
      kind: "session_screenshot_captured",
      sessionSlug: slug,
      filename,
      url: screenshot.url,
      capturedAt,
      description: opts.description,
    });

    return screenshot;
  }

  screenshotPath(slug: string, filename: string): string {
    rejectInvalidFilename(filename);
    const dir = this.deps.screenshotsDir(slug);
    const resolved = path.resolve(dir, filename);
    const confine = dir.endsWith(path.sep) ? dir : dir + path.sep;
    if (!resolved.startsWith(confine)) {
      throw new EngineError("bad_request", "invalid filename");
    }
    return resolved;
  }
}
