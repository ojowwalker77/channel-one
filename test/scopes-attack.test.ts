// Attack tests for member scopes (T615). The feature is Claude-1's; these only check the record
// on origin/scopes @ e02d1ba: a member cannot exceed, grant, or keep what the owner took away,
// and a relay that flips the can-post bit cannot make an honest client accept the message.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signRequest } from "../src/auth.ts";
import { Channel, RelayError } from "../src/client.ts";
import { newChannelKey } from "../src/crypto.ts";
import { generateIdentity, sign, verify, type Identity } from "../src/identity.ts";
import { makeRecord, openRecord, sealRecord } from "../src/membership.ts";
import { ignored, type Event, type Kind, type Message } from "../src/protocol.ts";
import { startRelay } from "../src/relay/bun.ts";
import type { Scope } from "../src/scopes.ts";
import { fold, type Roster } from "../src/state.ts";

const T0 = 1_700_000_000_000;
let seq = 0;

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

function people(owner: Identity, mac: Identity, scopes?: Scope[]): Roster {
  return [
    { name: "human", pk: owner.pk, owner: true, at: 0, active: true },
    { name: "mac", pk: mac.pk, owner: false, at: 1, active: true, ...(scopes ? { scopes } : {}) },
  ];
}

describe("a member cannot do more than the owner signed", () => {
  test("post does not include asks, tasks, claims or facts, and read-only includes nothing but release", async () => {
    const owner = await generateIdentity("human");
    const mac = await generateIdentity("mac");
    const chat = await msg(mac, "mac", { body: "hello" });
    const ask = await msg(mac, "mac", { kind: "ask", body: "can I?" });
    const fact = await msg(mac, "mac", { ev: { op: "fact.set", key: "ip", value: "1.2.3.4" } });
    const claim = await msg(mac, "mac", { ev: { op: "claim", paths: ["src/a"], ttl: 600 } });
    const task = await msg(mac, "mac", { ev: { op: "task.add", title: "ship it" } });
    const release = await msg(mac, "mac", { ev: { op: "release" } });
    const s = fold([chat, ask, fact, claim, task, release], people(owner, mac, ["post"]));
    expect(s.trust.get(chat.seq)).toBe("verified");
    expect(s.trust.get(release.seq)).toBe("verified");
    for (const m of [ask, fact, claim, task]) {
      expect(s.trust.get(m.seq)).toBe("refused");
      expect(ignored(s.trust.get(m.seq))).toBe(true);
    }
    expect(s.facts.size).toBe(0);
    expect(s.claims).toEqual([]);
    expect(s.tasks.size).toBe(0);
    expect(s.members.get("mac")?.messages).toBe(2);

    const quiet = await msg(mac, "mac", { body: "still here" });
    const hello = await msg(mac, "mac", { ev: { op: "hello", role: "capture" } });
    const letGo = await msg(mac, "mac", { ev: { op: "release" } });
    const none = fold([quiet, hello, letGo], people(owner, mac, []));
    expect(none.trust.get(quiet.seq)).toBe("refused");
    expect(none.trust.get(hello.seq)).toBe("refused");
    expect(none.rejected.get(hello.seq)).toContain("can only read");
    expect(none.trust.get(letGo.seq)).toBe("verified");
    expect(none.members.get("mac")?.scopes).toEqual([]);
  });

  test("a member cannot grant itself, and a forged owner signature does not either", async () => {
    const owner = await generateIdentity("human");
    const mac = await generateIdentity("mac");
    const grant = await msg(mac, "mac", { ev: { op: "scope.set", member: "mac", pk: mac.pk, scopes: null } });
    const fact = await msg(mac, "mac", { ev: { op: "fact.set", key: "ip", value: "9.9.9.9" } });
    const forged = await msg(mac, "human", { ev: { op: "scope.set", member: "mac", pk: mac.pk, scopes: null } });
    const s = fold([grant, fact, forged], people(owner, mac, ["post"]));
    expect(s.rejected.get(grant.seq)).toContain("only the owner");
    expect(s.trust.get(fact.seq)).toBe("refused");
    expect(s.trust.get(forged.seq)).toBe("forged");
    expect(s.facts.size).toBe(0);
    expect(s.members.get("mac")?.scopes).toEqual(["post"]);
  });

  test("a downgrade applies from that event on, and only to that key", async () => {
    const owner = await generateIdentity("human");
    const mac = await generateIdentity("mac");
    const again = await generateIdentity("mac");
    const before = await msg(mac, "mac", { body: "while I could" });
    const held = await msg(mac, "mac", { ev: { op: "claim", paths: ["src/a"], ttl: 600 } });
    const down = await msg(owner, "human", { ev: { op: "scope.set", member: "mac", pk: mac.pk, scopes: ["post"] } });
    const still = await msg(mac, "mac", { body: "chat remains" });
    const againClaim = await msg(mac, "mac", { ev: { op: "claim", paths: ["src/b"], ttl: 600 } });
    const narrowed = await msg(owner, "human", { ev: { op: "scope.set", member: "mac", pk: mac.pk, scopes: [] } });
    const after = await msg(mac, "mac", { body: "too late" });
    const roster: Roster = [
      { name: "human", pk: owner.pk, owner: true, at: 0, active: true },
      { name: "mac", pk: mac.pk, owner: false, at: 1, active: false },
      { name: "mac", pk: again.pk, owner: false, at: 2, active: true },
    ];
    const fromNew = await msg(again, "mac", { body: "new key, own record" });
    const s = fold([before, held, down, still, againClaim, narrowed, after, fromNew], roster, after.rts! + 1000);
    expect(s.trust.get(before.seq)).toBe("verified");
    expect(s.trust.get(still.seq)).toBe("verified");
    expect(s.trust.get(againClaim.seq)).toBe("refused");
    expect(s.trust.get(after.seq)).toBe("refused");
    expect(s.trust.get(fromNew.seq)).toBe("verified");
    expect(s.claims).toEqual([]);
    expect(s.members.get("mac")?.pk).toBe(again.pk);
    expect(s.members.get("mac")?.scopes).toEqual(["post", "ask", "tasks", "claims", "facts"]);
  });

  test("unknown scope names grant nothing, and a garbled value grants nothing", async () => {
    const owner = await generateIdentity("human");
    const mac = await generateIdentity("mac");
    const weird = await msg(owner, "human", { ev: { op: "scope.set", member: "mac", pk: mac.pk, scopes: ["post", "root"] } });
    const chat = await msg(mac, "mac", { body: "ok" });
    const fact = await msg(mac, "mac", { ev: { op: "fact.set", key: "ip", value: "0" } });
    const garbled = await msg(owner, "human", { ev: { op: "scope.set", member: "mac", pk: mac.pk, scopes: "nope" as unknown as null } });
    const after = await msg(mac, "mac", { body: "no" });
    const s = fold([weird, chat, fact, garbled, after], people(owner, mac));
    expect(s.trust.get(chat.seq)).toBe("verified");
    expect(s.trust.get(fact.seq)).toBe("refused");
    expect(s.trust.get(after.seq)).toBe("refused");
    expect(s.members.get("mac")?.scopes).toEqual([]);
  });

  test("a record whose scopes cannot be read is read-only, and the owner's record cannot be narrowed", async () => {
    const owner = await generateIdentity("human");
    const mac = await generateIdentity("mac");
    const key = newChannelKey();
    const room = "ab".repeat(16);
    const bad = await sign(owner, { room, member: mac.pk, mxpk: mac.xpk!, name: "mac", scopes: { all: true }, at: 1 });
    const opened = await openRecord(key, await sealRecord(key, bad), room, owner.pk, mac.pk);
    expect(opened?.scopes).toEqual([]);
    const ownerRec = await makeRecord(owner, room, { name: "human", pk: owner.pk, xpk: owner.xpk!, owner: true, scopes: [] });
    expect(ownerRec).not.toHaveProperty("scopes");
  });
});

