// Adversarial escape tests for kiwi sh (T46).
// Contract from Claude-2 (#56) and Coordinator (#55):
//   runSh(files, script, opts?) -> { stdout, stderr, exitCode }  // never throws
//   channelFiles(views) -> absolute virtual paths
//   channelView(session) -> ChannelView
// Fail closed: nonzero exit, and the leaked content is in neither stdout nor stderr.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/agent.ts";
import { Channel } from "../src/client.ts";
import { loadConfig, updateConfig, writeCursor } from "../src/config.ts";
import { generateIdentity, sign, verify, type Identity } from "../src/identity.ts";
import type { Event, Kind, Message } from "../src/protocol.ts";
import { startRelay } from "../src/relay/bun.ts";
import { channelFiles, channelView, runSh, type ChannelView } from "../src/sh.ts";
import { fold, type Roster } from "../src/state.ts";

setDefaultTimeout(25_000);

const HOST_HOME = process.env.HOME ?? "";
const CANARY_ENV = "KIWI_ESCAPE_CANARY";
const CANARY_VAL = `CANARY_${crypto.randomUUID()}`;
const FORGED = "FORGED_CANARY_do_not_mount";
const CACHE_SENTINEL = "CACHE_SENTINEL_do_not_mount";
const CURSOR_SENTINEL = "CURSOR_SENTINEL_do_not_mount";
const OTHER_CHANNEL = "BETA_ONLY_SECRET_do_not_mount";

const hostPasswdLine = readFileSync("/etc/passwd", "utf8")
  .split("\n")
  .find((line) => line.startsWith("root:")) ?? "root:";

function leaked(out: { stdout: string; stderr: string }, ...needles: string[]): string | undefined {
  const blob = `${out.stdout}\n${out.stderr}`;
  return needles.find((n) => n && blob.includes(n));
}

/** An escape attempt must fail, and must not echo host or canary material. */
async function closed(script: string, files: Record<string, string> = {}, cwd = "/channel"): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const out = await runSh(files, script, { cwd });
  expect([script, out.exitCode]).not.toEqual([script, 0]);
  const hit = leaked(out, CANARY_VAL, HOST_HOME, hostPasswdLine);
  expect([script, hit ?? ""]).toEqual([script, ""]);
  return out;
}

