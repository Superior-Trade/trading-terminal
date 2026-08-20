// End-to-end feature check against a running dev server.
//
//   npm run dev            # in another terminal
//   node evals/e2e.mjs
//
// Exercises the real thing: the live Superior Trade API, real Hyperliquid
// market data, real OpenRouter calls, and the embedded database. Nothing is
// mocked, so a pass here means a fresh clone actually works.
//
// It never spends money. Deploying a strategy and withdrawing funds are the
// two irreversible actions in this app, and neither is triggered — the tests
// stop at the last read-only step before each. Run them by hand.
const BASE = process.env.E2E_BASE ?? "http://localhost:3200";

const results = [];
let currentGroup = "";

function group(name) {
  currentGroup = name;
}

async function check(name, fn, { optional = false } = {}) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({
      group: currentGroup,
      name,
      ok: true,
      detail,
      ms: Date.now() - started,
    });
  } catch (err) {
    results.push({
      group: currentGroup,
      name,
      ok: false,
      optional,
      detail: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started,
    });
  }
}

async function get(path, timeoutMs = 60_000) {
  const res = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { res, json, text };
}

async function post(path, body, timeoutMs = 120_000) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* streaming or plain text */
  }
  return { res, json, text };
}

const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ── 1. It boots and serves the app ──────────────────────────────────────
group("Boot");

await check("serves the terminal page", async () => {
  const { res, text } = await get("/");
  must(res.ok, `HTTP ${res.status}`);
  must(text.includes("<html"), "no HTML in response");
  return `${(text.length / 1024).toFixed(0)} KB of HTML`;
});

await check("chart library is installed", async () => {
  const { res } = await get("/static/charting_library/charting_library.js");
  must(res.ok, `HTTP ${res.status} — run npm run setup:charts`);
  return "present";
});

// ── 2. The embedded database came up and migrated itself ────────────────
group("Database (embedded, zero-config)");

await check("created its schema on first boot", async () => {
  const { res, json } = await get("/api/usage");
  must(res.ok, `HTTP ${res.status}`);
  must(json?.usage?.chat, "no usage counters — migrations did not run");
  return `chat limit ${json.usage.chat.day.limit}/day`;
});

let conversationId = `e2e-${Date.now()}`;

await check("persists a conversation", async () => {
  const { res } = await post("/api/chat-store", {
    conversationId,
    messages: [
      {
        id: `m-${Date.now()}`,
        role: "user",
        parts: [{ type: "text", text: "e2e persistence probe" }],
      },
    ],
  });
  must(res.ok, `HTTP ${res.status}`);
  // The read param is `c`, not `conversationId` (see app/api/chat-store).
  const back = await get(`/api/chat-store?c=${conversationId}`);
  must(back.res.ok, `read-back HTTP ${back.res.status}`);
  const found = JSON.stringify(back.json).includes("e2e persistence probe");
  must(found, "wrote a message but could not read it back");
  return "write → read verified";
});

await check("lists saved plans", async () => {
  const { res } = await get("/api/plan-store");
  must(res.ok, `HTTP ${res.status}`);
  return "ok";
});

// ── 3. The Superior Trade API, with only an API key ─────────────────────
group("Superior Trade API (public, key-only)");

let mainWallet = null;

await check("resolves the account and its wallets", async () => {
  const { res, json } = await get("/api/account");
  must(res.ok, `HTTP ${res.status}`);
  must(Array.isArray(json?.items) && json.items.length, "no accounts returned");
  mainWallet = json.items[0].wallet_address;
  return `${json.items.length} account(s), main ${mainWallet.slice(0, 8)}…`;
});

await check("lists deployments", async () => {
  const { res, json } = await get("/api/deployments");
  must(res.ok, `HTTP ${res.status}`);
  must(Array.isArray(json?.items), "no items array");
  return `${json.items.length} deployment(s)`;
});

await check("reports live PnL", async () => {
  const { res, json } = await get("/api/deployments/pnl");
  must(res.ok, `HTTP ${res.status}`);
  return json?.items ? `${json.items.length} tracked` : "no open positions";
});

await check("lists backtests", async () => {
  const { res } = await get("/api/backtests");
  must(res.ok, `HTTP ${res.status}`);
  return "ok";
});

await check("lists API keys", async () => {
  const { res, json } = await get("/api/keys");
  must(res.ok, `HTTP ${res.status}`);
  return `${json?.items?.length ?? 0} key(s)`;
});

// ── 4. Money paths — quoted, never executed ─────────────────────────────
group("Funds (read-only; nothing is moved)");

await check("quotes a withdrawal", async () => {
  const { res, json } = await get("/api/withdraw");
  must(res.ok, `HTTP ${res.status}`);
  must(typeof json?.availableUsd === "number", "no availableUsd");
  must(json.mainAddress, "no destination resolved");
  return `$${json.availableUsd} available → ${json.mainAddress.slice(0, 8)}… (fee $${json.feeUsd})`;
});

await check("rejects a withdrawal below the minimum", async () => {
  const { res, json } = await post("/api/withdraw", { amount: 0.01 });
  must(res.status === 400, `expected 400, got ${res.status}`);
  must(/minimum/i.test(json?.error ?? ""), `unexpected error: ${json?.error}`);
  return "guard holds";
});

await check("rejects a withdrawal above the balance", async () => {
  const { res, json } = await post("/api/withdraw", { amount: 99_999_999 });
  must(res.status === 400, `expected 400, got ${res.status}`);
  must(/exceeds/i.test(json?.error ?? ""), `unexpected error: ${json?.error}`);
  return "balance re-checked server-side";
});

