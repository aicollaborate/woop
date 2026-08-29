import assert from "node:assert/strict";
import test from "node:test";
import { mergeFlowixProfileBundles } from "../src/runtime/profile-manifest.ts";

test("required Flowix layers lead while third-party DSH bundles keep their order", () => {
  assert.deepEqual(
    mergeFlowixProfileBundles([
      "third-party-a",
      "dsh-flowix-memory",
      "dsh-appserver",
      "third-party-b",
      "@deepseek-ai/dsh-base",
    ]),
    [
      "@deepseek-ai/dsh-base",
      "dsh-appserver",
      "dsh-flowix-memory",
      "third-party-a",
      "third-party-b",
    ],
  );
});

test("malformed profile bundle values are not persisted", () => {
  assert.deepEqual(mergeFlowixProfileBundles([null, 1, {}, "third-party"]), [
    "@deepseek-ai/dsh-base",
    "dsh-appserver",
    "dsh-flowix-memory",
    "third-party",
  ]);
});
