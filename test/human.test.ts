import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, myChannels, myUsage, relayConfig } from "../src/client.ts";
import { decodeJoinCode } from "../src/crypto.ts";
import { machineStatus, newMachine, registerMachine, unlinkMachine, vouchFor, type MachineFile } from "../src/machine.ts";
import { b64url } from "../src/crypto.ts";
import { generateIdentity } from "../src/identity.ts";
import { offerLink, offerToDevice, offerWaiting, parseOfferHash, takeOffer, withdrawOffer } from "../src/devices.ts";
import { startRelay } from "../src/relay/bun.ts";
import { onDeviceHttp, TRANSFER_TTL_MS, type DeviceStore, type DeviceTransfer } from "../src/relay/devices.ts";
import { workosHumanAuth } from "../src/relay/human.ts";
import { checked } from "./check.ts";

setDefaultTimeout(30_000);

// A stand-in for WorkOS: an RSA key, its JWKS endpoint, and tokens signed like AuthKit's.
const rsa = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const jwk = (await crypto.subtle.exportKey("jwk", rsa.publicKey)) as { n: string; e: string };
const jwks = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ keys: [{ kty: "RSA", kid: "k1", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }] }) });

async function token(sub: string, opts: { exp?: number; key?: CryptoKey; kid?: string } = {}): Promise<string> {
  const enc = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: "RS256", kid: opts.kid ?? "k1", typ: "JWT" });
  const body = enc({ sub, iss: "https://api.workos.com/user_management/client_test", exp: opts.exp ?? Math.floor(Date.now() / 1000) + 300 });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? rsa.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const names: Record<string, string> = { user_alice: "Alice Owner", user_bob: "Bob Builder", user_carol: "Carol Coder" };
const emails: Record<string, string> = { user_carol: "carol@example.com" };
const human = { ...workosHumanAuth("client_test", `${jwks.url.origin}/jwks`), profile: async (u: string) => (names[u] ? { name: names[u]!, email: emails[u] } : null) };
const dataDir = mkdtempSync(join(tmpdir(), "mc-relay-"));
let server: ReturnType<typeof startRelay>;
let relay: string;

