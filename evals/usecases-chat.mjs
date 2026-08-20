// Use-case sweep against the STREAMING tool-loop agent (/api/chat).
// Same 66 cases + validators as usecases.mjs; an adapter maps streamed
// tool calls back onto the legacy assertion shape.
// Usage: node evals/usecases-chat.mjs [cases.json]  (dev server on :3200)

import fs from "fs";
import { chatTurnWithClientTools } from "./lib/stream-client.mjs";

const BASE = "http://localhost:3200";
const SECRET = (fs.readFileSync(".env.local", "utf8").match(/^SERVER_SECRET=(.+)$/m) ?? [])[1];
const CASES = JSON.parse(fs.readFileSync(process.argv[2] ?? "evals/cases.json", "utf8"));
const CONCURRENCY = 4;

function makeCandles() {
  const candles = [];
  let t = 1783200000;
  for (let i = 0; i < 50; i++) {
    const mid = 62500;
    const c = mid + Math.sin(i / 4.5) * 1400 + (i % 7) * 30;
    const o = mid + Math.sin((i - 1) / 4.5) * 1400;
    candles.push({
      t,
      o: Math.round(o),
      h: Math.round(Math.max(o, c) + 180),
      l: Math.round(Math.min(o, c) - 180),
      c: Math.round(c),
    });
    t += 3600;
  }
  return candles;
}

const BASE_CTX = {
  symbol: "BTC/USD",
  timeframe: "1h",
  lastPrice: 62800,
  visibleRange: { from: 1783200000, to: 1783380000 },
  indicators: [],
  drawings: [],
  recentCandles: makeCandles(),
};

function contextFor(kind) {
  const ctx = structuredClone(BASE_CTX);
  if (kind === "drawn_level") {
    ctx.drawings = [
      { id: "u1", kind: "horizontal_line", points: [{ time: 1783300000, price: 64100 }], origin: "user" },
    ];
  }
  if (kind === "indicators_on") {
    ctx.indicators = [
      { id: "s1", name: "Bollinger Bands", inputs: { length: 20 } },
      { id: "s2", name: "Relative Strength Index", inputs: { length: 14 } },
      { id: "s3", name: "MACD", inputs: {} },
    ];
  }
  return ctx;
}

const SELECTED_PLAN = {
  id: "p1",
  title: "Rejection fade at 64100",
  direction: "short",
  thesis: "Fade the rejection at drawn resistance",
  entry: 64050,
  stop: 64450,
  target: 62200,
  invalidation: "4h close above 64500",
};

// ── Adapter: streamed tool calls → legacy assertion shape ───────────────
const CHART_TOOLS = [
  "draw_level", "draw_zone", "draw_trendline", "add_indicators",
  "remove_indicators", "clear_indicators", "set_timeframe", "set_range",
  "set_symbol", "clear_agent_drawings", "clear_all_drawings",
];

function adapt(turn) {
  // Errored calls (schema/geometry rejections) never reached the chart —
  // they are the guard WORKING, not applied actions.
  const applied = turn.toolCalls.filter((t) => !t.errored);
  const actions = applied
    .filter((t) => CHART_TOOLS.includes(t.toolName))
    .map((t) => ({ action: t.toolName, ...(t.input ?? {}) }));
  const compile = applied.find((t) => t.toolName === "compile_strategy");
  let strategy = null;
  if (compile?.input) {
    let config = {};
    try {
      config = JSON.parse(compile.input.configJson ?? "{}");
    } catch {
      /* invalid json fails the strategy validator naturally */
    }
    strategy = { name: compile.input.name, config, code: compile.input.code ?? "" };
  }
  const update = applied.find((t) => t.toolName === "update_plan");
  return {
    reply: turn.reply,
    actions,
    strategy,
    runDetect: applied.some((t) => t.toolName === "detect_setups"),
    updatedPlan: update?.input ?? null,
  };
}

const DRAW_ACTIONS = ["draw_level", "draw_zone", "draw_trendline"];

