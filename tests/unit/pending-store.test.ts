import { beforeEach, describe, expect, it } from "vitest";
import { PendingInteractionStore } from "../../src/pending/store.js";

describe("PendingInteractionStore", () => {
  let store: PendingInteractionStore;

  beforeEach(() => {
    store = new PendingInteractionStore();
  });

  it("adds and retrieves a pending request by requestId", () => {
    const entry = store.add(
      "req-1",
      "sess-1",
      "/workspace",
      "chat-1",
      "question",
    );

    expect(entry).toEqual({
      requestId: "req-1",
      sessionId: "sess-1",
      directory: "/workspace",
      chatId: "chat-1",
      type: "question",
      cardMessageId: null,
      createdAt: expect.any(Number),
    });
    expect(store.get("req-1")).toBe(entry);
    expect(store.size()).toBe(1);
  });

  it("returns existing entry when adding duplicate requestId", () => {
    const first = store.add(
      "req-1",
      "sess-1",
      "/workspace",
      "chat-1",
      "question",
    );
    const second = store.add(
      "req-1",
      "sess-2",
      "/other",
      "chat-2",
      "permission",
    );

    expect(second).toBe(first);
    expect(store.size()).toBe(1);
    expect(store.get("req-1")?.sessionId).toBe("sess-1");
  });

  it("sets and retrieves card message ID", () => {
    store.add("req-1", "sess-1", "/workspace", "chat-1", "question");

    expect(store.setCardMessageId("req-1", "msg-card-1")).toBe(true);
    expect(store.get("req-1")?.cardMessageId).toBe("msg-card-1");
  });

  it("returns false when setting card message ID for unknown request", () => {
    expect(store.setCardMessageId("nonexistent", "msg-1")).toBe(false);
  });

  it("retrieves pending requests by session ID", () => {
    store.add("req-1", "sess-1", "/workspace", "chat-1", "question");
    store.add("req-2", "sess-1", "/workspace", "chat-1", "permission");
    store.add("req-3", "sess-2", "/workspace", "chat-2", "question");

    const sess1Requests = store.getBySessionId("sess-1");
    expect(sess1Requests).toHaveLength(2);
    expect(sess1Requests.map((r) => r.requestId).sort()).toEqual([
      "req-1",
      "req-2",
    ]);
  });

  it("retrieves pending request by card message ID", () => {
    store.add("req-1", "sess-1", "/workspace", "chat-1", "question");
    store.setCardMessageId("req-1", "msg-card-1");

    expect(store.getByCardMessageId("msg-card-1")?.requestId).toBe("req-1");
    expect(store.getByCardMessageId("nonexistent")).toBeUndefined();
  });

  it("removes a pending request by requestId", () => {
    store.add("req-1", "sess-1", "/workspace", "chat-1", "question");

    expect(store.remove("req-1")).toBe(true);
    expect(store.get("req-1")).toBeUndefined();
    expect(store.size()).toBe(0);
    expect(store.remove("req-1")).toBe(false);
  });

  it("removes all pending requests for a session", () => {
    store.add("req-1", "sess-1", "/workspace", "chat-1", "question");
    store.add("req-2", "sess-1", "/workspace", "chat-1", "permission");
    store.add("req-3", "sess-2", "/workspace", "chat-2", "question");

    expect(store.removeBySessionId("sess-1")).toBe(2);
    expect(store.size()).toBe(1);
    expect(store.has("req-3")).toBe(true);
    expect(store.removeBySessionId("sess-1")).toBe(0);
  });

  it("reports correct has/size/getAll state", () => {
    expect(store.has("req-1")).toBe(false);
    expect(store.size()).toBe(0);
    expect(store.getAll()).toEqual([]);

    store.add("req-1", "sess-1", "/workspace", "chat-1", "question");
    store.add("req-2", "sess-1", "/workspace", "chat-1", "permission");

    expect(store.has("req-1")).toBe(true);
    expect(store.size()).toBe(2);
    expect(store.getAll()).toHaveLength(2);
  });

  it("clears all entries", () => {
    store.add("req-1", "sess-1", "/workspace", "chat-1", "question");
    store.add("req-2", "sess-2", "/workspace", "chat-2", "permission");

    store.clear();
    expect(store.size()).toBe(0);
    expect(store.getAll()).toEqual([]);
  });
});
