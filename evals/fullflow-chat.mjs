// Full-flow eval, 2026 edition: sim traders (GPT / Gemini via OpenRouter)
// converse with the STREAMING agent, which itself compiles the strategy,
// runs the REAL backtest (backtest_run awaits results in-turn), and
// deploys LIVE via deploy_strategy. Harness only verifies + cleans up.
// Usage: node evals/fullflow-chat.mjs   (dev server on :3200)

import fs from "fs";
import { chatTurnWithClientTools } from "./lib/stream-client.mjs";

const env = fs.readFileSync(".env.local", "utf8");
const SECRET = env.match(/^SERVER_SECRET=(.+)$/m)[1];
const OR_KEY = env.match(/^OPENROUTER_API_KEY=(.+)$/m)[1];
const ST_KEY = env.match(/^SUPERIOR_TRADE_API_KEY=(.+)$/m)[1];
const BASE = "http://localhost:3200";

const SIMS = [
  {
    model: "openai/gpt-5.5",
    goal: "You want a mean-reversion strategy on BTC 1h that buys dips to the lower Bollinger Band when RSI is oversold, with a 4% stop. Have the assistant build it, then ask it to BACKTEST it (April to July 2026), and after seeing results ask it to DEPLOY it live. Be a slightly impatient retail trader.",
  },
  {
    model: "google/gemini-3.5-flash",
    goal: "You drew a resistance line at 64100 and want a breakout strategy that longs when price closes above it, targeting roughly 2R. Have the assistant build it, backtest it over the last 3 months, then deploy it. You write tersely, sometimes in Traditional Chinese.",
  },
];

const CTX = {
  symbol: "BTC/USD",
  timeframe: "1h",
  lastPrice: 62800,
  visibleRange: { from: 1783200000, to: 1783380000 },
  indicators: [
    { id: "s1", name: "Bollinger Bands", inputs: { length: 20 } },
    { id: "s2", name: "Relative Strength Index", inputs: { length: 14 } },
  ],
  drawings: [
    { id: "u1", kind: "horizontal_line", points: [{ time: 1783300000, price: 64100 }], origin: "user" },
  ],
  recentCandles: Array.from({ length: 40 }, (_, i) => {
    const c = 62500 + Math.round(Math.sin(i / 4) * 1300);
    return { t: 1783200000 + i * 3600, o: c - 60, h: c + 200, l: c - 220, c };
  }),
};

async function simUser(model, goal, transcript) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OR_KEY}` },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content: `You are role-playing a retail crypto trader using an AI trading terminal. ${goal}\nRules: reply with ONLY your next chat message to the assistant (short, casual). When the assistant has DEPLOYED your strategy and you are satisfied, reply with exactly: DONE`,
        },
        ...transcript.map((m) => ({
          role: m.role === "assistant" ? "user" : "assistant",
          content: m.text,
        })),
      ],
    }),
  });
  const j = await res.json();
  return (j.choices?.[0]?.message?.content ?? "").trim();
}

async function runFlow({ model, goal }) {
  console.log(`\n════ SIM USER: ${model} ════`);
  const checkpoints = { converse: false, strategy: false, backtest: false, deploy: false, cleanup: false };
  const transcript = [];
  const convId = `ff-${model.split("/")[1]}-${Date.now().toString(36)}`;
  let deploymentId = null;

  for (let turn = 0; turn < 8; turn++) {
    const userMsg = await simUser(model, goal, transcript);
    if (!userMsg || userMsg === "DONE") {
      console.log(`  [sim] DONE after ${turn} turns`);
      break;
    }
    console.log(`  [sim→] ${userMsg.slice(0, 90)}`);
    const r = await chatTurnWithClientTools(
      BASE,
      SECRET,
      {
        message: { id: `u${Date.now()}`, role: "user", parts: [{ type: "text", text: userMsg }] },
        conversationId: convId,
        chartContext: CTX,
      },
      async () => ({ ok: true }), // stub chart execution
    );
    if (!r.ok) {
      console.log(`  [agent ERROR] ${r.error}`);
      break;
    }
    checkpoints.converse = true;
    console.log(`  [←agent] ${(r.reply ?? "").slice(0, 90)}`);
    for (const tc of r.toolCalls) {
      if (tc.errored) continue;
      if (tc.toolName === "compile_strategy") {
        checkpoints.strategy = true;
        console.log(`  [✓ strategy] ${tc.input?.name}`);
      }
      if (tc.toolName === "backtest_run") {
        const out = tc.output ?? {};
        if (out.status === "completed" || out.status === "timeout") {
          checkpoints.backtest = true;
          console.log(`  [✓ backtest] status=${out.status} trades=${out.trades} profit=${out.profitTotalPct}`);
        } else {
          console.log(`  [backtest] ${JSON.stringify(out).slice(0, 120)}`);
        }
      }
      if (tc.toolName === "deploy_strategy") {
        const out = tc.output ?? {};
        if (out.id) deploymentId = out.id;
        if (out.live) {
          checkpoints.deploy = true;
          console.log(`  [✓ deploy] id=${out.id} LIVE`);
        } else {
          console.log(`  [deploy] ${JSON.stringify(out).slice(0, 160)}`);
        }
      }
    }
    transcript.push({ role: "user", text: userMsg }, { role: "assistant", text: r.reply ?? "" });
    if (checkpoints.deploy) break;
  }

  if (deploymentId) {
    // stop (if live) then delete — leaves the account clean for the next sim.
    await fetch(`https://api.superior.trade/v2/deployment/${deploymentId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-api-key": ST_KEY },
      body: JSON.stringify({ action: "stop" }),
    }).catch(() => {});
    const del = await fetch(`https://api.superior.trade/v2/deployment/${deploymentId}`, {
      method: "DELETE",
      headers: { "x-api-key": ST_KEY },
    });
    checkpoints.cleanup = del.ok;
    console.log(`  [cleanup] delete ${del.status}`);
  }

  console.log(`  ── checkpoints: ${Object.entries(checkpoints).map(([k, v]) => `${k}=${v ? "✓" : "✗"}`).join(" ")}`);
  return { model, checkpoints, turns: transcript.length / 2 };
}

const results = [];
for (const sim of SIMS) results.push(await runFlow(sim));
console.log("\n════ SUMMARY ════");
for (const r of results) {
  const passed = Object.values(r.checkpoints).filter(Boolean).length;
  console.log(`${r.model.padEnd(28)} ${passed}/5 checkpoints, ${r.turns} turns`);
}
fs.writeFileSync("evals/fullflow-chat-results.json", JSON.stringify(results, null, 2));
