// Getting a seat back: the same key resumes; a new key takes the seat over only
// with the owner's approval, from the same person, never while unseen-online, and
// the old key is out for good.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, RelayError } from "../src/client.ts";
import { generateIdentity, type Identity } from "../src/identity.ts";
import type { JoinRequest } from "../src/membership.ts";
import { startRelay } from "../src/relay/bun.ts";
import { fold } from "../src/state.ts";
import { describeEvent } from "../src/format.ts";
import { memoryBudget } from "./check.ts";

setDefaultTimeout(60_000);

const dataDir = mkdtempSync(join(tmpdir(), "kiwi-reclaim-relay-"));
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

/** A reclaim's code check, as people run it: the owner's explicit check, then the joiner reveals. */
async function readyRequest(owner: Channel, code: string, joiner: Identity, requestId: string): Promise<JoinRequest> {
  const first = (await owner.requests({ budget: memoryBudget() })).find((r) => r.id === requestId)!;
  expect(first.reclaims).toBeDefined();
  // Never signed by the day's automatic share: a person starts it.
  expect(first.check).toBe("unchecked");
  await owner.checkRequest(first);
  await Channel.joinStatus(relay, code, joiner, requestId);
  return (await owner.requests()).find((r) => r.id === requestId)!;
}

describe("seat reclaim", () => {
  let owner: Identity;
  let oldKey: Identity;
  let code: string;
  let ownerCh: Channel;
  let oldCh: Channel;

  beforeAll(async () => {
    owner = await generateIdentity("human");
    oldKey = await generateIdentity("win");
    const made = await Channel.create(relay, owner, { name: "human" }, [{ ...oldKey, info: { name: "win", role: "windows", about: "the PC side" } }]);
    code = made.code;
    ownerCh = new Channel(made.access, relay, owner);
    // The same key resumes without asking: nothing new is granted.
    oldCh = new Channel(await Channel.resume(relay, code, oldKey), relay, oldKey);
    const t = await oldCh.send("", { ev: { op: "task.add", title: "fix the PC edge", owner: "win" } });
    await oldCh.send("", { ev: { op: "claim", paths: ["src/pc"], ttl: 3600 } });
    await oldCh.send("", { ev: { op: "fact.set", key: "pc.ip", value: "10.0.0.9" } });
    await oldCh.send("on it", { re: [t] });
  });

  test("a key that isn't a member can't resume", async () => {
    const stranger = await generateIdentity("win");
    await expect(Channel.resume(relay, code, stranger)).rejects.toBeInstanceOf(RelayError);
  });

  test("guards: another person's request, the owner's seat, a person's seat", async () => {
    const newKey = await generateIdentity("win");
    const { requestId } = await Channel.requestJoin(relay, code, newKey, { name: "win", reclaim: true });
    const req = await readyRequest(ownerCh, code, newKey, requestId);
    expect(req.reclaims).toMatchObject({ name: "win", pk: oldKey.pk, owner: false });
    expect(req.reclaim).toBe(true);
    await expect(ownerCh.reclaim({ ...req, sponsoredBy: { user: "user_mallory", name: "Mallory" } }, { online: false })).rejects.toThrow(/refused/);
    await expect(ownerCh.reclaim({ ...req, reclaims: { name: "human", pk: owner.pk, owner: true } }, { online: false })).rejects.toThrow();
    await expect(ownerCh.reclaim({ ...req, kind: "human" }, { online: false })).rejects.toThrow(/only an agent/);
    // A plain approve can't take a current member's name either.
    await expect(ownerCh.approve(req)).rejects.toThrow(/already someone's name/);
    await ownerCh.deny(requestId);
  });

  test("while the old key is online it takes force; then the seat moves, and everything of it carries over", async () => {
    const newKey = await generateIdentity("win");
    const { requestId } = await Channel.requestJoin(relay, code, newKey, { name: "win", reclaim: true });
    const req = await readyRequest(ownerCh, code, newKey, requestId);
    await expect(ownerCh.reclaim(req, { online: true })).rejects.toThrow(/ONLINE NOW/);
    const epochBefore = (await ownerCh.info()).epoch;
    const moved = await ownerCh.reclaim(req, { online: true, force: true });
    expect(moved).toMatchObject({ name: "win", role: "windows", about: "the PC side", pk: newKey.pk });

    // The old key is out at once: no keys, no history, no sending, and it can't ask back in.
    await expect(Channel.resume(relay, code, oldKey)).rejects.toBeInstanceOf(RelayError);
    await expect(oldCh.send("still here?")).rejects.toThrow();
    await expect(Channel.requestJoin(relay, code, oldKey, { name: "win", reclaim: true })).rejects.toThrow(/removed/);

    // The new key is in, under the same name, with a rotated channel key it alone (with the rest) holds.
    const st = await Channel.joinStatus(relay, code, newKey, requestId);
    expect(st.status).toBe("approved");
    const newCh = new Channel((st as { access: import("../src/crypto.ts").ChannelAccess }).access, relay, newKey);
    expect((await ownerCh.info()).epoch).toBe(epochBefore + 1);
    const members = await newCh.members();
    expect(members.filter((m) => m.name === "win").map((m) => [m.pk, m.active])).toEqual([
      [oldKey.pk, false],
      [newKey.pk, true],
    ]);

    // Tasks, claims and facts are the name's: they carry over. The old key's history still verifies.
    const { messages } = await newCh.history(0);
    const state = fold(messages, members.map((m) => ({ name: m.name, pk: m.pk, role: m.role, owner: m.owner, at: m.at, active: m.active, kind: m.kind })));
    expect([...state.tasks.values()].map((t) => [t.title, t.owner])).toEqual([["fix the PC edge", "win"]]);
    expect(state.claims.map((c) => [c.path, c.owner])).toEqual([["src/pc", "win"]]);
    expect(state.facts.get("pc.ip")?.value).toBe("10.0.0.9");
    expect(messages.filter((m) => m.from === "win").every((m) => state.trust.get(m.seq) === "verified")).toBe(true);
    // And the owner signed a record of it.
    const record = messages.find((m) => m.ev?.op === "seat.reclaim")!;
    expect(state.trust.get(record.seq)).toBe("verified");
    expect(record.from).toBe("human");
    expect(describeEvent(record, state)).toContain(`${oldKey.pk.slice(0, 8)} → ${newKey.pk.slice(0, 8)}`);
    expect(await newCh.send("back")).toBeGreaterThan(0);
  });
});

describe("kiwi join, again", () => {
  const homes: string[] = [];
  const home = () => {
    const d = mkdtempSync(join(tmpdir(), "kiwi-reclaim-"));
    homes.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of homes) rmSync(d, { recursive: true, force: true });
  });
  const spawn = (dir: string, ...args: string[]) =>
    Bun.spawn(["bun", join(import.meta.dir, "../src/cli/main.ts"), ...args], {
      cwd: dir,
      env: { ...process.env, KIWI_HOME: dir, KIWI_RELAY: relay, CLAUDE_CONFIG_DIR: dir, CLAUDECODE: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  const run = async (dir: string, ...args: string[]) => {
    const p = spawn(dir, ...args);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out, err };
  };
  /** Wait for a line matching `re` on a running process's stdout. */
  const waitFor = async (p: ReturnType<typeof spawn>, re: RegExp, seen: string[]) => {
    const reader = p.stdout.getReader();
    let buf = "";
    for (;;) {
      const m = seen.join("\n").match(re) ?? buf.match(re);
      if (m) return (reader.releaseLock(), m);
      const { value, done } = await reader.read();
      if (done) throw new Error(`process ended before ${re}: ${buf}`);
      buf += new TextDecoder().decode(value);
    }
  };

  test("the same key resumes; a lost key reclaims the seat through the owner, with --force while it looks online", async () => {
    const owner = home();
    const made = await run(owner, "create", "proj", "--as", "lead");
    const code = /join code: (\S+)/.exec(made.out)![1]!;
    expect(code).toBeTruthy();

    // Re-running join with a key that's already in resumes: no request, nothing granted.
    const again = await run(owner, "join", code, "--as", "lead");
    expect(again.code).toBe(0);
    expect(again.out).toContain("resumed, nothing new was granted");

    // win joins from its own computer, says something, then loses its key (a new home).
    const first = home();
    const joining = spawn(first, "join", code, "--as", "win", "--role", "windows");
    // The owner's machine opens the request (signing its half), then the joiner shows the code.
    await Bun.sleep(1500);
    await run(owner, "-c", "proj", "--as", "lead", "requests");
    let shown = await waitFor(joining, /verification code (\d{3}-\d{3})/, []);
    expect((await run(owner, "-c", "proj", "--as", "lead", "approve", shown[1]!, "--yes")).code).toBe(0);
    expect(await joining.exited).toBe(0);
    expect((await run(first, "-c", "proj", "--as", "win", "send", "last words from the old key")).code).toBe(0);
    expect((await run(owner, "-c", "proj", "--as", "lead", "send", "--to", "win", "are you there?")).code).toBe(0);

    const second = home();
    const reclaiming = spawn(second, "join", code, "--as", "win", "--reclaim");
    await Bun.sleep(1500);
    const listed = await run(owner, "-c", "proj", "--as", "lead", "requests");
    expect(listed.out).toMatch(/unchecked RECLAIMS win's seat · old key \S+, last seen/);
    const newKey = /new key (\S+)/.exec(listed.out)![1]!;
    expect((await run(owner, "-c", "proj", "--as", "lead", "check", newKey, "--yes")).code).toBe(0);
    shown = await waitFor(reclaiming, /verification code (\d{3}-\d{3})/, []);

    // win spoke a moment ago: the old key may be live, so it takes --force.
    const refused = await run(owner, "-c", "proj", "--as", "lead", "approve", shown[1]!, "--yes");
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("IS ONLINE NOW");
    const moved = await run(owner, "-c", "proj", "--as", "lead", "approve", shown[1]!, "--yes", "--force");
    expect(moved.out).toContain("moved win's seat to key");
    expect(await reclaiming.exited).toBe(0);

    // The new key reads what reached win after the old key last spoke, keeps its role, and the old key is out.
    const unread = await run(second, "-c", "proj", "--as", "win", "read");
    expect(unread.out).toContain("are you there?");
    expect((await run(second, "-c", "proj", "--as", "win", "status")).out).toContain("you are win (windows)");
    const old = await run(first, "-c", "proj", "--as", "win", "send", "hello?");
    expect(old.code).not.toBe(0);
  });
});