describe("the relay's can-post bit is not the record", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kiwi-scopes-"));
  const server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
  const relay = server.url.origin;
  afterAll(() => {
    server.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function stateOf(ch: Channel) {
    const { messages } = await ch.history(0);
    const members = (await ch.members()).filter((m) => !m.unverified);
    const roster: Roster = members.map((m) => ({
      name: m.name,
      pk: m.pk,
      owner: m.owner,
      at: m.at,
      active: m.active,
      ...(m.scopes ? { scopes: m.scopes } : {}),
    }));
    return { messages, state: fold(messages, roster) };
  }

  test("turning the bit on does not make a read-only key's message count", async () => {
    const owner = await generateIdentity("human");
    const mac = await generateIdentity("mac");
    const made = await Channel.create(relay, owner, { name: "human" }, [{ ...mac, info: { name: "mac", scopes: [] } }]);
    const ownerCh = new Channel(made.access, relay, owner);
    const macCh = new Channel(made.access, relay, mac);
    try {
      await macCh.send("smuggled");
    } catch (err) {
      expect(err).toBeInstanceOf(RelayError);
      expect(err).toMatchObject({ status: 403, tag: "ReadOnly" });
      await ownerCh.setCanPost(mac.pk, true);
      await macCh.send("smuggled");
    }
    const { messages, state } = await stateOf(ownerCh);
    const smuggled = messages.find((m) => m.body === "smuggled");
    expect(smuggled).toBeDefined();
    expect(state.trust.get(smuggled!.seq)).toBe("refused");
    expect(ignored(state.trust.get(smuggled!.seq))).toBe(true);

    await ownerCh.setCanPost(mac.pk, false);
    await expect(macCh.send("again")).rejects.toMatchObject({ status: 403, tag: "ReadOnly" });

    const body = JSON.stringify({ post: true });
    const path = `/members/${mac.pk}/post`;
    const token = await signRequest(mac, ownerCh.roomId, "PUT", path, body);
    const res = await fetch(new URL(`/v1/rooms/${ownerCh.roomId}${path}`, relay), {
      method: "PUT",
      body,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
  });

  test("a downgrade mid-session refuses what was allowed before, once the event is in the log", async () => {
    const owner = await generateIdentity("human");
    const mac = await generateIdentity("mac");
    const made = await Channel.create(relay, owner, { name: "human" }, [{ ...mac, info: { name: "mac" } }]);
    const ownerCh = new Channel(made.access, relay, owner);
    const macCh = new Channel(made.access, relay, mac);
    await macCh.send("before");
    await macCh.send("", { ev: { op: "claim", paths: ["src/a"], ttl: 600 } });
    await ownerCh.send("", { ev: { op: "scope.set", member: "mac", pk: mac.pk, scopes: ["post"] } });
    await macCh.send("still chatting");
    await macCh.send("", { ev: { op: "claim", paths: ["src/b"], ttl: 600 } });
    const { messages, state } = await stateOf(ownerCh);
    const seqOf = (body: string) => messages.find((m) => m.body === body)!.seq;
    expect(state.trust.get(seqOf("before"))).toBe("verified");
    expect(state.trust.get(seqOf("still chatting"))).toBe("verified");
    const secondClaim = messages.find((m) => m.ev?.op === "claim" && m.ev.paths[0] === "src/b");
    expect(state.trust.get(secondClaim!.seq)).toBe("refused");
    expect(state.claims).toEqual([]);

    await ownerCh.setCanPost(mac.pk, false);
    await expect(macCh.send("stored anyway")).rejects.toMatchObject({ status: 403, tag: "ReadOnly" });
  });
});
