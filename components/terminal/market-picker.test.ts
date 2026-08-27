import { describe, expect, test, vi } from "vitest";
import { stepHighlight, unsubscribeQuietly } from "./market-picker";

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

describe("stepHighlight", () => {
  test("ArrowDown enters the list at the top and clamps at the bottom", () => {
    expect(stepHighlight(-1, "ArrowDown", 3)).toBe(0);
    expect(stepHighlight(0, "ArrowDown", 3)).toBe(1);
    expect(stepHighlight(2, "ArrowDown", 3)).toBe(2);
  });

  test("ArrowUp enters the list at the bottom and clamps at the top", () => {
    expect(stepHighlight(-1, "ArrowUp", 3)).toBe(2);
    expect(stepHighlight(2, "ArrowUp", 3)).toBe(1);
    expect(stepHighlight(0, "ArrowUp", 3)).toBe(0);
  });

  test("an empty list never highlights", () => {
    expect(stepHighlight(-1, "ArrowDown", 0)).toBe(-1);
    expect(stepHighlight(5, "ArrowUp", 0)).toBe(-1);
  });
});
