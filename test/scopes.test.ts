// Member scopes: what each member may do besides read. Every client enforces
// them in fold; the relay enforces the one bit it knows ("can post").

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, RelayError } from "../src/client.ts";
import type { ChannelAccess } from "../src/crypto.ts";
import { generateIdentity, sign, verify, type Identity } from "../src/identity.ts";
import type { JoinRequest } from "../src/membership.ts";
import { ignored, type Event, type Kind, type Message } from "../src/protocol.ts";
import { startRelay } from "../src/relay/bun.ts";
import { parseScopes, readScopes, refusal, wireScopes, type Scope } from "../src/scopes.ts";
import { fold, type Roster } from "../src/state.ts";
import { checked, memoryBudget } from "./check.ts";

setDefaultTimeout(60_000);

// ---------- fold ----------

const ids: Record<string, Identity> = {};
let seq = 0;
async function msg(from: string, kind: Kind, body: string, ev?: Event, key = ids[from]!): Promise<Message> {
  seq++;
  const base = { v: 1 as const, id: crypto.randomUUID(), from, kind, body, ...(ev ? { ev } : {}), ts: seq };
  const p = await sign(key, base);
  return { ...p, seq, rts: seq, sigOk: await verify(p) };
}
const ev = (from: string, e: Event, key?: Identity) => msg(from, "event", "", e, key);
const set = (member: string, scopes: Scope[] | null, pk = ids[member]!.pk) => ev("jon", { op: "scope.set", member, pk, scopes });

let roster: Roster;
beforeAll(async () => {
  for (const n of ["jon", "chat", "ro", "full"]) ids[n] = await generateIdentity(n);
  roster = [
    { name: "jon", pk: ids.jon!.pk, owner: true, at: 0, active: true, kind: "human" },
    // May only talk: no questions, tasks, claims or facts.
    { name: "chat", pk: ids.chat!.pk, owner: false, at: 1, active: true, scopes: ["post"] },
    { name: "ro", pk: ids.ro!.pk, owner: false, at: 2, active: true, scopes: [] },
    // No scopes in the record: everything, as before scopes existed.
    { name: "full", pk: ids.full!.pk, owner: false, at: 3, active: true },
  ];
});

