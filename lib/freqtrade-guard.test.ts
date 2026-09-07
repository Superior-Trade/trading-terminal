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
  // talib.abstract multi-output results are DataFrames with NAMED columns —
  // the integer form raises "KeyError: 0" on the first candle (seen live:
  // "Strategy raised while computing indicators: KeyError: 0"). The fixer
  // rewrites integer subscripts to the canonical names.
  const INT_BROKEN = `
    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        bollinger = ta.BBANDS(dataframe['close'], timeperiod=20, nbdevup=2.0, nbdevdn=2.0, matype=0)
        dataframe['bb_upper'] = bollinger[0]
        dataframe['bb_middle'] = bollinger[1]
        dataframe['bb_lower'] = bollinger[2]
        return dataframe
`;

  it("rewrites integer subscripts to the DataFrame's named columns", () => {
    const fixed = fixTaLibTupleSubscripts(INT_BROKEN);
    expect(fixed).toContain("dataframe['bb_upper'] = bollinger['upperband']");
    expect(fixed).toContain("dataframe['bb_middle'] = bollinger['middleband']");
    expect(fixed).toContain("dataframe['bb_lower'] = bollinger['lowerband']");
    expect(fixed).not.toMatch(/bollinger\[\d/);
  });

  it("leaves the correct NAMED form alone (the live KeyError-0 regression)", () => {
    const src = `
        bollinger = ta.BBANDS(dataframe['close'], timeperiod=20, nbdevup=2.0, nbdevdn=2.0)
        dataframe['bb_upper'] = bollinger['upperband']
        dataframe['bb_lower'] = bollinger['lowerband']
`;
    expect(fixTaLibTupleSubscripts(src)).toBe(src);
    // ...and the validator accepts it — named subscripts must not bounce into
    // repair, or the compile→repair loop diverges (model re-emits names).
    const errs = validateStrategySafety({
      config: okConfig,
      code: `
class S:
    startup_candle_count = 50
    def populate_indicators(self, dataframe, metadata):
        bollinger = ta.BBANDS(dataframe['close'], timeperiod=20)
        dataframe['bb_lower'] = bollinger['lowerband']
        return dataframe
    def populate_entry_trend(self, dataframe, metadata):
        dataframe.loc[(dataframe['close'] < dataframe['bb_lower']) & (dataframe['volume'] > 0), 'enter_long'] = 1
        return dataframe
`,
      leverage: 1,
    });
    expect(errs).toEqual([]);
  });

  it("handles MACD and STOCH, and leaves tuple-unpacking assignments alone", () => {
    const src = `
        m = ta.MACD(dataframe)
        dataframe['macd'] = m[0]
        dataframe['sig'] = m[1]
        st = ta.STOCH(dataframe)
        dataframe['k'] = st[0]
        upper, mid, lower = ta.BBANDS(dataframe['close'], timeperiod=20)
        dataframe['bb'] = lower
`;
    const fixed = fixTaLibTupleSubscripts(src);
    expect(fixed).toContain("dataframe['macd'] = m['macd']");
    expect(fixed).toContain("dataframe['sig'] = m['macdsignal']");
    expect(fixed).toContain("dataframe['k'] = st['slowk']");
    // Unpacking assignments (comma on the LHS) are never rewritten.
    expect(fixed).toContain("upper, mid, lower = ta.BBANDS");
    expect(fixed).toContain("dataframe['bb'] = lower");
  });

  it("does not touch subscripts on non-TA-Lib results (qtpylib keys differ)", () => {
    const src = `
        bb = qtpylib.bollinger_bands(dataframe['close'], window=20, stds=2)
        dataframe['bb_lower'] = bb['lower']
        row = candles[0]
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
    expect(errs.join("\n")).toMatch(/not one of this TA-Lib function's outputs/);
    expect(errs.join("\n")).toContain("bollinger['lowerband']");
  });

  it("flags a leftover integer subscript (paths that validate without the fixer)", () => {
    const errs = validateStrategySafety({
      config: okConfig,
      code: `
        macd = ta.MACD(dataframe)
        dataframe['macd'] = macd[0]
`,
      leverage: 1,
    });
    expect(errs.join("\n")).toMatch(/KeyError: 0/);
    expect(errs.join("\n")).toContain("macd['macd']");
  });
});
