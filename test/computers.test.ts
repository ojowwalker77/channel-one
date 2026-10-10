import { afterAll, afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { machineStatus, newMachine, registerMachine, vouchFor, type MachineFile } from "../src/machine.ts";
import type { HumanAuth } from "../src/relay/human.ts";
import { sign } from "../src/identity.ts";
import { LINK_TTL_MS, registrationAddress, registrationAllowed, sweepPending, UNUSED_LINK_TTL_MS, onMachineHttp, vouchedBy, type MachineRecord, type MachineStore } from "../src/relay/machines.ts";
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
      // The route does not read client-address headers. The test passes the address the way Bun does, after it has decided.
      const ip = req.headers.get("x-client-address");
      return (await onMachineHttp(req, store, human, ip ? { ip, allow: registrationAllowed } : null)) ?? new Response("not found", { status: 404 });
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

describe("unlinked registrations don't live forever", () => {
  test("a registration nobody confirms is gone after the link window", async () => {
    const t0 = Date.now();
    setSystemTime(t0);
    const m = await newMachine(relay);
    expect((await registerMachine(m)).status).toBe("pending");
    expect(records.has(m.identity.pk)).toBe(true);

    setSystemTime(t0 + LINK_TTL_MS + 1000);
    const res = await fetch(`${relay}/v1/machines/${m.identity.pk}/public`);
    expect(res.status).toBe(404);
    expect(records.has(m.identity.pk)).toBe(false);
  });

  test("the sweep deletes an unlinked registration even if nobody reads it", async () => {
    const t0 = Date.now();
    const stale: MachineRecord = { pk: "stale-machine-key", label: "old", user: null, created: t0 - LINK_TTL_MS - 1000 };
    const fresh: MachineRecord = { pk: "fresh-machine-key", label: "new", user: null, created: t0 };
    const linked: MachineRecord = { pk: "linked-machine-key", label: "mine", user: "user_z", created: t0 - LINK_TTL_MS - 1000, linked: t0 };
    const all = [stale, fresh, linked];
    const n = await sweepPending(
      async () => all,
      async (rec) => void all.splice(all.indexOf(rec), 1),
      t0,
    );
    expect(n).toBe(1);
    expect(all.map((r) => r.pk)).toEqual(["fresh-machine-key", "linked-machine-key"]);
  });

  test("the 21st registration from one address in 10 minutes is refused", async () => {
    setSystemTime(Date.now());
    const ip = "203.0.113.50";
    let status = 0;
    for (let i = 0; i < 21; i++) {
      const m = await newMachine(relay);
      const body = JSON.stringify(await sign(m.identity, { label: m.label, ts: Date.now() }));
      const res = await fetch(`${relay}/v1/machines`, { method: "POST", headers: { "content-type": "application/json", "x-client-address": ip }, body });
      status = res.status;
      if (i < 20) expect(status).toBe(200);
    }
    expect(status).toBe(429);
  });

  test("a forwarded or Cloudflare header is not a limit by itself", async () => {
    setSystemTime(Date.now());
    for (let i = 0; i < 25; i++) {
      const m = await newMachine(relay);
      const body = JSON.stringify(await sign(m.identity, { label: m.label, ts: Date.now() }));
      const res = await fetch(`${relay}/v1/machines`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${i}`, "cf-connecting-ip": "198.51.100.20" },
        body,
      });
      expect(res.status).toBe(200);
    }
  });
});

describe("which address a registration counts against", () => {
  test("the peer, unless it is loopback and the proxy is trusted", () => {
    expect(registrationAddress("203.0.113.5", "1.2.3.4", true)).toBe("203.0.113.5");
    expect(registrationAddress("203.0.113.5", "1.2.3.4", false)).toBe("203.0.113.5");
    expect(registrationAddress("127.0.0.1", "1.2.3.4, 203.0.113.9", false)).toBe("127.0.0.1");
    expect(registrationAddress("127.0.0.1", "1.2.3.4, 203.0.113.9", true)).toBe("203.0.113.9");
    expect(registrationAddress("::ffff:127.0.0.1", "2001:db8::9", true)).toBe("2001:db8::9");
    expect(registrationAddress("::1", "not an ip, [2001:db8::8]", true)).toBe("2001:db8::8");
    expect(registrationAddress("127.0.0.1", "not an ip", true)).toBe("127.0.0.1");
    expect(registrationAddress(null, "203.0.113.9", true)).toBeNull();
  });

  test("a full table drops the oldest address, not every address", () => {
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 20; i++) expect(registrationAllowed("honest-kept", t0)).toBe(true);
    expect(registrationAllowed("honest-kept", t0)).toBe(false);
    for (let i = 0; i < 10_000; i++) expect(registrationAllowed(`flood-${i}`, t0)).toBe(true);
    // honest-kept was the oldest, so its window starts again. A key added at the end is still counted.
    expect(registrationAllowed("honest-kept", t0)).toBe(true);
    for (let i = 0; i < 19; i++) expect(registrationAllowed("flood-9999", t0)).toBe(true);
    expect(registrationAllowed("flood-9999", t0)).toBe(false);
  });
});
