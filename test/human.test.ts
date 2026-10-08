import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, myChannels, relayConfig } from "../src/client.ts";
import { b64url } from "../src/crypto.ts";
import { generateIdentity } from "../src/identity.ts";
import { startRelay } from "../src/relay/bun.ts";
import { workosHumanAuth } from "../src/relay/human.ts";

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

const names: Record<string, string> = { user_alice: "Alice Owner", user_bob: "Bob Builder" };
const human = { ...workosHumanAuth("client_test", `${jwks.url.origin}/jwks`), profile: async (u: string) => (names[u] ? { name: names[u]! } : null) };
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

    // Someone asks to join.
    const req = await Channel.requestJoin(relay, code, agent, { name: "mac" });

    // The owner key alone (e.g. an agent that copied it) can't see or approve requests.
    const keyOnly = new Channel(access, relay, owner);
    await expect(keyOnly.requests()).rejects.toMatchObject({ status: 401 });

    // Another signed-in human with the same key file can't either.
    const bob = new Channel(access, relay, owner, undefined, () => token("user_bob"));
    await expect(bob.requests()).rejects.toMatchObject({ status: 403 });

    // The owning human can.
    const asAlice = new Channel(access, relay, owner, undefined, () => token("user_alice"));
    // Alice vouches for this agent as hers, then approves it.
    await Channel.sponsor(relay, code, req.requestId, await token("user_alice"));
    const pending = await asAlice.requests();
    expect(pending.map((r) => r.code)).toEqual([req.verify]);
    await asAlice.approveWithSponsor(pending[0]!);
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

describe("an agent needs its own human's approval too", () => {
  test("no keys until its human vouches and the owner approves; names come from sign-in", async () => {
    const [owner, agent, bobKey] = await Promise.all([generateIdentity("alice"), generateIdentity("helper"), generateIdentity("bob")]);
    const alice = () => token("user_alice");
    const { code, access } = await Channel.create(
      relay,
      owner,
      { name: "alice", kind: "human", display: "Alice Owner", sponsor: { user: "user_alice", name: "Alice Owner", handle: "alice" } },
      [],
      undefined,
      await alice(),
    );
    const ownerCh = new Channel(access, relay, owner, undefined, alice);

    // The agent asks; the owner can't let it in before its human vouches.
    const req = await Channel.requestJoin(relay, code, agent, { name: "helper" });
    let [r] = await ownerCh.requests();
    expect(r!.kind).toBe("agent");
    expect(r!.sponsoredBy).toBeNull();
    await expect(ownerCh.approve(r!)).rejects.toMatchObject({ status: 409 });

    // The sponsor page shows the same verification code the agent printed.
    expect((await Channel.publicRequest(relay, code, req.requestId)).verify).toBe(req.verify);
    // Vouching needs a sign-in.
    await expect(Channel.sponsor(relay, code, req.requestId, "nope")).rejects.toMatchObject({ status: 401 });

    // Bob (the agent's human) asks to join as himself, and vouches for his agent.
    const bobReq = await Channel.requestJoin(relay, code, bobKey, { name: "bob" }, await token("user_bob"));
    expect((await Channel.sponsor(relay, code, req.requestId, await token("user_bob"), bobReq.requestId)).by).toBe("Bob Builder");
    // Nobody else can take over the vouch.
    await expect(Channel.sponsor(relay, code, req.requestId, await alice())).rejects.toMatchObject({ status: 409 });
    expect((await Channel.joinStatus(relay, code, agent, req.requestId)).status).toBe("pending");

    // The owner sees whose agent it is, and admits both in one go.
    const reqs = await ownerCh.requests();
    r = reqs.find((x) => x.id === req.requestId);
    expect(r!.sponsoredBy).toEqual({ user: "user_bob", name: "Bob Builder" });
    expect(reqs.find((x) => x.id === bobReq.requestId)).toMatchObject({ kind: "human", sponsoredBy: { name: "Bob Builder" } });
    const admitted = await ownerCh.approveWithSponsor(r!);
    expect(admitted.map((m) => m.name)).toEqual(["bob", "helper"]);

    // Everyone sees verified real names and who acts for whom.
    const st = await Channel.joinStatus(relay, code, agent, req.requestId);
    if (st.status !== "approved") throw new Error("not approved");
    const roster = await new Channel(st.access, relay, agent).members();
    const by = Object.fromEntries(roster.map((m) => [m.name, m]));
    expect(by.alice).toMatchObject({ kind: "human", display: "Alice Owner", owner: true });
    expect(by.bob).toMatchObject({ kind: "human", display: "Bob Builder" });
    expect(by.helper).toMatchObject({ kind: "agent", sponsor: { user: "user_bob", name: "Bob Builder", handle: "bob" } });
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

    // Bob's agent asks, Bob vouches and asks to join himself; the owner admits both.
    const req = await Channel.requestJoin(relay, code, agent, { name: "scout" });
    const bobReq = await Channel.requestJoin(relay, code, bobKey, { name: "bob" }, await bob());
    await Channel.sponsor(relay, code, req.requestId, await bob(), bobReq.requestId);
    const r = (await ownerCh.requests()).find((x) => x.id === req.requestId)!;
    await ownerCh.approveWithSponsor(r);
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
