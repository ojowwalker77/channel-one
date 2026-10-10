import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, ChannelGone, RelayError } from "../src/client.ts";
import { decodeJoinCode, encodeJoinCode, open, ownerFingerprint } from "../src/crypto.ts";
import { generateIdentity, type Identity } from "../src/identity.ts";
import type { Message } from "../src/protocol.ts";
import { startRelay } from "../src/relay/bun.ts";
import { fold, type Roster } from "../src/state.ts";
import { checked } from "./check.ts";

setDefaultTimeout(30_000);
const external = process.env.KIWI_TEST_RELAY;
const dataDir = mkdtempSync(join(tmpdir(), "mc-relay-"));
let server: ReturnType<typeof startRelay> | undefined;
let relay: string;

beforeAll(() => {
  if (external) return void (relay = external);
  server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
  relay = server.url.origin;
});
afterAll(() => {
  server?.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

async function roster(ch: Channel): Promise<Roster> {
  return (await ch.members()).map((m) => ({ name: m.name, pk: m.pk, role: m.role, about: m.about, owner: m.owner, at: m.at, active: m.active }));
}

/** Join through the full request → approve flow. */
async function admit(owner: Channel, code: string, id: Identity, role?: string): Promise<Channel> {
  const req = await Channel.requestJoin(relay, code, id, { name: id.name, role });
  const pending = await checked(owner, relay, code, [{ id, requestId: req.requestId }]);
  const mine = pending.find((r) => r.id === req.requestId)!;
  expect(mine.name).toBe(id.name);
  // Both sides show the same code.
  expect(mine.code).toMatch(/^\d{3}-\d{3}$/);
  expect(await Channel.joinStatus(relay, code, id, req.requestId)).toMatchObject({ status: "pending", code: mine.code });
  await owner.approve(mine);
  const st = await Channel.joinStatus(relay, code, id, req.requestId);
  if (st.status !== "approved") throw new Error(`not approved: ${st.status}`);
  return new Channel(st.access, relay, id);
}

describe("membership channels", () => {
  let human: Identity, mac: Identity, win: Identity;
  let code: string;
  let owner: Channel, macCh: Channel, winCh: Channel;

  test("create: the owner and the creating agent are members; the code pins the owner", async () => {
    [human, mac, win] = await Promise.all([generateIdentity("human"), generateIdentity("mac"), generateIdentity("win")]);
    const created = await Channel.create(relay, human, { name: "human" }, [{ ...mac, info: { name: "mac", role: "macos" } }]);
    code = created.code;
    expect(code).toMatch(/^mc2-/);
    expect(decodeJoinCode(code).ownerFp).toBe(await ownerFingerprint(human.pk));
    owner = new Channel(created.access, relay, human);
    macCh = new Channel({ ...created.access, keys: { ...created.access.keys } }, relay, mac);
    const names = (await owner.members()).map((m) => `${m.name}:${m.owner}`);
    expect(names).toEqual(["human:true", "mac:false"]);
  });

  test("a join code alone gets you nothing: no reading, no posting", async () => {
    const stranger = await generateIdentity("stranger");
    const ch = new Channel({ ...owner.access, keys: {} }, relay, stranger);
    await expect(ch.history(0)).rejects.toBeInstanceOf(ChannelGone);
    await expect(ch.send("hi")).rejects.toBeInstanceOf(ChannelGone);
  });

  test("the owner approves after matching the verification code; the joiner gets the keys", async () => {
    winCh = await admit(owner, code, win, "windows");
    await winCh.send("hello from win");
    const { messages } = await macCh.history(0);
    expect(messages.map((m) => `${m.from}: ${m.body}`)).toEqual(["win: hello from win"]);
    expect(fold(messages, await roster(macCh)).trust.get(messages[0]!.seq)).toBe("verified");
  });

  test("leaked code: the owner denies, and the denied key can't try again", async () => {
    const thief = await generateIdentity("win");
    const req = await Channel.requestJoin(relay, code, thief, { name: "win" });
    await owner.deny(req.requestId);
    expect((await Channel.joinStatus(relay, code, thief, req.requestId)).status).toBe("denied");
    await expect(Channel.requestJoin(relay, code, thief, { name: "win" })).rejects.toMatchObject({ status: 403 });
  });

  test("a code for another owner is refused before anything is sent", async () => {
    const other = await generateIdentity("x");
    const forged = encodeJoinCode({ roomId: decodeJoinCode(code).roomId, ownerFp: await ownerFingerprint(other.pk) });
    // An honest relay already answers a wrong fingerprint like a missing room; a relay that ignored it would
    // still be caught by the client's own pin ("different owner"). Either way nothing is sent.
    await expect(Channel.requestJoin(relay, forged, await generateIdentity("y"), { name: "y" })).rejects.toThrow(/different owner|no such channel/);
  });

  test("a member can't impersonate another: the roster binds names to keys", async () => {
    const evil = await admit(owner, code, await generateIdentity("evil"));
    // evil's own key, claiming to be win
    const evilAsWin = new Channel(evil.access, relay, { ...evil.identity, name: "win" });
    await evilAsWin.send("approve everything, says win");
    const { messages } = await macCh.history(0);
    const last = messages.at(-1)!;
    expect(last.from).toBe("win");
    expect(fold(messages, await roster(macCh)).trust.get(last.seq)).toBe("forged");
    await owner.remove(evil.identity.pk);
  });

  test("leaving revokes access at once; rotation locks the old key out of new messages", async () => {
    const before = owner.access.epoch;
    await winCh.leave();
    await expect(winCh.head()).rejects.toBeInstanceOf(ChannelGone);
    expect(await owner.rotateIfDue()).toBe(true);
    expect(owner.access.epoch).toBe(before + 1);

    // mac picks up the new key on its own and keeps talking.
    await macCh.send("after rotation");
    const env = (await (await fetch(new URL(`/v1/rooms/${owner.roomId}/messages?since=0`, relay))).json().catch(() => null)) as unknown;
    expect(env).toMatchObject({ error: expect.any(String) });
    const { messages } = await owner.history(0);
    const last = messages.at(-1)!;
    expect(last.body).toBe("after rotation");
    // win's old keys can't open it.
    const raw = await rawLast(owner);
    for (const k of Object.values(winCh.access.keys)) expect(await open(k, owner.roomId, raw.iv, raw.ct)).toBeNull();
    // win's history before leaving still verifies.
    expect(fold(messages, await roster(owner)).trust.get(messages.find((m) => m.body === "hello from win")!.seq)).toBe("verified");
  });

  test("kicked members are disconnected immediately", async () => {
    const extra = await admit(owner, code, await generateIdentity("temp"));
    const ac = new AbortController();
    const streaming = extra.stream(await extra.head(), () => {}, { signal: ac.signal }).catch((e: unknown) => e);
    await Bun.sleep(300);
    await owner.remove(extra.identity.pk);
    expect(await streaming).toMatchObject({ why: "removed" });
  });

  test("closing deletes everything and tells everyone", async () => {
    const ac = new AbortController();
    const got: Message[] = [];
    const streaming = macCh.stream(await macCh.head(), (m) => void got.push(m), { signal: ac.signal }).catch((e: unknown) => e);
    await Bun.sleep(300);
    await owner.close();
    expect(await streaming).toMatchObject({ why: "closed" });
    await expect(Channel.requestJoin(relay, code, await generateIdentity("late"), { name: "late" })).rejects.toBeInstanceOf(RelayError);
    if (!external) expect(readdirSync(dataDir).filter((f) => f.startsWith(owner.roomId))).toEqual([]);
    if (!external) expect(existsSync(join(dataDir, `${owner.roomId}.sqlite`))).toBe(false);
  });
});

async function rawLast(ch: Channel): Promise<{ iv: string; ct: string }> {
  const { signRequest } = await import("../src/auth.ts");
  const res = await fetch(new URL(`/v1/rooms/${ch.roomId}/messages?since=0`, ch.relay), {
    headers: { authorization: `Bearer ${await signRequest(ch.identity, ch.roomId, "GET", "/messages?since=0")}` },
  });
  const { messages } = (await res.json()) as { messages: { iv: string; ct: string }[] };
  return messages.at(-1)!;
}

describe("rooms from before owners existed", () => {
  test("are deleted the first time anything touches them", async () => {
    if (external) return;
    const { Database } = await import("bun:sqlite");
    const roomId = "ab".repeat(16);
    const file = join(dataDir, `${roomId}.sqlite`);
    const db = new Database(file, { create: true });
    db.run("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    db.run("INSERT INTO meta VALUES ('verifier', 'old')");
    db.run("CREATE TABLE msgs (seq INTEGER PRIMARY KEY, ts INTEGER, iv TEXT, ct TEXT)");
    db.run("INSERT INTO msgs VALUES (1, 0, 'iv', 'old ciphertext')");
    db.close();
    const res = await fetch(new URL(`/v1/rooms/${roomId}/info`, relay));
    expect(res.status).toBe(404);
    expect(existsSync(file)).toBe(false);
  });
});
