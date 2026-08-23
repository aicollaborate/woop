import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("upstream patch contents remain product-neutral", () => {
  const lock = JSON.parse(
    readFileSync(resolve(root, "upstream.lock.json"), "utf8"),
  ) as { patches: string[] };
  for (const relative of lock.patches) {
    const source = readFileSync(resolve(root, relative), "utf8");
    assert.doesNotMatch(source, /flowix/i, `${relative} contains Flowix policy`);
  }
});
