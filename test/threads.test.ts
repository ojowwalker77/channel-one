// Threads from the reply chain, and what reaches an agent by default: what's for it, not every conversation.

import { beforeAll, describe, expect, test } from "bun:test";
import { wants } from "../src/agent.ts";
import { formatMessage } from "../src/format.ts";
import { generateIdentity, sign, verify, type Identity } from "../src/identity.ts";
import type { Kind, Message } from "../src/protocol.ts";
import { fold, type ChannelState, type Roster } from "../src/state.ts";

const roster: Roster = [];
const ids: Record<string, Identity> = {};
let seq = 0;
async function msg(from: string, body: string, opts: { to?: string[]; re?: number[]; kind?: Kind } = {}): Promise<Message> {
  seq++;
  const base = { v: 1 as const, id: crypto.randomUUID(), from, kind: opts.kind ?? ("msg" as const), body, ts: seq, ...(opts.to ? { to: opts.to } : {}), ...(opts.re ? { re: opts.re } : {}) };
  const p = await sign(ids[from]!, base);
  return { ...p, seq, rts: seq, sigOk: await verify(p) };
}

let ms: Message[];
let state: ChannelState;
const seqOf = (body: string) => ms.find((m) => m.body === body)!.seq;
const inbox = (me: string, d = {}) => ms.filter((m) => wants(me, m, state, d)).map((m) => m.body);

beforeAll(async () => {
  for (const [name, extra] of [["jonatas", { kind: "human" as const, owner: true }], ["coord", {}], ["mac", { role: "backend" }], ["win", { role: "frontend" }], ["grok", {}]] as const) {
    ids[name] = await generateIdentity(name);
    roster.push({ name, pk: ids[name]!.pk, owner: false, at: 0, active: true, ...extra });
  }
  ms = [];
  ms.push(await msg("jonatas", "people's broadcast"));
  ms.push(await msg("coord", "agent chatter, no --to"));
  ms.push(await msg("coord", "everyone must see this", { to: ["*"] }));
  ms.push(await msg("coord", "mac, take T5", { to: ["mac"] }));
  ms.push(await msg("win", "a question for anyone", { kind: "ask" }));
  ms.push(await msg("coord", "win and grok, sync up", { to: ["win", "grok"] }));
  ms.push(await msg("win", "grok: I'll take the panel", { re: [seqOf("win and grok, sync up")], to: ["grok"] }));
  ms.push(await msg("mac", "jumping into their thread", { re: [seqOf("grok: I'll take the panel")], to: ["win"] }));
  ms.push(await msg("grok", "ok, the rest is mine", { re: [seqOf("grok: I'll take the panel")] }));
  ms.push(await msg("coord", "to the backend role", { to: ["role:backend"] }));
  state = fold(ms, roster);
});

describe("threads", () => {
  test("every reply belongs to the thread at the top of its chain", () => {
    const root = seqOf("win and grok, sync up");
    for (const b of ["grok: I'll take the panel", "jumping into their thread", "ok, the rest is mine"]) expect(state.threadOf.get(seqOf(b))).toBe(root);
    expect(state.threadOf.get(seqOf("people's broadcast"))).toBe(seqOf("people's broadcast"));
    expect([...state.threadPeople.get(root)!].sort()).toEqual(["coord", "grok", "mac", "win"]);
  });

  test("--thread N gives one thread, named by its root or any reply", () => {
    const expected = ["win and grok, sync up", "grok: I'll take the panel", "jumping into their thread", "ok, the rest is mine"];
    expect(inbox("jonatas", { thread: seqOf("win and grok, sync up") })).toEqual(expected);
    expect(inbox("jonatas", { thread: seqOf("ok, the rest is mine") })).toEqual(expected);
  });
});

describe("what reaches an agent by default", () => {
  test("what's for it: to it or its role, to everyone, people's broadcasts, questions, and its threads", () => {
    expect(inbox("mac")).toEqual([
      "people's broadcast",
      "everyone must see this",
      "mac, take T5",
      "a question for anyone",
      // mac wrote in this thread, so all of it reaches mac, from the start.
      "win and grok, sync up",
      "grok: I'll take the panel",
      "ok, the rest is mine",
      "to the backend role",
    ]);
  });

  test("another agents' conversation stays out until it's in it", () => {
    expect(inbox("coord")).not.toContain("mac, take T5");
    expect(inbox("grok")).not.toContain("mac, take T5");
    expect(inbox("grok")).not.toContain("agent chatter, no --to");
  });

  test("--chat is every conversation; --for-me only what's addressed", () => {
    expect(inbox("grok", { chat: true })).toContain("agent chatter, no --to");
    expect(inbox("grok", { chat: true })).toContain("mac, take T5");
    expect(inbox("mac", { forMe: true })).toEqual(["everyone must see this", "mac, take T5", "a question for anyone", "to the backend role"]);
  });

  test("--to all reads as 'everyone'", () => {
    expect(formatMessage(ms.find((m) => m.body === "everyone must see this")!)).toContain("coord → everyone:");
    expect(formatMessage(ms.find((m) => m.body === "agent chatter, no --to")!)).toContain("coord → all:");
  });
});
