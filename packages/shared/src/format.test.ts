import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatCostUsd, formatTokens } from "./format.js";

describe("formatCostUsd", () => {
  it("returns $0.00 for zero", () => {
    assert.equal(formatCostUsd(0), "$0.00");
  });
  it("returns $0.00 for negative values", () => {
    assert.equal(formatCostUsd(-1), "$0.00");
  });
  it("returns $0.00 for NaN", () => {
    assert.equal(formatCostUsd(Number.NaN), "$0.00");
  });
  it("uses 4-decimal precision for sub-cent values", () => {
    assert.equal(formatCostUsd(0.0042), "$0.0042");
  });
  it("uses 2-decimal precision at the cent boundary", () => {
    assert.equal(formatCostUsd(0.01), "$0.01");
  });
  it("rounds to 2 decimals for typical amounts", () => {
    assert.equal(formatCostUsd(1.234), "$1.23");
  });
  it("preserves trailing zeros in 2-decimal format", () => {
    assert.equal(formatCostUsd(1234.5), "$1234.50");
  });
});

describe("formatTokens", () => {
  it("returns 0 for zero", () => {
    assert.equal(formatTokens(0), "0");
  });
  it("returns 0 for negative values", () => {
    assert.equal(formatTokens(-1), "0");
  });
  it("returns 0 for NaN", () => {
    assert.equal(formatTokens(Number.NaN), "0");
  });
  it("renders small integers as-is", () => {
    assert.equal(formatTokens(42), "42");
  });
  it("renders values just under 1k as integers", () => {
    assert.equal(formatTokens(999), "999");
  });
  it("renders 1k with one decimal", () => {
    assert.equal(formatTokens(1000), "1.0k");
  });
  it("renders sub-10k values with one decimal", () => {
    assert.equal(formatTokens(1234), "1.2k");
  });
  it("drops decimals once values reach 10k", () => {
    assert.equal(formatTokens(12_345), "12k");
  });
  it("renders 1M with one decimal", () => {
    assert.equal(formatTokens(1_000_000), "1.0M");
  });
  it("drops decimals once values reach 10M", () => {
    assert.equal(formatTokens(12_300_000), "12M");
  });
});