describe("runSh fail closed", () => {
  const files = { "/channel/facts/ip": "10.0.0.4\n" };

  beforeAll(() => {
    process.env[CANARY_ENV] = CANARY_VAL;
  });
  afterAll(() => {
    delete process.env[CANARY_ENV];
  });

  test("network commands are absent", async () => {
    for (const script of ["curl https://example.com", "wget https://example.com", "fetch https://example.com"]) {
      const out = await closed(script, files);
      expect(out.stdout).not.toMatch(/example\.com|<!DOCTYPE|<html/i);
    }
  });

  test("host files, traversal, symlinks and ~/.kiwi stay outside the sandbox", async () => {
    await closed("cat /etc/passwd", files);
    await closed("cat /channel/../../etc/passwd", files);
    await closed("cat ../../etc/passwd", files);
    const link = await closed("ln -s /etc/passwd /channel/link; cat /channel/link", files);
    expect(link.stdout).not.toContain("root:");
    await closed('cat "$HOME/.kiwi/config.json"', files);
    await closed("cat ~/.kiwi/config.json", files);
    await closed("ls ~/.kiwi", files);
  });

  test("host environment and process are not visible", async () => {
    const out = await closed(`printenv ${CANARY_ENV}`, files);
    expect(out.stdout).not.toContain(CANARY_VAL);
    const env = await runSh(files, "env; printenv", { cwd: "/channel" });
    expect(leaked(env, CANARY_VAL, HOST_HOME)).toBeUndefined();
    await closed("ps eww", files);
    await closed("cat /proc/self/environ", files);
  });

  test("interpreters and sqlite are absent", async () => {
    for (const script of ["python3 -c 'print(1)'", "node -e 'process.stdout.write(\"1\")'", "js-exec '1'", "sqlite3 :memory: 'select 1'"]) {
      const out = await closed(script, files);
      expect(out.stdout.trim()).not.toBe("1");
    }
  });

  test("writes fail and do not persist across calls", async () => {
    const disk = { "/channel/facts/ip": "10.0.0.4\n" };
    await closed("echo pwned > /channel/facts/ip", disk);
    await closed("echo pwned > /tmp/x", disk);
    await closed("rm -f /channel/facts/ip", disk);
    await closed("mv /channel/facts/ip /channel/facts/gone", disk);
    await closed("touch /channel/facts/new", disk);
    expect(disk["/channel/facts/ip"]).toBe("10.0.0.4\n");
    const read = await runSh(disk, "cat /channel/facts/ip", { cwd: "/channel" });
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain("10.0.0.4");
    expect(read.stdout).not.toContain("pwned");
  });

  test("send, task and claim are not registered", async () => {
    for (const script of ["send hi", "kiwi send hi", "task add pwn", "claim src/sh.ts"]) {
      const out = await closed(script, files);
      expect(out.stdout).not.toMatch(/sent #|added T|claimed/i);
    }
  });

  test("infinite loops, deep recursion and fork bombs are cut off", async () => {
    const scripts = ["while true; do true; done", "f(){ f; }; f", ":(){ :|:& };:"];
    for (const script of scripts) {
      const out = await Promise.race([
        runSh(files, script, { cwd: "/channel" }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`not cut off: ${script}`)), 15_000)),
      ]);
      expect([script, out.exitCode]).not.toEqual([script, 0]);
    }
  });

  test("discarding stderr on /dev/null still runs the script", async () => {
    const out = await runSh(files, "echo ok 2>/dev/null");
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("ok");
  });

  test("shell execution from sed and awk is refused", async () => {
    const sed = await closed("sed -e 's/a/id/e' /channel/facts/ip", files);
    expect(sed.stderr).toMatch(/not supported|not allowed/);
    const awk = await closed("awk 'BEGIN { system(\"cat /etc/passwd\") }'", files);
    expect(awk.stderr).toMatch(/not supported|not allowed/);
    expect(awk.stdout).not.toContain("root:");
  });

  test("a long hash loop is stopped by the execution deadline, under the command cap", async () => {
    const started = Date.now();
    const out = await Promise.race([
      runSh(
        { "/channel/big": "x".repeat(8_000_000) },
        'i=0; while [ "$i" -lt 1500 ]; do sha256sum /channel/big >/dev/null; i=$((i+1)); done; echo done',
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("sha256 loop was not stopped")), 12_000)),
    ]);
    const ms = Date.now() - started;
    expect(out.exitCode).not.toBe(0);
    expect(out.stdout).not.toContain("done");
    expect(ms).toBeGreaterThan(1_000);
    expect(ms).toBeLessThan(12_000);
  });

  test("huge output is capped", async () => {
    const out = await Promise.race([
      runSh({ "/channel/big": "x".repeat(200_000) }, "cat /channel/big"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cat was not capped")), 15_000)),
    ]);
    expect(out.stdout.length).toBeLessThan(80_000);
    expect(out.stdout).toContain("output cut");
    const seq = await Promise.race([
      runSh(files, "seq 1 100000000"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("seq was not cut off")), 15_000)),
    ]);
    expect(seq.exitCode).not.toBe(0);
    expect(seq.stdout.length).toBeLessThan(80_000);
  });
});

