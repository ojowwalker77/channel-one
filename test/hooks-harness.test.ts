// Per-harness hook files: write, idempotent re-install, uninstall leaves the user's own entries.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, updateConfig } from "../src/config.ts";
import { cursorStopFollowup, extraInstalled, installDetected, installExtra, installHooks, stopStyle, uninstallExtra } from "../src/hooks.ts";

const made: string[] = [];
const prev = new Map<string, string | undefined>();

function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

function setEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!prev.has(k)) prev.set(k, process.env[k]);
    process.env[k] = v;
  }
}

afterEach(() => {
  for (const [k, v] of prev) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  prev.clear();
  for (const d of made) rmSync(d, { recursive: true, force: true });
  made.length = 0;
});

function read(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("codex, gemini, cursor, and grok install, re-install once, and uninstall keeps user entries", () => {
  const claude = scratch("hk-claude-");
  const codex = scratch("hk-codex-");
  const gemini = scratch("hk-gemini-");
  const cursor = scratch("hk-cursor-");
  const grok = scratch("hk-grok-");
  const home = scratch("hk-home-");
  setEnv({
    KIWI_HOME: home,
    CLAUDE_CONFIG_DIR: claude,
    KIWI_CODEX_DIR: codex,
    KIWI_GEMINI_DIR: gemini,
    KIWI_CURSOR_DIR: cursor,
    KIWI_GROK_DIR: grok,
  });

  writeFileSync(
    join(codex, "hooks.json"),
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo mine # kiwi" }, { type: "command", command: "'/old/kiwi' hook stop # channel-one" }] }],
      },
    }),
  );
  writeFileSync(
    join(gemini, "settings.json"),
    JSON.stringify({ theme: "dark", hooks: { BeforeAgent: [{ matcher: "startup", hooks: [{ type: "command", command: "echo gemini-user" }] }] } }),
  );
  writeFileSync(
    join(cursor, "hooks.json"),
    JSON.stringify({ version: 1, hooks: { stop: [{ command: "echo cursor-user # kiwi" }], preToolUse: [{ command: "echo tool" }] } }),
  );
  mkdirSync(join(grok, "hooks"), { recursive: true });
  writeFileSync(
    join(grok, "hooks", "kiwi.json"),
    JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "echo grok-user" }] }] } }),
  );

  installHooks();
  installExtra("codex");
  installExtra("gemini");
  installExtra("cursor");
  installExtra("grok");
  installExtra("codex");
  installExtra("gemini");
  installExtra("cursor");
  installExtra("grok");

  const codexStop = read(join(codex, "hooks.json")).hooks.Stop.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
  expect(codexStop).toContain("echo mine # kiwi");
  expect(codexStop).toContain("'/old/kiwi' hook stop # channel-one");
  expect(codexStop.filter((c: string) => c.endsWith(" hook stop # kiwi"))).toHaveLength(1);
  expect(read(join(codex, "hooks.json")).hooks.UserPromptSubmit).toBeDefined();
  expect(read(join(codex, "hooks.json")).hooks.SessionStart).toBeDefined();

  const gem = read(join(gemini, "settings.json"));
  expect(gem.theme).toBe("dark");
  const before = gem.hooks.BeforeAgent.flatMap((e: { hooks: { command: string; timeout?: number }[] }) => e.hooks);
  expect(before.map((h: { command: string }) => h.command)).toContain("echo gemini-user");
  expect(before.filter((h: { command: string }) => h.command.endsWith(" hook prompt # kiwi"))).toHaveLength(1);
  expect(before.find((h: { command: string }) => h.command.endsWith(" hook prompt # kiwi")).timeout).toBe(20_000);
  expect(gem.hooks.AfterAgent[0].matcher).toBe("*");
  expect(gem.hooks.AfterAgent[0].hooks[0].timeout).toBe(30_000);
  expect(gem.hooks.UserPromptSubmit).toBeUndefined();

  const cur = read(join(cursor, "hooks.json"));
  expect(cur.version).toBe(1);
  const curStop = cur.hooks.stop.map((h: { command: string; loop_limit?: number }) => h);
  expect(curStop.map((h: { command: string }) => h.command)).toContain("echo cursor-user # kiwi");
  expect(curStop.filter((h: { command: string }) => h.command.endsWith(" hook stop # kiwi"))).toHaveLength(1);
  expect(curStop.find((h: { command: string }) => h.command.endsWith(" hook stop # kiwi")).loop_limit).toBe(5);
  expect(cur.hooks.preToolUse).toEqual([{ command: "echo tool" }]);
  expect(cur.hooks.sessionStart.some((h: { command: string }) => h.command.endsWith(" hook session-start # kiwi"))).toBe(true);

  const claudeStop = read(join(claude, "settings.json")).hooks.Stop.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
  const grokStop = read(join(grok, "hooks", "kiwi.json")).hooks.Stop.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
  const ours = (list: string[]) => list.find((c) => c.endsWith(" hook stop # kiwi"));
  expect(ours(grokStop)).toBe(ours(claudeStop));
  expect(read(join(grok, "hooks", "kiwi.json")).hooks.PostToolUse[0].hooks[0].command).toBe("echo grok-user");
  expect(read(join(grok, "hooks", "kiwi.json")).hooks.UserPromptSubmit).toBeUndefined();
  expect(read(join(grok, "hooks", "kiwi.json")).hooks.SessionStart).toBeUndefined();

  uninstallExtra("codex");
  uninstallExtra("gemini");
  uninstallExtra("cursor");
  uninstallExtra("grok");

  const codexLeft = read(join(codex, "hooks.json")).hooks.Stop.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
  expect(codexLeft).toEqual(["echo mine # kiwi", "'/old/kiwi' hook stop # channel-one"]);
  const gemLeft = read(join(gemini, "settings.json"));
  expect(gemLeft.theme).toBe("dark");
  expect(gemLeft.hooks.BeforeAgent.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command))).toEqual(["echo gemini-user"]);
  expect(gemLeft.hooks.AfterAgent).toBeUndefined();
  const curLeft = read(join(cursor, "hooks.json"));
  expect(curLeft.version).toBe(1);
  expect(curLeft.hooks.stop).toEqual([{ command: "echo cursor-user # kiwi" }]);
  expect(curLeft.hooks.preToolUse).toEqual([{ command: "echo tool" }]);
  expect(curLeft.hooks.sessionStart).toBeUndefined();
  expect(read(join(grok, "hooks", "kiwi.json")).hooks.PostToolUse[0].hooks[0].command).toBe("echo grok-user");
  expect(read(join(grok, "hooks", "kiwi.json")).hooks.Stop).toBeUndefined();
  expect(extraInstalled("codex")).toBe(false);
  expect(extraInstalled("grok")).toBe(false);
});

