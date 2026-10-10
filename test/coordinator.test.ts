// Coordinator-only: people talk only with the coordinator, who relays both ways;
// other agents don't message people (strict: refused; otherwise flagged).

import { beforeAll, describe, expect, test } from "bun:test";
import { wants } from "../src/agent.ts";
import { modeLine } from "../src/format.ts";
import { generateIdentity, sign, verify, type Identity } from "../src/identity.ts";
import type { Event, Kind, Message } from "../src/protocol.ts";
import { fold, type Roster } from "../src/state.ts";

const ids: Record<string, Identity> = {};
let seq = 0;
async function msg(from: string, kind: Kind, body: string, extra: { to?: string[]; ev?: Event } = {}): Promise<Message> {
  seq++;
  const base = { v: 1 as const, id: crypto.randomUUID(), from, kind, body, ...extra, ts: seq };
  const p = await sign(ids[from]!, base);
  return { ...p, seq, rts: seq, sigOk: await verify(p) };
}
const ev = (from: string, e: Event) => msg(from, "event", "", { ev: e });
const on = (strict = true) => ev("jon", { op: "mode.set", coordinatorOnly: true, strict });
const makeCoord = (member: string) => ev("jon", { op: "role.set", member, role: "coordinator" });

let roster: Roster;
beforeAll(async () => {
  for (const n of ["jon", "ana", "coord", "dev", "dev2"]) ids[n] = await generateIdentity(n);
  roster = [
    { name: "jon", pk: ids.jon!.pk, owner: true, at: 0, active: true, kind: "human" },
    { name: "ana", pk: ids.ana!.pk, owner: false, at: 1, active: true, kind: "human" },
    { name: "coord", pk: ids.coord!.pk, owner: false, at: 2, active: true, kind: "agent" },
    { name: "dev", pk: ids.dev!.pk, owner: false, at: 3, active: true, kind: "agent", role: "frontend" },
    { name: "dev2", pk: ids.dev2!.pk, owner: false, at: 4, active: true, kind: "agent" },
  ];
});

describe("coordinator-only in fold", () => {
  test("off by default; only the owner turns it on; strict is off whenever the mode is", async () => {
    const ms = [await ev("dev", { op: "mode.set", coordinatorOnly: true, strict: true }), await ev("jon", { op: "mode.set", coordinatorOnly: false, strict: true })];
    const s = fold(ms, roster);
    expect(s.rejected.get(ms[0]!.seq)).toBe("only the owner sets the channel's mode");
    expect(s.mode).toEqual({ coordinatorOnly: false, strict: false });
    expect(fold([], roster).mode.coordinatorOnly).toBe(false);
  });

  test("one coordinator: giving the role to someone else moves it", async () => {
    const ms = [await makeCoord("coord"), await makeCoord("dev2")];
    const s = fold(ms, roster);
    expect(s.coordinator).toBe("dev2");
    expect(s.members.get("coord")!.role).toBeUndefined();
    expect(fold([ms[0]!], roster).coordinator).toBe("coord");
    // Clearing the holder's role leaves no coordinator.
    expect(fold([ms[0]!, await ev("jon", { op: "role.set", member: "coord", role: null })], roster).coordinator).toBeNull();
  });

  test("two records with the role: who joined first keeps it", () => {
    const r = roster.map((x) => (x.name === "coord" || x.name === "dev2" ? { ...x, role: "Coordinator" } : x));
    const s = fold([], r);
    expect(s.coordinator).toBe("coord");
    expect(s.members.get("dev2")!.role).toBeUndefined();
  });

  test("strict: an agent's message to a person is refused; the coordinator's isn't; agent to agent is fine", async () => {
    const ms = [await makeCoord("coord"), await on(), await msg("dev", "msg", "hi ana", { to: ["ana"] }), await msg("coord", "msg", "hi ana", { to: ["ana"] }), await msg("dev", "msg", "hi coord", { to: ["coord"] }), await msg("dev", "status", "all good")];
    const s = fold(ms, roster);
    expect(ms.slice(2).map((m) => s.trust.get(m.seq))).toEqual(["refused", "verified", "verified", "verified"]);
    expect(s.rejected.get(ms[2]!.seq)).toBe("only the coordinator (coord) messages people here");
  });

  test("not strict: it stands, flagged as sent directly", async () => {
    const ms = [await makeCoord("coord"), await on(false), await msg("dev", "msg", "hi ana", { to: ["ana", "coord"] })];
    const s = fold(ms, roster);
    expect(s.trust.get(ms[2]!.seq)).toBe("verified");
    expect(s.direct.has(ms[2]!.seq)).toBe(true);
  });

  test("no coordinator yet: nothing is refused, and status says so", async () => {
    const ms = [await on(), await msg("dev", "msg", "hi ana", { to: ["ana"] })];
    const s = fold(ms, roster);
    expect(s.trust.get(ms[1]!.seq)).toBe("verified");
    expect(modeLine(s, "dev")).toContain("no coordinator yet");
  });

  test("before the mode was turned on, history stands", async () => {
    const early = await msg("dev", "msg", "hi ana", { to: ["ana"] });
    const ms = [await makeCoord("coord"), early, await on()];
    expect(fold(ms, roster).trust.get(early.seq)).toBe("verified");
  });
});

