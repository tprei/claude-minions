import { describe, expect, it, vi } from "vitest";
import { GitHubClient, GitHubApiError } from "../../../src/plugins/github/github-client.js";
import { TokenBucket } from "../../../src/plugins/github/rate-limiter.js";
import { createLogger } from "../../../src/observability/logger.js";
import type { Sink } from "../../../src/observability/sinks.js";
import type { LogRecord } from "../../../src/observability/types.js";

function makeBucket(): TokenBucket {
  return new TokenBucket({ capacity: 20, refillPerSec: 10 });
}

function makeCapturingSink(): { sink: Sink; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { sink: { write: (r) => { records.push(r); } }, records };
}

function makeClient(fetchMock: typeof fetch): GitHubClient {
  return new GitHubClient({ token: "test-pat", bucket: makeBucket(), fetchImpl: fetchMock });
}

function mockFetch(status: number, body: unknown, linkHeader?: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (name: string) => name.toLowerCase() === "link" ? (linkHeader ?? null) : null },
  }) as unknown as typeof fetch;
}

describe("GitHubClient", () => {
  it("injects PAT as Authorization: Bearer header", async () => {
    const fetch = mockFetch(200, []);
    const client = makeClient(fetch);
    await client.findPRByHead("owner", "repo", "feature-branch", "main");
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-pat");
  });

  it("findPRByHead returns null on 404", async () => {
    const client = makeClient(mockFetch(404, "Not Found"));
    const result = await client.findPRByHead("owner", "repo", "feature-branch", "main");
    expect(result).toBeNull();
  });

  it("findPRByHead returns null when response is empty array", async () => {
    const client = makeClient(mockFetch(200, []));
    const result = await client.findPRByHead("owner", "repo", "feature-branch", "main");
    expect(result).toBeNull();
  });

  it("findPRByHead returns PR ref on match", async () => {
    const pr = { number: 42, html_url: "https://github.com/owner/repo/pull/42", head: { ref: "feature-branch" }, base: { ref: "main" }, state: "open" };
    const client = makeClient(mockFetch(200, [pr]));
    const result = await client.findPRByHead("owner", "repo", "feature-branch", "main");
    expect(result).toEqual({ number: 42, url: pr.html_url, headRef: "feature-branch", baseRef: "main", state: "open" });
  });

  it("createPR sends correct URL and body", async () => {
    const fetch = mockFetch(201, {
      number: 99,
      html_url: "https://github.com/owner/repo/pull/99",
      head: { ref: "feature" },
      base: { ref: "main" },
      state: "open",
    });
    const client = makeClient(fetch);
    await client.createPR("owner", "repo", { title: "My PR", body: "body text", head: "feature", base: "main" });
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain("/repos/owner/repo/pulls");
    const bodyParsed = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(bodyParsed["head"]).toBe("feature");
    expect(bodyParsed["base"]).toBe("main");
  });

  it("throws GitHubApiError on non-2xx", async () => {
    const client = makeClient(mockFetch(422, "Unprocessable Entity"));
    await expect(client.createPR("owner", "repo", { title: "T", body: "B", head: "h", base: "b" }))
      .rejects.toBeInstanceOf(GitHubApiError);
  });

  it("mergePR throws GitHubApiError with status 405", async () => {
    const client = makeClient(mockFetch(405, "Method Not Allowed"));
    await expect(client.mergePR("owner", "repo", 1))
      .rejects.toMatchObject({ status: 405 });
  });

  it("mergePR throws GitHubApiError with status 409", async () => {
    const client = makeClient(mockFetch(409, "Conflict"));
    await expect(client.mergePR("owner", "repo", 1))
      .rejects.toMatchObject({ status: 409 });
  });

  describe("listCheckRuns", () => {
    it("returns parsed array on 200", async () => {
      const body = {
        total_count: 1,
        check_runs: [{
          name: "ci/test",
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/checks/1",
          started_at: "2026-05-06T10:00:00Z",
          completed_at: "2026-05-06T10:05:00Z",
          output: { title: "Tests passed", summary: "All green", text: "details" },
        }],
      };
      const client = makeClient(mockFetch(200, body));
      const runs = await client.listCheckRuns("owner", "repo", "abc123");
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        name: "ci/test",
        status: "completed",
        conclusion: "success",
        htmlUrl: "https://github.com/checks/1",
        startedAt: "2026-05-06T10:00:00Z",
        completedAt: "2026-05-06T10:05:00Z",
        output: { title: "Tests passed", summary: "All green", text: "details" },
      });
    });

    it("throws GitHubApiError on 404", async () => {
      const client = makeClient(mockFetch(404, "Not Found"));
      await expect(client.listCheckRuns("owner", "repo", "abc123"))
        .rejects.toBeInstanceOf(GitHubApiError);
    });

    it("throws on 5xx", async () => {
      const client = makeClient(mockFetch(500, "Internal Server Error"));
      await expect(client.listCheckRuns("owner", "repo", "abc123"))
        .rejects.toBeInstanceOf(GitHubApiError);
    });

    it("paginates via Link header", async () => {
      const page1Body = {
        total_count: 2,
        check_runs: [{ name: "check-1", status: "completed", conclusion: "success" }],
      };
      const page2Body = {
        total_count: 2,
        check_runs: [{ name: "check-2", status: "completed", conclusion: "failure" }],
      };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(page1Body)),
          headers: { get: (name: string) => name.toLowerCase() === "link" ? '</repos/owner/repo/commits/abc123/check-runs?per_page=100&page=2>; rel="next"' : null },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(page2Body)),
          headers: { get: () => null },
        }) as unknown as typeof fetch;
      const client = makeClient(fetchMock);
      const runs = await client.listCheckRuns("owner", "repo", "abc123");
      expect(runs).toHaveLength(2);
      expect(runs[0]?.name).toBe("check-1");
      expect(runs[1]?.name).toBe("check-2");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("hits page cap and warns", async () => {
      const pageBody = {
        total_count: 1100,
        check_runs: [{ name: "check", status: "completed", conclusion: "success" }],
      };
      const perpetualLinkFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(pageBody)),
        headers: { get: (name: string) => name.toLowerCase() === "link" ? '</repos/owner/repo/commits/abc123/check-runs?per_page=100&page=2>; rel="next"' : null },
      }) as unknown as typeof fetch;
      const { sink, records } = makeCapturingSink();
      const client = new GitHubClient({ token: "test-pat", bucket: makeBucket(), fetchImpl: perpetualLinkFetch, log: createLogger("debug", [sink]) });
      const runs = await client.listCheckRuns("owner", "repo", "abc123");
      expect(perpetualLinkFetch).toHaveBeenCalledTimes(10);
      expect(runs).toHaveLength(10);
      const warnRecord = records.find((r) => r.lvl === "warn");
      expect(warnRecord).toBeDefined();
      expect(String(warnRecord?.msg)).toMatch(/page cap/);
    });

    it("maps unknown conclusion to undefined", async () => {
      const body = {
        total_count: 1,
        check_runs: [{ name: "ci", status: "completed", conclusion: "some_future_conclusion" }],
      };
      const client = makeClient(mockFetch(200, body));
      const runs = await client.listCheckRuns("owner", "repo", "abc123");
      expect(runs[0]?.conclusion).toBeUndefined();
    });
  });
});
