// T283: cancel is its own state, deps can be added later, review counts as ready,
// a near-duplicate open title warns, and an empty kiwi sh glob says so.

import { describe, expect, test } from "bun:test";
import { describeEvent, formatAdded, formatAfter, formatStatus, formatTask, formatTasks } from "../src/format.ts";
import { memberLoad } from "../src/load.ts";
import { wellFormedEvent, type Event, type Kind, type Message } from "../src/protocol.ts";
import { runSh } from "../src/sh.ts";
import { fold as foldWith, similarOpenTasks, titlesLookAlike, waitingOn, type Roster, type Task } from "../src/state.ts";
import { generateIdentity, sign, verify, type Identity } from "../src/identity.ts";

const roster: Roster = [];
async function member(name: string): Promise<Identity> {
  const id = await generateIdentity(name);
  roster.push({ name, pk: id.pk, owner: false, at: 0, active: true });
  return id;
}
const fold = (ms: Message[]) => foldWith(ms, roster);

let seq = 0;
const T0 = 1_700_000_000_000;
async function msg(id: Identity, from: string, ev: Event): Promise<Message> {
  seq++;
  const at = T0 + seq * 1000;
  const base = { v: 1 as const, id: crypto.randomUUID(), from, kind: "event" as Kind, body: "", ts: at, ev };
  const p = await sign(id, base);
  return { ...p, seq, rts: at, sigOk: await verify(p) };
}

describe("task cancel and after", () => {
  test("cancel is a state of its own; drop still only unassigns", async () => {
    const a = await member("a");
    const added = await msg(a, "a", { op: "task.add", title: "duplicate of the login fix", owner: "a" });
    const claimed = await msg(a, "a", { op: "task.claim", task: added.seq });
    const cancelled = await msg(a, "a", { op: "task.update", task: added.seq, state: "cancelled" });
    const s = fold([added, claimed, cancelled]);
    expect(s.tasks.get(added.seq)).toMatchObject({ state: "cancelled", owner: "a" });
    expect(s.rejected.has(cancelled.seq)).toBe(false);
    expect(describeEvent(cancelled, s)).toContain("cancelled");

    const other = await msg(a, "a", { op: "task.add", title: "still real", owner: "a" });
    const start = await msg(a, "a", { op: "task.claim", task: other.seq });
    const drop = await msg(a, "a", { op: "task.update", task: other.seq, owner: null });
    const dropped = fold([other, start, drop]);
    expect(dropped.tasks.get(other.seq)).toMatchObject({ state: "todo", owner: undefined });
  });

  test("a cancelled task cannot be claimed, and cancelling it unblocks dependents", async () => {
    const a = await member("a");
    const t1 = await msg(a, "a", { op: "task.add", title: "the duplicate", owner: "a" });
    const t2 = await msg(a, "a", { op: "task.add", title: "the real one", after: [t1.seq], owner: "a" });
    const cancel = await msg(a, "a", { op: "task.update", task: t1.seq, state: "cancelled" });
    const claim = await msg(a, "a", { op: "task.claim", task: t1.seq });
    const s = fold([t1, t2, cancel, claim]);
    expect(s.rejected.get(claim.seq)).toContain("cancelled");
    expect(waitingOn(s, s.tasks.get(t2.seq)!)).toEqual([]);
    const load = memberLoad(s, "a");
    expect([...load.current, ...load.queued, ...load.waiting].map((t) => t.id)).not.toContain(t1.seq);
    expect(load.queued.map((t) => t.id)).toEqual([t2.seq]);
  });

  test("task after appends deps and refuses a missing id, a self-dep or a cycle", async () => {
    const a = await member("a");
    const t1 = await msg(a, "a", { op: "task.add", title: "first" });
    const t2 = await msg(a, "a", { op: "task.add", title: "second", after: [t1.seq] });
    const again = await msg(a, "a", { op: "task.update", task: t2.seq, after: [t1.seq] });
    const extra = await msg(a, "a", { op: "task.add", title: "third" });
    const add = await msg(a, "a", { op: "task.update", task: t2.seq, after: [extra.seq] });
    const s = fold([t1, t2, again, extra, add]);
    expect(s.tasks.get(t2.seq)?.after).toEqual([t1.seq, extra.seq]);
    expect(describeEvent(add, s)).toContain(`T${extra.seq}`);

    const missing = await msg(a, "a", { op: "task.update", task: t2.seq, after: [999] });
    const self = await msg(a, "a", { op: "task.update", task: t1.seq, after: [t1.seq] });
    const cycle = await msg(a, "a", { op: "task.update", task: t1.seq, after: [t2.seq] });
    const bad = fold([t1, t2, extra, missing, self, cycle]);
    expect(bad.rejected.get(missing.seq)).toContain("no task T999");
    expect(bad.rejected.get(self.seq)).toContain("would cycle");
    expect(bad.rejected.get(cycle.seq)).toContain("would cycle");
    expect(bad.tasks.get(t1.seq)?.after).toEqual([]);
    expect(wellFormedEvent({ op: "task.update", task: t1.seq, state: "cancelled", after: [t2.seq] })).toBe(true);
    expect(wellFormedEvent({ op: "task.update", task: t1.seq, state: "nope" })).toBe(false);
  });

  test("review, done and cancelled satisfy a dependency; a todo one does not", async () => {
    const a = await member("a");
    const blocker = await msg(a, "a", { op: "task.add", title: "blocker" });
    const next = await msg(a, "a", { op: "task.add", title: "next", after: [blocker.seq] });
    const open = fold([blocker, next]);
    expect(waitingOn(open, open.tasks.get(next.seq)!)).toEqual([blocker.seq]);

    for (const state of ["review", "done", "cancelled"] as const) {
      const moved = await msg(a, "a", { op: "task.update", task: blocker.seq, state });
      const s = fold([blocker, next, moved]);
      expect(waitingOn(s, s.tasks.get(next.seq)!)).toEqual([]);
    }
  });
});

