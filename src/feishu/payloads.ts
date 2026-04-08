import {
  InteractiveCard,
  InteractiveCardMarkdownElement,
} from "@larksuiteoapi/node-sdk";

export const MAX_TEXT_PAYLOAD_SIZE = 150 * 1024; // 150 KB
export const MAX_CARD_PAYLOAD_SIZE = 30 * 1024; // 30 KB

export function buildTextPayload(text: string): string {
  return JSON.stringify({ text });
}

export function buildPostPayload(
  title: string,
  paragraphs: string[][],
  locale: string = "zh_cn",
): string {
  const content = paragraphs.map((p) =>
    p.map((text) => ({ tag: "text", text })),
  );

  return JSON.stringify({
    [locale]: {
      title,
      content,
    },
  });
}

export function buildCardPayload(
  card: InteractiveCard,
  updateMulti: boolean = false,
): string {
  if (updateMulti) {
    card.config = {
      ...(card.config || {}),
      update_multi: true,
    };
  }
  return JSON.stringify(card);
}

// Splits long text into multiple payloads of safe size (leaving some overhead margin)
export function splitTextPayload(
  text: string,
  maxSize = MAX_TEXT_PAYLOAD_SIZE - 100,
): string[] {
  const payloads: string[] = [];
  let remaining = text;

  // Roughly guess bytes vs chars. Feishu size limits are usually in bytes.
  // A simple way is to chunk by string length (since 1 char <= 4 bytes, 30000 chars is always safe for 150KB)
  const CHUNK_SIZE = Math.floor(maxSize / 4);

  while (remaining.length > 0) {
    if (Buffer.byteLength(remaining, "utf8") <= maxSize) {
      payloads.push(buildTextPayload(remaining));
      break;
    }

    // Find a good split point
    let splitAt = CHUNK_SIZE;
    if (splitAt > remaining.length) {
      splitAt = remaining.length;
    }

    // Try to split at a newline if possible
    const newlinePos = remaining.lastIndexOf("\n", splitAt);
    if (newlinePos > splitAt * 0.5) {
      splitAt = newlinePos + 1; // include the newline
    }

    payloads.push(buildTextPayload(remaining.slice(0, splitAt)));
    remaining = remaining.slice(splitAt);
  }

  return payloads;
}

export function truncateCardPayload(
  card: InteractiveCard,
  updateMulti: boolean = false,
): string {
  const payload = buildCardPayload(card, updateMulti);

  if (Buffer.byteLength(payload, "utf8") <= MAX_CARD_PAYLOAD_SIZE) {
    return payload;
  }

  // Very naive truncation for MVP: If we exceed card size, we start removing elements from the bottom up,
  // keeping the header and at least the first element if possible.
  // A production robust way would traverse and slice strings, but this ensures structural integrity.
  const clonedCard: InteractiveCard = JSON.parse(JSON.stringify(card));

  if (clonedCard.elements && clonedCard.elements.length > 1) {
    while (
      clonedCard.elements.length > 1 &&
      Buffer.byteLength(buildCardPayload(clonedCard, updateMulti), "utf8") >
        MAX_CARD_PAYLOAD_SIZE
    ) {
      clonedCard.elements.pop(); // Remove from bottom
    }
  }

  // If even with 1 element it's too big, truncate the text content of that element
  // Assuming it's a markdown element which is most common for long text
  let finalPayload = buildCardPayload(clonedCard, updateMulti);
  if (
    Buffer.byteLength(finalPayload, "utf8") > MAX_CARD_PAYLOAD_SIZE &&
    clonedCard.elements &&
    clonedCard.elements.length === 1
  ) {
    const el = clonedCard.elements[0] as InteractiveCardMarkdownElement;
    if (el.tag === "markdown" && typeof el.content === "string") {
      // Estimate how much to cut
      const overage =
        Buffer.byteLength(finalPayload, "utf8") - MAX_CARD_PAYLOAD_SIZE;
      const charsToRemove = overage + 100; // buffer
      el.content =
        el.content.slice(0, Math.max(0, el.content.length - charsToRemove)) +
        "... [Truncated]";
      finalPayload = buildCardPayload(clonedCard, updateMulti);
    }
  }

  return finalPayload;
}
