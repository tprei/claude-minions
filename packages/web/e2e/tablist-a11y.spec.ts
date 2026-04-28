import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { API_BASE, API_TOKEN, E2E_LABEL, seedConnection } from "./utils.js";

const SSE_TIMEOUT = 15_000;

interface SessionCreated {
  slug: string;
  title: string;
  status: string;
}

async function engineReachable(api: APIRequestContext): Promise<boolean> {
  try {
    const res = await api.get(`${API_BASE}/api/health`, { timeout: 2_000 });
    return res.ok();
  } catch {
    return false;
  }
}

async function createSessionViaApi(
  api: APIRequestContext,
  prompt: string,
): Promise<SessionCreated> {
  const res = await api.post(`${API_BASE}/api/messages`, {
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    data: { prompt, mode: "task" },
  });
  expect(res.ok(), `messages ${res.status()}`).toBeTruthy();
  return (await res.json()) as SessionCreated;
}

async function bootApp(page: Page): Promise<void> {
  await page.goto("/");
  await seedConnection(page);
  await page.reload();
  await expect(page.getByRole("button", { name: new RegExp(E2E_LABEL, "i") })).toBeVisible();
}

async function openSession(page: Page, slug: string, title: string): Promise<void> {
  const row = page.locator(`tr:has-text("${title}")`).first();
  await expect(row).toBeVisible({ timeout: SSE_TIMEOUT });
  await row.click();
  await expect.poll(() => page.url(), { timeout: 5_000 }).toContain(slug);
}

test.describe("tablist a11y", () => {
  test.beforeEach(async ({ request }, testInfo) => {
    if (!(await engineReachable(request))) {
      testInfo.skip(true, "engine not reachable on " + API_BASE);
    }
  });

  test("session surface tabs expose tablist semantics + arrow nav", async ({
    page,
    request,
  }) => {
    await bootApp(page);
    const created = await createSessionViaApi(request, "tablist a11y: surface");
    await openSession(page, created.slug, created.title);

    const tablist = page.getByRole("tablist", { name: "Session surface" });
    await expect(tablist).toBeVisible({ timeout: SSE_TIMEOUT });

    const tabs = tablist.getByRole("tab");
    await expect(tabs).toHaveCount(6);

    const selected = tablist.locator('[role="tab"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAttribute("id", "surface-tab-transcript");

    await selected.focus();
    await page.keyboard.press("ArrowRight");

    const nextSelected = tablist.locator('[role="tab"][aria-selected="true"]');
    await expect(nextSelected).toHaveAttribute("id", "surface-tab-diff");
    await expect(nextSelected).toBeFocused();
  });

  test("inner transcript/timeline tabs expose tablist semantics + arrow nav", async ({
    page,
    request,
  }) => {
    await bootApp(page);
    const created = await createSessionViaApi(request, "tablist a11y: transcript");
    await openSession(page, created.slug, created.title);

    const tablist = page.getByRole("tablist", { name: "Transcript view" });
    await expect(tablist).toBeVisible({ timeout: SSE_TIMEOUT });

    const tabs = tablist.getByRole("tab");
    await expect(tabs).toHaveCount(2);

    const selected = tablist.locator('[role="tab"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAttribute("id", "transcript-tab-transcript");

    await selected.focus();
    await page.keyboard.press("ArrowRight");

    const nextSelected = tablist.locator('[role="tab"][aria-selected="true"]');
    await expect(nextSelected).toHaveAttribute("id", "transcript-tab-timeline");
    await expect(nextSelected).toBeFocused();
  });
});
