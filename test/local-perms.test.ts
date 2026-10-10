// Local files stay private: downloads, ~/.kiwi, hook uninstall, and writePrivate.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveImages } from "../src/attach.ts";
import { home, writeCursor, writePrivate } from "../src/config.ts";
import { installHooks, uninstallHooks } from "../src/hooks.ts";
import type { ImageAttachment } from "../src/protocol.ts";

const prev = { KIWI_HOME: process.env.KIWI_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
const trash: string[] = [];

afterEach(() => {
  if (prev.KIWI_HOME === undefined) delete process.env.KIWI_HOME;
  else process.env.KIWI_HOME = prev.KIWI_HOME;
  if (prev.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prev.CLAUDE_CONFIG_DIR;
  for (const p of trash.splice(0)) rmSync(p, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trash.push(dir);
  return dir;
}

const png = (name: string): ImageAttachment => ({ name, mime: "image/png", data: Buffer.from("png").toString("base64") });
const mode = (p: string) => statSync(p).mode & 0o777;

test("saveImages writes 0600 files, and 0700 directories only under downloads", () => {
  const dir = scratch("kiwi-dl-");
  chmodSync(dir, 0o755);
  process.env.KIWI_HOME = dir;
  home();
  const room = join(dir, "downloads", "room");
  mkdirSync(room, { recursive: true });
  chmodSync(join(dir, "downloads"), 0o755);
  chmodSync(room, 0o755);
  const saved = saveImages(4, [png("shot.png")], room)[0];
  if (!saved) throw new Error("no saved image");
  expect(mode(saved)).toBe(0o600);
  expect(mode(room)).toBe(0o700);
  expect(mode(join(dir, "downloads"))).toBe(0o700);

  const user = scratch("kiwi-user-");
  chmodSync(user, 0o755);
  const elsewhere = saveImages(5, [png("other.png")], user)[0];
  if (!elsewhere) throw new Error("no saved image");
  expect(mode(elsewhere)).toBe(0o600);
  expect(mode(user)).toBe(0o755);
});

test("home() locks an existing tree once and does not follow symlinks or touch bin", () => {
  const dir = scratch("kiwi-home-");
  chmodSync(dir, 0o755);
  const room = join(dir, "downloads", "room");
  mkdirSync(room, { recursive: true });
  chmodSync(join(dir, "downloads"), 0o755);
  chmodSync(room, 0o755);
  const img = join(room, "pic");
  writeFileSync(img, "png", { mode: 0o644 });
  mkdirSync(join(dir, "bin"));
  chmodSync(join(dir, "bin"), 0o755);
  writeFileSync(join(dir, "bin", "kiwi"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(dir, "identities"));
  chmodSync(join(dir, "identities"), 0o755);

  const outside = scratch("kiwi-outside-");
  chmodSync(outside, 0o755);
  const secret = join(outside, "secret");
  writeFileSync(secret, "x", { mode: 0o644 });
  symlinkSync(outside, join(dir, "linked"));
  symlinkSync(secret, join(room, "link"));

  process.env.KIWI_HOME = dir;
  expect(home()).toBe(dir);
  expect(mode(dir)).toBe(0o700);
  expect(mode(join(dir, "downloads"))).toBe(0o700);
  expect(mode(room)).toBe(0o700);
  expect(mode(img)).toBe(0o600);
  expect(mode(join(dir, "identities"))).toBe(0o700);
  expect(mode(join(dir, "bin"))).toBe(0o755);
  expect(mode(join(dir, "bin", "kiwi"))).toBe(0o755);
  expect(mode(outside)).toBe(0o755);
  expect(mode(secret)).toBe(0o644);
  expect(lstatSync(join(dir, "linked")).isSymbolicLink()).toBe(true);

  chmodSync(dir, 0o755);
  expect(home()).toBe(dir);
  expect(mode(dir)).toBe(0o755);
});

test("names '.' and '..' stay inside the cursors directory", () => {
  const dir = scratch("kiwi-safe-");
  process.env.KIWI_HOME = dir;
  writeCursor("..", "agent", 3);
  writeCursor("ch", "..", 4);
  writeCursor("ch", ".", 5);
  expect(readFileSync(join(dir, "cursors", "~2e~~2e~", "agent"), "utf8").trim()).toBe("3");
  const nested = join(dir, "cursors", "ch");
  expect(new Set(readdirSync(nested))).toEqual(new Set(["~2e~~2e~", "~2e~"]));
  expect(mode(join(nested, "~2e~"))).toBe(0o600);
});

test("writePrivate does not follow a planted temp symlink", () => {
  const dir = scratch("kiwi-wx-");
  const dest = join(dir, "config.json");
  const victim = join(dir, "victim");
  writeFileSync(victim, "keep");
  symlinkSync(victim, `${dest}.${process.pid}.tmp`);
  writePrivate(dest, "new\n");
  expect(readFileSync(victim, "utf8")).toBe("keep");
  expect(readFileSync(dest, "utf8")).toBe("new\n");
  expect(mode(dest)).toBe(0o600);
  expect(lstatSync(`${dest}.${process.pid}.tmp`).isSymbolicLink()).toBe(true);
});

test("hook install removes only kiwi's own commands", () => {
  const dir = scratch("kiwi-hooks-");
  process.env.CLAUDE_CONFIG_DIR = dir;
  const settings = join(dir, "settings.json");
  writeFileSync(
    settings,
    JSON.stringify({
      keep: true,
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "echo user note # kiwi" },
              { type: "command", command: "'/old/bin/kiwi' hook stop # kiwi" },
              { type: "command", command: "'/old/bin/kiwi' hook stop # channel-one" },
            ],
          },
        ],
      },
    }),
  );
  installHooks();
  const installed = JSON.parse(readFileSync(settings, "utf8")) as {
    keep: boolean;
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
  const stop = (installed.hooks.Stop ?? []).flatMap((e) => e.hooks.map((h) => h.command));
  expect(installed.keep).toBe(true);
  expect(stop).toContain("echo user note # kiwi");
  expect(stop.some((c) => c.includes("/old/bin/kiwi"))).toBe(false);
  expect(stop.some((c) => c.endsWith(" hook stop # kiwi"))).toBe(true);
  uninstallHooks();
  const gone = JSON.parse(readFileSync(settings, "utf8")) as { hooks?: { Stop?: { hooks: { command: string }[] }[] } };
  const left = (gone.hooks?.Stop ?? []).flatMap((e) => e.hooks.map((h) => h.command));
  expect(left).toEqual(["echo user note # kiwi"]);
});

test("installers document the checksum and create a private home", () => {
  const root = join(import.meta.dir, "../web/public");
  const sh = readFileSync(join(root, "install.sh"), "utf8");
  expect(readFileSync(join(root, "install"), "utf8")).toBe(sh);
  expect(sh).toContain('mkdir -m 700 "$HOME/.kiwi"');
  expect(sh).toContain('chmod 700 "$HOME/.kiwi"');
  expect(sh).toContain("this script does not run it");
  const ps1 = readFileSync(join(root, "install.ps1"), "utf8");
  expect(ps1).toContain("/inheritance:r");
  expect(ps1).toContain("this script does not run it");
});
