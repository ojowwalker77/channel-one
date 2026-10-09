// Adversarial cases for seat reclaim (T185). The happy path and the guards live
// in reclaim.test.ts; this file is the attacks: every one of these must fail
// closed, and the two at the bottom must succeed.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, RelayError } from "../src/client.ts";
import { generateIdentity, sign, verify, type Identity } from "../src/identity.ts";
import type { JoinRequest } from "../src/membership.ts";
import type { Message } from "../src/protocol.ts";
import { startRelay } from "../src/relay/bun.ts";
import { fold } from "../src/state.ts";

setDefaultTimeout(60_000);

const dataDir = mkdtempSync(join(tmpdir(), "kiwi-reclaim-attack-"));
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

async function seat(extra: { id: Identity; info: { name: string; kind?: "human" | "agent"; role?: string } }[] = []) {
  const owner = await generateIdentity("human");
  const oldKey = await generateIdentity("win");
  const made = await Channel.create(relay, owner, { name: "human", kind: "human" }, [
    { ...oldKey, info: { name: "win", role: "windows", kind: "agent" } },
    ...extra.map((e) => ({ ...e.id, info: e.info })),
  ]);
  const ownerCh = new Channel(made.access, relay, owner);
  const oldCh = new Channel(await Channel.resume(relay, made.code, oldKey), relay, oldKey);
  return { owner, oldKey, code: made.code, ownerCh, oldCh };
}

/** A reclaim stays unchecked until a person starts the code check. The day's budget must not sign it. */
async function ready(owner: Channel, code: string, joiner: Identity, requestId: string): Promise<JoinRequest> {
  const first = (await owner.requests()).find((r) => r.id === requestId);
  expect(first?.check).toBe("unchecked");
  expect(first?.reclaims).toBeDefined();
  await owner.checkRequest(first!);
  await Channel.joinStatus(relay, code, joiner, requestId);
  return (await owner.requests()).find((r) => r.id === requestId)!;
}

function active(members: { name: string; pk: string; active: boolean }[], name: string): string[] {
  return members.filter((m) => m.name === name && m.active).map((m) => m.pk);
}