describe("how an add reads", () => {
  test("review is 'in review'; done and cancelled are not still waiting", async () => {
    const a = await member("a");
    const review = await msg(a, "a", { op: "task.add", title: "in review already" });
    const todo = await msg(a, "a", { op: "task.add", title: "not started" });
    const done = await msg(a, "a", { op: "task.add", title: "finished" });
    const finish = await msg(a, "a", { op: "task.update", task: done.seq, state: "done" });
    const mark = await msg(a, "a", { op: "task.update", task: review.seq, state: "review" });
    const s = fold([review, todo, done, finish, mark]);
    expect(formatAdded(s, 12, [review.seq, todo.seq, done.seq])).toBe(`added T12; waits on T${review.seq} (in review), T${todo.seq} (todo)`);
    expect(formatAfter(s, review.seq, [todo.seq])).toBe(`T${review.seq} waits on T${todo.seq} (todo)`);
    const child = s.tasks.get(todo.seq)!;
    expect(formatTask(s, { ...child, after: [review.seq] })).toContain(`T${review.seq} (review) — ready`);
    expect(formatTask(s, { ...child, after: [done.seq] })).toContain("— all done");
  });

  test("cancelled tasks stay off the open board unless --all", async () => {
    const a = await member("a");
    const t = await msg(a, "a", { op: "task.add", title: "drop me" });
    const cancel = await msg(a, "a", { op: "task.update", task: t.seq, state: "cancelled" });
    const s = fold([t, cancel]);
    expect(formatTasks(s)).toBe("no tasks");
    expect(formatTasks(s, { all: true })).toContain("cancelled");
    expect(formatStatus({ alias: "c", me: "a", state: s, online: new Map(), unread: 0, now: T0 })).toContain("0 open, 1 cancelled");
  });
});

describe("near-duplicate titles", () => {
  test("equal, contained, or mostly the same words; done titles do not warn", async () => {
    expect(titlesLookAlike("Fix the login button", "fix the login button")).toBe(true);
    expect(titlesLookAlike("Fix the login button", "fix the login button now")).toBe(true);
    expect(titlesLookAlike("Fix login", "Please fix the login flow")).toBe(true);
    expect(titlesLookAlike("Write the docs", "Fix the login button")).toBe(false);
    expect(titlesLookAlike("ui", "build the gui")).toBe(false);

    const a = await member("a");
    const open = await msg(a, "a", { op: "task.add", title: "Fix the login button" });
    const done = await msg(a, "a", { op: "task.add", title: "Fix the login button" });
    const finish = await msg(a, "a", { op: "task.update", task: done.seq, state: "done" });
    const cancel = await msg(a, "a", { op: "task.add", title: "Fix the login button" });
    const cancelled = await msg(a, "a", { op: "task.update", task: cancel.seq, state: "cancelled" });
    const s = fold([open, done, finish, cancel, cancelled]);
    expect(similarOpenTasks(s, "fix the login button!").map((t: Task) => t.id)).toEqual([open.seq]);
  });
});

describe("kiwi sh empty globs", () => {
  const files = { "/channel/tasks/T2.md": "hello\n", "/channel/nope/": "" };

  test("a glob that matches nothing is named on stderr and the script still runs", async () => {
    const r = await runSh(files, "echo /channel/nope/*.md; echo after");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("after\n");
    expect(r.stderr).toBe("bash: no match: /channel/nope/*.md\n");
  });

  test("a glob that matches nothing, and nothing after it, exits nonzero", async () => {
    const r = await runSh(files, "echo /channel/nope/*.md");
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("bash: no match: /channel/nope/*.md\n");
  });

  test("a matching glob is quiet, and test, arithmetic and prefix removal are not globs", async () => {
    const hit = await runSh(files, "echo /channel/tasks/*.md");
    expect(hit).toMatchObject({ stdout: "/channel/tasks/T2.md\n", stderr: "", exitCode: 0 });
    const testCmd = await runSh(files, "[ -f x ]; echo after");
    expect(testCmd).toMatchObject({ stdout: "after\n", stderr: "", exitCode: 0 });
    const arith = await runSh(files, "echo $((2*3))");
    expect(arith).toMatchObject({ stdout: "6\n", stderr: "", exitCode: 0 });
    const trim = await runSh(files, "x=a/b; echo ${x#*/}");
    expect(trim).toMatchObject({ stdout: "b\n", stderr: "", exitCode: 0 });
  });
});
