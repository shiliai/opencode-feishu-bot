import { describe, expect, it } from "vitest";
import { buildStatusCard } from "../../src/feishu/control-cards.js";

function getMarkdownContent(card: ReturnType<typeof buildStatusCard>): string {
  const markdownElement = card.elements.find(
    (element) => element.tag === "markdown",
  );
  if (!markdownElement || !("content" in markdownElement)) {
    throw new Error("Expected markdown content in status card");
  }

  return markdownElement.content;
}

describe("buildStatusCard", () => {
  it("shows context percentage when the limit is known", () => {
    const card = buildStatusCard({
      session: "ses_123",
      model: null,
      agent: null,
      state: "idle",
      contextUsed: 151_000,
      contextLimit: 400_000,
    });

    expect(getMarkdownContent(card)).toContain("**Context**: 151K/400K (38%)");
  });

  it("omits the context percentage when the limit is unknown", () => {
    const card = buildStatusCard({
      session: "ses_123",
      model: null,
      agent: null,
      state: "idle",
      contextUsed: 151_000,
      contextLimit: null,
    });

    const content = getMarkdownContent(card);
    expect(content).toContain("**Context**: 151K/unknown");
    expect(content).not.toContain("(0%)");
  });
});
