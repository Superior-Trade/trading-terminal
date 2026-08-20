// Memory/compaction eval against the STREAMING agent (/api/chat).
// Seeds a long conversation, triggers compaction, verifies recall of
// facts outside the verbatim window. Usage: node evals/memory-chat.mjs

import fs from "fs";
import { chatTurn } from "./lib/stream-client.mjs";

const env = fs.readFileSync(".env.local", "utf8");
const SECRET = env.match(/^SERVER_SECRET=(.+)$/m)[1];
const H = { "Content-Type": "application/json", "x-dev-secret": SECRET };
const BASE = "http://localhost:3200";
const convId = `memchat-${Date.now().toString(36)}`;

const early = [
  ["user", "before anything: I ONLY trade longs, never shorts. hard rule."],
  ["assistant", "Noted — longs only, I won't propose shorts."],
  ["user", "and keep risk per trade at 1% max, my account is small"],
  ["assistant", "Got it: 1% max risk per trade."],
  ["user", "i also prefer the 4h timeframe for everything"],
  ["assistant", "4h as the default timeframe, understood."],
];
const filler = [];
for (let i = 0; i < 11; i++) {
  filler.push(
    ["user", `random question ${i}: is volume higher today than yesterday?`],
    ["assistant", `Volume check ${i}: roughly flat vs yesterday on the 4h.`],
  );
}
const all = [...early, ...filler].map(([role, text], i) => ({
  id: `${convId}-m${i}`,
  role,
  parts: [{ type: "text", text }],
  createdAt: Date.now() - (100 - i) * 60_000,
}));

let res = await fetch(`${BASE}/api/chat-store`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ conversationId: convId, title: "memchat", messages: all }),
});
console.log(`seed: HTTP ${res.status}, ${all.length} messages`);

const CTX = { symbol: "BTC/USD", timeframe: "1h", lastPrice: 62800, indicators: [], drawings: [] };
const msg = (text) => ({ id: `u${Date.now()}`, role: "user", parts: [{ type: "text", text }] });

// Turn 1 triggers fire-and-forget compaction.
let r = await chatTurn(BASE, SECRET, {
  message: msg("hey, quick check-in"),
  conversationId: convId,
  chartContext: CTX,
});
console.log(`turn 1 ok=${r.ok}`);

let summary = null;
for (let i = 0; i < 20; i++) {
  await new Promise((s) => setTimeout(s, 1500));
  const list = await (await fetch(`${BASE}/api/chat-store`, { headers: H })).json();
  const conv = (list.items ?? []).find((c) => c.id === convId);
  if (conv?.summary) {
    summary = JSON.parse(conv.summary);
    break;
  }
}
if (!summary) {
  console.log("✗ FAIL: no summary written after 30s");
  process.exit(1);
}
console.log(`✓ compacted. riskProfile: ${summary.facts.riskProfile}`);

r = await chatTurn(BASE, SECRET, {
  message: msg("remind me — what standing rules did I give you about direction, risk and timeframe?"),
  conversationId: convId,
  chartContext: CTX,
});
const reply = (r.reply ?? "").toLowerCase();
console.log(`recall: ${r.reply}`);
const checks = {
  longsOnly: /long/.test(reply),
  onePercent: /1\s?%|one percent/.test(reply),
  fourHour: /4\s?h/.test(reply),
};
console.log(`── checks: ${Object.entries(checks).map(([k, v]) => `${k}=${v ? "✓" : "✗"}`).join(" ")}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
