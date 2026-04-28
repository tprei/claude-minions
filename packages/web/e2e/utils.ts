import type { Page } from "@playwright/test";

export const E2E_LABEL = "e2e-engine";
export const E2E_CONN_ID = "e2e-conn";
export const E2E_COLOR = "#7c5cff";

export const API_BASE = process.env["MINIONS_E2E_BASE"] ?? "http://127.0.0.1:8801";
export const API_TOKEN = process.env["MINIONS_E2E_TOKEN"] ?? "devtoken";

export async function seedConnection(
  page: Page,
  baseUrl: string = API_BASE,
  token: string = API_TOKEN,
  label: string = E2E_LABEL,
): Promise<void> {
  await page.goto("/");
  await page.evaluate(
    ({ id, label, baseUrl, token, color }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("keyval-store", 1);
        open.onupgradeneeded = () => {
          open.result.createObjectStore("keyval");
        };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("keyval", "readwrite");
          const store = tx.objectStore("keyval");
          const conn = { id, label, baseUrl, token, color };
          store.put([conn], "connections.v1");
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        };
      }),
    {
      id: E2E_CONN_ID,
      label,
      baseUrl,
      token,
      color: E2E_COLOR,
    },
  );
}

export interface CreateSessionBody {
  prompt: string;
  mode?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface CreatedSession {
  slug: string;
  title: string;
  prompt: string;
}

export async function createSessionViaApi(
  baseUrl: string,
  token: string,
  body: CreateSessionBody,
): Promise<CreatedSession> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/sessions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`createSessionViaApi failed (${res.status}): ${text}`);
  }
  const session = (await res.json()) as CreatedSession;
  return session;
}