beforeAll(() => {
  server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir, human });
  relay = server.url.origin;
});
afterAll(() => {
  server.stop(true);
  jwks.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

/** A computer its person linked with `kiwi setup`: registered by the computer, confirmed by the person signed in. */
async function linkedComputer(user: string): Promise<MachineFile> {
  const m = await newMachine(relay);
  await registerMachine(m);
  const res = await fetch(`${relay}/v1/machines/${m.identity.pk}/confirm`, { method: "POST", headers: { "x-human-token": await token(user) }, body: "{}" });
  if (!res.ok) throw new Error(`confirm failed: ${res.status}`);
  return { ...m, linked: { name: null, at: Date.now() } };
}

/** An agent asking to join from a linked computer. */
async function agentAsks(code: string, agent: Awaited<ReturnType<typeof generateIdentity>>, name: string, computer: MachineFile) {
  return Channel.requestJoin(relay, code, agent, { name }, null, await vouchFor(computer, decodeJoinCode(code).roomId, agent.pk));
}

describe("WorkOS token verification", () => {
  test("accepts a valid token, rejects expired, forged and tampered ones", async () => {
    expect(await human.verify(await token("user_a"))).toBe("user_a");
    expect(await human.verify(await token("user_a", { exp: Math.floor(Date.now() / 1000) - 120 }))).toBeNull();
    const other = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    expect(await human.verify(await token("user_a", { key: other.privateKey }))).toBeNull();
    const [h, , s] = (await token("user_a")).split(".");
    const forgedBody = b64url(new TextEncoder().encode(JSON.stringify({ sub: "admin", exp: 9999999999 })));
    expect(await human.verify(`${h}.${forgedBody}.${s}`)).toBeNull();
    expect(await human.verify("not.a.jwt")).toBeNull();
  });
});

describe("a relay that requires sign-in", () => {
  test("advertises its WorkOS client", async () => {
    expect(await relayConfig(relay)).toEqual({ workosClientId: "client_test" });
  });

  test("only a signed-in human can create a channel, and only that human can run it", async () => {
    const [owner, agent] = await Promise.all([generateIdentity("human"), generateIdentity("mac")]);
    // No session: refused.
    await expect(Channel.create(relay, owner, { name: "human" })).rejects.toMatchObject({ status: 401 });

    const alice = await token("user_alice");
    const { code, access } = await Channel.create(relay, owner, { name: "human" }, [], undefined, alice);

    // An agent asks to join from Alice's linked computer.
    const req = await agentAsks(code, agent, "mac", await linkedComputer("user_alice"));

    // The owner key alone (e.g. an agent that copied it) can't see or approve requests.
    const keyOnly = new Channel(access, relay, owner);
    await expect(keyOnly.requests()).rejects.toMatchObject({ status: 401 });

    // Another signed-in human with the same key file can't either.
    const bob = new Channel(access, relay, owner, undefined, () => token("user_bob"));
    await expect(bob.requests()).rejects.toMatchObject({ status: 403 });

    // The owning human can.
    const asAlice = new Channel(access, relay, owner, undefined, () => token("user_alice"));
    const pending = await checked(asAlice, relay, code, [{ id: agent, requestId: req.requestId }]);
    expect(pending.map((r) => r.code)).toEqual([((await Channel.joinStatus(relay, code, agent, req.requestId)) as { code: string }).code]);
    await asAlice.approve(pending[0]!);
    expect((await Channel.joinStatus(relay, code, agent, req.requestId)).status).toBe("approved");

    // Members still talk with their keys alone; sign-in is only for owning.
    const st = await Channel.joinStatus(relay, code, agent, req.requestId);
    if (st.status !== "approved") throw new Error("not approved");
    const mac = new Channel(st.access, relay, agent);
    await mac.send("hello");
    expect((await asAlice.history(0)).messages.map((m) => m.body)).toEqual(["hello"]);

    await expect(keyOnly.close()).rejects.toMatchObject({ status: 401 });
    await asAlice.close();
  });
});

describe("agents join only from a computer their person linked", () => {
  test("no request without a linked computer; the owner sees whose agent it is; unlinking stops it", async () => {
    const [owner, agent, stray, late] = await Promise.all([generateIdentity("alice"), generateIdentity("helper"), generateIdentity("stray"), generateIdentity("late")]);
    const alice = () => token("user_alice");
    const { code, access } = await Channel.create(relay, owner, { name: "alice-owner", kind: "human" }, [], undefined, await alice());
    const ownerCh = new Channel(access, relay, owner, undefined, alice);

    // A bare agent, or one from a computer nobody confirmed, can't even ask.
    await expect(Channel.requestJoin(relay, code, stray, { name: "stray" })).rejects.toMatchObject({ status: 403 });
    const unconfirmed = await newMachine(relay);
    await registerMachine(unconfirmed);
    expect((await machineStatus(unconfirmed)).status).toBe("pending");
    await expect(agentAsks(code, stray, "stray", unconfirmed)).rejects.toMatchObject({ status: 403 });

    // Bob links his computer; someone else can't take it over.
    const bobs = await linkedComputer("user_bob");
    expect(await machineStatus(bobs)).toMatchObject({ status: "linked", name: "Bob Builder" });
    const steal = await fetch(`${relay}/v1/machines/${bobs.identity.pk}/confirm`, { method: "POST", headers: { "x-human-token": await alice() }, body: "{}" });
    expect(steal.status).toBe(409);

    // His agent's request arrives as his; the owner approves it.
    const helperReq = await agentAsks(code, agent, "helper", bobs);
    const [r] = await checked(ownerCh, relay, code, [{ id: agent, requestId: helperReq.requestId }]);
    expect(r).toMatchObject({ kind: "agent", sponsoredBy: { user: "user_bob", name: "Bob Builder" } });
    await ownerCh.approve(r!);
    const roster = await ownerCh.members();
    expect(roster.find((m) => m.name === "helper")).toMatchObject({ kind: "agent", sponsor: { user: "user_bob", name: "Bob Builder" } });

    // Bob sees and removes his computer; agents from it can't ask anymore.
    const mine = (await (await fetch(`${relay}/v1/me/machines`, { headers: { "x-human-token": await token("user_bob") } })).json()) as { machines: { pk: string }[] };
    expect(mine.machines.map((m) => m.pk)).toContain(bobs.identity.pk);
    await unlinkMachine(bobs);
    await expect(agentAsks(code, late, "late", bobs)).rejects.toMatchObject({ status: 403 });
    await ownerCh.close();
  });
});

describe("each person's channel list", () => {
  test("lists channels you own, are in, or have agents in, and forgets closed ones", async () => {
    const [owner, agent, bobKey] = await Promise.all([generateIdentity("alice"), generateIdentity("scout"), generateIdentity("bob")]);
    const alice = () => token("user_alice");
    const bob = () => token("user_bob");
    const { code, access } = await Channel.create(relay, owner, { name: "alice", kind: "human" }, [], undefined, await alice(), "launch-plan");
    const room = access.roomId;
    const ownerCh = new Channel(access, relay, owner, undefined, alice);
    expect(await ownerCh.title()).toBe("launch-plan");
    expect((await myChannels(relay, await alice())).find((c) => c.room === room)).toMatchObject({ code, owner: true, member: true, agents: 0 });
    expect((await myChannels(relay, await bob())).some((c) => c.room === room)).toBe(false);

    // Bob joins himself, and his agent joins from his linked computer; the owner admits both.
    const bobReq = await Channel.requestJoin(relay, code, bobKey, { name: "bob" }, await bob());
    const req = await agentAsks(code, agent, "scout", await linkedComputer("user_bob"));
    for (const r of await checked(ownerCh, relay, code, [
      { id: bobKey, requestId: bobReq.requestId },
      { id: agent, requestId: req.requestId },
    ]))
      await ownerCh.approve(r);
    expect(bobReq.requestId).toBeTruthy();
    expect((await myChannels(relay, await bob())).find((c) => c.room === room)).toMatchObject({ owner: false, member: true, agents: 1 });

    // Members (not the relay) can read the channel's name.
    const st = await Channel.joinStatus(relay, code, agent, req.requestId);
    if (st.status !== "approved") throw new Error("not approved");
    expect(await new Channel(st.access, relay, agent).title()).toBe("launch-plan");

    // Without sign-in there's no list.
    await expect(myChannels(relay, "nope")).rejects.toMatchObject({ status: 401 });

    // Closing removes it from everyone's list.
    await ownerCh.close();
    expect((await myChannels(relay, await alice())).some((c) => c.room === room)).toBe(false);
    expect((await myChannels(relay, await bob())).some((c) => c.room === room)).toBe(false);
  });
});

describe("names", () => {
  test("people get their whole name as a handle, and the owner can't admit a name twice", async () => {
    const { handleFor } = await import("../src/membership.ts");
    expect(handleFor("Jonatas Filho")).toBe("jonatas-filho");
    expect(handleFor("Jonatas Walker")).toBe("jonatas-walker");
    expect(handleFor("  José  da Silva ")).toBe("jose-da-silva");

    const [owner, bob1, bob2, agent] = await Promise.all([generateIdentity("alice"), generateIdentity("alice"), generateIdentity("x"), generateIdentity("alice")]);
    const alice = () => token("user_alice");
    const { code, access } = await Channel.create(relay, owner, { name: "alice", kind: "human" }, [], undefined, await alice());
    const ownerCh = new Channel(access, relay, owner, undefined, alice);
    // A person who types someone else's name still gets the handle of their own account.
    const ask1 = await Channel.requestJoin(relay, code, bob1, { name: "alice" }, await token("user_bob"));
    await ownerCh.approve((await checked(ownerCh, relay, code, [{ id: bob1, requestId: ask1.requestId }]))[0]!);
    // The same account again (another browser) gets a distinct handle.
    const ask2 = await Channel.requestJoin(relay, code, bob2, { name: "whatever" }, await token("user_bob"));
    await ownerCh.approve((await checked(ownerCh, relay, code, [{ id: bob2, requestId: ask2.requestId }]))[0]!);
    // An agent can't take a name someone has.
    const ask3 = await agentAsks(code, agent, "alice", await linkedComputer("user_bob"));
    await expect(ownerCh.approve((await checked(ownerCh, relay, code, [{ id: agent, requestId: ask3.requestId }]))[0]!)).rejects.toThrow(/already someone's name/);
    expect((await ownerCh.members()).filter((m) => m.active).map((m) => m.name).sort()).toEqual(["alice", "bob-builder", "bob-builder-2"]);
    await ownerCh.close();
  });
});

describe("private beta", () => {
  test("only listed people create channels; anyone can still ask to join", async () => {
    const { OPEN_POLICY } = await import("../src/relay/policy.ts");
    const betaDir = mkdtempSync(join(tmpdir(), "mc-beta-"));
    const beta = startRelay({
      port: 0,
      hostname: "127.0.0.1",
      dataDir: betaDir,
      human,
      policy: { ...OPEN_POLICY, betaUsers: ["user_alice", "@example.com"], waitlistUrl: "https://kiwiinit.com/waitlist" },
    });
    const at = beta.url.origin;
    try {
      const [a, b, c, guest] = await Promise.all([generateIdentity("a"), generateIdentity("b"), generateIdentity("c"), generateIdentity("g")]);
      // Listed by id: yes. Listed by email domain: yes. Not listed: a clear 403 with the waitlist.
      const { code } = await Channel.create(at, a, { name: "alice-owner", kind: "human" }, [], undefined, await token("user_alice"));
      await Channel.create(at, c, { name: "carol", kind: "human" }, [], undefined, await token("user_carol"));
      await expect(Channel.create(at, b, { name: "bob", kind: "human" }, [], undefined, await token("user_bob"))).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining("https://kiwiinit.com/waitlist"),
      });
      // Bob isn't in the beta, but he can ask to join Alice's channel.
      expect((await Channel.requestJoin(at, code, guest, { name: "bob" }, await token("user_bob"))).requestId).toBeTruthy();
    } finally {
      beta.stop(true);
      rmSync(betaDir, { recursive: true, force: true });
    }
  });

  test("with no list configured, anyone signed in creates channels", async () => {
    // The shared relay in this file has no beta list: Bob could create above too.
    const owner = await generateIdentity("bob");
    const { access } = await Channel.create(relay, owner, { name: "bob", kind: "human" }, [], undefined, await token("user_bob"));
    await new Channel(access, relay, owner, undefined, () => token("user_bob")).close();
  });
});

describe("channels per person", () => {
  test("at the limit a person can't create another; closing one frees the slot", async () => {
    const { OPEN_POLICY } = await import("../src/relay/policy.ts");
    const dir = mkdtempSync(join(tmpdir(), "mc-owned-"));
    const r = startRelay({ port: 0, hostname: "127.0.0.1", dataDir: dir, human, policy: { ...OPEN_POLICY, channelsPerOwner: 1 } });
    const at = r.url.origin;
    try {
      const [first, second] = await Promise.all([generateIdentity("a"), generateIdentity("b")]);
      const alice = () => token("user_alice");
      const { access } = await Channel.create(at, first, { name: "alice-owner", kind: "human" }, [], undefined, await alice());
      await expect(Channel.create(at, second, { name: "alice-owner", kind: "human" }, [], undefined, await alice())).rejects.toMatchObject({
        status: 429,
        message: expect.stringContaining("close one to create another"),
      });
      // Others aren't affected.
      const bobs = await Channel.create(at, await generateIdentity("c"), { name: "bob", kind: "human" }, [], undefined, await token("user_bob"));
      expect(bobs.code).toBeTruthy();
      await new Channel(access, at, first, undefined, alice).close();
      expect((await Channel.create(at, second, { name: "alice-owner", kind: "human" }, [], undefined, await alice())).code).toBeTruthy();
    } finally {
      r.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("expiry and channel lists", () => {
  test("an expired channel leaves everyone's list, like a close", async () => {
    const { OPEN_POLICY } = await import("../src/relay/policy.ts");
    const dir = mkdtempSync(join(tmpdir(), "mc-expire-"));
    const clock = { now: Date.now() };
    const r = startRelay({ port: 0, hostname: "127.0.0.1", dataDir: dir, human, policy: { ...OPEN_POLICY, expireAfterDays: 90 }, now: () => clock.now });
    try {
      const owner = await generateIdentity("a");
      const { access } = await Channel.create(r.url.origin, owner, { name: "alice-owner", kind: "human" }, [], undefined, await token("user_alice"));
      expect((await myChannels(r.url.origin, await token("user_alice"))).some((c) => c.room === access.roomId)).toBe(true);
      clock.now += 91 * 86_400_000;
      expect(r.sweep()).toBe(1);
      expect((await myChannels(r.url.origin, await token("user_alice"))).some((c) => c.room === access.roomId)).toBe(false);
    } finally {
      r.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("usage", () => {
  test("a person sees their channels' use against the relay's limits; only they can", async () => {
    const { OPEN_POLICY } = await import("../src/relay/policy.ts");
    const dir = mkdtempSync(join(tmpdir(), "mc-usage-"));
    const r = startRelay({ port: 0, hostname: "127.0.0.1", dataDir: dir, human, policy: { ...OPEN_POLICY, channelsPerOwner: 2, messagesPerDay: 2000 } });
    const at = r.url.origin;
    try {
      const [owner, agent] = await Promise.all([generateIdentity("a"), generateIdentity("helper")]);
      const alice = () => token("user_alice");
      const { code, access } = await Channel.create(at, owner, { name: "alice-owner", kind: "human" }, [], undefined, await alice());
      const ownerCh = new Channel(access, at, owner, undefined, alice);
      const m = await newMachine(at);
      await registerMachine(m);
      await fetch(`${at}/v1/machines/${m.identity.pk}/confirm`, { method: "POST", headers: { "x-human-token": await alice() }, body: "{}" });
      const ask = await Channel.requestJoin(at, code, agent, { name: "helper" }, null, await vouchFor(m, access.roomId, agent.pk));
      await ownerCh.approve((await checked(ownerCh, at, code, [{ id: agent, requestId: ask.requestId }]))[0]!);
      await ownerCh.send("one");
      await ownerCh.send("two");

      // Anyone with the code sees who invited them, as sign-in knows the owner.
      expect(((await (await fetch(`${at}/v1/rooms/${access.roomId}/info`)).json()) as { ownerName?: string }).ownerName).toBe("Alice Owner");
      const u = await myUsage(at, await alice());
      expect(u.limits).toMatchObject({ channelsPerOwner: 2, messagesPerDay: 2000, membersPerChannel: null });
      expect(u.owned).toBe(1);
      expect(u.channels[0]).toMatchObject({ room: access.roomId, messagesToday: 2, members: 2 });
      expect(u.channels[0]!.bytes).toBeGreaterThan(0);
      // Someone else sees only their own (none), and can't read this channel's counts.
      expect((await myUsage(at, await token("user_bob"))).owned).toBe(0);
      const peek = await fetch(`${at}/v1/rooms/${access.roomId}/usage`, { headers: { "x-human-token": await token("user_bob") } });
      expect(peek.status).toBe(403);
    } finally {
      r.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bringing your channels to another device", () => {
  const channels = JSON.stringify({ channels: [{ code: "mc2-example", identity: { sk: "secret-member-key" } }] });

  test("your other device takes the box once, and the relay only ever holds ciphertext", async () => {
    const alice = await token("user_alice");
    const offer = await offerToDevice(relay, alice, channels);
    expect(await offerWaiting(relay, alice, offer.id)).toBe(true);
    // The secret travels in the link's fragment, which browsers never send.
    const link = offerLink(relay, offer);
    expect(new URL(link).hash).toBe(`#device=${offer.id}.${offer.secret}`);
    expect(parseOfferHash(new URL(link).hash)).toEqual({ id: offer.id, secret: offer.secret });
    // What the relay stored can't be read without that secret.
    const { Database } = await import("bun:sqlite");
    const stored = new Database(join(dataDir, "people.sqlite"), { readonly: true }).query("SELECT rec FROM devices").all() as { rec: string }[];
    expect(stored.length).toBe(1);
    expect(stored[0]!.rec).not.toContain("secret-member-key");
    expect(stored[0]!.rec).not.toContain(offer.secret);

    expect(await takeOffer(relay, await token("user_alice"), offer.id, offer.secret)).toBe(channels);
    expect(await offerWaiting(relay, alice, offer.id)).toBe(false);
    await expect(takeOffer(relay, alice, offer.id, offer.secret)).rejects.toThrow(/already used or has expired/);
  });

  test("someone else can't take it, even with the link", async () => {
    const alice = await token("user_alice");
    const offer = await offerToDevice(relay, alice, channels);
    await expect(takeOffer(relay, await token("user_bob"), offer.id, offer.secret)).rejects.toThrow(/already used or has expired/);
    expect(await offerWaiting(relay, alice, offer.id)).toBe(true);
    await withdrawOffer(relay, alice, offer.id);
  });

  test("a box under a different secret doesn't open", async () => {
    const alice = await token("user_alice");
    const offer = await offerToDevice(relay, alice, channels);
    const other = (await offerToDevice(relay, alice, channels)).secret;
    // Showing a new code retires the last one.
    expect(await offerWaiting(relay, alice, offer.id)).toBe(false);
    const fresh = await offerToDevice(relay, alice, channels);
    await expect(takeOffer(relay, alice, fresh.id, other)).rejects.toThrow(/didn’t open/);
  });

  test("signed-out requests and unknown routes are refused", async () => {
    expect((await fetch(`${relay}/v1/me/devices/transfers`, { method: "POST", body: JSON.stringify({ box: "x" }) })).status).toBe(401);
    expect((await fetch(`${relay}/v1/me/devices/elsewhere`, { headers: { "x-human-token": await token("user_alice") } })).status).toBe(404);
  });

  test("codes expire after ten minutes", async () => {
    const rows = new Map<string, DeviceTransfer>();
    const store: DeviceStore = {
      list: async () => [...rows.values()],
      put: async (_u, t) => void rows.set(t.id, t),
      remove: async (_u, id) => void rows.delete(id),
    };
    const at = (path: string, method = "GET", body?: string) =>
      token("user_alice").then((t) => new Request(`https://relay/v1/me/devices/transfers${path}`, { method, body, headers: { "x-human-token": t } }));
    const t0 = 1_000_000;
    const { id } = (await (await onDeviceHttp(await at("", "POST", JSON.stringify({ box: "ct" })), store, human, t0))!.json()) as { id: string };
    expect((await onDeviceHttp(await at(`/${id}`, "HEAD"), store, human, t0 + TRANSFER_TTL_MS))!.status).toBe(200);
    expect((await onDeviceHttp(await at(`/${id}`, "HEAD"), store, human, t0 + TRANSFER_TTL_MS + 1))!.status).toBe(404);
    expect(rows.size).toBe(0);
  });
});
