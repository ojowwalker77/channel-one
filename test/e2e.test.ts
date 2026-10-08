import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, RelayError } from "../src/client.ts";
import { deriveChannel, generateCode } from "../src/crypto.ts";
import type { Message } from "../src/protocol.ts";
import { startRelay } from "../src/relay/bun.ts";

const dataDir = mkdtempSync(join(tmpdir(), "mc-relay-"));
let server: ReturnType<typeof startRelay>;
let relay: string;

// MC_TEST_RELAY=http://localhost:8787 runs the suite against another relay,
// e.g. the Cloudflare one under `wrangler dev`.
const external = process.env.MC_TEST_RELAY;

beforeAll(() => {
  if (external) return void (relay = external);
  server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
  relay = server.url.origin;
});
afterAll(() => server?.stop(true));

async function newChannel(): Promise<{ code: string; mac: Channel; win: Channel }> {
  const code = generateCode();
  const keys = await deriveChannel(code);
  const mac = new Channel(keys, relay, "mac");
  await mac.create();
  const win = new Channel(await deriveChannel(code), relay, "win");
  return { code, mac, win };
}

const MC = ["bun", join(import.meta.dir, "../src/cli/main.ts")];

function mc(home: string, ...args: string[]) {
  return Bun.spawn([...MC, ...args], {
    env: { ...process.env, MC_HOME: home, MC_RELAY: relay },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function run(home: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = mc(home, ...args);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

test("same code derives the same keys; different codes don't collide", async () => {
  const a = await deriveChannel("mc1-abc");
  expect(await deriveChannel("mc1-abc")).toEqual(a);
  const b = await deriveChannel("mc1-abd");
  expect(b.roomId).not.toBe(a.roomId);
  expect(b.key).not.toBe(a.key);
});

test("send and history round-trip, encrypted at rest", async () => {
  const { mac, win } = await newChannel();
  const seq = await mac.send("secret plan: ship it", { to: ["win"], kind: "ask" });
  const { messages } = await win.history(0);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ seq, from: "mac", to: ["win"], kind: "ask", body: "secret plan: ship it" });

  // The relay's database must not contain the plaintext.
  if (external) return;
  const file = readdirSync(dataDir).find((f) => f.startsWith(mac.keys.roomId) && f.endsWith(".sqlite"))!;
  expect(readFileSync(join(dataDir, file)).includes("secret plan")).toBe(false);
});

test("wrong token is rejected, unknown room is 404", async () => {
  const { mac } = await newChannel();
  const forged = new Channel({ ...mac.keys, token: "nope" }, relay, "x");
  await expect(forged.head()).rejects.toMatchObject({ status: 403 });
  const stranger = new Channel(await deriveChannel(generateCode()), relay, "x");
  await expect(stranger.head()).rejects.toBeInstanceOf(RelayError);
});

test("stream delivers live messages and replays after reconnect", async () => {
  const { mac, win } = await newChannel();
  await mac.send("before");

  const got: Message[] = [];
  const ac = new AbortController();
  const done = win.stream(0, (m) => void got.push(m), { signal: ac.signal });
  await mac.send("live");
  while (got.length < 2) await Bun.sleep(10);
  ac.abort();
  await done;

  await mac.send("while offline");
  const ac2 = new AbortController();
  const later: Message[] = [];
  const done2 = win.stream(got.at(-1)!.seq, (m) => void later.push(m), { signal: ac2.signal });
  while (later.length < 1) await Bun.sleep(10);
  ac2.abort();
  await done2;

  expect(got.map((m) => m.body)).toEqual(["before", "live"]);
  expect(later.map((m) => m.body)).toEqual(["while offline"]);
});

test("cli: create, join, wait wakes on a message, cursor prevents repeats", async () => {
  const macHome = mkdtempSync(join(tmpdir(), "mc-mac-"));
  const winHome = mkdtempSync(join(tmpdir(), "mc-win-"));

  const created = await run(macHome, "create", "proj", "--as", "mac");
  expect(created.code).toBe(0);
  const code = /join code: (\S+)/.exec(created.out)![1]!;
  expect((await run(winHome, "join", code, "proj", "--as", "win")).code).toBe(0);

  // win blocks in wait; mac's own messages never wake mac.
  const waiter = mc(winHome, "wait", "--for-me");
  await Bun.sleep(300);
  expect((await run(macHome, "send", "--to", "win", "--kind", "ask", "listening", "on", "10.0.0.2:24801")).code).toBe(0);
  const out = await new Response(waiter.stdout).text();
  expect(await waiter.exited).toBe(0);
  expect(out.trim()).toMatch(/^#1 mac → win \[ask\]: listening on 10\.0\.0\.2:24801$/);

  // Already consumed: read prints nothing new, wait times out.
  expect((await run(winHome, "read")).out).toBe("");
  expect((await run(winHome, "wait", "--timeout", "1")).code).toBe(2);

  // Replies and history.
  expect((await run(winHome, "send", "--re", "1", "connecting")).code).toBe(0);
  expect((await run(macHome, "read")).out.trim()).toBe("#2 win → all re #1: connecting");
  const log = await run(macHome, "log", "--json");
  expect(log.out.trim().split("\n").map((l) => JSON.parse(l).body)).toEqual(["listening on 10.0.0.2:24801", "connecting"]);
});

test("cli: tail streams one line per message, flushed immediately", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-tail-"));
  const other = mkdtempSync(join(tmpdir(), "mc-tail2-"));
  const code = /join code: (\S+)/.exec((await run(home, "create", "t", "--as", "a")).out)![1]!;
  await run(other, "join", code, "t", "--as", "b");

  const tail = mc(home, "tail");
  const reader = tail.stdout.getReader();
  const lines: string[] = [];
  let buf = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) (lines.push(buf.slice(0, i)), (buf = buf.slice(i + 1)));
    }
  })();
  await Bun.sleep(300);
  await run(other, "send", "one");
  while (lines.length < 1) await Bun.sleep(10);
  await run(other, "send", "two\nlines");
  while (lines.length < 3) await Bun.sleep(10);
  tail.kill();
  await pump;
  expect(lines).toEqual(["#1 b → all: one", "#2 b → all: two", "lines"]);
});
