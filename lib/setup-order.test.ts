import { describe, it, expect } from "vitest";
import { orderSetupsNewestFirst, setupTimestamp } from "./setup-order";

const dep = (id: string, createdAt: string) => ({ id, createdAt });
const brk = (id: string, created_at: string) => ({ id, created_at });

const idsOf = (rows: ReturnType<typeof orderSetupsNewestFirst>) =>
  rows.map((r) => (r.kind === "dep" ? (r.item as { id: string }).id : (r.b as { id: string }).id));

describe("orderSetupsNewestFirst", () => {
  it("interleaves the two kinds by time instead of grouping by type", () => {
    // The reported bug: every recurring first, then every one-shot.
    const rows = orderSetupsNewestFirst(
      [dep("dep-old", "2026-08-10T00:00:00Z"), dep("dep-new", "2026-08-14T12:00:00Z")],
      [brk("brk-mid", "2026-08-12T00:00:00Z"), brk("brk-newest", "2026-08-15T09:00:00Z")],
    );
    expect(idsOf(rows)).toEqual(["brk-newest", "dep-new", "brk-mid", "dep-old"]);
  });

  it("puts a one-shot placed minutes ago above a week-old deployment", () => {
    const rows = orderSetupsNewestFirst(
      [dep("last-week", "2026-08-08T10:00:00Z")],
      [brk("just-now", "2026-08-15T10:00:00Z")],
    );
    expect(idsOf(rows)[0]).toBe("just-now");
  });

  it("accepts snake_case on deployments too", () => {
    const rows = orderSetupsNewestFirst(
      [{ id: "snake", created_at: "2026-08-15T11:00:00Z" }],
      [brk("older", "2026-08-14T11:00:00Z")],
    );
    expect(idsOf(rows)).toEqual(["snake", "older"]);
  });

  it("sorts rows with missing or unparseable timestamps last, not into NaN", () => {
    const rows = orderSetupsNewestFirst(
      [dep("no-date", ""), dep("dated", "2026-08-14T00:00:00Z")],
      [{ id: "junk", created_at: "not-a-date" }],
    );
    expect(idsOf(rows)[0]).toBe("dated");
    expect(idsOf(rows).slice(1).sort()).toEqual(["junk", "no-date"]);
  });

  it("handles either list being empty", () => {
    expect(idsOf(orderSetupsNewestFirst([dep("a", "2026-08-14T00:00:00Z")], []))).toEqual(["a"]);
    expect(idsOf(orderSetupsNewestFirst([], [brk("b", "2026-08-14T00:00:00Z")]))).toEqual(["b"]);
    expect(orderSetupsNewestFirst([], [])).toEqual([]);
  });
});

describe("setupTimestamp", () => {
  it("returns 0 rather than NaN for anything unusable", () => {
    expect(setupTimestamp(undefined)).toBe(0);
    expect(setupTimestamp(null)).toBe(0);
    expect(setupTimestamp("")).toBe(0);
    expect(setupTimestamp("not-a-date")).toBe(0);
  });

  it("parses an ISO timestamp", () => {
    expect(setupTimestamp("2026-08-14T00:00:00Z")).toBe(Date.parse("2026-08-14T00:00:00Z"));
  });
});
