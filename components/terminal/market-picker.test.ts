import { describe, expect, test, vi } from "vitest";
import { unsubscribeQuietly } from "./market-picker";

describe("unsubscribeQuietly", () => {
  test("does not surface rejected subscription cleanup", async () => {
    const subscription = {
      unsubscribe: vi.fn().mockRejectedValue(new Error("signal timed out")),
    };

    unsubscribeQuietly(subscription);

    await Promise.resolve();

    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  });
});
