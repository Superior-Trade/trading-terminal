import { eq, and, asc } from "drizzle-orm";
import { getDb, schema } from "./db";

// Server-side conversation persistence for the streaming agent route.
// Storage format matches /api/chat-store (UIMessage parts JSON), so the
// client's initial-history load needs no changes.

export interface StoredUIMessage {
  id: string;
  role: string;
  parts: unknown[];
  metadata?: unknown;
}

export async function ensureConversation(
  userId: string,
  conversationId: string,
  title?: string,
): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const existing = await db
    .select({ id: schema.conversations.id, userId: schema.conversations.userId })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId));
  if (existing.length) {
    if (existing[0].userId !== userId) {
      throw new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }
    await db
      .update(schema.conversations)
      .set({ updatedAt: now, ...(title ? { title } : {}) })
      .where(eq(schema.conversations.id, conversationId));
    return;
  }
  await db.insert(schema.conversations).values({
    id: conversationId,
    userId,
    title: title ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

/** Messages after the compaction watermark (what the model should see),
 *  capped to the most recent `limit`. */
export async function loadTail(
  userId: string,
  conversationId: string,
  limit = 20,
): Promise<StoredUIMessage[]> {
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
  if (!convs.length) return [];
  const all = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(asc(schema.messages.createdAt));
  const uptoIdx = convs[0].summaryUptoMessageId
    ? all.findIndex((m) => m.id === convs[0].summaryUptoMessageId)
    : -1;
  return all.slice(uptoIdx + 1, all.length).slice(-limit).map((m) => ({
    id: m.id,
    role: m.role,
    parts: JSON.parse(m.partsJson) as unknown[],
    metadata: m.metadataJson ? JSON.parse(m.metadataJson) : undefined,
  }));
}

/** Insert or replace by id — tool-result continuations re-send the same
 *  assistant message with outputs filled in. */
export async function upsertMessages(
  conversationId: string,
  messages: StoredUIMessage[],
): Promise<void> {
  const db = getDb();
  const now = Date.now();
  for (const m of messages) {
    await db
      .insert(schema.messages)
      .values({
        id: m.id,
        conversationId,
        role: m.role,
        partsJson: JSON.stringify(m.parts ?? []),
        metadataJson: m.metadata ? JSON.stringify(m.metadata) : null,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: schema.messages.id,
        set: {
          partsJson: JSON.stringify(m.parts ?? []),
          metadataJson: m.metadata ? JSON.stringify(m.metadata) : null,
        },
      });
  }
}
