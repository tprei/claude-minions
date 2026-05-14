import { expect, test, type Page, type Route } from "@playwright/test";
import {
  TASK_EXECUTION_STATUSES,
  TASK_STACK_STATUSES,
  type TaskExecutionStatus,
  type TaskStackStatus,
  type Workflow,
} from "@minions/engine";

const ENGINE_URL = "http://engine.test";
const NOW = "2026-05-14T00:00:00.000Z";

const STACK_LABEL: Record<TaskStackStatus, string | undefined> = {
  clean: undefined,
  "restack-pending": "RESTACK PENDING",
  restacking: "RESTACKING",
  "restack-conflict": "CONFLICT",
  "stale-artifacts": "STALE",
};

const STATUS_LABEL: Record<TaskExecutionStatus, string> = {
  pending: "pending",
  ready: "ready",
  running: "running",
  completed: "completed",
  finalizing: "finalizing",
  "quality-pending": "quality check",
  "ci-pending": "CI pending",
  "pr-open": "PR open",
  merged: "merged",
  failed: "failed",
  cancelled: "cancelled",
  "needs-review": "needs review",
};

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};

function makeWorkflow(id: string, statuses: readonly TaskExecutionStatus[]): Workflow {
  const graph: Workflow["graph"] = {};
  for (const status of statuses) {
    const taskId = `task-${status}`;
    graph[taskId] = {
      id: taskId,
      workflowId: id,
      title: `Status ${status}`,
      prompt: `Render ${status}`,
      dependsOn: [],
      executionStatus: status,
      stackStatus: "clean",
      priority: 0,
      claims: [],
      contract: { summary: `Status ${status}`, expectedArtifacts: [] },
      artifacts: [],
      runs: [],
      readiness: "unknown",
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
  }
  return {
    id,
    kind: "manual-dag",
    status: "active",
    graph,
    operations: {},
    policy: { maxConcurrent: 3, autoLand: false, autoMergeOnGreen: false },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeStatusMatrixWorkflow(id: string): Workflow {
  const graph: Workflow["graph"] = {};
  for (const executionStatus of TASK_EXECUTION_STATUSES) {
    for (const stackStatus of TASK_STACK_STATUSES) {
      const taskId = `task-${executionStatus}-${stackStatus}`;
      graph[taskId] = {
        id: taskId,
        workflowId: id,
        title: `Status ${executionStatus} ${stackStatus}`,
        prompt: `Render ${executionStatus} ${stackStatus}`,
        dependsOn: [],
        executionStatus,
        stackStatus,
        priority: 0,
        claims: [],
        contract: { summary: `Status ${executionStatus} ${stackStatus}`, expectedArtifacts: [] },
        artifacts: [],
        runs: [],
        readiness: "unknown",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
    }
  }
  return {
    id,
    kind: "manual-dag",
    status: "active",
    graph,
    operations: {},
    policy: { maxConcurrent: 3, autoLand: false, autoMergeOnGreen: false },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function versionResponse(): unknown {
  return {
    apiVersion: "workflow-v1",
    libraryVersion: "0.1.0",
    buildSha: "e2e",
    features: [
      "workflows",
      "runtime-diagnostics",
      "snapshot-cache",
      "status-rendering",
      "slash-commands",
      "voice-input",
    ],
    featuresPending: [],
    provider: "stub",
    providers: ["stub"],
    repos: [{ id: "fixture/repo", label: "fixture/repo", defaultBranch: "main" }],
    pluginSet: ["runtime:stub"],
    startedAt: NOW,
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  });
}

async function setupEngineRoutes(
  page: Page,
  state: { online: boolean; workflows: Workflow[]; commands?: unknown[] },
  onRequest?: (pathname: string) => void,
): Promise<void> {
  await page.route(`${ENGINE_URL}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }

    if (!state.online) {
      await route.abort("failed");
      return;
    }

    const url = new URL(request.url());
    onRequest?.(url.pathname);
    if (url.pathname === "/version") {
      await fulfillJson(route, versionResponse());
      return;
    }
    if (url.pathname === "/workflows") {
      await fulfillJson(route, state.workflows);
      return;
    }
    if (url.pathname.endsWith("/events")) {
      await route.fulfill({
        status: 200,
        headers: { ...CORS_HEADERS, "content-type": "text/event-stream" },
        body: "",
      });
      return;
    }
    if (url.pathname === "/commands" && request.method() === "POST") {
      state.commands?.push(request.postDataJSON());
      await fulfillJson(route, { ok: true });
      return;
    }
    await fulfillJson(route, { code: "not_found", message: url.pathname }, 404);
  });
}

async function addConnection(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: /No connection/i }).click();
  await page.getByTestId("picker-add-connection").click();
  await page.getByPlaceholder("My engine").fill("Fixture engine");
  await page.getByPlaceholder("http://localhost:3000").fill(ENGINE_URL);
  await page.getByPlaceholder("secret").fill("token");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("button", { name: /Fixture engine/i })).toBeVisible();
}

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test("connection picker accepts a URL and renders workflows from the engine", async ({ page }) => {
  const state = {
    online: true,
    workflows: [makeWorkflow("wf-picker", ["running"])],
  };
  await setupEngineRoutes(page, state);
  await addConnection(page);

  await expect(page.getByRole("cell", { name: "Status running" })).toBeVisible();
  await expect(page.getByText("running").first()).toBeVisible();
});

test("connection picker accepts a QR payload and renders workflows from the engine", async ({ page }) => {
  const state = {
    online: true,
    workflows: [makeWorkflow("wf-qr", ["ready"])],
  };
  await setupEngineRoutes(page, state);

  await page.goto("/");
  await page.getByRole("button", { name: /No connection/i }).click();
  await page.getByTestId("picker-scan-qr").click();
  await page.getByTestId("qr-payload-input").fill(JSON.stringify({
    label: "QR engine",
    baseUrl: ENGINE_URL,
    token: "qr-token",
    color: "#34d399",
  }));
  await page.getByTestId("qr-payload-submit").click();
  await page.getByTestId("qr-confirm-form").getByRole("button", { name: "Add" }).click();

  await expect(page.getByRole("button", { name: /QR engine/i })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Status ready" })).toBeVisible();
});

test("snapshot cache replays workflows when the engine is unavailable", async ({ page }) => {
  const state = {
    online: true,
    workflows: [makeWorkflow("wf-snapshot", ["needs-review"])],
  };
  await setupEngineRoutes(page, state);
  await addConnection(page);
  await expect(page.getByRole("cell", { name: "Status needs-review" })).toBeVisible();

  state.online = false;
  await page.reload();

  await expect(page.getByRole("cell", { name: "Status needs-review" })).toBeVisible();
  await expect(page.getByText("needs review").first()).toBeVisible();
});

test("list view renders every task execution and stack status combination", async ({ page }) => {
  const state = {
    online: true,
    workflows: [makeStatusMatrixWorkflow("wf-statuses")],
  };
  await setupEngineRoutes(page, state);
  await addConnection(page);

  for (const executionStatus of TASK_EXECUTION_STATUSES) {
    for (const stackStatus of TASK_STACK_STATUSES) {
      const row = page.locator("tr", { hasText: `Status ${executionStatus} ${stackStatus}` });
      await expect(row).toBeVisible();
      await expect(row.getByText(STATUS_LABEL[executionStatus], { exact: true })).toBeVisible();
      const stackLabel = STACK_LABEL[stackStatus];
      if (stackLabel !== undefined) {
        await expect(row.getByText(stackLabel, { exact: true })).toBeVisible();
      }
    }
  }
});

test("SSE reconnect refetches workflows", async ({ page }) => {
  const state = {
    online: true,
    workflows: [makeWorkflow("wf-reconnect", ["running"])],
  };
  let workflowRequests = 0;
  await setupEngineRoutes(page, state, (pathname) => {
    if (pathname === "/workflows") workflowRequests++;
  });
  await addConnection(page);
  await expect(page.getByRole("cell", { name: "Status running" })).toBeVisible();
  const beforeReconnect = workflowRequests;

  await page.keyboard.press("Control+K");
  await page.getByPlaceholder("Type a command, view, or session…").fill("reconnect");
  await page.getByRole("button", { name: /Force reconnect SSE/i }).click();

  await expect.poll(() => workflowRequests).toBeGreaterThan(beforeReconnect);
});

test("slash commands render in chat and dispatch engine commands", async ({ page }) => {
  const commands: unknown[] = [];
  const state = {
    online: true,
    workflows: [makeWorkflow("wf-slash", ["needs-review"])],
    commands,
  };
  await setupEngineRoutes(page, state);
  await addConnection(page);
  await page.getByRole("cell", { name: "Status needs-review" }).click();

  const input = page.getByPlaceholder(/Message/i);
  await input.fill("/help");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("help-row-reply")).toBeVisible();
  await page.keyboard.press("Escape");

  await input.fill("/reply ship it");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    kind: "continue-task",
    workflowId: "wf-slash",
    taskId: "task-needs-review",
    prompt: "ship it",
  });
});

test("pull-to-refresh threshold vibrates and refetches workflows", async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as unknown as { __vibrations: unknown[] }).__vibrations = [];
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value(pattern: unknown) {
        (globalThis as unknown as { __vibrations: unknown[] }).__vibrations.push(pattern);
        return true;
      },
    });
  });
  const state = {
    online: true,
    workflows: [makeWorkflow("wf-refresh", ["running"])],
  };
  let workflowRequests = 0;
  await setupEngineRoutes(page, state, (pathname) => {
    if (pathname === "/workflows") workflowRequests++;
  });
  await addConnection(page);
  await expect(page.getByRole("cell", { name: "Status running" })).toBeVisible();
  const beforeRefresh = workflowRequests;

  const scroller = page.getByTestId("task-list-scroll");
  const box = await scroller.boundingBox();
  if (!box) throw new Error("task list scroller not visible");
  const x = box.x + box.width / 2;
  const y = box.y + 12;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 95, { steps: 12 });
  await page.mouse.up();

  await expect.poll(() => workflowRequests).toBeGreaterThan(beforeRefresh);
  await expect.poll(() => page.evaluate(() =>
    (globalThis as unknown as { __vibrations: unknown[] }).__vibrations.length,
  )).toBeGreaterThan(0);
});
