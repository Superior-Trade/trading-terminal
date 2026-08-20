import { z } from "zod";
import { generateObject } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { eq, and, asc } from "drizzle-orm";
import { getDb, schema } from "./db";

// ── Conversation memory: rolling compaction ─────────────────────────────
//
// One endless conversation per user + a last-8-messages prompt window
// means the agent forgets anything older (risk prefs, strategies built,
// plans discussed). 2026-standard fix (Anthropic compaction semantics,
// implemented app-side because OpenRouter doesn't pass the native
// Compaction API through): pinned extracted FACTS + rolling NARRATIVE
// summary, regenerated from `prior memory + newly-dropped messages` —
// never from full history, so each compaction pass stays small.
//
// Storage: conversations.summary holds JSON {narrative, facts} (server-
// only — stateJson is client-owned session state and must not be touched);
// summaryUptoMessageId marks how far the summary has absorbed. Raw message
// rows are never deleted — compaction changes what the MODEL sees, not
// what the user can scroll back through.
//
// Cache-friendliness: the memory block sits at the top of the prompt and
// only changes at compaction events (roughly every TRIGGER-KEEP_TAIL
// messages), so between compactions the prompt prefix stays byte-stable.

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

/** Compact when this many un-summarized messages have accumulated… */
const TRIGGER_MESSAGES = 24;
/** …absorbing all but the most recent KEEP_TAIL into the summary. */
const KEEP_TAIL = 12;

const FactsSchema = z.object({
  riskProfile: z
    .string()
    .nullable()
    .describe("Stated risk tolerance, sizing, leverage or stop preferences"),
  activePlans: z
    .array(z.string())
    .describe("Trade plans being watched: direction, entry/stop/target, symbol"),
  strategiesBuilt: z
    .array(z.string())
    .describe("Strategies built/backtested/deployed, with key params + outcomes"),
  chartArtifacts: z
    .array(z.string())
    .describe("Levels/zones/trendlines discussed: symbol, timeframe, price"),
  preferences: z
    .array(z.string())
    .describe("Style preferences: timeframes, instruments, indicators, language"),
  openQuestions: z.array(z.string()).describe("Unresolved threads to follow up"),
});

const CompactionSchema = z.object({
  narrative: z
    .string()
    .describe(
      "Chronological summary of the conversation: what was asked, analyzed, built, concluded. Preserve exact numbers (prices, levels, percentages, indicator params).",
    ),
  facts: FactsSchema,
});

export interface ConversationMemory {
  narrative: string;
  facts: z.infer<typeof FactsSchema>;
}

function parseMemory(summary: string | null): ConversationMemory | null {
  if (!summary) return null;
  try {
    const j = JSON.parse(summary) as ConversationMemory;
    return j && typeof j.narrative === "string" ? j : null;
  } catch {
    return null;
  }
}

/** Memory block for the agent/detect prompt, or "" when none exists yet. */
export async function renderMemory(
  userId: string,
  conversationId: string | undefined,
): Promise<string> {
  if (!conversationId) return "";
  try {
    const db = getDb();
    const rows = await db
      .select({ summary: schema.conversations.summary })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.userId, userId),
        ),
      );
    const mem = parseMemory(rows[0]?.summary ?? null);
    if (!mem) return "";
    const facts = Object.entries(mem.facts)
      .map(([k, v]) => {
        const items = Array.isArray(v) ? v : v ? [v] : [];
        return items.length ? `${k}: ${items.join(" | ")}` : null;
      })
      .filter(Boolean)
      .join("\n");
    return `\n=== MEMORY (prior turns — context & stated preferences ONLY) ===\nAny prices, levels, or percentages below are from EARLIER in the conversation and may be STALE — never quote them as current. Use LIVE CHART CONTEXT / market_pulse for all current prices.\n${mem.narrative}${facts ? `\n--- pinned facts ---\n${facts}` : ""}\n`;
  } catch {
    return ""; // memory is an enhancement, never a failure mode
  }
}

function textOf(partsJson: string): string {
  try {
    const parts = JSON.parse(partsJson) as Array<{ type?: string; text?: string }>;
    return parts
      .map((p) => (p.type === "text" && p.text ? p.text : ""))
      .filter(Boolean)
      .join(" ");
  } catch {
    return "";
  }
}

/** Fire-and-forget after replying: fold overflow messages into the memory.
 *  Lags the current turn by design (client persists messages after the
 *  agent responds) — the summary is always ≥ KEEP_TAIL messages behind,
 *  which the verbatim window already covers. */
export async function maybeCompact(
  userId: string,
  conversationId: string | undefined,
): Promise<void> {
  if (!conversationId) return;
  try {
    const db = getDb();
    const convs = await db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.userId, userId),
        ),
      );
    const conv = convs[0];
    if (!conv) return;

    const all = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(asc(schema.messages.createdAt));

    // Un-summarized span = everything after the last absorbed message.
    const uptoIdx = conv.summaryUptoMessageId
      ? all.findIndex((m) => m.id === conv.summaryUptoMessageId)
      : -1;
    const pending = all.slice(uptoIdx + 1);
    if (pending.length < TRIGGER_MESSAGES) return;

    // Absorb all but the tail; cut on a user boundary so the verbatim
    // window always opens with the user speaking.
    let cut = pending.length - KEEP_TAIL;
    while (cut > 0 && pending[cut].role !== "user") cut--;
    const head = pending.slice(0, cut);
    if (head.length < 4) return; // too small to be worth a model call

    const prior = parseMemory(conv.summary);
    const transcript = head
      .map((m) => `${m.role.toUpperCase()}: ${textOf(m.partsJson)}`)
      .filter((l) => !l.endsWith(": "))
      .join("\n");

    const { object } = await generateObject({
      model: openrouter(
        process.env.COMPACT_MODEL ?? "anthropic/claude-haiku-4.5",
      ),
      schema: CompactionSchema,
      system:
        "You compact a trading-copilot conversation into memory. Merge the PRIOR MEMORY with the NEW MESSAGES being archived: carry still-relevant facts forward, drop superseded ones (e.g. a plan that was replaced or closed), and keep exact numbers. Write in English regardless of the conversation language.",
      prompt: [
        prior
          ? `=== PRIOR MEMORY ===\n${JSON.stringify(prior)}`
          : "=== PRIOR MEMORY ===\n(none)",
        `\n=== NEW MESSAGES BEING ARCHIVED ===\n${transcript}`,
      ].join("\n"),
    });

    await db
      .update(schema.conversations)
      .set({
        summary: JSON.stringify(object),
        summaryUptoMessageId: head[head.length - 1].id,
        updatedAt: Date.now(),
      })
      .where(eq(schema.conversations.id, conversationId));
  } catch {
    // Compaction must never break the chat; next turn retries naturally.
  }
}
