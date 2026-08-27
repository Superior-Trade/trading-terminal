import { describe, expect, test } from "vitest";
import {
  parseHlCandles,
  parseLighterCandles,
  lighterMarketKeyCandidates,
  pickLighterMarketId,
} from "./preview-market-data";

describe("parseHlCandles", () => {
  test("maps candleSnapshot rows (ms times, string prices) to preview candles", () => {
    const out = parseHlCandles([
      { t: 1_700_000_000_000, o: "100.5", h: "110", l: "99", c: "105" },
    ]);
    expect(out).toEqual([
      { time: 1_700_000_000, open: 100.5, high: 110, low: 99, close: 105 },
    ]);
  });
});

describe("parseLighterCandles", () => {
  test("maps { c: [...] } numeric rows, sorted ascending", () => {
    const out = parseLighterCandles({
      c: [
        { t: 2_000_000, o: 2, h: 3, l: 1, c: 2.5, v: 1, V: 1, i: 1 },
        { t: 1_000_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 1, V: 1, i: 0 },
      ],
    });
    expect(out.map((c) => Number(c.time))).toEqual([1_000, 2_000]);
    expect(out[1]).toMatchObject({ open: 2, high: 3, low: 1, close: 2.5 });
  });

  test("de-duplicates repeated bar times, keeping the later row", () => {
    const out = parseLighterCandles({
      c: [
        { t: 1_000_000, o: 1, h: 2, l: 1, c: 1 },
        { t: 1_000_000, o: 1, h: 2, l: 1, c: 1.8 },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].close).toBe(1.8);
  });

  test("tolerates malformed payloads", () => {
    expect(parseLighterCandles(null)).toEqual([]);
    expect(parseLighterCandles({})).toEqual([]);
    expect(parseLighterCandles({ c: [{ t: "nope" }] })).toEqual([]);
  });
});

describe("lighterMarketKeyCandidates", () => {
  test("strips the venue prefix and instrument suffix", () => {
    expect(lighterMarketKeyCandidates("LIGHTER:BTC-PERP")).toEqual(["BTC-PERP", "BTC"]);
    expect(lighterMarketKeyCandidates("eth")).toEqual(["ETH"]);
  });
});

describe("pickLighterMarketId", () => {
  const payload = {
    order_book_details: [
      { symbol: "BTC", market_id: 1, status: "active" },
      { symbol: "ETH", market_id: 2, status: "active" },
      { symbol: "OLD", market_id: 9, status: "inactive" },
    ],
  };

  test("resolves picker symbols to their market id", () => {
    expect(pickLighterMarketId(payload, "LIGHTER:BTC-PERP")).toBe(1);
    expect(pickLighterMarketId(payload, "ETH-PERP")).toBe(2);
  });

  test("ignores inactive markets and unknown symbols", () => {
    expect(pickLighterMarketId(payload, "LIGHTER:OLD-PERP")).toBeNull();
    expect(pickLighterMarketId(payload, "LIGHTER:NOPE-PERP")).toBeNull();
  });

  test("tolerates malformed payloads", () => {
    expect(pickLighterMarketId(null, "BTC")).toBeNull();
    expect(pickLighterMarketId({ order_book_details: "x" }, "BTC")).toBeNull();
  });
});
