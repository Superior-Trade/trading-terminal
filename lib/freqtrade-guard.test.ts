import { describe, it, expect } from "vitest";
import { validateStrategySafety } from "./freqtrade-guard";

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

describe("TA-Lib multi-output subscript validation", () => {
  // talib.abstract multi-output results are DataFrames with NAMED columns —
  // the integer form raises "KeyError: 0" on the first candle. Wrong
  // subscripts are validator hard errors routed through the repair loop
  // (which converges: the model re-emits the named form). There is no
  // silent rewrite: a scope-blind regex rewrite corrupts reassigned holders
  // and plain-`import talib` tuple code.

  it("accepts the correct NAMED form (the live KeyError-0 regression)", () => {
    // Named subscripts must not bounce into repair, or the compile→repair
    // loop diverges (the model re-emits names).
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

  it("does not register a tuple-unpacking LHS as a holder", () => {
    // `lower` here is a plain Series, not a multi-output DataFrame — the
    // old holder regex matched "lower = ta.BBANDS" inside the unpacking
    // line and then flagged legitimate uses of the name.
    const errs = validateStrategySafety({
      config: okConfig,
      code: `
        upper, mid, lower = ta.BBANDS(dataframe['close'], timeperiod=20)
        dataframe['bb'] = lower
        first = lower[0]
`,
      leverage: 1,
    });
    expect(errs.join("\n")).not.toMatch(/KeyError/);
  });

  it("does not flag a holder reassigned from a non-TA-Lib RHS", () => {
    const errs = validateStrategySafety({
      config: okConfig,
      code: `
        bollinger = ta.BBANDS(dataframe['close'], timeperiod=20)
        bollinger = qtpylib.bollinger_bands(dataframe['close'], window=20, stds=2)
        dataframe['bb_lower'] = bollinger['lower']
`,
      leverage: 1,
    });
    expect(errs.join("\n")).not.toMatch(/KeyError/);
  });

  it("leaves bare `talib.` results alone — those really are tuples", () => {
    const errs = validateStrategySafety({
      config: okConfig,
      code: `
        bollinger = talib.BBANDS(dataframe['close'], timeperiod=20)
        dataframe['bb_upper'] = bollinger[0]
        dataframe['bb_lower'] = bollinger[2]
`,
      leverage: 1,
    });
    expect(errs.join("\n")).not.toMatch(/KeyError/);
  });

  it("does not touch subscripts on non-TA-Lib results (qtpylib keys differ)", () => {
    const errs = validateStrategySafety({
      config: okConfig,
      code: `
        bb = qtpylib.bollinger_bands(dataframe['close'], window=20, stds=2)
        dataframe['bb_lower'] = bb['lower']
        row = candles[0]
`,
      leverage: 1,
    });
    expect(errs.join("\n")).not.toMatch(/KeyError/);
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

  it("flags an integer subscript on a ta. holder, naming the fix", () => {
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
