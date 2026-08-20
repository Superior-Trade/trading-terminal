import { NextResponse } from "next/server";
import { desc, eq, and } from "drizzle-orm";
import { getDb, schema } from "../../../lib/db";
import { currentAccount } from "../../../lib/account";

export const runtime = "nodejs";

// GET  /api/chat-store               -> user's conversations (newest first)
// GET  /api/chat-store?c=<id>        -> messages of one conversation
// POST /api/chat-store { conversationId, title?, state?, messages: [...] }
//   Upserts the conversation, appends messages (id-deduped).

export async function GET(req: Request) {
  try {
    const user = await currentAccount();
    const db = getDb();
    const convId = new URL(req.url).searchParams.get("c");
    if (!convId) {
      const items = await db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.userId, user.id))
        .orderBy(desc(schema.conversations.updatedAt))
        .limit(50);
      return NextResponse.json({ items });
    }
    const conv = await db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, convId),
          eq(schema.conversations.userId, user.id),
        ),
      );
    if (!conv.length) return NextResponse.json({ items: [] });
    // Cap the DISPLAY history — a long conversation shouldn't ship hundreds of
    // messages to the client (slow fetch + render). Take the newest N, then
    // restore chronological order. The model's own context is tail-limited
    // separately (loadTail + rolling-memory compaction).
    const DISPLAY_LIMIT = 80;
    const recent = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, convId))
      .orderBy(desc(schema.messages.createdAt))
      .limit(DISPLAY_LIMIT);
    const items = recent.reverse();
    return NextResponse.json({
      items: items.map((m) => ({
        id: m.id,
        role: m.role,
        parts: JSON.parse(m.partsJson),
        metadata: m.metadataJson ? JSON.parse(m.metadataJson) : undefined,
        createdAt: m.createdAt,
      })),
      state: conv[0].stateJson ? JSON.parse(conv[0].stateJson) : null,
    });
  } catch (err) {
    if (err instanceof Response) return err;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "chat-store error" },
      { status: 500 },
    );
  }
}

interface IncomingMessage {
  id: string;
  role: string;
  parts: unknown[];
  metadata?: unknown;
  createdAt?: number;
}

export async function POST(req: Request) {
  try {
    const user = await currentAccount();
    const db = getDb();
    const body = (await req.json()) as {
      conversationId: string;
      title?: string;
      state?: unknown;
      messages?: IncomingMessage[];
    };
    if (!body.conversationId) {
      return NextResponse.json({ error: "conversationId required" }, { status: 400 });
    }
    const now = Date.now();
    const existing = await db
      .select({ id: schema.conversations.id, userId: schema.conversations.userId })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, body.conversationId));
    if (existing.length && existing[0].userId !== user.id) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (!existing.length) {
      await db.insert(schema.conversations).values({
        id: body.conversationId,
        userId: user.id,
        title: body.title ?? null,
        stateJson: body.state ? JSON.stringify(body.state) : null,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await db
        .update(schema.conversations)
        .set({
          updatedAt: now,
          ...(body.title ? { title: body.title } : {}),
          ...(body.state !== undefined
            ? { stateJson: JSON.stringify(body.state) }
            : {}),
        })
        .where(eq(schema.conversations.id, body.conversationId));
    }
    for (const m of body.messages ?? []) {
      await db
        .insert(schema.messages)
        .values({
          id: m.id,
          conversationId: body.conversationId,
          role: m.role,
          partsJson: JSON.stringify(m.parts ?? []),
          metadataJson: m.metadata ? JSON.stringify(m.metadata) : null,
          createdAt: m.createdAt ?? now,
        })
        .onConflictDoNothing();
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof Response) return err;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "chat-store error" },
      { status: 500 },
    );
  }
}

// DELETE /api/chat-store?c=<id> — wipe a conversation: its messages AND the
// conversation row (which holds the rolling-memory summary), so /clear and
// /reset truly start over. Ownership-checked; recreated on the next message.
export async function DELETE(req: Request) {
  try {
    const user = await currentAccount();
    const db = getDb();
    const convId = new URL(req.url).searchParams.get("c");
    if (!convId) {
      return NextResponse.json({ error: "c required" }, { status: 400 });
    }
    const conv = await db
      .select({ userId: schema.conversations.userId })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, convId));
    // Not found → nothing to clear (idempotent). Found but not owned → forbid.
    if (conv.length && conv[0].userId !== user.id) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    await db
      .delete(schema.messages)
      .where(eq(schema.messages.conversationId, convId));
    await db
      .delete(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, convId),
          eq(schema.conversations.userId, user.id),
        ),
      );
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof Response) return err;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "chat-store delete error" },
      { status: 500 },
    );
  }
}
