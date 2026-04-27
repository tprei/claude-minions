import { test, expect } from "@playwright/test";
import { seedConnection, createSessionViaApi, E2E_LABEL } from "./utils.js";

const BASE_URL = "http://127.0.0.1:8801";
const TOKEN = "devtoken";

test.describe("smoke", () => {
  test("connects to engine + lists sessions", async ({ page }) => {
    await seedConnection(page, BASE_URL, TOKEN);
    await page.reload();

    const pill = page.locator(`button:has-text("${E2E_LABEL}")`).first();
    await expect(pill).toBeVisible();
    await expect(pill).toContainText(E2E_LABEL);
  });

  test("session lifecycle via mock provider", async ({ page }) => {
    await seedConnection(page, BASE_URL, TOKEN);
    await page.reload();

    const session = await createSessionViaApi(BASE_URL, TOKEN, {
      prompt: "hello",
      mode: "task",
    });

    const card = page
      .locator(`tr:has-text("${session.title}"), [class*="card"]:has-text("${session.title}")`)
      .first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    const transcriptText = page.getByText(/Working on: hello|Done\./).first();
    await expect(transcriptText).toBeVisible({ timeout: 20_000 });
  });

  test("chat resize handle", async ({ page }) => {
    await seedConnection(page, BASE_URL, TOKEN);
    await page.reload();

    const session = await createSessionViaApi(BASE_URL, TOKEN, {
      prompt: "hello resize",
      mode: "task",
    });

    const card = page
      .locator(`tr:has-text("${session.title}"), [class*="card"]:has-text("${session.title}")`)
      .first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    const handle = page.locator('[role="separator"]').first();
    await expect(handle).toBeVisible();

    const panel = handle.locator("..");
    const before = await panel.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);

    const box = await handle.boundingBox();
    if (!box) throw new Error("resize handle has no bounding box");
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const endX = startX - 200;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 50, startY, { steps: 5 });
    await page.mouse.move(startX - 120, startY, { steps: 5 });
    await page.mouse.move(endX, startY, { steps: 5 });
    await page.mouse.up();

    const after = await panel.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
    const delta = after - before;
    expect(delta).toBeGreaterThanOrEqual(150);
    expect(delta).toBeLessThanOrEqual(250);
  });
});
