import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InteractionManager,
  normalizeCommand,
} from "../../src/interaction/manager.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("InteractionManager", () => {
  it("normalizes commands and deduplicates allowed commands on start", () => {
    const manager = new InteractionManager();
    const state = manager.start({
      kind: "custom",
      expectedInput: "text",
      allowedCommands: ["help", "/HELP", "/status@OpenCodeBot", "   "],
    });

    expect(normalizeCommand("/Status@OpenCodeBot")).toBe("/status");
    expect(state.allowedCommands).toEqual(["/help", "/status"]);

    state.allowedCommands.push("/mutated");
    expect(manager.get()?.allowedCommands).toEqual(["/help", "/status"]);
  });

  it("blocks unexpected inputs and allows explicitly allowed commands", () => {
    const manager = new InteractionManager();
    manager.start({
      kind: "custom",
      expectedInput: "text",
      allowedCommands: ["/abort"],
    });

    expect(manager.resolveGuardDecision({ callbackData: "clicked" })).toMatchObject({
      allow: false,
      reason: "expected_text",
    });
    expect(manager.resolveGuardDecision({ text: "/abort" })).toMatchObject({
      allow: true,
      inputType: "command",
      command: "/abort",
    });
    expect(manager.resolveGuardDecision({ text: "/other" })).toMatchObject({
      allow: false,
      reason: "command_not_allowed",
    });
  });

  it("clears expired interactions during guard resolution", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));

    const manager = new InteractionManager();
    manager.start({
      kind: "custom",
      expectedInput: "text",
      expiresInMs: 1000,
    });

    vi.setSystemTime(new Date("2025-01-01T00:00:02.000Z"));

    const decision = manager.resolveGuardDecision({ text: "answer" });

    expect(decision).toMatchObject({ allow: false, reason: "expired" });
    expect(manager.get()).toBeNull();
  });

  it("allows busy-safe commands and question responses while busy", () => {
    const manager = new InteractionManager();
    manager.start({
      kind: "question",
      expectedInput: "text",
    });
    manager.startBusy({ reason: "active prompt" });

    expect(manager.resolveGuardDecision({ text: "/abort" })).toMatchObject({
      allow: true,
      busy: true,
      inputType: "command",
    });
    expect(manager.resolveGuardDecision({ text: "typed answer" })).toMatchObject({
      allow: true,
      busy: true,
      inputType: "text",
    });
    expect(manager.resolveGuardDecision({ callbackData: "clicked" })).toMatchObject({
      allow: false,
      busy: true,
      reason: "expected_text",
    });
  });
});
