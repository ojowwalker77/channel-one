// Per-harness hook files: write, idempotent re-install, uninstall leaves the user's own entries.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, updateConfig } from "../src/config.ts";
import { autoInstallExtraHooks, autoInstallHooks, cursorStopFollowup, extraInstalled, installDetected, installExtra, installHooks, stopStyle, uninstallDetected, uninstallExtra } from "../src/hooks.ts";

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

function hideEnv(keys: string[]): void {
  for (const k of keys) {
    if (!prev.has(k)) prev.set(k, process.env[k]);
    delete process.env[k];
  }
}

const SESSION_ENVS = ["CODEX_THREAD_ID", "GEMINI_CLI", "CURSOR_AGENT", "GROK_SESSION_ID", "GROK_AGENT", "KIWI_NO_HOOKS", "CLAUDECODE"];

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

function realHomeStamp(): string {
  const root = homedir();
  const paths = [
    join(root, ".grok"),
    join(root, ".grok", "hooks"),
    join(root, ".grok", "hooks", "kiwi.json"),
    join(root, ".codex"),
    join(root, ".codex", "hooks.json"),
    join(root, ".cursor"),
    join(root, ".cursor", "hooks.json"),
    join(root, ".gemini"),
    join(root, ".gemini", "settings.json"),
    join(root, ".claude"),
    join(root, ".claude", "settings.json"),
  ];
  return paths
    .map((p) => {
      try {
        const s = statSync(p);
        return `${p} ${s.mtimeMs} ${s.size} ${s.mode}`;
      } catch (e) {
        if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return `${p} absent`;
        throw e;
      }
    })
    .join("\n");
}

test("a harness session during tests does not touch the real home", () => {
  const root = homedir();
  for (const key of ["KIWI_CODEX_DIR", "KIWI_GEMINI_DIR", "KIWI_CURSOR_DIR", "KIWI_GROK_DIR", "CLAUDE_CONFIG_DIR"]) {
    const dir = process.env[key];
    expect(dir, key).toBeTruthy();
    expect(dir!.startsWith(`${root}/`), key).toBe(false);
  }
  expect(process.env.CLAUDECODE).toBeUndefined();
  expect(process.env.CODEX_THREAD_ID).toBeUndefined();
  expect(process.env.GEMINI_CLI).toBeUndefined();
  expect(process.env.CURSOR_AGENT).toBeUndefined();
  expect(process.env.GROK_SESSION_ID).toBeUndefined();

  const before = realHomeStamp();
  setEnv({
    KIWI_HOME: scratch("hk-preload-home-"),
    CLAUDECODE: "1",
    CODEX_THREAD_ID: "thr_test",
    GEMINI_CLI: "1",
    CURSOR_AGENT: "1",
    GROK_SESSION_ID: "sess_test",
  });
  expect(autoInstallHooks()).toContain(process.env.CLAUDE_CONFIG_DIR!);
  const extras = autoInstallExtraHooks();
  expect(extras).toContain("Codex hooks");
  expect(extras).toContain("Gemini hooks");
  expect(extras).toContain("Cursor hooks");
  expect(extras).toContain("Grok hooks");
  expect(existsSync(join(process.env.KIWI_GROK_DIR!, "hooks", "kiwi.json"))).toBe(true);
  installDetected();
  uninstallDetected();
  expect(realHomeStamp()).toBe(before);
});

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

function harnessHomes(): { home: string; codex: string; gemini: string; cursor: string; grok: string } {
  const home = scratch("hk-auto-home-");
  const codex = scratch("hk-auto-codex-");
  const gemini = scratch("hk-auto-gemini-");
  const cursor = scratch("hk-auto-cursor-");
  const grok = scratch("hk-auto-grok-");
  setEnv({
    KIWI_HOME: home,
    CLAUDE_CONFIG_DIR: scratch("hk-auto-claude-"),
    KIWI_CODEX_DIR: codex,
    KIWI_GEMINI_DIR: gemini,
    KIWI_CURSOR_DIR: cursor,
    KIWI_GROK_DIR: grok,
  });
  hideEnv(SESSION_ENVS);
  return { home, codex, gemini, cursor, grok };
}

test("joining from inside a harness installs that harness only", () => {
  const dirs = harnessHomes();
  const cases = [
    ["codex", "CODEX_THREAD_ID", "thr_1", join(dirs.codex, "hooks.json"), "Codex"],
    ["gemini", "GEMINI_CLI", "1", join(dirs.gemini, "settings.json"), "Gemini"],
    ["cursor", "CURSOR_AGENT", "1", join(dirs.cursor, "hooks.json"), "Cursor"],
    ["grok", "GROK_SESSION_ID", "sess-1", join(dirs.grok, "hooks", "kiwi.json"), "Grok"],
  ] as const;
  for (const [name, env, value, path, label] of cases) {
    hideEnv(SESSION_ENVS);
    setEnv({ [env]: value });
    const wrote = autoInstallExtraHooks();
    expect(wrote).toContain(`${label} hooks (${path})`);
    expect(autoInstallExtraHooks()).toBeNull();
    expect(extraInstalled(name)).toBe(true);
  }
  expect(existsSync(join(dirs.codex, "hooks.json"))).toBe(true);
  expect(existsSync(join(dirs.gemini, "settings.json"))).toBe(true);
  expect(existsSync(join(dirs.cursor, "hooks.json"))).toBe(true);
  expect(existsSync(join(dirs.grok, "hooks", "kiwi.json"))).toBe(true);
  const grokStop = read(join(dirs.grok, "hooks", "kiwi.json")).hooks.Stop.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
  expect(grokStop.filter((c: string) => c.endsWith(" hook stop # kiwi"))).toHaveLength(1);
  expect(read(join(dirs.grok, "hooks", "kiwi.json")).hooks.UserPromptSubmit).toBeUndefined();
});

test("join skips a harness that is off, opted out by KIWI_NO_HOOKS, or not the current session", () => {
  const dirs = harnessHomes();
  updateConfig((c) => {
    c.harnessHooks = { codex: "off" };
  });
  setEnv({ CODEX_THREAD_ID: "thr_1" });
  expect(autoInstallExtraHooks()).toBeNull();
  expect(existsSync(join(dirs.codex, "hooks.json"))).toBe(false);
  expect(loadConfig().harnessHooks?.codex).toBe("off");

  updateConfig((c) => {
    c.harnessHooks = {};
  });
  setEnv({ KIWI_NO_HOOKS: "1", GEMINI_CLI: "1" });
  expect(autoInstallExtraHooks()).toBeNull();
  expect(existsSync(join(dirs.gemini, "settings.json"))).toBe(false);

  hideEnv(SESSION_ENVS);
  setEnv({ GROK_AGENT: "1", CURSOR_AGENT: "" });
  expect(autoInstallExtraHooks()).toBeNull();
  expect(existsSync(join(dirs.cursor, "hooks.json"))).toBe(false);
  expect(existsSync(join(dirs.grok, "hooks", "kiwi.json"))).toBe(false);
  expect(autoInstallHooks()).toBeNull();
});

test("a corrupt harness file does not fail join", () => {
  const dirs = harnessHomes();
  writeFileSync(join(dirs.codex, "hooks.json"), "{");
  setEnv({ CODEX_THREAD_ID: "thr_1", GEMINI_CLI: "1" });
  expect(autoInstallExtraHooks()).toContain("Gemini hooks");
  expect(existsSync(join(dirs.gemini, "settings.json"))).toBe(true);
  expect(readFileSync(join(dirs.codex, "hooks.json"), "utf8")).toBe("{");
});
