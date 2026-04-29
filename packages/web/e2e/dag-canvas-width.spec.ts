import { test, expect } from "@playwright/test";
import {
  seedConnection,
  createSessionViaApi,
  API_BASE,
  API_TOKEN,
  E2E_CONN_ID,
} from "./utils.js";

const VIEWPORT = { width: 1440, height: 900 };

test.describe("dag canvas width", () => {
  test.use({ viewport: VIEWPORT });

  test("DAG canvas takes available width when /dag is the active view", async ({ page }) => {
    await seedConnection(page, API_BASE, API_TOKEN);

    const session = await createSessionViaApi(API_BASE, API_TOKEN, {
      prompt: "dag canvas width e2e",
      mode: "task",
    });

    await page.goto(`/c/${E2E_CONN_ID}/dag/${session.slug}`);

    const canvas = page.locator('[data-testid="panel-dag-canvas-body"]').first();
    await expect(canvas).toBeVisible({ timeout: 15_000 });

    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas body has no bounding box");
    expect(box.width).toBeGreaterThan(800);
  });
});
