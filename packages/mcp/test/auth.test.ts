import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ClientContext } from "../src/lib/encryption.js";

let tempDir: string;
let mod: typeof import("../src/lib/auth/index.js");

async function freshModule(): Promise<typeof import("../src/lib/auth/index.js")> {
  vi.resetModules();
  return await import("../src/lib/auth/index.js");
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "context7-auth-prompt-"));
  process.env.CONTEXT7_CONFIG_DIR = tempDir;
  delete process.env.CONTEXT7_DISABLE_AUTH_PROMPT;
  mod = await freshModule();
});

afterEach(() => {
  mod.__test.reset();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.CONTEXT7_CONFIG_DIR;
  delete process.env.CONTEXT7_DISABLE_AUTH_PROMPT;
});

const httpAnon: ClientContext = {
  transport: "http",
  clientIp: "203.0.113.5",
  clientInfo: { ide: "claude-code" },
};
const stdioAnon: ClientContext = { transport: "stdio" };

describe("recordCallAndDecide", () => {
  test("does not prompt before threshold", () => {
    for (let i = 1; i < mod.__test.PROMPT_AFTER_CALLS; i++) {
      expect(mod.recordCallAndDecide(httpAnon).shouldPrompt).toBe(false);
    }
  });

  test("prompts on the threshold call", () => {
    for (let i = 1; i < mod.__test.PROMPT_AFTER_CALLS; i++) mod.recordCallAndDecide(httpAnon);
    expect(mod.recordCallAndDecide(httpAnon).shouldPrompt).toBe(true);
  });

  test("does not prompt for authenticated callers", () => {
    const auth: ClientContext = { ...httpAnon, apiKey: "ctx7sk_real_key" };
    for (let i = 0; i < 100; i++) {
      expect(mod.recordCallAndDecide(auth).shouldPrompt).toBe(false);
    }
  });

  test("respects CONTEXT7_DISABLE_AUTH_PROMPT", async () => {
    process.env.CONTEXT7_DISABLE_AUTH_PROMPT = "1";
    const fresh = await freshModule();
    for (let i = 0; i < 50; i++) {
      expect(fresh.recordCallAndDecide(httpAnon).shouldPrompt).toBe(false);
    }
  });

  test("isolates state per fingerprint in HTTP mode", () => {
    const a: ClientContext = { ...httpAnon, clientIp: "1.1.1.1" };
    const b: ClientContext = { ...httpAnon, clientIp: "2.2.2.2" };
    for (let i = 1; i < mod.__test.PROMPT_AFTER_CALLS; i++) mod.recordCallAndDecide(a);
    expect(mod.recordCallAndDecide(b).shouldPrompt).toBe(false);
    expect(mod.recordCallAndDecide(a).shouldPrompt).toBe(true);
  });

  test("respects opt-out", () => {
    const state = mod.__test.emptyState();
    state.optedOut = true;
    mod.__test.setStdioState(state);
    for (let i = 0; i < 50; i++) {
      expect(mod.recordCallAndDecide(stdioAnon).shouldPrompt).toBe(false);
    }
  });

  test("respects cooldown after a recent prompt", () => {
    const state = mod.__test.emptyState();
    state.lastPromptedAt = Date.now();
    mod.__test.setStdioState(state);
    for (let i = 0; i < mod.__test.PROMPT_AFTER_CALLS + 5; i++) {
      expect(mod.recordCallAndDecide(stdioAnon).shouldPrompt).toBe(false);
    }
  });

  test("re-prompts after cooldown expires", () => {
    const state = mod.__test.emptyState();
    state.lastPromptedAt = Date.now() - mod.__test.PROMPT_COOLDOWN_MS - 1000;
    mod.__test.setStdioState(state);
    for (let i = 1; i < mod.__test.PROMPT_AFTER_CALLS; i++) mod.recordCallAndDecide(stdioAnon);
    expect(mod.recordCallAndDecide(stdioAnon).shouldPrompt).toBe(true);
  });
});

describe("isAuthenticated", () => {
  test("explicit apiKey wins regardless of transport", () => {
    expect(mod.isAuthenticated({ ...httpAnon, apiKey: "k" })).toBe(true);
    expect(mod.isAuthenticated({ ...stdioAnon, apiKey: "k" })).toBe(true);
  });

  test("anonymous HTTP is unauthenticated", () => {
    expect(mod.isAuthenticated(httpAnon)).toBe(false);
  });
});
