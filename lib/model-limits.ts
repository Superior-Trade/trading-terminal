// Output-token ceilings for every model call. Without one, OpenRouter reserves
// the model's maximum (65k for Gemini Flash) against the key's credit limit up
// front, so a key with a few dollars left fails a call that would have used a
// few thousand. These are ceilings, not targets: generous enough that a
// normal response never hits them (reasoning tokens count toward them too),
// and a response that does is an error, never a silently truncated strategy.

/** 2–4 plans as structured JSON. */
export const DETECT_MAX_TOKENS = 8_000;
/** A whole Freqtrade strategy: config JSON plus Python. */
export const COMPILE_MAX_TOKENS = 12_000;
/** Chart annotations for one screen. */
export const ANNOTATE_MAX_TOKENS = 4_000;
/** One compacted memory summary. */
export const COMPACT_MAX_TOKENS = 4_000;
/** One chat step at high reasoning effort, tool calls included. */
export const CHAT_MAX_TOKENS = 32_000;