describe("coordinator-only delivery", () => {
  test("people's words go to the coordinator; other agents get only what's addressed to them", async () => {
    const setup = [await makeCoord("coord"), await on()];
    const broadcast = await msg("ana", "msg", "can someone fix the login?");
    const question = await msg("ana", "ask", "who's on it?");
    const toDev = await msg("ana", "msg", "dev, a quick one", { to: ["dev"] });
    const s = fold([...setup, broadcast, question, toDev], roster);
    for (const m of [broadcast, question, toDev]) expect(wants("coord", m, s)).toBe(true);
    expect(wants("dev", broadcast, s)).toBe(false);
    expect(wants("dev", question, s)).toBe(false);
    expect(wants("dev", toDev, s)).toBe(true);
    // Agents still hear each other, and everyone hears the mode change.
    const agentNote = await msg("coord", "msg", "dev: fix the login", { to: ["dev"] });
    expect(wants("dev", agentNote, fold([...setup, agentNote], roster))).toBe(true);
    expect(wants("dev2", setup[1]!, fold(setup, roster))).toBe(true);
  });

  test("with no coordinator, delivery is as usual", async () => {
    const setup = [await on()];
    const broadcast = await msg("ana", "msg", "can someone fix the login?");
    expect(wants("dev", broadcast, fold([...setup, broadcast], roster))).toBe(true);
  });
});

describe("what each member is told", () => {
  test("status speaks to the coordinator, the agents and the people", async () => {
    const s = fold([await makeCoord("coord"), await on()], roster);
    expect(modeLine(s, "coord")).toContain("you are the coordinator");
    expect(modeLine(s, "dev")).toContain("report to coord, never to a person");
    expect(modeLine(s, "ana")).toContain("you talk with coord");
    expect(modeLine(fold([], roster), "dev")).toBeNull();
  });

  test("the prompt explains coordinator-only", async () => {
    const { agentPrompt } = await import("../src/cli/main.ts");
    expect(agentPrompt("c", "dev")).toContain("## Coordinator-only channels");
  });
});

// ---------- GLM #993 ----------

describe("strict holds however an agent spells its recipients", () => {
  test("a broadcast, *, or a thread reply from another agent never reaches a person", async () => {
    const { keptFromPeople } = await import("../src/state.ts");
    const setup = [await makeCoord("coord"), await on()];
    const ask = await msg("ana", "msg", "status?")
    const broadcast = await msg("dev", "msg", "everyone: shipping now");
    const star = await msg("dev", "msg", "all: shipping", { to: ["*"] });
    const inThread = await msg("dev", "msg", "on it", { re: [ask.seq] } as never);
    const fromCoord = await msg("coord", "msg", "shipping today", { to: ["ana"] });
    const s = fold([...setup, ask, broadcast, star, inThread, fromCoord], roster);
    for (const m of [broadcast, star, inThread]) {
      expect(keptFromPeople(s, m)).toBe(true);
      expect(wants("ana", m, s)).toBe(false);
    }
    // Other agents still hear what's addressed to them.
    expect(wants("dev2", star, s)).toBe(true);
    expect(keptFromPeople(s, fromCoord)).toBe(false);
    expect(wants("ana", fromCoord, s)).toBe(true);
    // Events still reach people.
    expect(keptFromPeople(s, setup[1]!)).toBe(false);
  });

  test("not strict, a person still gets them", async () => {
    const { keptFromPeople } = await import("../src/state.ts");
    const broadcast = await msg("dev", "msg", "everyone: shipping");
    const s = fold([await makeCoord("coord"), await on(false), broadcast], roster);
    expect(keptFromPeople(s, broadcast)).toBe(false);
  });
});

