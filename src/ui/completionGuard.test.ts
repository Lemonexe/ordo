import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe("shared task completion guard", () => {
  it("accepts the first toggle immediately and ignores inputs for 400 ms", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const { acceptCompletionToggle } = await import("./completionGuard.ts");

    expect(acceptCompletionToggle()).toBe(true);
    expect(acceptCompletionToggle()).toBe(false);
    now.mockReturnValue(200);
    expect(acceptCompletionToggle()).toBe(false);
    now.mockReturnValue(399);
    expect(acceptCompletionToggle()).toBe(false);
    // Ignored inputs must not extend the original deadline.
    now.mockReturnValue(400);
    expect(acceptCompletionToggle()).toBe(true);
    now.mockReturnValue(799);
    expect(acceptCompletionToggle()).toBe(false);
    now.mockReturnValue(800);
    expect(acceptCompletionToggle()).toBe(true);
  });

  it("shares the window across callers", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const list = await import("./completionGuard.ts");
    const calendar = await import("./completionGuard.ts");
    const keyboard = await import("./completionGuard.ts");

    expect(list.acceptCompletionToggle()).toBe(true);
    now.mockReturnValue(1100);
    expect(calendar.acceptCompletionToggle()).toBe(false);
    expect(keyboard.acceptCompletionToggle()).toBe(false);
    now.mockReturnValue(1400);
    expect(keyboard.acceptCompletionToggle()).toBe(true);
    expect(list.acceptCompletionToggle()).toBe(false);
  });
});