describe("scopes in fold", () => {
  test("each scope covers its kind of message; a refused one counts for nothing", async () => {
    const ms = [
      await msg("chat", "msg", "hello"),
      await msg("chat", "ask", "can I?"),
      await msg("chat", "blocking", "stuck"),
      await ev("chat", { op: "task.add", title: "sneak a task in" }),
      await ev("chat", { op: "claim", paths: ["src"], ttl: 600 }),
      await ev("chat", { op: "fact.set", key: "k", value: "v" }),
      // Letting go never needs a scope; announcing yourself needs any.
      await ev("chat", { op: "release", paths: ["src"] }),
      await ev("chat", { op: "hello", host: "h", dir: "d" } as Event),
    ];
    const s = fold(ms, roster);
    expect(ms.map((m) => s.trust.get(m.seq))).toEqual(["verified", "refused", "refused", "refused", "refused", "refused", "verified", "verified"]);
    expect(s.rejected.get(ms[1]!.seq)).toBe("chat may not ask questions and say they're blocked");
    expect(s.rejected.get(ms[3]!.seq)).toBe("chat may not add, claim and update tasks");
    expect(s.tasks.size).toBe(0);
    expect(s.claims).toEqual([]);
    expect(s.facts.size).toBe(0);
    expect(ignored(s.trust.get(ms[1]!.seq))).toBe(true);
  });

  test("read-only may not even say hello; full and the owner may do everything", async () => {
    const ms = [
      await msg("ro", "msg", "let me in"),
      await ev("ro", { op: "color.set", member: "ro", color: "teal" }),
      await ev("full", { op: "task.add", title: "a real task" }),
      await ev("full", { op: "claim", paths: ["web"], ttl: 600 }),
      await msg("jon", "ask", "status?"),
    ];
    const s = fold(ms, roster);
    expect(ms.map((m) => s.trust.get(m.seq))).toEqual(["refused", "refused", "verified", "verified", "verified"]);
    expect(s.rejected.get(ms[0]!.seq)).toBe("ro may not write messages");
    expect(s.rejected.get(ms[1]!.seq)).toBe("ro can only read");
    expect(s.members.get("ro")!.scopes).toEqual([]);
    expect(s.members.get("full")!.scopes).toEqual(["post", "ask", "tasks", "claims", "facts"]);
    expect(s.members.get("jon")!.scopes).toEqual(["post", "ask", "tasks", "claims", "facts"]);
  });

  test("scope.set is the owner's, applies from where it lands, and history before it stands", async () => {
    const ms = [
      await ev("chat", { op: "scope.set", member: "chat", pk: ids.chat!.pk, scopes: null }),
      await ev("chat", { op: "task.add", title: "before" }),
      await set("chat", ["post", "tasks"]),
      await ev("chat", { op: "task.add", title: "after" }),
      await set("full", ["post"]),
      await ev("full", { op: "task.add", title: "too late" }),
    ];
    const s = fold(ms, roster);
    expect(s.rejected.get(ms[0]!.seq)).toBe("only the owner sets what members may do");
    expect(s.trust.get(ms[1]!.seq)).toBe("refused");
    expect(s.trust.get(ms[3]!.seq)).toBe("verified");
    expect(s.trust.get(ms[5]!.seq)).toBe("refused");
    expect([...s.tasks.values()].map((t) => t.title)).toEqual(["after"]);
    expect(s.members.get("chat")!.scopes).toEqual(["post", "tasks"]);
  });

  test("the owner's own scopes can't be set, nor a key that isn't the member's", async () => {
    const ms = [await set("jon", []), await set("chat", [], ids.ro!.pk), await set("nobody", [], ids.ro!.pk)];
    const s = fold(ms, roster);
    expect(s.rejected.get(ms[0]!.seq)).toBe("the owner may do everything");
    expect(s.rejected.get(ms[1]!.seq)).toBe("that key isn't chat's");
    expect(s.rejected.get(ms[2]!.seq)).toBe("no member named nobody");
    expect(s.members.get("chat")!.scopes).toEqual(["post"]);
  });

  test("losing claims lets go of the ones held; tasks stay theirs", async () => {
    const ms = [await ev("full", { op: "task.add", title: "mine", owner: "full" }), await ev("full", { op: "claim", paths: ["src/a"], ttl: 600 }), await set("full", ["post", "tasks"])];
    const s = fold(ms, roster);
    expect(s.claims).toEqual([]);
    expect([...s.tasks.values()].map((t) => t.owner)).toEqual(["full"]);
  });

  test("scopes belong to a key: a name admitted again starts from its own record, old history by the old key's", async () => {
    const oldKey = await generateIdentity("win");
    const newKey = await generateIdentity("win");
    const r: Roster = [
      ...roster,
      { name: "win", pk: oldKey.pk, owner: false, at: 4, active: false, scopes: ["post"] },
      { name: "win", pk: newKey.pk, owner: false, at: 5, active: true },
    ];
    const ms = [
      await ev("win", { op: "task.add", title: "old key, no tasks scope" }, oldKey),
      // The owner narrows the old key: it never reaches the new one.
      await ev("jon", { op: "scope.set", member: "win", pk: oldKey.pk, scopes: [] }),
      await ev("win", { op: "task.add", title: "new key, full" }, newKey),
      await msg("win", "msg", "old key again", undefined, oldKey),
    ];
    const s = fold(ms, r);
    expect(ms.map((m) => s.trust.get(m.seq))).toEqual(["refused", "verified", "verified", "refused"]);
    expect(s.members.get("win")!.scopes).toEqual(["post", "ask", "tasks", "claims", "facts"]);
  });

  test("garbled or unknown scopes give no more than they can be read as", () => {
    expect(readScopes(["post", "admin", "facts"])).toEqual(["post", "facts"]);
    expect(readScopes("post")).toBeNull();
    expect(readScopes(Array(40).fill("post"))).toBeNull();
    expect(wireScopes(["post", "ask", "tasks", "claims", "facts"])).toBeNull();
    expect(wireScopes([])).toEqual([]);
    expect(parseScopes("read-only")).toEqual([]);
    expect(parseScopes("post, claims")).toEqual(["post", "claims"]);
    expect(parseScopes("post,root")).toBeNull();
    expect(refusal([], { kind: "event", ev: { op: "release", paths: ["x"] } })).toBeNull();
  });

  test("the record's later scopes are the floor for a client holding only the log's tail", async () => {
    // The tail: the scope.set (narrowing chat to read-only at seq 5) isn't in it; the record says so.
    const before = await msg("chat", "msg", "said while allowed")
    seq++ // the scope.set's position, missing from this tail
    const after = await msg("chat", "msg", "said after being narrowed")
    const r = roster.map((x) => (x.name === "chat" ? { ...x, later: { scopes: [] as Scope[], since: before.seq + 1 } } : x))
    const s = fold([before, after], r)
    expect(s.trust.get(before.seq)).toBe("verified")
    expect(s.trust.get(after.seq)).toBe("refused")
    expect(s.members.get("chat")!.scopes).toEqual([])
  })

  test("with the whole log, the record and the scope.set agree; a later scope.set still wins", async () => {
    const narrow = await set("chat", [])
    const quiet = await msg("chat", "msg", "refused")
    const widen = await set("chat", ["post"])
    const back = await msg("chat", "msg", "allowed again")
    // The record only knows the first change (its update after the second one failed).
    const r = roster.map((x) => (x.name === "chat" ? { ...x, later: { scopes: [] as Scope[], since: narrow.seq } } : x))
    const s = fold([narrow, quiet, widen, back], r)
    expect([quiet, back].map((m) => s.trust.get(m.seq))).toEqual(["refused", "verified"])
    expect(s.scopeSets.get(ids.chat!.pk)).toEqual({ seq: widen.seq, scopes: ["post"] })
    // A tail that ends before the floor's position still takes it: the record is newer than the tail.
    expect(fold([], r).members.get("chat")!.scopes).toEqual([])
  })

  test("a scope.set with names this version doesn't know grants only the ones it does", async () => {
    const ms = [await ev("jon", { op: "scope.set", member: "ro", pk: ids.ro!.pk, scopes: ["post", "superpowers"] }), await msg("ro", "msg", "now I can talk")];
    const s = fold(ms, roster);
    expect(s.members.get("ro")!.scopes).toEqual(["post"]);
    expect(s.trust.get(ms[1]!.seq)).toBe("verified");
  });
});

