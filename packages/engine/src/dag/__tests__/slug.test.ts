import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { DAG, DAGNode } from "@minions/shared";
import {
  slugifyText,
  extractNodeKey,
  deriveShipPrefix,
  deriveDagTaskSlug,
} from "../slug.js";

function makeNode(partial: Partial<DAGNode> = {}): DAGNode {
  return {
    id: "n1",
    title: "Untitled",
    prompt: "",
    status: "pending",
    dependsOn: [],
    metadata: {},
    ...partial,
  };
}

function makeDag(partial: Partial<DAG> = {}): DAG {
  return {
    id: "dag-1",
    title: "",
    goal: "",
    nodes: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    metadata: {},
    ...partial,
  };
}

const SLUG_INVARIANT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("slugifyText", () => {
  test("sanitizes uppercase, spaces, punctuation, and accents into kebab-case", () => {
    assert.equal(slugifyText("Héllo, WORLD!  Café"), "hello-world-cafe");
    assert.equal(slugifyText("--Foo___Bar--"), "foo-bar");
    assert.equal(slugifyText("naïve façade"), "naive-facade");
    assert.equal(slugifyText("a/b\\c::d"), "a-b-c-d");
  });

  test("returns empty string for empty or pure-punctuation input", () => {
    assert.equal(slugifyText(""), "");
    assert.equal(slugifyText("!!!---???"), "");
    assert.equal(slugifyText("   "), "");
  });

  test("truncates to maxLen and trims trailing hyphen left by truncation", () => {
    assert.equal(slugifyText("hello-world-foo-bar", 11), "hello-world");
    assert.equal(slugifyText("foo bar baz qux quux", 8), "foo-bar");
    const short = slugifyText("abcdefghij", 5);
    assert.equal(short, "abcde");
    assert.ok(short.length <= 5);
  });
});

describe("extractNodeKey", () => {
  test("prefers the first H1 in the prompt over the title", () => {
    const node = makeNode({
      title: "Some Other Title",
      prompt: "# Add Login Endpoint\n\nDetails follow.",
    });
    assert.equal(extractNodeKey(node, 40), "add-login-endpoint");
  });

  test("falls back to first 6 words of title when prompt has no H1", () => {
    const node = makeNode({
      title: "Refactor session registry to remove dead code from registry helpers",
      prompt: "No heading here, just narrative content.",
    });
    assert.equal(
      extractNodeKey(node, 40),
      "refactor-session-registry-to-remove-dead",
    );
  });

  test("falls back to sha256 prefix when both prompt H1 and title slugify to empty", () => {
    const prompt = "%%% --- !!!";
    const node = makeNode({ title: "***", prompt });
    const expected = createHash("sha256").update(prompt).digest("hex").slice(0, 6);
    assert.equal(extractNodeKey(node, 40), expected);
  });

  test("respects maxLen budget", () => {
    const node = makeNode({
      title: "very long descriptive title that should be hard truncated",
      prompt: "no heading",
    });
    const key = extractNodeKey(node, 10);
    assert.ok(key.length <= 10, `expected ≤ 10 chars, got ${key.length}: ${key}`);
    assert.ok(SLUG_INVARIANT.test(key), `invalid kebab-case: ${key}`);
  });
});

describe("deriveShipPrefix", () => {
  test("returns first 6 alnum chars of rootSessionSlug when present", () => {
    assert.equal(deriveShipPrefix({ rootSessionSlug: "ship-abc123def4" }), "shipab");
    assert.equal(deriveShipPrefix({ rootSessionSlug: "task-xyz789qrs0" }), "taskxy");
  });

  test("falls back to deterministic sha256-derived prefix when rootSessionSlug absent", () => {
    const title = "Some DAG Title";
    const expected = createHash("sha256").update(title).digest("hex").slice(0, 6);
    assert.equal(deriveShipPrefix({ title }), expected);
    assert.equal(
      deriveShipPrefix({ title }),
      deriveShipPrefix({ title }),
      "same title must produce same prefix",
    );
  });

  test("always returns exactly 6 chars matching [a-z0-9]", () => {
    const cases = [
      deriveShipPrefix({ rootSessionSlug: "ship-abc123def4" }),
      deriveShipPrefix({ title: "My DAG" }),
      deriveShipPrefix({}),
      deriveShipPrefix({ rootSessionSlug: "" }),
    ];
    for (const p of cases) {
      assert.equal(p.length, 6, `expected length 6, got ${p.length}: ${p}`);
      assert.ok(/^[a-z0-9]{6}$/.test(p), `not [a-z0-9]{6}: ${p}`);
    }
  });
});

describe("deriveDagTaskSlug", () => {
  test("composes prefix and node key separated by hyphen", () => {
    const dag = makeDag({
      title: "Anything",
      rootSessionSlug: "ship-abcdef1234",
    });
    const node = makeNode({
      title: "Add login endpoint",
      prompt: "# Add Login Endpoint\n\nDetails.",
    });
    const slug = deriveDagTaskSlug(dag, node);
    assert.equal(slug, "shipab-add-login-endpoint");
    assert.ok(SLUG_INVARIANT.test(slug));
  });

  test("total length is ≤ 40 even for very long titles", () => {
    const dag = makeDag({
      title: "Whatever",
      rootSessionSlug: "ship-abcdef1234",
    });
    const node = makeNode({
      title:
        "A truly extraordinarily long descriptive title that surely overflows any reasonable budget for slug generation and beyond",
      prompt: "no heading here either, just plain prose",
    });
    const slug = deriveDagTaskSlug(dag, node);
    assert.ok(slug.length <= 40, `expected ≤ 40 chars, got ${slug.length}: ${slug}`);
    assert.ok(SLUG_INVARIANT.test(slug), `invalid kebab-case: ${slug}`);
  });

  test("output matches invariant regex across diverse inputs", () => {
    const cases: Array<{ dag: DAG; node: DAGNode }> = [
      {
        dag: makeDag({ title: "Plain title" }),
        node: makeNode({ title: "Simple", prompt: "no heading" }),
      },
      {
        dag: makeDag({ rootSessionSlug: "task-xyz789qrs0" }),
        node: makeNode({
          title: "Refactor",
          prompt: "# Heading with !@# punctuation\nbody",
        }),
      },
      {
        dag: makeDag({ title: "Crème brûlée pipeline" }),
        node: makeNode({ title: "Naïve façade", prompt: "" }),
      },
      {
        dag: makeDag({}),
        node: makeNode({ title: "***", prompt: "%%%" }),
      },
    ];
    for (const { dag, node } of cases) {
      const slug = deriveDagTaskSlug(dag, node);
      assert.ok(
        SLUG_INVARIANT.test(slug),
        `slug must match invariant regex: ${slug}`,
      );
      assert.ok(slug.length <= 40, `slug must be ≤ 40 chars: ${slug}`);
    }
  });
});
