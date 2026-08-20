/**
 * Title for a saved conversation, derived from the first thing the user said.
 *
 * Derived, not model-generated. The prevailing pattern across chat UIs is to
 * title from the first prompt and let the user rename — and here that is also
 * the honest option: a title is a lookup key in a list, so it has to appear
 * the instant the conversation starts and never change under the user
 * afterwards. An extra model call would cost tokens, arrive late, and could
 * rewrite the label someone had already learned to recognise.
 *
 * What matters for THIS product is that the subject survives truncation. These
 * conversations open with things like "scan HYPE 15m for a long" — the pair
 * and the intent are the whole identity of the chat, and both live in the
 * first few words, which is what makes first-prompt titling work well here.
 */

const MAX = 52;

/** Strip the markdown and whitespace that would otherwise reach the list. */
function flatten(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images → their text
    .replace(/^[>\s]*[-*+]\s+/gm, "") // list bullets
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1") // emphasis
    .replace(/\s+/g, " ")
    .trim();
}

export function deriveConversationTitle(firstUserMessage: string): string {
  const flat = flatten(firstUserMessage);
  if (!flat) return "";
  if (flat.length <= MAX) return flat;

  // Cut on a word boundary so a truncated title still reads as words. Only
  // accept the boundary if it keeps most of the budget — otherwise a long
  // first word would leave a uselessly short title.
  const clipped = flat.slice(0, MAX);
  const lastSpace = clipped.lastIndexOf(" ");
  const base = lastSpace > MAX * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${base.replace(/[,;:.\-–—\s]+$/, "")}…`;
}

/** What the list shows when a conversation has no usable first message. */
export function fallbackConversationTitle(createdAt: number | string | Date): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "Untitled chat";
  return `Chat · ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}
