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

const MOBILE_VIEWPORT = { width: 412, height: 915 };

test.describe("dag canvas mobile layout", () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  test("DAG canvas renders inline at full available size on mobile", async ({ page }) => {
    await seedConnection(page, API_BASE, API_TOKEN);

    const session = await createSessionViaApi(API_BASE, API_TOKEN, {
      prompt: "dag canvas mobile e2e",
      mode: "task",
    });

    await page.goto(`/c/${E2E_CONN_ID}/dag/${session.slug}`);

    const canvas = page.locator('[data-testid="panel-dag-canvas-body"]').first();
    await expect(canvas).toBeVisible({ timeout: 15_000 });

    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error("canvas body has no bounding box");
    expect(canvasBox.width).toBeGreaterThanOrEqual(400);
    expect(canvasBox.height).toBeGreaterThanOrEqual(850);

    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    const nodes = page.locator(".react-flow__node");
    const nodeCount = await nodes.count();
    expect(nodeCount).toBeGreaterThan(0);

    for (let i = 0; i < nodeCount; i++) {
      const nodeBox = await nodes.nth(i).boundingBox();
      if (!nodeBox) throw new Error(`node ${i} has no bounding box`);
      expect(nodeBox.x).toBeGreaterThanOrEqual(canvasBox.x);
      expect(nodeBox.y).toBeGreaterThanOrEqual(canvasBox.y);
      expect(nodeBox.x + nodeBox.width).toBeLessThanOrEqual(canvasBox.x + canvasBox.width);
      expect(nodeBox.y + nodeBox.height).toBeLessThanOrEqual(canvasBox.y + canvasBox.height);
    }

    const titleDiv = nodes.locator("div.font-medium").first();
    await expect(titleDiv).toBeVisible();
    const lineClamp = await titleDiv.evaluate(
      (el) => getComputedStyle(el).webkitLineClamp,
    );
    expect(lineClamp).toBe("2");
  });
});
