// A listener stays quiet through routine drops, and says something only when the relay stays away.

import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "../src/client.ts";
import { generateIdentity } from "../src/identity.ts";
import { startRelay } from "../src/relay/bun.ts";

setDefaultTimeout(30_000);

const dataDir = mkdtempSync(join(tmpdir(), "kiwi-reconnect-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

test("drops are silent, a long outage is one line, and nothing is missed", async () => {
  let server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
  const port = server.port;
  const relay = server.url.origin;
  const owner = await generateIdentity("human");
  const { access } = await Channel.create(relay, owner, { name: "human" });
  const ch = new Channel(access, relay, owner);

  const status: string[] = [];
  const got: string[] = [];
  const ac = new AbortController();
  let ready!: () => void;
  const opened = new Promise<void>((r) => (ready = r));
  const listening = ch.stream(0, (m) => void got.push(m.body), { signal: ac.signal, quietMs: 1_500, onStatus: (s) => status.push(s), onReady: () => ready() });
  await opened;

  // A quick restart (like a deploy): no line at all.
  server.stop(true);
  server = startRelay({ port, hostname: "127.0.0.1", dataDir });
  await ch.send("after a blip");
  for (let i = 0; i < 40 && !got.includes("after a blip"); i++) await Bun.sleep(100);
  expect(got).toContain("after a blip");
  expect(status).toEqual([]);

  // Down for longer than the quiet window: one line while down, one when back.
  server.stop(true);
  await Bun.sleep(3_000);
  server = startRelay({ port, hostname: "127.0.0.1", dataDir });
  await ch.send("after an outage");
  for (let i = 0; i < 100 && !got.includes("after an outage"); i++) await Bun.sleep(100);
  expect(got).toEqual(["after a blip", "after an outage"]);
  expect(status.length).toBe(2);
  expect(status[0]).toMatch(/can't reach the relay for \ds/);
  expect(status[1]).toMatch(/reconnected after \ds; nothing was missed/);

  ac.abort();
  await listening;
  server.stop(true);
});

test("tail started while the relay is down keeps waiting instead of exiting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-reconnect-home-"));
  let server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
  const port = server.port;
  const env = { ...process.env, KIWI_HOME: dir, KIWI_RELAY: server.url.origin, CLAUDE_CONFIG_DIR: dir, CLAUDECODE: "" };
  const cli = (...args: string[]) => Bun.spawn(["bun", join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    expect(await cli("create", "r", "--as", "lead").exited).toBe(0);
    server.stop(true);
    // Its first fetch fails (0.5.0 exited here for good); it must keep trying.
    const tail = cli("-c", "r", "--as", "lead", "tail");
    await Bun.sleep(2_000);
    expect(tail.exitCode).toBeNull();
    server = startRelay({ port, hostname: "127.0.0.1", dataDir });
    await Bun.sleep(2_000);
    expect(tail.exitCode).toBeNull();
    tail.kill();
    expect(await new Response(tail.stderr).text()).not.toContain("socket");
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
