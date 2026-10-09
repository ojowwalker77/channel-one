// Channel titles: owner-signed inside the seal, like icons. An old unsigned
// { name } still shows until this client has seen a signed one, or the room
// was created with the owner's titles promise.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, ownerStatement } from "../src/client.ts";
import { seal, type ChannelAccess } from "../src/crypto.ts";
import { generateIdentity, sign, verify, type Identity } from "../src/identity.ts";
import { startRelay } from "../src/relay/bun.ts";
import { checked } from "./check.ts";

setDefaultTimeout(30_000);

const dataDir = mkdtempSync(join(tmpdir(), "kiwi-title-"));
let server: ReturnType<typeof startRelay>;
let relay: string;

beforeAll(() => {
  server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
  relay = server.url.origin;
});
afterAll(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

function put(roomId: string, key: string, value: string): void {
  const db = new Database(join(dataDir, `${roomId}.sqlite`));
  db.run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [key, value]);
  db.close();
}

async function room(title?: string): Promise<{ owner: Identity; member: Identity; ownerCh: Channel; memberCh: Channel }> {
  const owner = await generateIdentity("human");
  const made = await Channel.create(relay, owner, { name: "human" }, [], undefined, null, title);
  const ownerCh = new Channel(made.access, relay, owner);
  const member = await generateIdentity("win");
  const ask = await Channel.requestJoin(relay, made.code, member, { name: "win" });
  await ownerCh.approve((await checked(ownerCh, relay, made.code, [{ id: member, requestId: ask.requestId }]))[0]!);
  const st = await Channel.joinStatus(relay, made.code, member, ask.requestId);
  const memberCh = new Channel((st as { access: ChannelAccess }).access, relay, member);
  return { owner, member, ownerCh, memberCh };
}

test("a new room signs its title, and an unsigned blob is refused without anyone having seen the signed one", async () => {
  const { member, memberCh } = await room("plans");
  expect(await memberCh.title()).toBe("plans");
  const key = memberCh.access.keys["0"]!;
  const evil = await seal(key, memberCh.roomId, { name: "evil" });
  put(memberCh.roomId, "title", JSON.stringify(evil));
  const fresh = new Channel({ ...memberCh.access, signedTitle: undefined }, relay, member);
  expect(fresh.access.signedTitle).toBeUndefined();
  expect(await fresh.title()).toBeNull();
});

test("a 0.7 client still verifies a new room's owner statement; stripping the titles promise falls back", async () => {
  const { member, memberCh } = await room("plans");
  const info = await memberCh.info();
  expect(await ownerStatement(memberCh.roomId, info)).toBe("signed-keys");
  expect(await verify({ room: memberCh.roomId, pk: info.ownerPk, xpk: info.ownerXpk, v: 2, sig: info.ownerSig })).toBe(true);
  expect(await memberCh.title()).toBe("plans");

  const key = memberCh.access.keys["0"]!;
  const db = new Database(join(dataDir, `${memberCh.roomId}.sqlite`));
  db.run("DELETE FROM meta WHERE k = 'titles_sig'");
  db.close();
  put(memberCh.roomId, "title", JSON.stringify(await seal(key, memberCh.roomId, { name: "evil" })));
  // This client already saw the signed title, so the stripped promise doesn't bring the unsigned name back.
  expect(await memberCh.title()).toBeNull();
  // A client that never saw it, and was never given the promise, is on the older rule.
  const fresh = new Channel({ ...memberCh.access, signedTitle: undefined }, relay, member);
  expect(await fresh.title()).toBe("evil");
});

test("a title a member signed themself is ignored", async () => {
  const { member, memberCh } = await room("plans");
  const key = memberCh.access.keys["0"]!;
  const forged = await seal(key, memberCh.roomId, await sign(member, { what: "channel-title", room: memberCh.roomId, name: "evil" }));
  put(memberCh.roomId, "title", JSON.stringify(forged));
  expect(await memberCh.title()).toBeNull();
  await expect(memberCh.setTitle("nope")).rejects.toThrow(/owner/);
});

test("an older room still shows an unsigned title, and refuses one after it has seen the owner sign", async () => {
  const { owner, member, ownerCh, memberCh } = await room();
  const roomId = ownerCh.roomId;
  const key = ownerCh.access.keys["0"]!;
  // A room from before titles were signed: the 0.7 key statement, no titles promise, a plain { name }.
  const old = await sign(owner, { room: roomId, xpk: owner.xpk!, v: 2 });
  put(roomId, "owner_sig", old.sig);
  const db = new Database(join(dataDir, `${roomId}.sqlite`));
  db.run("DELETE FROM meta WHERE k = 'titles_sig'");
  db.close();
  put(roomId, "title", JSON.stringify(await seal(key, roomId, { name: "old-name" })));
  const reader = new Channel({ ...memberCh.access }, relay, member);
  expect(await reader.title()).toBe("old-name");
  expect(reader.access.signedTitle).toBeUndefined();

  await ownerCh.setTitle("renamed");
  expect(await reader.title()).toBe("renamed");
  expect(reader.access.signedTitle).toBe(true);

  // Downgrade: the relay serves a member-sealed unsigned name again. This client saw the signature, so it refuses.
  put(roomId, "title", JSON.stringify(await seal(key, roomId, { name: "evil" })));
  expect(await reader.title()).toBeNull();
  const persisted = new Channel({ ...reader.access }, relay, member);
  expect(await persisted.title()).toBeNull();
});
