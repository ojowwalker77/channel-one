// T323: a claim records the checkout, file#Symbol shares a file, and facts can expire.

import { describe, expect, test } from "bun:test";
import { formatClaims, formatFact, parseDuration } from "../src/format.ts";
import { wellFormedEvent, type Event, type Kind, type Message } from "../src/protocol.ts";
import { claimConflict, fold as foldWith, overlaps, type Roster } from "../src/state.ts";
import { homedir } from "node:os";
import { claimPlace, hideHome } from "../src/where.ts";
import { generateIdentity, sign, verify, type Identity } from "../src/identity.ts";

const roster: Roster = [];
async function member(name: string, owner = false): Promise<Identity> {
  const id = await generateIdentity(name);
  roster.push({ name, pk: id.pk, owner, at: 0, active: true });
  return id;
}
const fold = (ms: Message[], now?: number) => foldWith(ms, roster, now);

let seq = 0;
const T0 = 1_700_000_000_000;
async function msg(id: Identity, from: string, ev: Event, at = T0 + seq * 1000): Promise<Message> {
  seq++;
  const base = { v: 1 as const, id: crypto.randomUUID(), from, kind: "event" as Kind, body: "", ts: at, ev };
  const p = await sign(id, base);
  return { ...p, seq, rts: at, sigOk: await verify(p) };
}

describe("claims name a checkout and can share a file by symbol", () => {
  test("file#A and file#B do not overlap; a whole file or a directory still locks", () => {
    const file = "web/src/components/message.tsx";
    expect(overlaps(`${file}#EventRow`, `${file}#Bubble`)).toBe(false);
    expect(overlaps(`${file}#EventRow`, `${file}#EventRow`)).toBe(true);
    expect(overlaps(`${file}#EventRow`, file)).toBe(true);
    expect(overlaps("web/src/components", `${file}#EventRow`)).toBe(true);
    expect(overlaps("src", "src/a.rs")).toBe(true);
    expect(overlaps("src/a", "src/ab")).toBe(false);
    expect(overlaps("*", `${file}#EventRow`)).toBe(true);
  });

  test("a claim in another checkout conflicts, and the list names that checkout", async () => {
    const a = await member("a");
    const b = await member("b");
    const held = await msg(a, "a", { op: "claim", paths: ["src/net"], ttl: 600, machine: "mbp", checkout: "/work/a" });
    const symbol = await msg(b, "b", { op: "claim", paths: ["src/ui.tsx#Header", "src/ui.tsx#Footer"], ttl: 600, checkout: "/work/b" });
    const again = await msg(b, "b", { op: "claim", paths: ["src/ui.tsx#Header"], ttl: 600, checkout: "/work/b" });
    const whole = await msg(b, "b", { op: "claim", paths: ["src/net/tcp.rs"], ttl: 600, checkout: "/work/b" });
    const s = fold([held, symbol, again, whole], held.rts! + 1000);
    expect(s.rejected.get(whole.seq)).toBe("src/net is claimed by a in a's checkout (/work/a)");
    expect(s.claims.map((c) => c.path).sort()).toEqual(["src/net", "src/ui.tsx#Footer", "src/ui.tsx#Header"]);
    expect(s.claims.find((c) => c.path === "src/net")).toMatchObject({ machine: "mbp", checkout: "/work/a" });
    expect(formatClaims(s, held.rts! + 1000)).toContain("in a's checkout (/work/a, on mbp)");
    expect(claimConflict(s.claims.find((c) => c.path === "src/net")!)).toContain("in a's checkout");
    expect(wellFormedEvent({ op: "claim", paths: ["src/a.ts#Row"], ttl: 60, machine: "mbp", checkout: "/work/a" })).toBe(true);
  });
});

describe("facts are shared and can expire", () => {
  test("anyone can unset, a ttl fact disappears, and the list shows its age", async () => {
    const author = await member("author");
    const other = await member("other");
    const set = await msg(author, "author", { op: "fact.set", key: "build.cmd", value: "cargo test" }, T0);
    const branch = await msg(author, "author", { op: "fact.set", key: "sh.branch", value: "grok/sh", ttl: 7 * 86400 }, T0);
    const fresh = fold([set, branch], T0 + 3600_000);
    expect(fresh.facts.get("build.cmd")?.value).toBe("cargo test");
    expect(fresh.facts.get("sh.branch")?.expires).toBe(T0 + 7 * 86400_000);
    expect(formatFact(fresh.facts.get("sh.branch")!, T0 + 3600_000)).toContain("1h ago");
    expect(formatFact(fresh.facts.get("sh.branch")!, T0 + 3600_000)).toContain("left");

    const cleared = await msg(other, "other", { op: "fact.del", key: "build.cmd" }, T0 + 2000);
    const after = fold([set, branch, cleared], T0 + 3600_000);
    expect(after.facts.has("build.cmd")).toBe(false);
    expect(after.facts.has("sh.branch")).toBe(true);
    expect(fold([set, branch], T0 + 8 * 86400_000).facts.has("sh.branch")).toBe(false);
    expect(fold([set, branch], T0 + 8 * 86400_000).facts.has("build.cmd")).toBe(true);
    expect(parseDuration("7d")).toBe(7 * 86400);
    expect(wellFormedEvent({ op: "fact.set", key: "k", value: "v", ttl: 3600 })).toBe(true);
  });
});

test("a claim's checkout never carries the home directory", () => {
  const home = homedir();
  expect(hideHome(home + "/.t3/worktrees/modelchannel/t3-07c0ed11")).toBe("~/.t3/worktrees/modelchannel/t3-07c0ed11");
  expect(hideHome(home)).toBe("~");
  expect(hideHome("/opt/src")).toBe("/opt/src");
  expect(hideHome(home + "2/proj")).toBe(home + "2/proj");
  const place = claimPlace();
  expect(place.checkout?.startsWith("~/")).toBe(true);
  expect(place.checkout).toContain("t3-papercuts");
  expect(place.checkout?.includes(home)).toBe(false);
  expect(JSON.stringify(place).includes(home)).toBe(false);
});
