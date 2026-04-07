import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";
import {
  SummaryAggregator,
  countDiffChangesFromText,
} from "../../src/summary/aggregator.js";
import type { ProjectInfo } from "../../src/settings/manager.js";

function makeEvent(type: string, properties: Record<string, unknown>): Event {
  return { type, properties } as unknown as Event;
}

describe("SummaryAggregator", () => {
  let aggregator: SummaryAggregator;
  let currentProject: ProjectInfo | undefined;

  beforeEach(() => {
    currentProject = {
      id: "project-1",
      worktree: "/workspace/repo",
      name: "repo",
    };
    aggregator = new SummaryAggregator({
      getCurrentProject: () => currentProject,
      scheduleAsync: (callback) => callback(),
    });
  });

  it("emits typing lifecycle, partials, completion, and token updates for assistant messages", () => {
    const onTypingStart = vi.fn();
    const onTypingStop = vi.fn();
    const onPartial = vi.fn();
    const onComplete = vi.fn();
    const onTokenUpdate = vi.fn();

    aggregator.setOnTypingStart(onTypingStart);
    aggregator.setOnTypingStop(onTypingStop);
    aggregator.setOnPartial(onPartial);
    aggregator.setOnComplete(onComplete);
    aggregator.setOnTokenUpdate(onTokenUpdate);
    aggregator.setSession("session-1");

    aggregator.processEvent(
      makeEvent("message.updated", {
        info: {
          id: "message-1",
          sessionID: "session-1",
          role: "assistant",
          time: { created: Date.now() },
        },
      }),
    );

    aggregator.processEvent(
      makeEvent("message.part.updated", {
        part: {
          id: "part-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "text",
          text: "Hello",
        },
      }),
    );

    aggregator.processEvent(
      makeEvent("message.part.updated", {
        part: {
          id: "part-2",
          sessionID: "session-1",
          messageID: "message-1",
          type: "text",
          text: " world",
        },
      }),
    );

    aggregator.processEvent(
      makeEvent("message.updated", {
        info: {
          id: "message-1",
          sessionID: "session-1",
          role: "assistant",
          tokens: {
            input: 42,
            output: 7,
            reasoning: 0,
            cache: { read: 3, write: 1 },
          },
          time: { created: Date.now(), completed: Date.now() },
        },
      }),
    );

    expect(onTypingStart).toHaveBeenCalledWith("session-1");
    expect(onPartial).toHaveBeenLastCalledWith(
      "session-1",
      "message-1",
      "Hello world",
    );
    expect(onComplete).toHaveBeenCalledWith(
      "session-1",
      "message-1",
      "Hello world",
    );
    expect(onTokenUpdate).toHaveBeenCalledWith({
      sessionId: "session-1",
      messageId: "message-1",
      tokens: {
        input: 42,
        output: 7,
        reasoning: 0,
        cacheRead: 3,
        cacheWrite: 1,
      },
      isCompleted: true,
    });
    expect(onTypingStop).toHaveBeenCalledWith("session-1", "message_completed");
  });

  it("emits session idle callback when the current session settles", () => {
    const onSessionIdle = vi.fn();
    const onTypingStart = vi.fn();
    const onTypingStop = vi.fn();

    aggregator.setOnSessionIdle(onSessionIdle);
    aggregator.setOnTypingStart(onTypingStart);
    aggregator.setOnTypingStop(onTypingStop);
    aggregator.setSession("session-1");

    aggregator.processEvent(
      makeEvent("message.updated", {
        info: {
          id: "message-1",
          sessionID: "session-1",
          role: "assistant",
          time: { created: Date.now() },
        },
      }),
    );
    aggregator.processEvent(
      makeEvent("session.idle", {
        sessionID: "session-1",
      }),
    );

    expect(onTypingStart).toHaveBeenCalledWith("session-1");
    expect(onTypingStop).toHaveBeenCalledWith("session-1", "session_idle");
    expect(onSessionIdle).toHaveBeenCalledWith("session-1");
  });

  it("starts optimistic partial streaming on the second unknown text update", () => {
    const onPartial = vi.fn();
    aggregator.setOnPartial(onPartial);
    aggregator.setSession("session-1");

    aggregator.processEvent(
      makeEvent("message.part.updated", {
        part: {
          id: "part-1",
          sessionID: "session-1",
          messageID: "message-optimistic",
          type: "text",
          text: "H",
        },
      }),
    );
    aggregator.processEvent(
      makeEvent("message.part.updated", {
        part: {
          id: "part-2",
          sessionID: "session-1",
          messageID: "message-optimistic",
          type: "text",
          text: "Hello",
        },
      }),
    );

    expect(onPartial).toHaveBeenCalledTimes(1);
    expect(onPartial).toHaveBeenCalledWith(
      "session-1",
      "message-optimistic",
      "Hello",
    );
  });

  it("streams delta events and ignores unknown delta parts after reasoning begins", () => {
    const onTypingStart = vi.fn();
    const onPartial = vi.fn();
    aggregator.setOnTypingStart(onTypingStart);
    aggregator.setOnPartial(onPartial);
    aggregator.setSession("session-1");

    aggregator.processEvent(
      makeEvent("message.part.delta", {
        part: {
          id: "delta-part-1",
          sessionID: "session-1",
          messageID: "message-delta",
        },
        delta: "Hel",
      }),
    );
    aggregator.processEvent(
      makeEvent("message.part.delta", {
        part: {
          id: "delta-part-1",
          sessionID: "session-1",
          messageID: "message-delta",
        },
        delta: "lo",
      }),
    );
    aggregator.processEvent(
      makeEvent("message.part.updated", {
        part: {
          id: "reasoning-part",
          sessionID: "session-1",
          messageID: "message-reasoning",
          type: "reasoning",
          text: "thinking",
        },
      }),
    );
    aggregator.processEvent(
      makeEvent("message.part.delta", {
        part: {
          id: "unknown-after-reasoning",
          sessionID: "session-1",
          messageID: "message-reasoning",
        },
        delta: "hidden",
      }),
    );

    expect(onTypingStart).toHaveBeenCalledWith("session-1");
    expect(onPartial).toHaveBeenNthCalledWith(
      1,
      "session-1",
      "message-delta",
      "Hel",
    );
    expect(onPartial).toHaveBeenNthCalledWith(
      2,
      "session-1",
      "message-delta",
      "Hello",
    );
    expect(onPartial).toHaveBeenCalledTimes(2);
  });

  it("emits tool events with transport-neutral attachment data only once per completed call", () => {
    const onTool = vi.fn();
    aggregator.setOnTool(onTool);
    aggregator.setSession("session-1");

    aggregator.processEvent(
      makeEvent("message.updated", {
        info: {
          id: "message-tool",
          sessionID: "session-1",
          role: "assistant",
          time: { created: Date.now() },
        },
      }),
    );

    const toolEvent = makeEvent("message.part.updated", {
      part: {
        id: "tool-part",
        sessionID: "session-1",
        messageID: "message-tool",
        type: "tool",
        callID: "call-1",
        tool: "apply_patch",
        state: {
          status: "completed",
          title: "Success. Updated the following files:\nM src/one.ts",
          input: {
            patchText: [
              "--- a/src/one.ts",
              "+++ b/src/one.ts",
              "@@ -1,2 +1,3 @@",
              " old",
              "-before",
              "+after",
              "+extra",
            ].join("\n"),
          },
          metadata: {
            filediff: {
              file: "/workspace/repo/src/one.ts",
              additions: 2,
              deletions: 1,
            },
          },
        },
      },
    });

    aggregator.processEvent(toolEvent);
    aggregator.processEvent(toolEvent);

    expect(onTool).toHaveBeenCalledTimes(1);
    expect(onTool).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        messageId: "message-tool",
        callId: "call-1",
        tool: "apply_patch",
        fileChange: { file: "src/one.ts", additions: 2, deletions: 1 },
        attachment: expect.objectContaining({
          filename: "edit_one.ts.txt",
          displayPath: "src/one.ts",
          operation: "edit",
        }),
      }),
    );
    const attachment = onTool.mock.calls[0][0].attachment as { buffer: Buffer };
    expect(attachment.buffer.toString("utf8")).toContain(
      "Edit File/Path: src/one.ts",
    );
  });

  it("emits question, permission, session diff, retry, compacted, and error callbacks", () => {
    const onQuestion = vi.fn();
    const onPermission = vi.fn();
    const onSessionDiff = vi.fn();
    const onSessionRetry = vi.fn();
    const onSessionCompacted = vi.fn();
    const onSessionError = vi.fn();

    aggregator.setOnQuestion(onQuestion);
    aggregator.setOnPermission(onPermission);
    aggregator.setOnSessionDiff(onSessionDiff);
    aggregator.setOnSessionRetry(onSessionRetry);
    aggregator.setOnSessionCompacted(onSessionCompacted);
    aggregator.setOnSessionError(onSessionError);
    aggregator.setSession("session-1");

    aggregator.processEvent(
      makeEvent("question.asked", {
        id: "question-1",
        sessionID: "session-1",
        questions: [
          {
            question: "Choose one",
            header: "Choice",
            options: [{ label: "Yes", description: "Proceed" }],
            multiple: false,
          },
        ],
      }),
    );
    aggregator.processEvent(
      makeEvent("permission.asked", {
        id: "permission-1",
        sessionID: "session-1",
        permission: "bash",
        patterns: ["npm test"],
        metadata: {},
        always: [],
      }),
    );
    aggregator.processEvent(
      makeEvent("session.diff", {
        sessionID: "session-1",
        diff: [{ file: "src/index.ts", additions: 3, deletions: 1 }],
      }),
    );
    aggregator.processEvent(
      makeEvent("session.status", {
        sessionID: "session-1",
        status: {
          type: "retry",
          attempt: 2,
          message: "retry later",
          next: 1234,
        },
      }),
    );
    aggregator.processEvent(
      makeEvent("session.compacted", { sessionID: "session-1" }),
    );
    aggregator.processEvent(
      makeEvent("session.error", {
        sessionID: "session-1",
        error: { data: { message: "failure" } },
      }),
    );

    expect(onQuestion).toHaveBeenCalledWith({
      sessionId: "session-1",
      requestId: "question-1",
      questions: [
        {
          question: "Choose one",
          header: "Choice",
          options: [{ label: "Yes", description: "Proceed" }],
          multiple: false,
        },
      ],
    });
    expect(onPermission).toHaveBeenCalledWith({
      sessionId: "session-1",
      request: expect.objectContaining({
        id: "permission-1",
        permission: "bash",
      }),
    });
    expect(onSessionDiff).toHaveBeenCalledWith({
      sessionId: "session-1",
      diffs: [{ file: "src/index.ts", additions: 3, deletions: 1 }],
    });
    expect(onSessionRetry).toHaveBeenCalledWith({
      sessionId: "session-1",
      attempt: 2,
      message: "retry later",
      next: 1234,
    });
    expect(onSessionCompacted).toHaveBeenCalledWith(
      "session-1",
      "/workspace/repo",
    );
    expect(onSessionError).toHaveBeenCalledWith("session-1", "failure");
  });

  it("fires question error callback when question tool fails", () => {
    const onQuestionError = vi.fn();
    aggregator.setOnQuestionError(onQuestionError);
    aggregator.setSession("session-1");

    aggregator.processEvent(
      makeEvent("message.part.updated", {
        part: {
          id: "tool-question-error",
          sessionID: "session-1",
          messageID: "message-1",
          type: "tool",
          callID: "call-question",
          tool: "question",
          state: { status: "error", metadata: {} },
        },
      }),
    );

    expect(onQuestionError).toHaveBeenCalledWith("session-1");
  });

  it("ignores unknown or foreign-session payloads without throwing and supports clearing", () => {
    const onCleared = vi.fn();
    const onTool = vi.fn();
    aggregator.setOnCleared(onCleared);
    aggregator.setOnTool(onTool);
    aggregator.setSession("session-1");
    onCleared.mockClear();

    expect(() => {
      aggregator.processEvent(makeEvent("unknown.event", { anything: true }));
      aggregator.processEvent(
        makeEvent("message.part.updated", {
          part: {
            id: "foreign-tool",
            sessionID: "session-2",
            messageID: "message-2",
            type: "tool",
            callID: "call-foreign",
            tool: "write",
            state: {
              status: "completed",
              input: { filePath: "src/foreign.ts", content: "test" },
              metadata: {},
            },
          },
        }),
      );
    }).not.toThrow();

    expect(onTool).not.toHaveBeenCalled();
    aggregator.clear();
    expect(onCleared).toHaveBeenCalledTimes(1);
  });

  it("counts additions and deletions from diff text deterministically", () => {
    expect(
      countDiffChangesFromText(
        [
          "--- a/src/file.ts",
          "+++ b/src/file.ts",
          "@@ -1,2 +1,3 @@",
          " unchanged",
          "-old",
          "+new",
          "+extra",
        ].join("\n"),
      ),
    ).toEqual({ additions: 2, deletions: 1 });
  });
});