// ---------- the relay and the client ----------

const dataDir = mkdtempSync(join(tmpdir(), "kiwi-scopes-relay-"));
let server: ReturnType<typeof startRelay>;
let relay: string;
let owner: Identity;
let ownerCh: Channel;
let code: string;

async function admit(name: string, scopes?: Scope[]): Promise<{ id: Identity; ch: Channel }> {
  const id = await generateIdentity(name);
  const ask = await Channel.requestJoin(relay, code, id, { name });
  const [req] = await checked(ownerCh, relay, code, [{ id, requestId: ask.requestId }]);
  await ownerCh.approve(req!, scopes ? { name, scopes } : undefined);
  const st = await Channel.joinStatus(relay, code, id, ask.requestId);
  return { id, ch: new Channel((st as { access: ChannelAccess }).access, relay, id) };
}

describe("scopes at the relay", () => {
  beforeAll(async () => {
    server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
    relay = server.url.origin;
    owner = await generateIdentity("human");
    const made = await Channel.create(relay, owner, { name: "human" });
    code = made.code;
    ownerCh = new Channel(made.access, relay, owner);
  });
  afterAll(() => {
    server.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("approved read-only: the record says so, and the relay refuses their posts (ReadOnly)", async () => {
    const { id, ch } = await admit("watcher", []);
    expect((await ownerCh.members()).find((m) => m.pk === id.pk)!.scopes).toEqual([]);
    const err = await ch.send("hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).status).toBe(403);
    expect((err as RelayError).tag).toBe("ReadOnly");
    // Reading still works.
    expect((await ch.history(0)).messages.length).toBeGreaterThanOrEqual(0);
  });

  test("only the owner flips the bit, never for the owner, and it takes effect at once", async () => {
    const { id, ch } = await admit("later", []);
    const other = await admit("other");
    await expect(other.ch.setCanPost(id.pk, true)).rejects.toThrow();
    await expect(ownerCh.setCanPost(owner.pk, false)).rejects.toThrow(/owner may always post/);
    await ownerCh.setCanPost(id.pk, true);
    expect(await ch.send("now I can")).toBeGreaterThan(0);
    await ownerCh.setCanPost(id.pk, false);
    await expect(ch.send("and now I can't")).rejects.toThrow(/only read/);
  });

  test("a member with some scopes posts; a full member's record carries none", async () => {
    const some = await admit("talker", ["post"]);
    const full = await admit("doer");
    expect(await some.ch.send("hello")).toBeGreaterThan(0);
    const members = await ownerCh.members();
    expect(members.find((m) => m.name === "talker")!.scopes).toEqual(["post"]);
    expect(members.find((m) => m.name === "doer")!.scopes).toBeUndefined();
    expect(full.id.pk).toBeTruthy();
  });

  test("an agent the owner creates the channel with, read-only, can't post from the first message", async () => {
    const agent = await generateIdentity("quiet");
    const made = await Channel.create(relay, owner, { name: "human" }, [{ ...agent, info: { name: "quiet", scopes: [] } }]);
    const ch = new Channel(await Channel.resume(relay, made.code, agent), relay, agent);
    await expect(ch.send("first")).rejects.toThrow(/only read/);
    // The owner may always post, whatever the create body said.
    expect(await new Channel(made.access, relay, owner).send("owner here")).toBeGreaterThan(0);
  });

  test("the owner's client puts the relay's bit right when it disagrees with the log", async () => {
    const { id, ch } = await admit("drift");
    const roster = async () => (await ownerCh.members()).map((m) => ({ name: m.name, pk: m.pk, owner: m.owner, at: m.at, active: m.active, kind: m.kind, ...(m.scopes ? { scopes: m.scopes } : {}) }));
    const folded = async () => fold((await ownerCh.history(0)).messages, await roster());
    // A scope.set whose second step (the bit) never happened: the relay still stores their posts.
    await ownerCh.send("drift may only read", { ev: { op: "scope.set", member: "drift", pk: id.pk, scopes: [] } });
    const stored = await ch.send("still stored");
    expect((await folded()).trust.get(stored)).toBe("refused");
    expect(await ownerCh.reconcilePosting(await folded())).toEqual([id.pk]);
    await expect(ch.send("not any more")).rejects.toThrow(/only read/);
    // Already right: nothing to change.
    expect(await ownerCh.reconcilePosting(await folded())).toEqual([]);
    // And the other way: a bit turned off by mistake comes back on for a member who may post.
    await ownerCh.send("drift may talk again", { ev: { op: "scope.set", member: "drift", pk: id.pk, scopes: null } });
    expect(await ownerCh.reconcilePosting(await folded())).toEqual([id.pk]);
    expect(await ch.send("back")).toBeGreaterThan(0);
    expect((await ownerCh.members()).find((m) => m.pk === id.pk)!.readOnly).toBeUndefined();
  });

  test("a scope change re-signs the record; reconcile writes it when only the event landed", async () => {
    const { id, ch } = await admit("recorded")
    const roster = async () => (await ownerCh.members()).map((m) => ({ name: m.name, pk: m.pk, owner: m.owner, at: m.at, active: m.active, kind: m.kind, ...(m.scopes ? { scopes: m.scopes } : {}), ...(m.later ? { later: m.later } : {}) }))
    const folded = async () => fold((await ownerCh.history(0)).messages, await roster())
    const ev1 = await ownerCh.send("recorded may only talk", { ev: { op: "scope.set", member: "recorded", pk: id.pk, scopes: ["post"] } })
    const rec = (await ownerCh.members()).find((m) => m.pk === id.pk)!
    await ownerCh.updateScopes(rec, ["post"], ev1)
    expect((await ch.members()).find((m) => m.pk === id.pk)!.later).toEqual({ scopes: ["post"], since: ev1 })
    // Only the event, not the record: reconcile re-signs the record, and the bit follows.
    const ev2 = await ownerCh.send("recorded may only read", { ev: { op: "scope.set", member: "recorded", pk: id.pk, scopes: [] } })
    expect(await ownerCh.reconcilePosting(await folded())).toEqual([id.pk])
    const now = (await ownerCh.members()).find((m) => m.pk === id.pk)!
    expect(now.later).toEqual({ scopes: [], since: ev2 })
    expect(now.readOnly).toBe(true)
    await expect(ch.send("hi")).rejects.toThrow(/only read/)
    expect(await ownerCh.reconcilePosting(await folded())).toEqual([])
  })

  test("the newest record seen for a key wins over an older one the relay serves", async () => {
    const { id } = await admit("pinned")
    const served = (await ownerCh.members()).find((m) => m.pk === id.pk)!
    const newer = { ...served, at: served.at + 1000, later: { scopes: [] as Scope[], since: 1 } }
    const kept = new Map<string, import("../src/membership.ts").Member>([[`${ownerCh.roomId}/${id.pk}`, newer]])
    const { keepRecordsIn } = await import("../src/client.ts")
    keepRecordsIn({ get: (room, pk) => kept.get(`${room}/${pk}`) ?? null, set: (room, pk, m) => void kept.set(`${room}/${pk}`, m) })
    try {
      expect((await ownerCh.members()).find((m) => m.pk === id.pk)!.later).toEqual({ scopes: [], since: 1 })
    } finally {
      const fresh = new Map<string, import("../src/membership.ts").Member>()
      keepRecordsIn({ get: (room, pk) => fresh.get(`${room}/${pk}`) ?? null, set: (room, pk, m) => void fresh.set(`${room}/${pk}`, m) })
    }
  })

  test("a reclaimed seat keeps what the seat may do now", async () => {
    const { id: oldKey, ch: oldCh } = await admit("seat", ["post", "claims"]);
    await oldCh.send("here");
    const newKey = await generateIdentity("seat");
    const { requestId } = await Channel.requestJoin(relay, code, newKey, { name: "seat", reclaim: true });
    const first = (await ownerCh.requests({ budget: memoryBudget() })).find((r) => r.id === requestId)!;
    await ownerCh.checkRequest(first);
    await Channel.joinStatus(relay, code, newKey, requestId);
    const req = (await ownerCh.requests()).find((r) => r.id === requestId) as JoinRequest;
    // The owner narrowed the seat since its record was signed: the fold's word is what moves.
    await ownerCh.reclaim(req, { online: false, force: true, scopes: ["post"] });
    const members = await ownerCh.members();
    expect(members.find((m) => m.pk === newKey.pk)).toMatchObject({ name: "seat", active: true, scopes: ["post"] });
    expect(members.find((m) => m.pk === oldKey.pk)!.active).toBe(false);
  });
});

// ---------- what the agent is told ----------

describe("the agent's prompt", () => {
  test("says what it may do when that's less than everything, and nothing when it's everything", async () => {
    const { agentPrompt } = await import("../src/cli/main.ts");
    expect(agentPrompt("c", "bot", { scopes: ["post", "ask", "tasks", "claims", "facts"] })).not.toContain("What you may do here");
    expect(agentPrompt("c", "bot")).not.toContain("What you may do here");
    const some = agentPrompt("c", "bot", { scopes: ["post", "claims"] });
    expect(some).toContain("## What you may do here");
    expect(some).toContain("write messages; claim paths");
    const none = agentPrompt("c", "bot", { scopes: [] });
    expect(none).toContain("lets you only read this channel");
  });
});
