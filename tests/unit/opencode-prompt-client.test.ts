import { describe, expect, it, vi } from "vitest";
import { createOpenCodePromptClient } from "../../src/opencode/prompt-client.js";
import type { Logger } from "../../src/utils/logger.js";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("createOpenCodePromptClient", () => {
  it("dispatches file parts via session.prompt", async () => {
    const prompt = vi
      .fn()
      .mockResolvedValue({ data: undefined, error: undefined });
    const openCodeClient = {
      session: { prompt },
    };
    const logger = createMockLogger();
    const client = createOpenCodePromptClient(openCodeClient, logger);

    await client.promptAsync({
      sessionID: "session-1",
      directory: "/workspace/project",
      parts: [
        { type: "text", text: "Please inspect this image" },
        {
          type: "file",
          mime: "image/jpeg",
          filename: "image.jpg",
          url: "data:image/jpeg;base64,/9j/4AAQ",
        },
      ],
    });

    expect(prompt).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "/workspace/project",
      model: undefined,
      agent: undefined,
      variant: undefined,
      parts: [
        { type: "text", text: "Please inspect this image" },
        {
          type: "file",
          mime: "image/jpeg",
          filename: "image.jpg",
          url: "data:image/jpeg;base64,/9j/4AAQ",
        },
      ],
    });
  });

  it("throws when session.prompt returns an API error", async () => {
    const apiError = new Error(
      "media type: application/octet-stream functionality not supported",
    );
    const prompt = vi
      .fn()
      .mockResolvedValue({ data: undefined, error: apiError });
    const openCodeClient = {
      session: { prompt },
    };
    const client = createOpenCodePromptClient(
      openCodeClient,
      createMockLogger(),
    );

    await expect(
      client.promptAsync({
        sessionID: "session-1",
        directory: "/workspace/project",
        parts: [
          {
            type: "file",
            mime: "image/jpeg",
            filename: "image.jpg",
            url: "data:image/jpeg;base64,/9j/4AAQ",
          },
        ],
      }),
    ).rejects.toThrow(
      "media type: application/octet-stream functionality not supported",
    );
  });
});
