import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorChecks, type Finding } from "../src/cli/doctor.ts";
import { b64url } from "../src/crypto.ts";
import { newMachine, registerMachine, saveMachine, type MachineFile } from "../src/machine.ts";
import { startRelay } from "../src/relay/bun.ts";
import { workosHumanAuth } from "../src/relay/human.ts";

// A stand-in for WorkOS, same shape as test/human.test.ts: the relay can confirm and remove a computer.
const rsa = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const jwk = (await crypto.subtle.exportKey("jwk", rsa.publicKey)) as { n: string; e: string };
const jwks = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => Response.json({ keys: [{ kty: "RSA", kid: "k1", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }] }),
});

async function token(sub: string): Promise<string> {
  const enc = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
  const body = enc({ sub, iss: "https://api.workos.com/user_management/client_test", exp: Math.floor(Date.now() / 1000) + 300 });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsa.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const human = {
  ...workosHumanAuth("client_test", `${jwks.url.origin}/jwks`),
  profile: async (u: string) => (u === "user_alice" ? { name: "Alice Owner", email: "alice@example.com" } : null),
};

const tmp = mkdtempSync(join(tmpdir(), "kiwi-doctor-"));
let openRelay: ReturnType<typeof startRelay>;
let signedIn: ReturnType<typeof startRelay>;

beforeAll(() => {
  openRelay = startRelay({ port: 0, hostname: "127.0.0.1", dataDir: join(tmp, "open") });
  signedIn = startRelay({ port: 0, hostname: "127.0.0.1", dataDir: join(tmp, "signed"), human });
});
afterAll(() => {
  openRelay.stop(true);
  signedIn.stop(true);
  jwks.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

/** Run the checks with a throwaway home, then put the environment back. */
async function checks(env: Record<string, string>): Promise<Finding[]> {
  const prev = { KIWI_HOME: process.env.KIWI_HOME, KIWI_RELAY: process.env.KIWI_RELAY };
  const home = mkdtempSync(join(tmp, "home-"));
  process.env.KIWI_HOME = home;
  process.env.KIWI_RELAY = env.KIWI_RELAY;
  try {
    return await doctorChecks();
  } finally {
    if (prev.KIWI_HOME === undefined) delete process.env.KIWI_HOME;
    else process.env.KIWI_HOME = prev.KIWI_HOME;
    if (prev.KIWI_RELAY === undefined) delete process.env.KIWI_RELAY;
    else process.env.KIWI_RELAY = prev.KIWI_RELAY;
  }
}

const mentionsLink = (f: Finding) => /link|kiwi setup/i.test(`${f.what}\n${"how" in f ? f.how : ""}`);

describe("kiwi doctor", () => {
  test("a relay with no sign-in is not asked for a computer link", async () => {
    const found = await checks({ KIWI_RELAY: openRelay.url.origin });
    expect(found.some((f) => f.ok && f.what.includes("/v1/config answered"))).toBe(true);
    expect(found.some(mentionsLink)).toBe(false);
  });

  test("an unreachable relay is reported as down, not as a missing link", async () => {
    const found = await checks({ KIWI_RELAY: "http://127.0.0.1:1" });
    const down = found.find((f) => !f.ok && f.what.includes("http://127.0.0.1:1"));
    expect(down?.ok).toBe(false);
    expect(found.some(mentionsLink)).toBe(false);
  });

  test("a removed computer is reported only because the relay says the link is gone", async () => {
    const relay = signedIn.url.origin;
    const prev = { KIWI_HOME: process.env.KIWI_HOME, KIWI_RELAY: process.env.KIWI_RELAY };
    const home = mkdtempSync(join(tmp, "home-"));
    process.env.KIWI_HOME = home;
    process.env.KIWI_RELAY = relay;
    try {
      const m = await newMachine(relay);
      await registerMachine(m);
      const headers = { "x-human-token": await token("user_alice") };
      const confirm = await fetch(`${relay}/v1/machines/${m.identity.pk}/confirm`, { method: "POST", headers, body: "{}" });
      expect(confirm.ok).toBe(true);
      const removed = await fetch(`${relay}/v1/me/machines/${m.identity.pk}`, { method: "DELETE", headers });
      expect(removed.ok).toBe(true);
      const linked: MachineFile = { ...m, linked: { name: "Alice Owner", at: Date.now() } };
      saveMachine(linked);

      const found = await doctorChecks();
      expect(found.some((f) => !f.ok && f.what === "this computer's link was removed.")).toBe(true);
      expect(found.some((f) => !f.ok && f.what.startsWith("couldn't check this computer's link"))).toBe(false);
    } finally {
      if (prev.KIWI_HOME === undefined) delete process.env.KIWI_HOME;
      else process.env.KIWI_HOME = prev.KIWI_HOME;
      if (prev.KIWI_RELAY === undefined) delete process.env.KIWI_RELAY;
      else process.env.KIWI_RELAY = prev.KIWI_RELAY;
    }
  });
});
