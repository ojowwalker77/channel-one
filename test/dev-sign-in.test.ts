// Dev sign-in: a local relay where "dev:<name>" is <name>, so the signed-in flows
// (owner, vouched agents, vault) can be tested end to end without WorkOS.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, relayConfig } from "../src/client.ts";
import { decodeJoinCode } from "../src/crypto.ts";
import { generateIdentity } from "../src/identity.ts";
import { newMachine, registerMachine, vouchFor } from "../src/machine.ts";
import { startRelay } from "../src/relay/bun.ts";
import { devHostOk, devHumanAuth } from "../src/relay/human.ts";
import { fetchVault, newVault, putVault } from "../src/vault.ts";
import { checked } from "./check.ts";

setDefaultTimeout(30_000);

const dataDir = mkdtempSync(join(tmpdir(), "kiwi-dev-"));
let server: ReturnType<typeof startRelay>;
let relay: string;
beforeAll(() => {
  server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir, human: devHumanAuth() });
  relay = server.url.origin;
});
afterAll(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

test("only on this machine", () => {
  expect(["127.0.0.1", "localhost", "::1"].every(devHostOk)).toBe(true);
  expect([undefined, "0.0.0.0", "192.168.1.5", "relay.example.com"].some(devHostOk)).toBe(false);
});

test("the relay says it's dev, and dev tokens are the only ones it takes", async () => {
  expect(await relayConfig(relay)).toMatchObject({ workosClientId: "dev", dev: true });
  const auth = devHumanAuth();
  // Namespaced, so a dev relay on a copy of real data can never sign in as a real WorkOS user.
  expect(await auth.verify("dev:alice")).toBe("dev_alice");
  expect(await auth.verify("dev:user_01HREALID")).toBe("dev_user_01HREALID");
  expect((await auth.profile!("dev_alice"))?.name).toBe("Alice (dev)");
  for (const bad of ["alice", "dev:", "dev:../x", "dev:a b", "Bearer dev:alice"]) expect(await auth.verify(bad)).toBeNull();
});

test("a signed-in owner, a vouched agent and a vault, end to end", async () => {
  const owner = await generateIdentity("alice");
  const { code, access } = await Channel.create(relay, owner, { name: "alice", kind: "human" }, [], undefined, "dev:alice");
  const ownerCh = new Channel(access, relay, owner, undefined, async () => "dev:alice");

  // alice links her computer, and an agent joins from it, vouched for.
  const m = await newMachine(relay);
  await registerMachine(m);
  const confirmed = await fetch(`${relay}/v1/machines/${m.identity.pk}/confirm`, { method: "POST", headers: { "x-human-token": "dev:alice" }, body: "{}" });
  expect(confirmed.ok).toBe(true);
  const agent = await generateIdentity("win");
  const ask = await Channel.requestJoin(relay, code, agent, { name: "win" }, null, await vouchFor({ ...m, linked: { name: null, at: Date.now() } }, decodeJoinCode(code).roomId, agent.pk));
  const [req] = await checked(ownerCh, relay, code, [{ id: agent, requestId: ask.requestId }]);
  expect(req!.sponsoredBy?.user).toBe("dev_alice");
  const admitted = await ownerCh.approve(req!);
  expect(admitted.sponsor?.name).toBe("Alice (dev)");

  // Owner actions still need the session: without it, nothing.
  const noSession = new Channel(access, relay, owner);
  await expect(noSession.rotate()).rejects.toThrow();

  // Her vault, saved and read back as her.
  const v = await newVault("dev_alice", { channels: [], gone: {} }, { kind: "passkey", label: "test", secret: crypto.getRandomValues(new Uint8Array(32)), credentialId: "c" });
  expect(await putVault(relay, "dev:alice", "dev_alice", 0, v.blob, v.writer, v.writer.pk)).toEqual({ version: 1 });
  expect((await fetchVault(relay, "dev:alice"))?.version).toBe(1);
  expect(await fetchVault(relay, "dev:bob")).toBeNull();
});

test("a dev token is refused unless the request comes straight from this machine", async () => {
  const get = (headers: Record<string, string>) => fetch(`${relay}/v1/me/vault`, { headers: { "x-human-token": "dev:alice", ...headers } });
  expect((await get({})).status).not.toBe(403);
  // Passed on by a reverse proxy on this machine, or asked for under a public name: no.
  const proxied: Record<string, string>[] = [{ "x-forwarded-for": "203.0.113.9" }, { forwarded: "for=203.0.113.9" }, { "x-real-ip": "203.0.113.9" }, { via: "1.1 caddy" }, { host: "relay.example.com" }];
  for (const h of proxied) {
    const res = await get(h);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("only takes requests made on this machine");
  }
});