describe("channelFiles", () => {
  let seq = 0;
  const T0 = 1_700_000_000_000;

  async function msg(id: Identity | null, from: string, init: { kind?: Kind; ev?: Event; body?: string } = {}): Promise<Message> {
    seq++;
    const at = T0 + seq * 1000;
    const base = {
      v: 1 as const,
      id: crypto.randomUUID(),
      from,
      kind: init.kind ?? (init.ev ? "event" : "msg"),
      body: init.body ?? "",
      ts: at,
      ...(init.ev ? { ev: init.ev } : {}),
    };
    const p = id ? await sign(id, base) : base;
    return { ...p, seq, rts: at, sigOk: await verify(p) };
  }

  function view(alias: string, me: string, messages: Message[], roster: Roster, cursor = 0): ChannelView {
    return { alias, me, messages, state: fold(messages, roster), cursor };
  }

  function blob(files: Record<string, string>): string {
    return Object.entries(files).map(([path, body]) => `${path}\n${body}`).join("\n");
  }

  test("mounts only this identity's channel and drops forged messages", async () => {
    const human = await generateIdentity("human");
    const intern = await generateIdentity("intern");
    const evil = await generateIdentity("evil");
    const roster: Roster = [
      { name: "human", pk: human.pk, owner: true, at: 0, active: true, kind: "human" },
      { name: "intern", pk: intern.pk, owner: false, at: 0, active: true, role: "intern", kind: "agent" },
    ];
    const messages = [
      await msg(human, "human", { ev: { op: "fact.set", key: "ip", value: "10.0.0.4" } }),
      await msg(intern, "intern", { body: "verified-hello" }),
      await msg(evil, "intern", { body: FORGED, ev: { op: "fact.set", key: "ip", value: "6.6.6.6" } }),
    ];
    const files = channelFiles([view("alpha", "intern", messages, roster)]);
    const text = blob(files);
    expect(text).toContain("verified-hello");
    expect(text).toContain("10.0.0.4");
    expect(text).not.toContain(FORGED);
    expect(text).not.toContain("6.6.6.6");
    expect(text).not.toContain(OTHER_CHANNEL);
    expect(text).not.toContain(intern.sk);
    expect(text).not.toContain(intern.xsk!);
    expect(text).not.toContain(human.sk);
    for (const path of Object.keys(files)) {
      expect(path.startsWith("/channel/") || path.startsWith("/channels/alpha/")).toBe(true);
      expect(path).not.toContain("cursor");
    }
    expect(files["/etc/passwd"]).toBeUndefined();
    const me = JSON.parse(files["/channel/me"] ?? "");
    expect(Object.keys(me).sort()).toEqual(["channel", "name", "role"]);
    expect(me).toEqual({ name: "intern", role: "intern", channel: "alpha" });
    const member = JSON.parse(files["/channel/members/intern.json"] ?? "");
    expect(member.pk).toBeUndefined();
    expect(member.sk).toBeUndefined();
    expect(JSON.stringify(member)).not.toContain(intern.pk);
  });

  test("a real relay session does not leak keys, cursors, home or forged text", async () => {
    const kiwiHome = mkdtempSync(join(tmpdir(), "kiwi-sh-escape-"));
    const dataDir = mkdtempSync(join(tmpdir(), "kiwi-sh-relay-"));
    const previous = process.env.KIWI_HOME;
    process.env.KIWI_HOME = kiwiHome;
    const server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
    try {
      const relay = server.url.origin;
      const human = await generateIdentity("human");
      const intern = await generateIdentity("intern");
      const evil = await generateIdentity("evil");
      const { code, access } = await Channel.create(relay, human, { name: "human", kind: "human" }, [
        { ...intern, info: { name: "intern", role: "intern", kind: "agent" } },
      ], undefined, null, "escape");
      updateConfig((cfg) => {
        cfg.channels.escape = { ...access, relay, code, as: "intern", owner: "human", title: "escape" };
      });
      for (const id of [human, intern]) {
        const path = join(kiwiHome, "identities", access.roomId, `${id.name}.json`);
        mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(path, JSON.stringify(id, null, 2) + "\n", { mode: 0o600 });
      }
      writeCursor("escape", "intern", 0);
      writeFileSync(join(kiwiHome, "cursors", "escape", "intern"), `${CURSOR_SENTINEL}\n`);
      mkdirSync(join(kiwiHome, "cache"), { recursive: true });
      writeFileSync(join(kiwiHome, "cache", "sentinel"), `${CACHE_SENTINEL}\n`);

      await new Channel(access, relay, intern).send("verified-hello");
      // A key the owner never admitted is not a member, so the relay refuses it before it can be stored.
      await expect(new Channel(access, relay, { ...evil, name: "intern" }).send(FORGED)).rejects.toThrow(/member/);

      const session = await AgentSession.open("escape", loadConfig().channels.escape!, "intern");
      const files = channelFiles([await channelView(session)]);
      const text = blob(files);
      const secrets = [
        human.sk, human.xsk!, intern.sk, intern.xsk!, evil.sk,
        ...Object.values(access.keys),
        kiwiHome, relay, FORGED, CACHE_SENTINEL, CURSOR_SENTINEL, hostPasswdLine,
      ];
      for (const secret of secrets) {
        if (text.includes(secret)) throw new Error(`channel FS leaked ${secret.slice(0, 24)}`);
      }
      expect(text).toContain("verified-hello");
      for (const path of Object.keys(files)) {
        expect(path.startsWith("/channel/") || path.startsWith("/channels/escape/")).toBe(true);
      }
      const me = JSON.parse(files["/channel/me"] ?? "");
      expect(Object.keys(me).sort()).toEqual(["channel", "name", "role"]);
      expect(me).toEqual({ name: "intern", role: "intern", channel: "escape" });
    } finally {
      server.stop(true);
      if (previous === undefined) delete process.env.KIWI_HOME;
      else process.env.KIWI_HOME = previous;
      rmSync(kiwiHome, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