describe("the mode's floor, for a client holding only the log's tail", () => {
  test("the signed setting stands in for a mode.set the tail doesn't hold; a later one wins", async () => {
    const tail = [await msg("dev", "msg", "hi ana", { to: ["ana"] })];
    const r = roster.map((x) => (x.name === "coord" ? { ...x, role: "coordinator" } : x));
    const floor = { coordinatorOnly: true, strict: true, since: tail[0]!.seq - 1 };
    const s = fold(tail, r, Date.now(), floor);
    expect(s.mode).toEqual({ coordinatorOnly: true, strict: true });
    expect(s.trust.get(tail[0]!.seq)).toBe("refused");
    // Without the floor, the same tail reads as normal: that's the gap.
    expect(fold(tail, r).mode.coordinatorOnly).toBe(false);
    // A newer mode.set in the tail still applies on top.
    const off = await ev("jon", { op: "mode.set", coordinatorOnly: false, strict: false });
    expect(fold([...tail, off], r, Date.now(), floor).mode.coordinatorOnly).toBe(false);
    // A floor past the tail's end: the settings are newer than what's loaded.
    expect(fold([], r, Date.now(), { ...floor, since: 10_000 }).mode.coordinatorOnly).toBe(true);
  });
});

describe("at the relay", () => {
  test("the owner signs the mode into the settings; members read it; nobody else can set it", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Channel } = await import("../src/client.ts");
    const { startRelay } = await import("../src/relay/bun.ts");
    const { checked } = await import("./check.ts");
    const dataDir = mkdtempSync(join(tmpdir(), "kiwi-coord-relay-"));
    const server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
    const relay = server.url.origin;
    try {
      const owner = await generateIdentity("human");
      const made = await Channel.create(relay, owner, { name: "human" });
      const ownerCh = new Channel(made.access, relay, owner);
      const admit = async (name: string, role?: string) => {
        const id = await generateIdentity(name);
        const ask = await Channel.requestJoin(relay, made.code, id, { name, role });
        const [req] = await checked(ownerCh, relay, made.code, [{ id, requestId: ask.requestId }]);
        return { id, req: req!, ask };
      };
      // GLM #993 (3): asking to be the coordinator doesn't make you one on a plain confirm.
      const asker = await admit("eager", "coordinator");
      const plain = await ownerCh.approve(asker.req);
      expect(plain.role).toBeUndefined();
      const chosen = await admit("picked", "coordinator");
      expect((await ownerCh.approve(chosen.req, { name: "picked", role: "coordinator" })).role).toBe("coordinator");
      const other = await admit("other", "frontend");
      expect((await ownerCh.approve(other.req)).role).toBe("frontend");

      expect(await ownerCh.mode()).toBeNull();
      await ownerCh.setMode({ coordinatorOnly: true, strict: true, since: 7 });
      const st = await Channel.joinStatus(relay, made.code, other.id, other.ask.requestId);
      const memberCh = new Channel((st as { access: import("../src/crypto.ts").ChannelAccess }).access, relay, other.id);
      expect(await memberCh.mode()).toEqual({ coordinatorOnly: true, strict: true, since: 7 });
      await expect(memberCh.setMode({ coordinatorOnly: false, strict: false, since: 8 })).rejects.toThrow();
    } finally {
      server.stop(true);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
