import assert from "node:assert/strict";
import test from "node:test";
import { mergeFlowixProfileBundles } from "../src/runtime/profile-manifest.ts";

test("required Flowix layers lead while third-party DSH bundles keep their order", () => {
  assert.deepEqual(
    mergeFlowixProfileBundles([
      "third-party-a",
      "dsh-flowix-memory",
      "@flowix/dsh-flowix-bridge",
      "third-party-b",
      "@deepseek-ai/dsh-base",
    ]),
    [
      "@deepseek-ai/dsh-base",
      "@flowix/dsh-flowix-bridge",
      "dsh-flowix-memory",
      "third-party-a",
      "third-party-b",
    ],
  );
});

test("malformed profile bundle values are not persisted", () => {
  assert.deepEqual(mergeFlowixProfileBundles([null, 1, {}, "third-party"]), [
    "@deepseek-ai/dsh-base",
    "@flowix/dsh-flowix-bridge",
    "dsh-flowix-memory",
    "third-party",
  ]);
});
