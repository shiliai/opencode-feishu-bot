import { describe, it, expect } from "vitest";
import {
  splitTextPayload,
  truncateCardPayload,
  MAX_TEXT_PAYLOAD_SIZE,
  MAX_CARD_PAYLOAD_SIZE
} from "../../src/feishu/payloads.js";
import type { InteractiveCard } from "@larksuiteoapi/node-sdk";

describe("Feishu Payload Limits", () => {
  it("oversized text splits safely and reconstructs exactly", () => {
    const part1 = "a".repeat(Math.floor(MAX_TEXT_PAYLOAD_SIZE / 2));
    const part2 = "b".repeat(Math.floor(MAX_TEXT_PAYLOAD_SIZE / 2));
    const part3 = "c".repeat(100);
    const largeText = part1 + part2 + part3;

    const splits = splitTextPayload(largeText);
    
    expect(splits.length).toBeGreaterThan(1);
    
    let reconstructed = "";
    for (const split of splits) {
      expect(Buffer.byteLength(split, 'utf8')).toBeLessThanOrEqual(MAX_TEXT_PAYLOAD_SIZE);
      const parsed = JSON.parse(split);
      reconstructed += parsed.text;
    }
    
    expect(reconstructed).toBe(largeText);
  });

  it("oversized cards truncate safely and stay valid JSON", () => {
    const largeContent = "x".repeat(MAX_CARD_PAYLOAD_SIZE + 1000);
    const giantCard: InteractiveCard = {
      elements: [
        { tag: "markdown", content: "Header" },
        { tag: "markdown", content: largeContent }
      ]
    };

    const truncatedStr = truncateCardPayload(giantCard);
    
    expect(Buffer.byteLength(truncatedStr, 'utf8')).toBeLessThanOrEqual(MAX_CARD_PAYLOAD_SIZE);
    
    const parsed = JSON.parse(truncatedStr);
    expect(parsed.elements).toBeDefined();
    
    // It should have dropped the second element because dropping it makes it fit
    expect(parsed.elements.length).toBe(1);
    expect(parsed.elements[0].content).toBe("Header");
  });

  it("giant single-element cards truncate content with suffix", () => {
    const largeContent = "x".repeat(MAX_CARD_PAYLOAD_SIZE + 1000);
    const giantCard: InteractiveCard = {
      elements: [
        { tag: "markdown", content: largeContent }
      ]
    };

    const truncatedStr = truncateCardPayload(giantCard);
    expect(Buffer.byteLength(truncatedStr, 'utf8')).toBeLessThanOrEqual(MAX_CARD_PAYLOAD_SIZE);
    
    const parsed = JSON.parse(truncatedStr);
    expect(parsed.elements[0].content).toMatch(/\[Truncated\]$/);
  });

  it("update-card payloads preserve config.update_multi = true", () => {
    const card: InteractiveCard = {
      elements: [{ tag: "markdown", content: "Test" }]
    };

    const payload = truncateCardPayload(card, true);
    const parsed = JSON.parse(payload);
    
    expect(parsed.config).toBeDefined();
    expect(parsed.config.update_multi).toBe(true);
  });
});
