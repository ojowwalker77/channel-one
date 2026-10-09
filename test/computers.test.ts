import { afterAll, afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { machineStatus, newMachine, registerMachine, vouchFor, type MachineFile } from "../src/machine.ts";
import type { HumanAuth } from "../src/relay/human.ts";
import { UNUSED_LINK_TTL_MS, onMachineHttp, vouchedBy, type MachineRecord, type MachineStore } from "../src/relay/machines.ts";
import { errorResponse } from "../src/relay/room.ts";

// The machine routes on their own: an in-memory store, and a "WorkOS" that trusts any user_ token.
const records = new Map<string, MachineRecord>();
let writes = 0;
const store: MachineStore = {
  get: async (pk) => records.get(pk) ?? null,
  put: async (rec) => void (writes++, records.set(rec.pk, rec)),
  remove: async (rec) => void records.delete(rec.pk),
  listFor: async (user) => [...records.values()].filter((r) => r.user === user).map((r) => ({ pk: r.pk, label: r.label, linked: r.linked ?? r.created })),
};
const human: HumanAuth = { clientId: "client_test", verify: async (t) => (t.startsWith("user_") ? t : null) };
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    try {
      return (await onMachineHttp(req, store, human)) ?? new Response("not found", { status: 404 });
    } catch (err) {
      return errorResponse(err);
    }
  },
});
const relay = server.url.origin;
const ROOM = "0".repeat(32);
const HOUR = 3600_000;
const DAY = 24 * HOUR;

afterEach(() => setSystemTime());
afterAll(() => server.stop(true));

async function linked(user: string): Promise<MachineFile> {
  const m = await newMachine(relay);
  await registerMachine(m);
  const res = await fetch(`${relay}/v1/machines/${m.identity.pk}/confirm`, { method: "POST", headers: { "x-human-token": user }, body: "{}" });
  expect(res.status).toBe(200);
  return { ...m, linked: { name: null, at: Date.now() } };
}

const vouch = async (m: MachineFile) => vouchedBy(store, ROOM, "agentpk", await vouchFor(m, ROOM, "agentpk"));
const list = async (user: string) =>
  ((await (await fetch(`${relay}/v1/me/machines`, { headers: { "x-human-token": user } })).json()) as { machines: { pk: string; used: number | null; expires: number }[] }).machines;

describe("your computers: last used", () => {
  test("a fresh link hasn't been used; vouching for an agent counts, recorded at most hourly", async () => {
    const t0 = Date.now();
    setSystemTime(t0);
    const m = await linked("user_a");
    expect((await list("user_a"))[0]!.used).toBeNull();

    expect(await vouch(m)).toBe("user_a");
    expect((await list("user_a"))[0]!.used).toBe(t0);

    // Within the hour: no new write.
    setSystemTime(t0 + 30 * 60_000);
    const before = writes;
    await vouch(m);
    expect(writes).toBe(before);

    setSystemTime(t0 + 2 * HOUR);
    await vouch(m);
    const [c] = await list("user_a");
    expect(c!.used).toBe(t0 + 2 * HOUR);
    expect(c!.expires).toBe(t0 + 2 * HOUR + UNUSED_LINK_TTL_MS);
  });

  test("the computer checking its own link counts as use", async () => {
    const t0 = Date.now();
    setSystemTime(t0);
    const m = await linked("user_b");
    setSystemTime(t0 + 5 * DAY);
    expect((await machineStatus(m)).status).toBe("linked");
    expect((await list("user_b"))[0]!.used).toBe(t0 + 5 * DAY);
  });
});

describe("your computers: unused links expire", () => {
  test("29 days unused still vouches; 31 days and the link is gone everywhere", async () => {
    const t0 = Date.now();
    setSystemTime(t0);
    const m = await linked("user_c");

    setSystemTime(t0 + 29 * DAY);
    expect(await vouch(m)).toBe("user_c");

    // 31 days after that use.
    setSystemTime(t0 + 29 * DAY + 31 * DAY);
    expect(await vouch(m)).toBeNull();
    expect(records.has(m.identity.pk)).toBe(false);
    expect(await list("user_c")).toEqual([]);
    expect((await machineStatus(m)).status).toBe("expired");
  });

  test("an expired computer drops off the list and can be set up again", async () => {
    const t0 = Date.now();
    setSystemTime(t0);
    const m = await linked("user_d");
    setSystemTime(t0 + 31 * DAY);
    expect(await list("user_d")).toEqual([]);
    // kiwi setup again: the same key registers as a new pending link.
    expect((await registerMachine(m)).status).toBe("pending");
  });
});
