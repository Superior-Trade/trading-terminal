import { describe, it, expect } from "vitest";
import { validateStrategySafety, fixTaLibTupleSubscripts } from "./freqtrade-guard";

// A config that satisfies the pre-existing guard rules (stoploss/roi),
// so tests isolate the entry-confirmation / no-instant-entry check.
const okConfig = { stoploss: -0.2, minimal_roi: { "0": 0.05 } };

const wrap = (entryBody: string, exitBody: string) => `
import talib.abstract as ta
class S:
    startup_candle_count = 50
    def populate_indicators(self, dataframe, metadata):
        dataframe['rsi'] = ta.RSI(dataframe)
        return dataframe
    def populate_entry_trend(self, dataframe, metadata):
${entryBody}
        return dataframe
    def populate_exit_trend(self, dataframe, metadata):
${exitBody}
        return dataframe
`;

const has = (errs: string[], needle: string) => errs.some((e) => e.includes(needle));

describe("freqtrade-guard: entry confirmation + no instant-entry", () => {
  it("rejects a bare price-level touch (no indicator, no cross)", () => {
    const code = wrap(
      "        dataframe.loc[(dataframe['low'] <= 57.50) & (dataframe['volume'] > 0), 'enter_long'] = 1",
      "        dataframe.loc[(dataframe['rsi'] > 70), 'exit_long'] = 1",
    );
    const errs = validateStrategySafety({ config: okConfig, code, leverage: 1 });
    expect(has(errs, "bare price/level touch")).toBe(true);
  });

  it("accepts an indicator-gated entry", () => {
    const code = wrap(
      "        dataframe.loc[(dataframe['rsi'] < 30) & (dataframe['volume'] > 0), 'enter_long'] = 1",
      "        dataframe.loc[(dataframe['rsi'] > 70), 'exit_long'] = 1",
    );
    const errs = validateStrategySafety({ config: okConfig, code, leverage: 1 });
    expect(has(errs, "bare price/level touch")).toBe(false);
  });

  it("accepts a confirmed-cross level entry (no separate indicator)", () => {
    const code = wrap(
      "        dataframe.loc[(dataframe['close'] > 64500) & (dataframe['close'].shift(1) <= 64500) & (dataframe['volume'] > 0), 'enter_long'] = 1",
      "        dataframe.loc[(dataframe['rsi'] > 70), 'exit_long'] = 1",
    );
    const errs = validateStrategySafety({ config: okConfig, code, leverage: 1 });
    expect(has(errs, "bare price/level touch")).toBe(false);
  });
});

describe("fixTaLibTupleSubscripts", () => {
  // Verbatim from deployment 01kzztg6vgc4 ("HYPE BB Range Low Long"), which
  // ran funded for ten hours placing nothing while its entry fired 7 times.
  const LIVE_BROKEN = `
    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        bollinger = ta.BBANDS(dataframe['close'], timeperiod=20, nbdevup=2.0, nbdevdn=2.0, matype=0)
        dataframe['bb_upper'] = bollinger['upperband']
        dataframe['bb_middle'] = bollinger['middleband']
        dataframe['bb_lower'] = bollinger['lowerband']
        return dataframe
`;

  it("rewrites the subscripts that killed the live HYPE bot", () => {
    const fixed = fixTaLibTupleSubscripts(LIVE_BROKEN);
    expect(fixed).toContain("dataframe['bb_upper'] = bollinger[0]");
    expect(fixed).toContain("dataframe['bb_middle'] = bollinger[1]");
    expect(fixed).toContain("dataframe['bb_lower'] = bollinger[2]");
    expect(fixed).not.toMatch(/bollinger\[['"]/);
  });

  it("handles MACD and STOCH, and leaves correct tuple-unpacking alone", () => {
    const src = `
        m = ta.MACD(dataframe)
        dataframe['macd'] = m['macd']
        dataframe['sig'] = m['macdsignal']
        st = ta.STOCH(dataframe)
        dataframe['k'] = st['slowk']
        upper, mid, lower = ta.BBANDS(dataframe['close'], timeperiod=20)
        dataframe['bb'] = lower
`;
    const fixed = fixTaLibTupleSubscripts(src);
    expect(fixed).toContain("m[0]");
    expect(fixed).toContain("m[1]");
    expect(fixed).toContain("st[0]");
    // Already-correct unpacking is untouched.
    expect(fixed).toContain("upper, mid, lower = ta.BBANDS");
    expect(fixed).toContain("dataframe['bb'] = lower");
  });

  it("does not touch dict subscripts on non-TA-Lib results (qtpylib is dict-like)", () => {
    const src = `
        bb = qtpylib.bollinger_bands(dataframe['close'], window=20, stds=2)
        dataframe['bb_lower'] = bb['lower']
`;
    expect(fixTaLibTupleSubscripts(src)).toBe(src);
  });

  it("flags an unrecognised output name instead of deploying it", () => {
    const errs = validateStrategySafety({
      config: okConfig,
      code: `
        bollinger = ta.BBANDS(dataframe['close'], timeperiod=20)
        dataframe['bb_lower'] = bollinger['lower']
`,
      leverage: 1,
    });
    expect(errs.join("\n")).toMatch(/list indices must be integers/);
  });
});