test("a harness opted out stays out of install, and a named install turns it back on", () => {
  const home = scratch("hk-opt-home-");
  const claude = scratch("hk-opt-claude-");
  const codex = scratch("hk-opt-codex-");
  const absent = join(scratch("hk-opt-absent-"), "missing");
  setEnv({
    KIWI_HOME: home,
    CLAUDE_CONFIG_DIR: claude,
    KIWI_CODEX_DIR: codex,
    KIWI_GEMINI_DIR: absent,
    KIWI_CURSOR_DIR: absent,
    KIWI_GROK_DIR: absent,
  });
  updateConfig((c) => {
    c.harnessHooks = { codex: "off" };
  });
  const paths = installDetected();
  expect(paths).toEqual([join(claude, "settings.json")]);
  expect(existsSync(join(codex, "hooks.json"))).toBe(false);

  installExtra("codex");
  expect(extraInstalled("codex")).toBe(true);
  updateConfig((c) => {
    c.harnessHooks = { ...loadConfig().harnessHooks, codex: "on" };
  });
  installDetected();
  const stop = read(join(codex, "hooks.json")).hooks.Stop.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
  expect(stop.filter((c: string) => c.endsWith(" hook stop # kiwi"))).toHaveLength(1);
});

test("stop style keeps Grok on the Claude block path and Cursor on followup", () => {
  expect(stopStyle({})).toBe("block");
  expect(stopStyle({ hook_event_name: "Stop" })).toBe("block");
  expect(stopStyle({ hook_event_name: "Stop", status: "completed", loop_count: 0 })).toBe("block");
  expect(stopStyle({ hook_event_name: "AfterAgent" })).toBe("gemini");
  expect(stopStyle({ status: "completed", loop_count: 0 })).toBe("cursor");
  expect(stopStyle({ status: "aborted" })).toBe("cursor");

  const mc = "kiwi -c proj --as mac";
  const unread = cursorStopFollowup(mc, true, true, 0);
  const again = cursorStopFollowup(mc, true, false, 4);
  expect(again).toBe(unread);
  expect(unread).toBe(`Unread Kiwi messages. Run \`${mc} read\`, answer with \`${mc} reply N "…"\`, then continue.`);
  expect(unread!.length).toBeLessThan(180);
  expect(unread).not.toContain("\n");
  expect(cursorStopFollowup(mc, false, true, 0)).toBeNull();
  expect(cursorStopFollowup(mc, false, false, 0)).toContain("Monitor");
  expect(cursorStopFollowup(mc, false, false, 1)).toBeNull();
});