// ── 5. Market data ──────────────────────────────────────────────────────
group("Market data");

await check("fetches market intel", async () => {
  const { res } = await get("/api/market-intel?coin=BTC");
  must(res.ok, `HTTP ${res.status}`);
  return "ok";
});

await check("fetches the liquidation heatmap", async () => {
  const { res, json } = await get("/api/liquidation-heatmap?coin=BTC");
  must(res.ok, `HTTP ${res.status}`);
  return json?.available ? "bins returned" : "no data for this coin (expected)";
});

await check("fetches order flow", async () => {
  const { res } = await get("/api/orderflow?coin=BTC");
  must(res.ok, `HTTP ${res.status}`);
  return "ok";
});

// ── 6. The agent — real OpenRouter calls ────────────────────────────────
group("AI agent (real model calls)");

await check("answers a chat turn", async () => {
  const { res, text } = await post(
    "/api/chat",
    {
      conversationId: `${conversationId}-chat`,
      message: {
        id: `u-${Date.now()}`,
        role: "user",
        parts: [
          {
            type: "text",
            text: "In one short sentence: what does the stoploss field do in a Freqtrade strategy?",
          },
        ],
      },
      chart: { symbol: "BTC-USD", timeframe: "15", lastPrice: 62000 },
    },
    180_000,
  );
  must(res.ok, `HTTP ${res.status}: ${text.slice(0, 200)}`);
  must(text.length > 40, `suspiciously short stream: ${text.slice(0, 200)}`);
  return `${text.length} bytes streamed back`;
});

await check("compiles a strategy through the validator", async () => {
  const code = `
from freqtrade.strategy import IStrategy
from pandas import DataFrame
import talib.abstract as ta

class E2EProbe(IStrategy):
    timeframe = '15m'
    can_short = False
    stoploss = -0.10
    minimal_roi = {"0": 0.05}
    startup_candle_count = 60

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe['rsi'] = ta.RSI(dataframe, timeperiod=14)
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (dataframe['rsi'] < 30) & (dataframe['volume'] > 0), 'enter_long'] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[(dataframe['rsi'] > 70), 'exit_long'] = 1
        return dataframe

    def leverage(self, pair: str, current_time, current_rate: float,
                 proposed_leverage: float, max_leverage: float, side: str, **kwargs) -> float:
        return 1.0
`.trim();
  const { res, json, text } = await post(
    "/api/compile",
    {
      name: "E2E Probe",
      code,
      config: {
        stoploss: -0.1,
        minimal_roi: { "0": 0.05 },
        stake_amount: 20,
        exchange: { name: "hyperliquid", pair_whitelist: ["BTC/USDC:USDC"] },
      },
      pair: "BTC/USDC:USDC",
      timeframe: "15m",
    },
    180_000,
  );
  must(res.ok, `HTTP ${res.status}: ${(json?.error ?? text).toString().slice(0, 250)}`);
  return "valid strategy accepted";
});

// /api/compile does not merely validate — it REPAIRS. A rejected strategy goes
// back to the model with the validator's complaints attached, and what returns
// is a rewritten one. So the guarantee under test is not "this 400s", it is the
// stronger and more useful "lookahead-biased code can never come back as valid".
await check("never lets lookahead-biased code through", async () => {
  const code = `
from freqtrade.strategy import IStrategy
from pandas import DataFrame

class E2ELookahead(IStrategy):
    timeframe = '15m'
    stoploss = -0.10
    minimal_roi = {"0": 0.05}
    startup_candle_count = 30

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe['future'] = dataframe['close'].shift(-5)
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (dataframe['future'] > dataframe['close']) & (dataframe['volume'] > 0),
            'enter_long'] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        return dataframe
`.trim();
  const { res, json, text } = await post(
    "/api/compile",
    {
      name: "E2E Lookahead",
      code,
      config: {
        stoploss: -0.1,
        minimal_roi: { "0": 0.05 },
        stake_amount: 20,
        exchange: { name: "hyperliquid", pair_whitelist: ["BTC/USDC:USDC"] },
      },
      pair: "BTC/USDC:USDC",
      timeframe: "15m",
    },
    180_000,
  );
  if (!res.ok) {
    const why = (json?.error ?? "") + JSON.stringify(json?.details ?? "") + text;
    must(/safety validation|lookahead|shift\(-/i.test(why), `rejected for an unrelated reason: ${why.slice(0, 200)}`);
    return "rejected by the validator";
  }
  const returned = json?.strategy?.code ?? "";
  must(returned, "200 OK but no strategy in the response");
  must(!/shift\(\s*-/.test(returned), "REPAIRED STRATEGY STILL READS FUTURE CANDLES");
  return "caught, then repaired into clean code";
});

// ── Report ──────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
let lastGroup = "";
console.log("");
for (const r of results) {
  if (r.group !== lastGroup) {
    console.log(`\n${r.group}`);
    lastGroup = r.group;
  }
  const mark = r.ok ? "PASS" : r.optional ? "SKIP" : "FAIL";
  console.log(`  ${pad(mark, 5)} ${pad(r.name, 46)} ${pad(`${r.ms}ms`, 8)} ${r.detail ?? ""}`);
}
const failed = results.filter((r) => !r.ok && !r.optional);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? ` — ${failed.length} FAILED` : " — all good"),
);
process.exit(failed.length ? 1 : 0);
