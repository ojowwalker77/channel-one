// Channel icons: set by the owner, sealed like the title, readable only by members.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "../src/client.ts";
import { decodeJoinCode } from "../src/crypto.ts";
import { generateIdentity } from "../src/identity.ts";
import { wellFormedIcon } from "../src/protocol.ts";
import { startRelay } from "../src/relay/bun.ts";
import { checked } from "./check.ts";

setDefaultTimeout(30_000);

const dataDir = mkdtempSync(join(tmpdir(), "kiwi-icon-"));
let server: ReturnType<typeof startRelay>;
let relay: string;
let ownerCh: Channel;
let memberCh: Channel;
let code: string;
beforeAll(async () => {
  server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
  relay = server.url.origin;
  const owner = await generateIdentity("human");
  const made = await Channel.create(relay, owner, { name: "human" });
  code = made.code;
  ownerCh = new Channel(made.access, relay, owner);
  const agent = await generateIdentity("win");
  const ask = await Channel.requestJoin(relay, code, agent, { name: "win" });
  await ownerCh.approve((await checked(ownerCh, relay, code, [{ id: agent, requestId: ask.requestId }]))[0]!);
  const st = await Channel.joinStatus(relay, code, agent, ask.requestId);
  memberCh = new Channel((st as { access: import("../src/crypto.ts").ChannelAccess }).access, relay, agent);
});
afterAll(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

test("the owner sets an emoji; members read it; info says when it changed", async () => {
  expect(await memberCh.icon()).toBeNull();
  expect((await memberCh.info()).iconAt).toBeNull();
  await ownerCh.setIcon({ kind: "emoji", emoji: "🦊" });
  expect(await memberCh.icon()).toEqual({ kind: "emoji", emoji: "🦊" });
  expect((await memberCh.info()).iconAt).toBeGreaterThan(0);
});

test("an image, and the relay never sees it", async () => {
  const data = Buffer.from(new Uint8Array(2048).map((_, i) => i % 251)).toString("base64");
  await ownerCh.setIcon({ kind: "image", mime: "image/png", data });
  expect(await memberCh.icon()).toEqual({ kind: "image", mime: "image/png", data });
  const raw = (await (await fetch(`${relay}/v1/rooms/${ownerCh.roomId}/info?fp=${decodeJoinCode(code).ownerFp}`)).text());
  expect(raw).toContain("ownerPk");
  expect(raw).not.toContain(data.slice(0, 40));
});

test("only the owner sets it, only members read it, and only sane icons go in", async () => {
  await expect(memberCh.setIcon({ kind: "emoji", emoji: "💀" })).rejects.toThrow();
  const stranger = new Channel({ ...memberCh.access }, relay, await generateIdentity("x"));
  await expect(stranger.icon()).rejects.toBeInstanceOf(Error);
  await expect(ownerCh.setIcon({ kind: "emoji", emoji: "🦊🦊" })).rejects.toThrow(/one emoji/);
  await expect(ownerCh.setIcon({ kind: "image", mime: "image/svg+xml" as "image/png", data: "PHN2Zz4=" })).rejects.toThrow();
  await expect(ownerCh.setIcon({ kind: "image", mime: "image/png", data: "A".repeat(50_000) })).rejects.toThrow(/32KB/);
  expect(wellFormedIcon({ kind: "emoji", emoji: "👩‍💻" })).toBe(true);
  expect(wellFormedIcon({ kind: "emoji", emoji: "<script>" })).toBe(false);
});

test("an icon a member sealed themself (for a colluding relay to serve) is ignored: it must be the owner's", async () => {
  const { seal } = await import("../src/crypto.ts");
  const e = memberCh.access.epoch;
  const forged = { e, ...(await seal(memberCh.access.keys[String(e)]!, memberCh.roomId, { what: "channel-icon", room: memberCh.roomId, icon: { kind: "emoji", emoji: "💀" } })) };
  // Straight into the relay's storage, as a relay that colludes with a member would.
  const db = new (await import("bun:sqlite")).Database(join(dataDir, `${memberCh.roomId}.sqlite`));
  db.run("INSERT INTO meta (k, v) VALUES ('icon', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [JSON.stringify(forged)]);
  db.close();
  expect(await memberCh.icon()).toBeNull();
});

test("clearing it", async () => {
  await ownerCh.setIcon(null);
  expect(await memberCh.icon()).toBeNull();
});

test("members are told when it changes", async () => {
  const ac = new AbortController();
  let told = 0;
  let ready!: () => void;
  const opened = new Promise<void>((r) => (ready = r));
  const listening = memberCh.stream(await memberCh.head(), () => {}, { signal: ac.signal, onReady: () => ready(), onInfo: () => void told++ });
  await opened;
  await ownerCh.setIcon({ kind: "emoji", emoji: "🌱" });
  const end = Date.now() + 10_000;
  while (!told && Date.now() < end) await Bun.sleep(50);
  if (!told) throw new Error("icon change was not announced");
  ac.abort();
  await listening;
  expect(told).toBe(1);
});

