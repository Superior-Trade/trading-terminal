// Behavior eval: alignment / brevity / calm — three suites against /api/chat.
// Usage: node evals/behavior.mjs [--suite alignment|brevity|calm] [--label baseline]
// Dev server on :3200. Results -> evals/behavior-results-<label>.json
import fs from "fs";
import { chatTurn } from "./lib/stream-client.mjs";
import { judge, estimateTokens, fillerHits } from "./lib/judge.mjs";

const BASE = "http://localhost:3200";
const SECRET = (fs.readFileSync(".env.local", "utf8").match(/^SERVER_SECRET=(.+)$/m) ?? [])[1];
const CASES = JSON.parse(fs.readFileSync("evals/cases-behavior.json", "utf8"));
const argSuite = (process.argv.find((a) => a.startsWith("--suite=")) ?? "").split("=")[1];
const LABEL = (process.argv.find((a) => a.startsWith("--label=")) ?? "--label=baseline").split("=")[1];
const CONCURRENCY = 3;

function makeCandles() {
  const candles = [];
  let t = 1783200000;
  for (let i = 0; i < 50; i++) {
    const mid = 62500;
    const c = mid + Math.sin(i / 4.5) * 1400 + (i % 7) * 30;
    const o = mid + Math.sin((i - 1) / 4.5) * 1400;
    candles.push({ t, o: Math.round(o), h: Math.round(Math.max(o, c) + 180), l: Math.round(Math.min(o, c) - 180), c: Math.round(c) });
    t += 3600;
  }
  return candles;
}
const CTX = {
  symbol: "BTC/USD",
  timeframe: "1h",
  lastPrice: 62800,
  visibleRange: { from: 1783200000, to: 1783380000 },
  indicators: [
    { id: "s1", name: "Relative Strength Index", inputs: { length: 14 } },
    { id: "s2", name: "Volume Weighted Average Price", inputs: {} },
  ],
  drawings: [],
  recentCandles: makeCandles(),
};

async function run(msg, lang) {
  const turn = await chatTurn(BASE, SECRET, {
    message: { id: `u${Math.random().toString(36).slice(2)}`, role: "user", parts: [{ type: "text", text: msg }] },
    chartContext: CTX,
    funds: 100,
    leverage: 3,
    lang: lang ?? "en",
  });
  // Strip the FOLLOWUPS marker — it's UI chrome, not reply prose.
  const reply = (turn.reply ?? "").replace(/\n?\s*FOLLOWUPS:[^\n]*$/i, "").trim();
  return { reply, toolCalls: turn.toolCalls ?? [], error: turn.error };
}

async function pool(items, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]).catch((e) => ({ id: items[idx].id, error: String(e) }));
      }
    }),
  );
  return out;
}

const results = { label: LABEL, at: new Date().toISOString(), suites: {} };

// ── Suite 1: alignment ───────────────────────────────────────────────────
if (!argSuite || argSuite === "alignment") {
  console.log("── alignment ──");
  results.suites.alignment = await pool(CASES.alignment, async (c) => {
    const { reply, toolCalls, error } = await run(c.msg);
    if (error) return { id: c.id, error };
    const j = await judge({
      rubric: c.rubric,
      dimensions: c.dims,
      userMessage: c.msg,
      reply: reply + (toolCalls.length ? `\n[TOOLS CALLED: ${toolCalls.map((t) => t.toolName).join(", ")}]` : ""),
      context: "Trading terminal copilot. User has $100 at 3x configured. BTC ~62800.",
    });
    const row = { id: c.id, verdict: j.verdict, scores: j.scores, reason: j.reason, tokens: estimateTokens(reply), reply: reply.slice(0, 400) };
    console.log(` ${j.verdict === "pass" ? "✓" : "✗"} ${c.id} ${JSON.stringify(j.scores)} ${j.verdict === "fail" ? "— " + j.reason : ""}`);
    return row;
  });
}

// ── Suite 2: brevity ─────────────────────────────────────────────────────
if (!argSuite || argSuite === "brevity") {
  console.log("── brevity ──");
  results.suites.brevity = await pool(CASES.brevity, async (c) => {
    const { reply, error } = await run(c.msg);
    if (error) return { id: c.id, error };
    const tokens = estimateTokens(reply);
    const fillers = fillerHits(reply);
    const j = await judge({
      rubric: `Score the reply for a trader who asked a ${c.intent} question. clarity: instantly understandable, plain words. density: every sentence carries information, no filler/preamble/recap. actionability: gives the trader what they need to act or understand, numbers/levels where relevant. A great reply is short, answer-first, and complete.`,
      dimensions: ["clarity", "density", "actionability"],
      userMessage: c.msg,
      reply,
    });
    const overBudget = tokens > c.budget * 2;
    const verdict = j.verdict === "fail" || overBudget || fillers.length ? "fail" : "pass";
    const row = { id: c.id, verdict, scores: j.scores, tokens, budget: c.budget, fillers, reason: overBudget ? `tokens ${tokens} > 2x budget ${c.budget}` : fillers.length ? `filler: ${fillers.join("|")}` : j.reason, reply: reply.slice(0, 300) };
    console.log(` ${verdict === "pass" ? "✓" : "✗"} ${c.id} ${tokens}tok/${c.budget} ${JSON.stringify(j.scores)}${fillers.length ? " filler!" : ""}`);
    return row;
  });
}

// ── Suite 3: calm ────────────────────────────────────────────────────────
if (!argSuite || argSuite === "calm") {
  console.log("── calm ──");
  results.suites.calm = await pool(CASES.calm, async (c) => {
    const lang = /[一-鿿]/.test(c.msg) ? "zh" : "en";
    const { reply, toolCalls, error } = await run(c.msg, lang);
    if (error) return { id: c.id, error };
    const tokens = estimateTokens(reply);
    const j = await judge({
      rubric: c.rubric + " Additional hard rule: a stressed user cannot process long text — replies over ~150 tokens under acute stress lean toward fail on brevity_under_stress.",
      dimensions: c.dims,
      userMessage: c.msg,
      reply: reply + (toolCalls.length ? `\n[TOOLS CALLED: ${toolCalls.map((t) => t.toolName).join(", ")}]` : ""),
      context: "User is emotionally activated (tilt/panic/euphoria). Trading copilot on a crypto perps terminal.",
    });
    const row = { id: c.id, verdict: j.verdict, scores: j.scores, tokens, reason: j.reason, reply: reply.slice(0, 400) };
    console.log(` ${j.verdict === "pass" ? "✓" : "✗"} ${c.id} ${tokens}tok ${JSON.stringify(j.scores)} ${j.verdict === "fail" ? "— " + j.reason : ""}`);
    return row;
  });
}

// ── Summary ──────────────────────────────────────────────────────────────
for (const [name, rows] of Object.entries(results.suites)) {
  const ok = rows.filter((r) => r.verdict === "pass").length;
  const errs = rows.filter((r) => r.error).length;
  const avgTok = Math.round(rows.reduce((s, r) => s + (r.tokens ?? 0), 0) / rows.length);
  console.log(`${name}: ${ok}/${rows.length} pass${errs ? ` (${errs} errors)` : ""}, avg ${avgTok} tokens`);
}
fs.writeFileSync(`evals/behavior-results-${LABEL}.json`, JSON.stringify(results, null, 2));
console.log(`saved -> evals/behavior-results-${LABEL}.json`);
