// Per-person and per-channel limits (the future free tier), and the safety caps every relay keeps.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "../src/client.ts";
import { generateIdentity } from "../src/identity.ts";
import { startRelay } from "../src/relay/bun.ts";
import { OPEN_POLICY, policyFrom, SAFETY_BYTES_PER_CHANNEL, type RelayPolicy } from "../src/relay/policy.ts";
import { checked } from "./check.ts";

setDefaultTimeout(30_000);
const dirs: string[] = [];
const servers: ReturnType<typeof startRelay>[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A Bun relay with this policy and a clock the test controls. */
function relayWith(policy: Partial<RelayPolicy>, clock = { now: Date.now() }) {
  const dataDir = mkdtempSync(join(tmpdir(), "kiwi-quota-"));
  dirs.push(dataDir);
  const server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir, policy: { ...OPEN_POLICY, ...policy }, now: () => clock.now });
  servers.push(server);
  return { relay: server.url.origin, dataDir, clock, server };
}

async function channelOn(relay: string, members = 1) {
  const owner = await generateIdentity("boss");
  const { code, access } = await Channel.create(relay, owner, { name: "boss" });
  const ownerCh = new Channel(access, relay, owner);
  const agents: Channel[] = [];
  for (let i = 0; i < members; i++) {
    const a = await generateIdentity(`a${i}`);
    const req = await Channel.requestJoin(relay, code, a, { name: `a${i}` });
    await ownerCh.approve((await checked(ownerCh, relay, code, [{ id: a, requestId: req.requestId }])).find((r) => r.id === req.requestId)!);
    const st = await Channel.joinStatus(relay, code, a, req.requestId);
    if (st.status !== "approved") throw new Error("not approved");
    agents.push(new Channel(st.access, relay, a));
  }
  return { code, access, ownerCh, agents };
}

describe("settings", () => {
  test("nothing configured: no limits but the byte safety cap", () => {
    expect(policyFrom({})).toEqual(OPEN_POLICY);
    expect(OPEN_POLICY.bytesPerChannel).toBe(SAFETY_BYTES_PER_CHANNEL);
    expect(policyFrom({ KIWI_QUOTA_MESSAGES_PER_DAY: "2000", KIWI_QUOTA_BYTES_PER_CHANNEL: "52428800", KIWI_QUOTA_MEMBERS_PER_CHANNEL: "8" })).toMatchObject({
      messagesPerDay: 2000,
      bytesPerChannel: 52_428_800,
      membersPerChannel: 8,
    });
  });
});

describe("members per channel", () => {
  test("at the limit the owner can't admit another; removing someone frees the seat", async () => {
    const { relay } = relayWith({ membersPerChannel: 2 });
    const { code, ownerCh } = await channelOn(relay, 1);
    const extra = await generateIdentity("extra");
    const ask = await Channel.requestJoin(relay, code, extra, { name: "extra" });
    const [r] = await checked(ownerCh, relay, code, [{ id: extra, requestId: ask.requestId }]);
    await expect(ownerCh.approve(r!)).rejects.toMatchObject({ status: 429, message: expect.stringContaining("2 members") });
    const a0 = (await ownerCh.members()).find((m) => m.name === "a0")!;
    await ownerCh.remove(a0.pk);
    await ownerCh.approve(r!);
    expect((await ownerCh.members()).filter((m) => m.active).map((m) => m.name).sort()).toEqual(["boss", "extra"]);
  });
});

describe("messages per day", () => {
  test("at the limit sends are refused with when it resets; the next UTC day starts over", async () => {
    const clock = { now: Date.UTC(2026, 9, 8, 23, 50) };
    const { relay } = relayWith({ messagesPerDay: 3 }, clock);
    const { agents } = await channelOn(relay, 1);
    const a = agents[0]!;
    for (let i = 0; i < 3; i++) await a.send(`m${i}`);
    await expect(a.send("one too many")).rejects.toMatchObject({ status: 429, message: expect.stringContaining("00:00 UTC (in 10m)") });
    clock.now = Date.UTC(2026, 9, 9, 0, 1);
    await a.send("a new day");
  });
});

describe("stored bytes per channel", () => {
  test("the oldest messages make room; the counter matches what's stored; oversize is refused", async () => {
    const { relay, dataDir } = relayWith({ bytesPerChannel: 4000 });
    const { access, agents } = await channelOn(relay, 1);
    const a = agents[0]!;
    for (let i = 0; i < 12; i++) await a.send(`message ${i} ${"x".repeat(300)}`);
    const db = new Database(join(dataDir, `${access.roomId}.sqlite`));
    const stored = (db.query("SELECT COALESCE(SUM(LENGTH(ct)), 0) AS n FROM msgs").get() as { n: number }).n;
    const counted = Number((db.query("SELECT v FROM meta WHERE k = 'bytes'").get() as { v: string }).v);
    const oldest = (db.query("SELECT MIN(seq) AS s FROM msgs").get() as { s: number }).s;
    db.close();
    expect(counted).toBe(stored);
    expect(stored).toBeLessThanOrEqual(4000);
    expect(oldest).toBeGreaterThan(1);
    // The newest messages are all still there.
    const { messages } = await a.history(0);
    expect(messages.at(-1)!.body).toStartWith("message 11");
    await expect(a.send("y".repeat(5000))).rejects.toMatchObject({ status: 413 });
  });
});

describe("idle rooms expire", () => {
  test("activity keeps a room; a quiet one is wiped like a close, and members learn it's gone", async () => {
    const clock = { now: Date.UTC(2026, 9, 8, 12) };
    const { relay, dataDir, server } = relayWith({ expireAfterDays: 1 }, clock);
    const { access, agents } = await channelOn(relay, 1);
    const a = agents[0]!;
    await a.send("still here");
    clock.now += 20 * 3_600_000;
    expect(server.sweep()).toBe(0);
    await a.send("still here, later"); // activity: the clock restarts
    clock.now += 20 * 3_600_000;
    expect(server.sweep()).toBe(0);
    clock.now += 5 * 3_600_000;
    expect(server.sweep()).toBe(1);
    expect(existsSync(join(dataDir, `${access.roomId}.sqlite`))).toBe(false);
    await expect(a.send("anyone?")).rejects.toMatchObject({ why: "closed" });
  });

  test("off unless configured: nothing expires", async () => {
    const clock = { now: Date.UTC(2026, 9, 8, 12) };
    const { relay, server } = relayWith({}, clock);
    await channelOn(relay, 0);
    clock.now += 400 * 86_400_000;
    expect(server.sweep()).toBe(0);
  });
});
