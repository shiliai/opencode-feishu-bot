/**
 * Markdown style optimization for Feishu card display.
 *
 * Ported from openclaw-lark/src/card/markdown-style.ts.
 * Pure function, no side effects, no external dependencies.
 */

/**
 * Optimize Markdown for Feishu card rendering.
 *
 * Transformation pipeline:
 * 1. Extract code blocks → placeholders (protect from modification)
 * 2. Heading downgrade: H1→H4, H2~H6→H5 (only if doc has H1-H3)
 * 3. For cardVersion >= 2: consecutive heading spacing with `<br>`,
 *    table spacing with `<br>`, code blocks get `<br>` before/after
 * 4. Restore code blocks
 * 5. Compress 3+ consecutive newlines → 2
 * 6. Strip invalid image keys (non-`img_xxx` image references)
 *
 * @param text - Raw markdown text
 * @param cardVersion - Feishu card version (default 2). Version 2 enables
 *   `<br>` spacing enhancements.
 * @returns Optimized markdown string safe for Feishu card rendering.
 */
export function optimizeMarkdownStyle(
  text: string,
  cardVersion: number = 2,
): string {
  try {
    let r = _optimizeMarkdownStyle(text, cardVersion);
    r = stripInvalidImageKeys(r);
    return r;
  } catch {
    return text;
  }
}

/**
 * Internal implementation — separated so the outer try/catch is a safety net.
 */
function _optimizeMarkdownStyle(text: string, cardVersion: number = 2): string {
  // ── 1. Extract code blocks, protect with placeholders, restore later ──
  const MARK = "___CB_";
  const codeBlocks: string[] = [];
  let r = text.replace(/```[\s\S]*?```/g, (m) => {
    return `${MARK}${codeBlocks.push(m) - 1}___`;
  });

  // ── 2. Heading downgrade ────────────────────────────────────────────
  // Only downgrade when the original document contains H1–H3 headings.
  // Order matters: process H2–H6 first, then H1.
  // If we did H1→H4 first, the resulting #### would be caught by #{2,6} → H5.
  const hasH1toH3 = /^#{1,3} /m.test(text);
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, "##### $1"); // H2–H6 → H5
    r = r.replace(/^# (.+)$/gm, "#### $1"); // H1 → H4
  }

  if (cardVersion >= 2) {
    // ── 3. Add paragraph spacing between consecutive headings ──────────
    r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, "$1\n<br>\n$2");

    // ── 4. Table spacing ──────────────────────────────────────────────
    // 4a. When a non-table line is immediately followed by a table row,
    //     insert a blank line.
    r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, "$1\n\n$2");
    // 4b. Before table: insert <br> before the blank line preceding a table.
    r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, "\n\n<br>\n\n$1");
    // 4c. After table: append <br> (skip if followed by hr/heading/bold/eof).
    r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, (m, _table, offset) => {
      const after = r.slice(offset + m.length).replace(/^\n+/, "");
      if (!after || /^(---|#{4,5} |\*\*)/.test(after)) return m;
      return `${m}\n<br>\n`;
    });
    // 4d. Table preceded by plain text (non-heading, non-bold): collapse to
    //     single <br>, remove extra blank lines.
    r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n$3");
    // 4d2. Table preceded by bold line: <br> right after bold, keep blank line.
    r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n\n$3");
    // 4e. Table followed by plain text (non-heading, non-bold): collapse to
    //     single <br>, remove extra blank lines.
    r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, "$1$2$3");

    // ── 5. Restore code blocks with <br> padding ──────────────────────
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, `\n<br>\n${block}\n<br>\n`);
    });
  } else {
    // ── 5. Restore code blocks (no <br>) ─────────────────────────────
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, block);
    });
  }

  // ── 6. Compress 3+ consecutive newlines → 2 ────────────────────────
  r = r.replace(/\n{3,}/g, "\n\n");

  return r;
}

// ---------------------------------------------------------------------------
// stripInvalidImageKeys
// ---------------------------------------------------------------------------

/** Matches complete markdown image syntax: `![alt](value)` */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Strip `![alt](value)` where value is not a valid Feishu image key
 * (`img_xxx`). Prevents CardKit error 200570.
 *
 * HTTP URLs are stripped as well — any image resolver should have already
 * replaced them with `img_xxx` keys before this point. This serves
 * as a safety net for any unresolved URLs.
 */
function stripInvalidImageKeys(text: string): string {
  if (!text.includes("![")) return text;
  return text.replace(IMAGE_RE, (fullMatch, _alt, value) => {
    if (value.startsWith("img_")) return fullMatch;
    return ""; // strip all non-img_ image references (URLs, local paths, etc.)
  });
}
