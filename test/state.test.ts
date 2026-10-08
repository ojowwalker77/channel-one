import { describe, expect, test } from "bun:test";
import { canonical, generateIdentity, sign, verify, type Identity } from "../src/identity.ts";
import type { Event, Kind, Message } from "../src/protocol.ts";
import { fold, overlaps, parseTaskId } from "../src/state.ts";

let seq = 0;
const T0 = 1_700_000_000_000;

async function msg(id: Identity | null, from: string, init: { kind?: Kind; ev?: Event; to?: string[]; re?: number[]; body?: string; at?: number } = {}): Promise<Message> {
  seq++;
  const at = init.at ?? T0 + seq * 1000;
  const base = {
    v: 1 as const,
    id: crypto.randomUUID(),
    from,
    kind: init.kind ?? (init.ev ? "event" : "msg"),
    body: init.body ?? "",
    ts: at,
    ...(init.to ? { to: init.to } : {}),
    ...(init.re ? { re: init.re } : {}),
    ...(init.ev ? { ev: init.ev } : {}),
  };
  const p = id ? await sign(id, base) : base;
  return { ...p, seq, rts: at, sigOk: await verify(p) };
}

describe("identity", () => {
  test("canonical JSON ignores key order and undefined", () => {
    expect(canonical({ b: 1, a: [{ y: 2, x: undefined, w: "s" }] })).toBe('{"a":[{"w":"s","y":2}],"b":1}');
  });

  test("signatures verify, and break on any change", async () => {
    const id = await generateIdentity("mac");
    const signed = await sign(id, { from: "mac", body: "hi", n: 1 });
    expect(await verify(signed)).toBe(true);
    expect(await verify({ ...signed, body: "hi!" })).toBe(false);
    const other = await generateIdentity("mac");
    expect(await verify({ ...signed, pk: other.pk })).toBe(false);
  });
});

describe("fold", () => {
  test("first signed key owns a name; later impostors are forged and ignored", async () => {
    const mac = await generateIdentity("mac");
    const evil = await generateIdentity("mac");
    const ms = [
      await msg(mac, "mac", { ev: { op: "hello", role: "capture" } }),
      await msg(evil, "mac", { ev: { op: "fact.set", key: "ip", value: "6.6.6.6" } }),
      await msg(null, "mac", { body: "unsigned, but the name has a key" }),
    ];
    const s = fold(ms);
    expect(s.trust.get(ms[0]!.seq)).toBe("verified");
    expect(s.trust.get(ms[1]!.seq)).toBe("forged");
    expect(s.trust.get(ms[2]!.seq)).toBe("forged");
    expect(s.facts.size).toBe(0);
    expect(s.members.get("mac")?.role).toBe("capture");
  });

  test("task claim race: the earlier claim wins", async () => {
    const a = await generateIdentity("a");
    const b = await generateIdentity("b");
    const add = await msg(a, "a", { ev: { op: "task.add", title: "ship it" } });
    const claimB = await msg(b, "b", { ev: { op: "task.claim", task: add.seq } });
    const claimA = await msg(a, "a", { ev: { op: "task.claim", task: add.seq } });
    const s = fold([add, claimB, claimA]);
    expect(s.tasks.get(add.seq)).toMatchObject({ owner: "b", state: "doing" });
    expect(s.rejected.get(claimA.seq)).toContain("owned by b");
  });

  test("tasks: dependencies, handoff, done", async () => {
    const a = await generateIdentity("a");
    const t1 = await msg(a, "a", { ev: { op: "task.add", title: "protocol" } });
    const t2 = await msg(a, "a", { ev: { op: "task.add", title: "client", after: [t1.seq], owner: "b" } });
    const drop = await msg(a, "a", { ev: { op: "task.update", task: t2.seq, owner: null, note: "free for anyone" } });
    const done = await msg(a, "a", { ev: { op: "task.update", task: t1.seq, state: "done" } });
    const s = fold([t1, t2, drop, done]);
    expect(s.tasks.get(t1.seq)?.state).toBe("done");
    expect(s.tasks.get(t2.seq)).toMatchObject({ owner: undefined, state: "todo", after: [t1.seq] });
    expect(s.tasks.get(t2.seq)?.notes[0]?.text).toBe("free for anyone");
  });

  test("claims: overlapping paths conflict, expire, and release", async () => {
    const a = await generateIdentity("a");
    const b = await generateIdentity("b");
    const ca = await msg(a, "a", { ev: { op: "claim", paths: ["src/net"], ttl: 600 } });
    const cb = await msg(b, "b", { ev: { op: "claim", paths: ["src/net/tcp.rs"], ttl: 600 } });
    const cb2 = await msg(b, "b", { ev: { op: "claim", paths: ["src/ui"], ttl: 600 } });
    let s = fold([ca, cb, cb2], ca.rts! + 1000);
    expect(s.rejected.get(cb.seq)).toBe("src/net is claimed by a");
    expect(s.claims.map((c) => `${c.owner}:${c.path}`).sort()).toEqual(["a:src/net", "b:src/ui"]);
    expect(fold([ca, cb, cb2], ca.rts! + 601_000).claims.map((c) => c.path)).toEqual(["src/ui"]);

    const rel = await msg(a, "a", { ev: { op: "release" } });
    const cb3 = await msg(b, "b", { ev: { op: "claim", paths: ["src/net/tcp.rs"], ttl: 600 } });
    s = fold([ca, cb, cb2, rel, cb3], cb3.rts! + 1000);
    expect(s.rejected.has(cb3.seq)).toBe(false);
    expect(s.claims.find((c) => c.path === "src/net/tcp.rs")?.owner).toBe("b");
  });

  test("open asks close when someone else replies", async () => {
    const a = await generateIdentity("a");
    const b = await generateIdentity("b");
    const q1 = await msg(a, "a", { kind: "ask", to: ["b"], body: "ip?" });
    const q2 = await msg(a, "a", { kind: "blocking", body: "need review" });
    const selfReply = await msg(a, "a", { re: [q2.seq], body: "bump" });
    const ans = await msg(b, "b", { re: [q1.seq], body: "10.0.0.2" });
    const s = fold([q1, q2, selfReply, ans]);
    expect(s.openAsks.map((m) => m.seq)).toEqual([q2.seq]);
  });

  test("helpers", () => {
    expect(parseTaskId("T12")).toBe(12);
    expect(parseTaskId("#7")).toBe(7);
    expect(parseTaskId("x")).toBeNull();
    expect(overlaps("src", "src/a.rs")).toBe(true);
    expect(overlaps("src/a", "src/ab")).toBe(false);
    expect(overlaps("*", "anything")).toBe(true);
  });
});
