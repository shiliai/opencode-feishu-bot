import { describe, expect, it, vi } from "vitest";
import { createSessionMessageFetcher } from "../../src/opencode/message-fetcher.js";

function createMockClient(
  messages: Array<{
    info: { id: string; sessionID: string; role: string };
    parts: Array<{ type: string; text?: string }>;
  }>,
) {
  return {
    session: {
      messages: vi.fn().mockResolvedValue({
        data: messages,
        error: undefined,
      }),
    },
  };
}

describe("createSessionMessageFetcher", () => {
  it("returns the last assistant message from API response", async () => {
    const messages = [
      {
        info: { id: "user-1", sessionID: "ses-1", role: "user" },
        parts: [{ type: "text", text: "Hello" }],
      },
      {
        info: { id: "assistant-1", sessionID: "ses-1", role: "assistant" },
        parts: [{ type: "text", text: "First reply" }],
      },
      {
        info: { id: "user-2", sessionID: "ses-1", role: "user" },
        parts: [{ type: "text", text: "Continue" }],
      },
      {
        info: { id: "assistant-2", sessionID: "ses-1", role: "assistant" },
        parts: [{ type: "text", text: "Final summary" }, { type: "tool" }],
      },
    ];

    const client = createMockClient(messages);
    const fetcher = createSessionMessageFetcher(client);

    const result = await fetcher.fetchLastAssistantMessage("ses-1", "/workdir");

    expect(result).toBeDefined();
    expect(result?.info.id).toBe("assistant-2");
    expect(result?.parts).toHaveLength(2);
    expect(client.session.messages).toHaveBeenCalledWith({
      sessionID: "ses-1",
      directory: "/workdir",
      limit: 10,
    });
  });

  it("returns undefined when no assistant messages exist", async () => {
    const messages = [
      {
        info: { id: "user-1", sessionID: "ses-1", role: "user" },
        parts: [{ type: "text", text: "Hello" }],
      },
    ];

    const client = createMockClient(messages);
    const fetcher = createSessionMessageFetcher(client);

    const result = await fetcher.fetchLastAssistantMessage("ses-1", "/workdir");

    expect(result).toBeUndefined();
  });

  it("returns undefined when API returns empty array", async () => {
    const client = createMockClient([]);
    const fetcher = createSessionMessageFetcher(client);

    const result = await fetcher.fetchLastAssistantMessage("ses-1", "/workdir");

    expect(result).toBeUndefined();
  });

  it("returns undefined when API returns error", async () => {
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: undefined,
          error: { message: "not found" },
        }),
      },
    };
    const fetcher = createSessionMessageFetcher(client);

    const result = await fetcher.fetchLastAssistantMessage("ses-1", "/workdir");

    expect(result).toBeUndefined();
  });

  it("returns undefined when API returns undefined data", async () => {
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: undefined,
          error: undefined,
        }),
      },
    };
    const fetcher = createSessionMessageFetcher(client);

    const result = await fetcher.fetchLastAssistantMessage("ses-1", "/workdir");

    expect(result).toBeUndefined();
  });

  it("respects the maxMessagesToScan parameter", async () => {
    const client = createMockClient([]);
    const fetcher = createSessionMessageFetcher(client, 5);

    await fetcher.fetchLastAssistantMessage("ses-1", "/workdir");

    expect(client.session.messages).toHaveBeenCalledWith({
      sessionID: "ses-1",
      directory: "/workdir",
      limit: 5,
    });
  });

  it("scans messages from the end to find last assistant message", async () => {
    const messages = [
      {
        info: { id: "assistant-1", sessionID: "ses-1", role: "assistant" },
        parts: [{ type: "text", text: "Old reply" }],
      },
      {
        info: { id: "user-1", sessionID: "ses-1", role: "user" },
        parts: [{ type: "text", text: "Question" }],
      },
      {
        info: { id: "assistant-2", sessionID: "ses-1", role: "assistant" },
        parts: [{ type: "text", text: "New reply" }],
      },
    ];

    const client = createMockClient(messages);
    const fetcher = createSessionMessageFetcher(client);

    const result = await fetcher.fetchLastAssistantMessage("ses-1", "/workdir");

    expect(result?.info.id).toBe("assistant-2");
    expect(result?.parts[0]?.text).toBe("New reply");
  });
});
