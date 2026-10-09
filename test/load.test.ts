import { describe, expect, test } from "bun:test";
import { loadJson, loadLine, loadSummary, memberLoad, showsLoad } from "../src/load.ts";
import type { ChannelState, Claim, Task } from "../src/state.ts";

const now = 1_000_000;
const task = (id: number, owner: string | undefined, state: Task["state"], title = `task ${id}`): Task => ({ id, title, state, owner, createdBy: "x", createdAt: 0, updatedAt: 0, after: [], notes: [] });
const claim = (owner: string, path: string, expires = now + 60_000): Claim => ({ owner, path, seq: 1, since: 0, expires });
const board = (tasks: Task[], claims: Claim[] = []): ChannelState =>
  ({ members: new Map(), tasks: new Map(tasks.map((t) => [t.id, t])), claims, facts: new Map(), trust: new Map(), rejected: new Map(), openAsks: [], threadOf: new Map(), threadPeople: new Map(), head: 0 }) as ChannelState;

describe("member load", () => {
  test("nothing assigned is free; done tasks and other people's don't count", () => {
    const s = board([task(1, "win", "done"), task(2, "mac", "doing"), task(3, undefined, "todo")]);
    const l = memberLoad(s, "win", now);
    expect(l.level).toBe("free");
    expect(loadLine(l)).toBe("free");
  });

  test("one task in progress, or a queue, is busy", () => {
    expect(memberLoad(board([task(1, "win", "doing")]), "win", now).level).toBe("busy");
    expect(memberLoad(board([task(1, "win", "todo")]), "win", now).level).toBe("busy");
  });

  test("two at once, or four on the plate, is overloaded", () => {
    expect(memberLoad(board([task(1, "win", "doing"), task(2, "win", "doing")]), "win", now).level).toBe("overloaded");
    expect(memberLoad(board([1, 2, 3, 4].map((i) => task(i, "win", i === 1 ? "doing" : "todo"))), "win", now).level).toBe("overloaded");
  });

  test("blocked and in-review tasks are shown but aren't load; expired claims are gone", () => {
    const s = board([task(1, "win", "blocked"), task(2, "win", "review")], [claim("win", "src/a"), claim("win", "src/b", now - 1)]);
    const l = memberLoad(s, "win", now);
    expect(l.level).toBe("free");
    expect(loadLine(l)).toBe("2 waiting · 1 claim");
  });

  test("the line names the current task; json carries the details", () => {
    const s = board([task(7, "win", "doing", "Fix the login redirect"), task(8, "win", "todo")], [claim("win", "web/src")]);
    const l = memberLoad(s, "win", now);
    expect(loadLine(l)).toBe("doing T7 Fix the login redirect · 1 queued · 1 claim");
    expect(loadJson(l)).toEqual({ level: "busy", current: [{ id: "T7", title: "Fix the login redirect" }], queued: [{ id: "T8", title: "task 8" }], waiting: [], claims: [{ path: "web/src", expires: now + 60_000 }] });
  });

  test("agents always show load; people and owners only when they hold something", () => {
    const free = memberLoad(board([]), "x", now);
    const busy = memberLoad(board([task(1, "x", "todo")]), "x", now);
    expect(showsLoad({ kind: "agent" }, free)).toBe(true);
    expect(showsLoad(undefined, free)).toBe(true);
    expect(showsLoad({ kind: "human" }, free)).toBe(false);
    expect(showsLoad({ owner: true }, free)).toBe(false);
    expect(showsLoad({ owner: true }, busy)).toBe(true);
    expect(loadSummary(free)).toBe("free");
    expect(loadSummary(busy)).toBe("busy: 1 queued");
  });
});
