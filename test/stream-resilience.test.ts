// A consumer that throws on one message mustn't leave the listener deaf (GLM-3, T663).

import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "../src/client.ts";
import { generateIdentity } from "../src/identity.ts";
import { startRelay } from "../src/relay/bun.ts";

setDefaultTimeout(30_000);
const dataDir = mkdtempSync(join(tmpdir(), "kiwi-stream-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

test("a throwing consumer loses one message, not the stream; a server close still reconnects", async () => {
  let server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
  const port = server.port;
  const relay = server.url.origin;
  const owner = await generateIdentity("human");
  const { access } = await Channel.create(relay, owner, { name: "human" });
  const ch = new Channel(access, relay, owner);

  const got: string[] = [];
  const status: string[] = [];
  const ac = new AbortController();
  let ready!: () => void;
  const opened = new Promise<void>((r) => (ready = r));
  const listening = ch.stream(
    0,
    (m) => {
      if (m.body === "boom") throw new Error("consumer bug");
      got.push(m.body);
    },
    { signal: ac.signal, quietMs: 60_000, onStatus: (s) => status.push(s), onReady: () => ready() },
  );
  await opened;

  await ch.send("boom");
  await ch.send("after the bug");
  const waitFor = async (body: string) => {
    const end = Date.now() + 15_000;
    while (!got.includes(body)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${body}; got ${got.join(", ")}`);
      await Bun.sleep(50);
    }
  };
  await waitFor("after the bug");
  expect(got).toEqual(["after the bug"]);
  expect(status.some((s) => s.includes("dropped a msg frame") && s.includes("consumer bug"))).toBe(true);

  // The relay restarts: the socket closes from the server side, and the stream must come back.
  server.stop(true);
  server = startRelay({ port, hostname: "127.0.0.1", dataDir });
  await ch.send("after a restart");
  await waitFor("after a restart");
  expect(got).toEqual(["after the bug", "after a restart"]);

  ac.abort();
  await listening;
  server.stop(true);
});