const VALIDATORS = {
  restraint: (r) => ({
    pass: (r.actions ?? []).length === 0 && !r.strategy && !r.runDetect,
    note: `actions=${(r.actions ?? []).length} strat=${!!r.strategy} detect=${!!r.runDetect}`,
  }),
  draw: (r) => ({
    pass: (r.actions ?? []).some((a) => DRAW_ACTIONS.includes(a.action)),
    note: JSON.stringify((r.actions ?? []).map((a) => a.action)),
  }),
  indicators: (r) => ({
    pass: (r.actions ?? []).some((a) =>
      ["add_indicators", "remove_indicators", "clear_indicators"].includes(a.action),
    ),
    note: JSON.stringify((r.actions ?? []).map((a) => a.action)),
  }),
  timeframe: (r) => ({
    pass: (r.actions ?? []).some((a) => a.action === "set_timeframe" || a.action === "set_range"),
    note: JSON.stringify((r.actions ?? []).map((a) => a.action)),
  }),
  strategy: (r) => {
    const s = r.strategy;
    const cfgOk = s && s.config && s.config.timeframe && s.code?.includes("IStrategy");
    return { pass: !!cfgOk, note: s ? `tf=${s.config?.timeframe}` : "no strategy (compile_strategy not called)" };
  },
  detect: (r) => ({ pass: r.runDetect === true, note: `detect_setups=${r.runDetect}` }),
  plan_edit: (r) => {
    const u = r.updatedPlan;
    if (!u) {
      // Push-back OR clarification are both correct for invalid/vague edits.
      const pushback =
        /\?|invalid|can't|cannot|wrong side|doesn't make|geometry|which|what price|specify|clarif|不合理|無法|哪些|需要知道|請提供|具體/i.test(
          r.reply ?? "",
        );
      return { pass: pushback, note: pushback ? "pushed back / clarified (ok)" : "no update_plan, no pushback" };
    }
    const sane =
      u.direction === "short" ? u.stop > u.entry && u.target < u.entry : u.stop < u.entry && u.target > u.entry;
    return { pass: sane, note: `E${u.entry} S${u.stop} T${u.target} ${u.direction}${sane ? "" : " (INSANE GEOMETRY)"}` };
  },
  clear_agent: (r) => ({
    pass: (r.actions ?? []).some((a) => a.action === "clear_agent_drawings") &&
      !(r.actions ?? []).some((a) => a.action === "clear_all_drawings"),
    note: JSON.stringify((r.actions ?? []).map((a) => a.action)),
  }),
  clear_all: (r) => ({
    pass: (r.actions ?? []).some((a) => a.action === "clear_all_drawings"),
    note: JSON.stringify((r.actions ?? []).map((a) => a.action)),
  }),
  clarify_or_restraint: (r) => ({
    pass:
      (r.actions ?? []).every((a) => !["clear_all_drawings"].includes(a.action)) &&
      !r.strategy &&
      ((r.actions ?? []).length === 0 || /\?|assum/i.test(r.reply ?? "")),
    note: `actions=${(r.actions ?? []).length} asks=${/\?/.test(r.reply ?? "")}`,
  }),
  oos: (r) => ({
    pass: (r.actions ?? []).length === 0 && !r.strategy && !r.runDetect,
    note: `actions=${(r.actions ?? []).length} reply="${(r.reply ?? "").slice(0, 60)}"`,
  }),
  // ── Tool-era categories ────────────────────────────────────────────────
  screen: (r, turn) => ({
    pass: turn.toolCalls.some((t) => t.toolName === "screen_markets" && !t.errored),
    note: `tools=${turn.toolCalls.map((t) => t.toolName).join(",")}`,
  }),
  switch: (r) => ({
    pass: (r.actions ?? []).some((a) => a.action === "set_symbol"),
    note: JSON.stringify((r.actions ?? []).map((a) => `${a.action}${a.pair ? `:${a.pair}` : ""}`)),
  }),
  pnl: (r, turn) => ({
    pass: turn.toolCalls.some((t) => t.toolName === "pnl_check" && !t.errored),
    note: `tools=${turn.toolCalls.map((t) => t.toolName).join(",")}`,
  }),
  no_switch: (r, turn) => ({
    pass: !(r.actions ?? []).some((a) => a.action === "set_symbol"),
    note: `tools=${turn.toolCalls.map((t) => t.toolName).join(",")} reply="${(r.reply ?? "").slice(0, 50)}"`,
  }),
};

async function runCase(c) {
  const body = {
    message: { id: `u-${c.id}`, role: "user", parts: [{ type: "text", text: c.message }] },
    chartContext: contextFor(c.context),
    ...(c.context === "selected_plan" ? { selectedPlan: SELECTED_PLAN } : {}),
  };
  const t0 = Date.now();
  try {
    // Answer client tool calls like the browser would (stub success), so
    // multi-step flows (e.g. set_timeframe → draw_trendline) complete.
    const turn = await chatTurnWithClientTools(BASE, SECRET, body, async () => ({ ok: true }));
    if (!turn.ok) return { ...c, pass: false, note: `stream error: ${turn.error}`, ms: Date.now() - t0 };
    const r = adapt(turn);
    const v = (VALIDATORS[c.expect] ?? VALIDATORS.restraint)(r, turn);
    return { ...c, ...v, reply: (r.reply ?? "").slice(0, 100), ms: Date.now() - t0 };
  } catch (e) {
    return { ...c, pass: false, note: String(e), ms: Date.now() - t0 };
  }
}

const results = [];
let idx = 0;
async function worker() {
  while (idx < CASES.length) {
    const c = CASES[idx++];
    const r = await runCase(c);
    results.push(r);
    console.log(`${r.pass ? "PASS" : "FAIL"}  [${r.expect}] ${r.id}  (${(r.ms / 1000).toFixed(0)}s)  ${r.note}`);
    if (!r.pass) console.log(`      msg: ${r.message.slice(0, 90)}\n      reply: ${r.reply ?? ""}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const byCat = {};
for (const r of results) {
  byCat[r.expect] ??= { pass: 0, fail: 0 };
  byCat[r.expect][r.pass ? "pass" : "fail"]++;
}
console.log("\n── By category ──");
for (const [k, v] of Object.entries(byCat).sort()) console.log(`${k.padEnd(22)} ${v.pass}/${v.pass + v.fail}`);
const total = results.filter((r) => r.pass).length;
console.log(`\nTOTAL ${total}/${results.length}`);
fs.writeFileSync("evals/usecase-chat-results.json", JSON.stringify(results, null, 2));
