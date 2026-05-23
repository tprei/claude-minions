import { describe, expect, it } from "vitest";
import { validateBaseUrl } from "./validateBaseUrl.js";

describe("validateBaseUrl", () => {
  it("accepts http URLs", () => {
    expect(() => validateBaseUrl("http://localhost:3000")).not.toThrow();
    expect(() => validateBaseUrl("http://example.com/api")).not.toThrow();
  });

  it("accepts https URLs", () => {
    expect(() => validateBaseUrl("https://example.com")).not.toThrow();
    expect(() => validateBaseUrl("https://my.server.io:8443/api/")).not.toThrow();
  });

  it("rejects malformed / non-URL strings", () => {
    expect(() => validateBaseUrl("not-a-url")).toThrow("baseUrl is not a valid URL");
    expect(() => validateBaseUrl("")).toThrow("baseUrl is not a valid URL");
    expect(() => validateBaseUrl("   ")).toThrow("baseUrl is not a valid URL");
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => validateBaseUrl("ftp://example.com")).toThrow("baseUrl must use http or https");
    expect(() => validateBaseUrl("file:///etc/passwd")).toThrow("baseUrl must use http or https");
    expect(() => validateBaseUrl("javascript:alert(1)")).toThrow("baseUrl must use http or https");
    expect(() => validateBaseUrl("data:text/html,<h1>x</h1>")).toThrow("baseUrl must use http or https");
  });
});
