import assert from "node:assert/strict";
import { test } from "node:test";
import { pickModel } from "../prism-agent.mjs";

const mib = 1024 ** 2;

test("picks a fitting Ollama tier within the requested ceiling", () => {
  assert.equal(pickModel(null, 18_000 * mib), "dcostenco/prism-coder:27b");
  assert.equal(pickModel("9b", 18_000 * mib), "dcostenco/prism-coder:9b");
  assert.equal(pickModel(null, 1_500 * mib), "dcostenco/prism-coder:2b");
});

test("refuses automatic loading when the RAM measurement is invalid or too small", () => {
  for (const bytes of [NaN, Infinity, -1, 0, 1_500 * mib - 1]) {
    assert.equal(pickModel(null, bytes), null);
  }
});
