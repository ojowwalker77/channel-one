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
