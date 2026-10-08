import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, relayConfig } from "../src/client.ts";
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

const human = workosHumanAuth("client_test", `${jwks.url.origin}/jwks`);
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
    const pending = await asAlice.requests();
    expect(pending.map((r) => r.code)).toEqual([req.verify]);
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
