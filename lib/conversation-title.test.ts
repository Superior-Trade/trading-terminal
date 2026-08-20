import { describe, it, expect } from "vitest";
import {
  deriveConversationTitle,
  fallbackConversationTitle,
} from "./conversation-title";

describe("deriveConversationTitle", () => {
  it("keeps a short prompt verbatim", () => {
    expect(deriveConversationTitle("scan HYPE 15m for a long")).toBe(
      "scan HYPE 15m for a long",
    );
  });

  it("keeps the pair and intent when it has to truncate", () => {
    // The subject is the identity of the chat — if truncation loses it, the
    // list is useless. It lives in the first few words, which is the whole
    // reason first-prompt titling works for this product.
    const t = deriveConversationTitle(
      "scan HYPE on the 15m and tell me whether the range low is worth a long here, given funding is negative and OI has been climbing all session",
    );
    expect(t).toContain("HYPE");
    expect(t.length).toBeLessThanOrEqual(53);
    expect(t.endsWith("…")).toBe(true);
  });

  it("cuts on a word boundary, not mid-word", () => {
    const source =
      "analyse the current bitcoin market structure and momentum please";
    const t = deriveConversationTitle(source);
    const kept = t.replace(/…$/, "");
    // The kept text must end where a word ends in the source — i.e. the source
    // continues with a space, never with more letters of the same word.
    expect(source.startsWith(kept)).toBe(true);
    expect(source[kept.length]).toBe(" ");
  });

  it("strips markdown so the list shows words, not syntax", () => {
    expect(
      deriveConversationTitle("**scan** `HYPE` and [see this](https://x.com)"),
    ).toBe("scan HYPE and see this");
  });

  it("collapses newlines from a pasted multi-line prompt", () => {
    expect(deriveConversationTitle("scan HYPE\n\n15m\nlong only")).toBe(
      "scan HYPE 15m long only",
    );
  });

  it("does not leave dangling punctuation before the ellipsis", () => {
    const t = deriveConversationTitle(
      "check ETH, then BTC, then SOL, then HYPE, and report which one is closest to its range low",
    );
    expect(t).not.toMatch(/[,;:\-\s]…$/);
  });

  it("returns empty for an unusable prompt so the caller can fall back", () => {
    expect(deriveConversationTitle("   \n  ")).toBe("");
    expect(deriveConversationTitle("```\ncode only\n```")).toBe("");
  });

  it("falls back to a dated label", () => {
    expect(fallbackConversationTitle(Date.now())).toMatch(/^Chat · /);
    expect(fallbackConversationTitle("not-a-date")).toBe("Untitled chat");
  });
});