describe("reclaim attacks", () => {
  test("a request with no owner approval grants nothing", async () => {
    const { oldKey, code, ownerCh } = await seat();
    const newbie = await generateIdentity("win");
    const { requestId } = await Channel.requestJoin(relay, code, newbie, { name: "win", reclaim: true });
    expect((await Channel.joinStatus(relay, code, newbie, requestId)).status).toBe("pending");
    await expect(Channel.resume(relay, code, newbie)).rejects.toBeInstanceOf(RelayError);
    expect(active(await ownerCh.members(), "win")).toEqual([oldKey.pk]);
  });

  test("a plain approve cannot move a seat, and a non-owner cannot reclaim", async () => {
    const { oldKey, code, ownerCh, oldCh } = await seat();
    const newbie = await generateIdentity("win");
    const { requestId } = await Channel.requestJoin(relay, code, newbie, { name: "win", reclaim: true });
    const req = await ready(ownerCh, code, newbie, requestId);
    await expect(ownerCh.approve(req)).rejects.toThrow(/already someone's name/);
    await expect(oldCh.reclaim(req, { online: false })).rejects.toThrow(/only the channel owner/);
    expect(active(await ownerCh.members(), "win")).toEqual([oldKey.pk]);
    await ownerCh.deny(requestId);
  });

  test("the sponsor has to be the person behind the old seat", async () => {
    const { code, ownerCh } = await seat();
    const newbie = await generateIdentity("win");
    const { requestId } = await Channel.requestJoin(relay, code, newbie, { name: "win", reclaim: true });
    const req = await ready(ownerCh, code, newbie, requestId);
    await expect(ownerCh.reclaim({ ...req, sponsoredBy: { user: "user_mallory", name: "Mallory" } }, { online: false })).rejects.toThrow(/refused/);
    expect((await Channel.joinStatus(relay, code, newbie, requestId)).status).toBe("pending");
  });

  test("the owner's seat and a person's seat cannot be reclaimed", async () => {
    const pat = await generateIdentity("pat");
    const { owner, code, ownerCh } = await seat([{ id: pat, info: { name: "pat", kind: "human" } }]);
    const asOwner = await generateIdentity("human");
    const ownerAsk = await Channel.requestJoin(relay, code, asOwner, { name: "human", reclaim: true });
    const ownerReq = await ready(ownerCh, code, asOwner, ownerAsk.requestId);
    expect(ownerReq.reclaims).toMatchObject({ pk: owner.pk, owner: true });
    await expect(ownerCh.reclaim(ownerReq, { online: false })).rejects.toThrow(/owner's seat/);

    const asPat = await generateIdentity("pat");
    const patAsk = await Channel.requestJoin(relay, code, asPat, { name: "pat", reclaim: true });
    const patReq = await ready(ownerCh, code, asPat, patAsk.requestId);
    await expect(ownerCh.reclaim(patReq, { online: false })).rejects.toThrow(/person's own seat/);
    expect(active(await ownerCh.members(), "human")).toEqual([owner.pk]);
    expect(active(await ownerCh.members(), "pat")).toEqual([pat.pk]);
  });

  test("an online old key needs force, and force is what the owner passes, not the requester", async () => {
    const { code, ownerCh } = await seat();
    const newbie = await generateIdentity("win");
    const { requestId } = await Channel.requestJoin(relay, code, newbie, { name: "win", reclaim: true });
    const req = await ready(ownerCh, code, newbie, requestId);
    await expect(ownerCh.reclaim(req, { online: true })).rejects.toThrow(/ONLINE NOW/);
    await expect(ownerCh.reclaim(req, { online: true, force: false })).rejects.toThrow(/ONLINE NOW/);
    expect((await Channel.joinStatus(relay, code, newbie, requestId)).status).toBe("pending");
  });

  test("a denied request and a removed key cannot reclaim", async () => {
    const { oldKey, code, ownerCh } = await seat();
    const denied = await generateIdentity("win");
    const ask = await Channel.requestJoin(relay, code, denied, { name: "win", reclaim: true });
    const req = await ready(ownerCh, code, denied, ask.requestId);
    await ownerCh.deny(ask.requestId);
    expect((await Channel.joinStatus(relay, code, denied, ask.requestId)).status).toBe("denied");
    await expect(Channel.resume(relay, code, denied)).rejects.toBeInstanceOf(RelayError);
    await expect(ownerCh.reclaim(req, { online: false })).rejects.toThrow();

    await ownerCh.remove(oldKey.pk);
    await expect(Channel.resume(relay, code, oldKey)).rejects.toBeInstanceOf(RelayError);
    await expect(Channel.requestJoin(relay, code, oldKey, { name: "win", reclaim: true })).rejects.toThrow(/removed/);
  });

  test("after a reclaim the old key cannot send, read or decrypt, and only one key is live", async () => {
    const { oldKey, code, ownerCh, oldCh } = await seat();
    const task = await oldCh.send("", { ev: { op: "task.add", title: "fix the PC edge", owner: "win" } });
    await oldCh.send("", { ev: { op: "claim", paths: ["src/pc"], ttl: 3600 } });
    await oldCh.send("still mine");
    const newbie = await generateIdentity("win");
    const { requestId } = await Channel.requestJoin(relay, code, newbie, { name: "win", reclaim: true });
    const req = await ready(ownerCh, code, newbie, requestId);
    await ownerCh.reclaim(req, { online: false });

    const secret = `SECRET_${crypto.randomUUID()}`;
    const st = await Channel.joinStatus(relay, code, newbie, requestId);
    expect(st.status).toBe("approved");
    if (st.status !== "approved") return;
    const newCh = new Channel(st.access, relay, newbie);
    await newCh.send(secret);

    await expect(oldCh.send("still here")).rejects.toThrow();
    await expect(oldCh.history(0)).rejects.toThrow();
    await expect(Channel.resume(relay, code, oldKey)).rejects.toBeInstanceOf(RelayError);

    const members = await newCh.members();
    expect(active(members, "win")).toEqual([newbie.pk]);
    const { messages } = await newCh.history(0);
    const state = fold(
      messages,
      members.map((m) => ({ name: m.name, pk: m.pk, role: m.role, owner: m.owner, at: m.at, active: m.active, kind: m.kind })),
    );
    expect([...state.tasks.values()].map((t) => t.title)).toEqual(["fix the PC edge"]);
    expect(state.claims.map((c) => c.path)).toEqual(["src/pc"]);
    expect(messages.filter((m) => m.from === "win" && m.body === "still mine").every((m) => state.trust.get(m.seq) === "verified")).toBe(true);
    expect(messages.some((m) => m.body === secret)).toBe(true);
    expect(task).toBeGreaterThan(0);

    const other = await generateIdentity("win");
    const again = await Channel.requestJoin(relay, code, other, { name: "win", reclaim: true });
    const second = await ready(ownerCh, code, other, again.requestId);
    await expect(ownerCh.reclaim({ ...second, reclaims: { ...second.reclaims!, pk: oldKey.pk } }, { online: false })).rejects.toThrow();
    expect(active(await ownerCh.members(), "win")).toEqual([newbie.pk]);
  });

  test("a seat.reclaim event that isn't from the owner is rejected and moves nothing", async () => {
    const { oldKey, code, ownerCh, oldCh } = await seat();
    await oldCh.send("I took it", { ev: { op: "seat.reclaim", member: "win", from: "deadbeef", to: "cafebabe" } });
    const { messages } = await ownerCh.history(0);
    const members = await ownerCh.members();
    const state = fold(
      messages,
      members.map((m) => ({ name: m.name, pk: m.pk, role: m.role, owner: m.owner, at: m.at, active: m.active, kind: m.kind })),
    );
    const event = messages.find((m) => m.ev?.op === "seat.reclaim")!;
    // The signature is win's, so it verifies, but only the owner may record a move.
    expect(state.trust.get(event.seq)).toBe("verified");
    expect(state.rejected.get(event.seq)).toMatch(/only the owner/);
    expect(active(members, "win")).toEqual([oldKey.pk]);

    // A signature under win's name from a key the owner never admitted never verifies.
    const evil = await generateIdentity("evil");
    const forged = await forgedMessage(evil, "win", { op: "seat.reclaim", member: "win", from: "deadbeef", to: "cafebabe" });
    const folded = fold(
      [...messages, forged],
      members.map((m) => ({ name: m.name, pk: m.pk, role: m.role, owner: m.owner, at: m.at, active: m.active, kind: m.kind })),
    );
    expect(folded.trust.get(forged.seq)).toBe("forged");
    expect(active(members, "win")).toEqual([oldKey.pk]);
  });

  test("the same key resumes without a request or an approval", async () => {
    const { oldKey, code, ownerCh } = await seat();
    const before = (await ownerCh.requests()).length;
    const access = await Channel.resume(relay, code, oldKey);
    expect(access.keys["0"]).toBeTruthy();
    expect((await ownerCh.requests()).length).toBe(before);
    const ch = new Channel(access, relay, oldKey);
    expect(active(await ch.members(), "win")).toEqual([oldKey.pk]);
  });
});

async function forgedMessage(id: Identity, from: string, ev: { op: "seat.reclaim"; member: string; from: string; to: string }): Promise<Message> {
  const base = { v: 1 as const, id: crypto.randomUUID(), from, kind: "event" as const, body: "forged", ts: Date.now(), ev };
  const signed = await sign(id, base);
  return { ...signed, seq: 99, rts: base.ts, sigOk: await verify(signed) };
}
