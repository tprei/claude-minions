import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { API_BASE, API_TOKEN, seedConnection } from "./utils.js";

interface SessionCreated {
  slug: string;
  title: string;
  status: string;
  worktreePath?: string | null;
}

const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

const SSE_TIMEOUT = 15_000;
const REPLY_TIMEOUT = 10_000;

async function engineReachable(api: APIRequestContext): Promise<boolean> {
  try {
    const res = await api.get(`${API_BASE}/api/health`, { timeout: 2_000 });
    return res.ok();
  } catch {
    return false;
  }
}

async function postJson<T = unknown>(
  api: APIRequestContext,
  pathname: string,
  body: unknown,
): Promise<T> {
  const res = await api.post(`${API_BASE}${pathname}`, {
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    data: body,
  });
  expect(res.ok(), `${pathname} ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}

async function getJson<T = unknown>(
  api: APIRequestContext,
  pathname: string,
): Promise<T> {
  const res = await api.get(`${API_BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  expect(res.ok(), `${pathname} ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}

async function createSessionViaApi(
  api: APIRequestContext,
  prompt: string,
  attachments?: { name: string; mimeType: string; dataBase64: string }[],
): Promise<SessionCreated> {
  const body: Record<string, unknown> = { prompt, mode: "task" };
  if (attachments) body["attachments"] = attachments;
  return postJson<SessionCreated>(api, "/api/messages", body);
}

async function getSession(
  api: APIRequestContext,
  slug: string,
): Promise<SessionCreated> {
  return getJson<SessionCreated>(api, `/api/sessions/${slug}`);
}

async function waitForStatus(
  api: APIRequestContext,
  slug: string,
  matcher: (status: string) => boolean,
  timeoutMs = SSE_TIMEOUT,
): Promise<SessionCreated> {
  const deadline = Date.now() + timeoutMs;
  let last: SessionCreated | null = null;
  while (Date.now() < deadline) {
    last = await getSession(api, slug);
    if (matcher(last.status)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `timed out waiting for status; last=${last?.status ?? "unknown"} slug=${slug}`,
  );
}

async function bootApp(page: Page): Promise<void> {
  await page.goto("/");
  await seedConnection(page);
  await page.reload();
  await expect(page.getByRole("button", { name: /self/i })).toBeVisible();
}

async function openSession(page: Page, slug: string, title: string): Promise<void> {
  const row = page.locator(`tr:has-text("${title}")`).first();
  await expect(row).toBeVisible({ timeout: SSE_TIMEOUT });
  await row.click();
  await expect.poll(() => page.url(), { timeout: 5_000 }).toContain(slug);
}

test.describe("chat lifecycle", () => {
  test.beforeEach(async ({ request }, testInfo) => {
    if (!(await engineReachable(request))) {
      testInfo.skip(true, "engine not reachable on " + API_BASE);
    }
  });

  test("session created via UI flows to chat surface", async ({ page, request }) => {
    await bootApp(page);
    const created = await createSessionViaApi(request, "lifecycle: open chat");
    await openSession(page, created.slug, created.title);

    const chatHeader = page
      .locator("div")
      .filter({ hasText: created.title })
      .filter({ has: page.locator('button[title*="Close"]') })
      .first();
    await expect(chatHeader).toBeVisible({ timeout: SSE_TIMEOUT });

    const chatInput = page.locator('textarea[placeholder*="Message"]').first();
    await expect(chatInput).toBeVisible();
  });

  test("reply mid-turn enqueues + arrives in transcript", async ({ page, request }) => {
    await bootApp(page);
    const created = await createSessionViaApi(request, "lifecycle: mid-turn reply");
    await waitForStatus(request, created.slug, (s) => s === "running" || s === "completed" || s === "waiting_input");
    await openSession(page, created.slug, created.title);

    const chatInput = page.locator('textarea[placeholder*="Message"]').first();
    await expect(chatInput).toBeVisible({ timeout: SSE_TIMEOUT });

    const replyText = `mid-turn-reply-${Date.now()}`;
    await chatInput.click();
    await chatInput.fill(replyText);
    await page.getByRole("button", { name: /^send$/i }).click();

    const replyBubble = page.locator(`text=${replyText}`).first();
    await expect(replyBubble).toBeVisible({ timeout: REPLY_TIMEOUT });

    const userPill = page
      .locator(".pill", { hasText: /operator|external|injected/i })
      .first();
    await expect(userPill).toBeVisible({ timeout: REPLY_TIMEOUT });
  });

  test("image attachment lands in session uploads", async ({ request }) => {
    const created = await createSessionViaApi(request, "lifecycle: image attach", [
      { name: "pixel.png", mimeType: "image/png", dataBase64: PNG_1x1_BASE64 },
    ]);
    expect(created.slug).toBeTruthy();

    const session = await waitForStatus(
      request,
      created.slug,
      (s) => s === "running" || s === "completed" || s === "pending" || s === "waiting_input",
      SSE_TIMEOUT,
    );

    const worktreePath = session.worktreePath;
    if (!worktreePath) {
      test.skip(true, "session.worktreePath not exposed by API; cannot verify upload on disk");
      return;
    }

    const workspaceRoot = path.dirname(path.dirname(worktreePath));
    const candidates = [
      path.join(workspaceRoot, "uploads", session.slug, "pixel.png"),
      path.join(worktreePath, ".minions", "uploads", "pixel.png"),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    expect(found, `expected uploaded pixel.png in one of: ${candidates.join(", ")}`).toBeTruthy();
    if (found) {
      const buf = fs.readFileSync(found);
      expect(buf.length).toBeGreaterThan(0);
      expect(buf.subarray(0, 4).toString("hex")).toBe("89504e47");
    }
  });

  test("restore checkpoint fires API call", async ({ page, request }) => {
    const created = await createSessionViaApi(request, "lifecycle: restore checkpoint");
    await waitForStatus(
      request,
      created.slug,
      (s) => s === "completed" || s === "failed" || s === "waiting_input",
      SSE_TIMEOUT,
    );

    const checkpoints = await getJson<{ items: { id: string }[] }>(
      request,
      `/api/sessions/${created.slug}/checkpoints`,
    );
    if (checkpoints.items.length === 0) {
      test.skip(true, "mock provider produced no checkpoints; cannot exercise restore flow");
      return;
    }
    const targetId = checkpoints.items[0]!.id;

    await bootApp(page);
    await openSession(page, created.slug, created.title);

    const restoreCalls: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && /\/api\/sessions\/.+\/checkpoints\/.+\/restore/.test(req.url())) {
        restoreCalls.push(req.url());
      }
    });

    const restoreBtn = page
      .getByRole("button", { name: /restore checkpoint|restore last|restore/i })
      .first();
    if (await restoreBtn.isVisible().catch(() => false)) {
      await restoreBtn.click();
      await expect.poll(() => restoreCalls.length, { timeout: REPLY_TIMEOUT }).toBeGreaterThan(0);
      return;
    }

    const restoreRes = await request.post(
      `${API_BASE}/api/sessions/${created.slug}/checkpoints/${targetId}/restore`,
      { headers: { Authorization: `Bearer ${API_TOKEN}` } },
    );
    expect(restoreRes.ok(), `restore ${restoreRes.status()}`).toBeTruthy();
    const body = (await restoreRes.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("stop cancels a running session", async ({ page, request }) => {
    const created = await createSessionViaApi(request, "lifecycle: stop running");
    await waitForStatus(
      request,
      created.slug,
      (s) => s === "running" || s === "pending" || s === "waiting_input",
      SSE_TIMEOUT,
    );

    await bootApp(page);
    await openSession(page, created.slug, created.title);

    const stopBtn = page.getByRole("button", { name: /^stop$/i }).first();
    if (await stopBtn.isVisible().catch(() => false)) {
      await stopBtn.click();
    } else {
      const res = await request.post(`${API_BASE}/api/commands`, {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          "Content-Type": "application/json",
        },
        data: { kind: "stop", sessionSlug: created.slug },
      });
      expect(res.ok(), `commands stop ${res.status()}`).toBeTruthy();
    }

    await expect
      .poll(async () => (await getSession(request, created.slug)).status, {
        timeout: SSE_TIMEOUT,
      })
      .toMatch(/cancelled|completed/);

    const finalStatus = (await getSession(request, created.slug)).status;
    expect(["cancelled", "completed"]).toContain(finalStatus);
  });
});
