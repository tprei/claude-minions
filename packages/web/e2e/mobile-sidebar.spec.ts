import { test, expect } from "@playwright/test";
import {
  seedConnection,
  createSessionViaApi,
  API_BASE,
  API_TOKEN,
  E2E_LABEL,
} from "./utils.js";

const VIEWPORT = { width: 390, height: 844 };

async function sidebarRightEdge(
  page: import("@playwright/test").Page,
): Promise<number> {
  const sidebar = page.locator('[data-testid="mobile-sidebar"]');
  const box = await sidebar.boundingBox();
  if (!box) throw new Error("sidebar testid element missing from DOM");
  return box.x + box.width;
}

async function sidebarLeftEdge(
  page: import("@playwright/test").Page,
): Promise<number> {
  const sidebar = page.locator('[data-testid="mobile-sidebar"]');
  const box = await sidebar.boundingBox();
  if (!box) throw new Error("sidebar testid element missing from DOM");
  return box.x;
}

test.describe("mobile sidebar", () => {
  test.use({ viewport: VIEWPORT });

  test("starts closed, opens via hamburger, closes via backdrop", async ({ page }) => {
    await seedConnection(page, API_BASE, API_TOKEN);
    await page.reload();

    const pill = page.locator(`button:has-text("${E2E_LABEL}")`).first();
    await expect(pill).toBeVisible();

    // Sidebar wrapper is in the DOM (Sheet always mounts) but slid off-screen.
    const sidebar = page.locator('[data-testid="mobile-sidebar"]');
    await expect(sidebar).toBeAttached();

    // Default state on mobile: closed → right edge of panel ≤ 0 (off-screen left).
    await expect.poll(() => sidebarRightEdge(page)).toBeLessThanOrEqual(8);

    // Hamburger toggles sidebar open.
    await page.locator('button[aria-label="Toggle sidebar"]').click();
    await expect.poll(() => sidebarLeftEdge(page)).toBeGreaterThanOrEqual(-1);
    await expect.poll(() => sidebarRightEdge(page)).toBeGreaterThan(100);

    // Backdrop click closes the sheet. Panel is max-w-sm (384px); on a 390px
    // viewport, only x ≥ 384 lands on the backdrop, so click 2px from the right.
    await page.mouse.click(VIEWPORT.width - 2, Math.floor(VIEWPORT.height / 2));
    await expect.poll(() => sidebarRightEdge(page)).toBeLessThanOrEqual(8);
  });

  test("chat panel takes full viewport width when sidebar closed", async ({ page }) => {
    await seedConnection(page, API_BASE, API_TOKEN);
    await page.reload();

    const session = await createSessionViaApi(API_BASE, API_TOKEN, {
      prompt: "hello mobile",
      mode: "task",
    });

    // The list view renders a `hidden sm:table` desktop table AND a
    // `block sm:hidden` cards container at mobile. Match the visible card.
    const card = page
      .locator(`div.card:has-text("${session.title}")`)
      .first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    // Sidebar must be closed for this assertion.
    await expect.poll(() => sidebarRightEdge(page)).toBeLessThanOrEqual(8);

    // Main content area should occupy ≈ full viewport width (allow tiny rounding).
    const main = page.locator("main").first();
    const box = await main.boundingBox();
    if (!box) throw new Error("main element has no bounding box");
    expect(box.width).toBeGreaterThanOrEqual(VIEWPORT.width - 4);
  });
});
