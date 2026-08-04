import { beforeEach, describe, expect, it } from "vitest";
import {
  acquireThreadInterest,
  getInterestedThreadIds,
  hasThreadInterest,
  resetThreadInterests,
} from "@features/agent/store/thread-interest";

describe("thread interest registry", () => {
  beforeEach(resetThreadInterests);

  it("keeps interest until the last card releases it", () => {
    const releaseA = acquireThreadInterest("thread-1");
    const releaseB = acquireThreadInterest("thread-1");
    expect(getInterestedThreadIds()).toEqual(["thread-1"]);
    releaseA();
    expect(hasThreadInterest("thread-1")).toBe(true);
    releaseB();
    expect(hasThreadInterest("thread-1")).toBe(false);
  });
});
