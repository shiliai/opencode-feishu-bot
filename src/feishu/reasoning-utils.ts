/**
 * Reasoning text extraction and stripping utilities.
 *
 * Ports the reasoning-related functions from openclaw-lark's
 * `src/card/builder.ts` for use in the Feishu bridge response pipeline.
 *
 * Supported reasoning formats:
 * - `💭...💭` emoji blocks
 * - `<thinking>...</thinking>` XML tags (Claude)
 * - `<thought>...</thought>` XML tags
 * - `<antthinking>...</antthinking>` XML tags
 * - `Reasoning:\n...` prefix (OpenAI)
 *
 * All functions are pure with no side effects, safe for streaming partials.
 */

const REASONING_PREFIX = "Reasoning:\n";

/**
 * Split a payload text into optional `reasoningText` and `answerText`.
 *
 * Handles two formats produced by the framework:
 * 1. "Reasoning:\n_italic line_\n…" prefix (from `formatReasoningMessage`)
 * 2. `💭…💭` / `<thinking>…</thinking>` XML tags
 *
 * @param text - Raw response text (may be partial during streaming)
 * @returns Object with optional `reasoningText` and/or `answerText`
 */
export function splitReasoningText(text?: string): {
  reasoningText?: string;
  answerText?: string;
} {
  if (typeof text !== "string" || !text.trim()) return {};

  const trimmed = text.trim();

  // Case 1: "Reasoning:\n..." prefix — the entire payload is reasoning
  if (
    trimmed.startsWith(REASONING_PREFIX) &&
    trimmed.length > REASONING_PREFIX.length
  ) {
    return { reasoningText: cleanReasoningPrefix(trimmed) };
  }

  // Case 2: XML thinking tags — extract content and strip from answer
  const taggedReasoning = extractThinkingContent(text);
  const strippedAnswer = stripReasoningTags(text);
  if (!taggedReasoning && strippedAnswer === text) {
    return { answerText: text };
  }
  return {
    reasoningText: taggedReasoning || undefined,
    answerText: strippedAnswer || undefined,
  };
}

/**
 * Extract content from `💭`, `<thinking>`, `<thought>` blocks.
 * Handles both closed and unclosed (streaming) tags.
 *
 * Scans the text for opening/closing thinking tags and returns the
 * concatenated content from all matched blocks.
 *
 * @param text - Raw response text
 * @returns Concatenated thinking content (trimmed), or empty string
 */
export function extractThinkingContent(text: string): string {
  if (!text) return "";
  const scanRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
  let result = "";
  let lastIndex = 0;
  let inThinking = false;
  for (const match of text.matchAll(scanRe)) {
    const idx = match.index ?? 0;
    if (inThinking) {
      result += text.slice(lastIndex, idx);
    }
    inThinking = match[1] !== "/";
    lastIndex = idx + match[0].length;
  }
  // Handle unclosed tag (still streaming)
  if (inThinking) {
    result += text.slice(lastIndex);
  }
  return result.trim();
}

/**
 * Strip reasoning blocks — both XML tags with their content and any
 * "Reasoning:\n" prefixed content.
 *
 * Three-pass removal:
 * 1. Complete XML blocks (open + close tags with content)
 * 2. Unclosed tag at end (streaming in-progress)
 * 3. Orphaned closing tags
 *
 * @param text - Raw response text
 * @returns Text with all reasoning blocks removed (trimmed)
 */
export function stripReasoningTags(text: string): string {
  // Strip complete XML blocks
  let result = text.replace(
    /<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi,
    "",
  );
  // Strip unclosed tag at end (streaming)
  result = result.replace(
    /<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*$/gi,
    "",
  );
  // Strip orphaned closing tags
  result = result.replace(
    /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi,
    "",
  );
  return result.trim();
}

/**
 * Clean a "Reasoning:\n_italic_" formatted message back to plain text.
 * Strips the prefix and per-line italic markdown wrappers.
 *
 * @param text - Text with "Reasoning:\n" prefix and optional italic wrappers
 * @returns Plain text with prefix and wrappers removed
 */
function cleanReasoningPrefix(text: string): string {
  let cleaned = text.replace(/^Reasoning:\s*/i, "");
  cleaned = cleaned
    .split("\n")
    .map((line) => line.replace(/^_(.+)_$/, "$1"))
    .join("\n");
  return cleaned.trim();
}
