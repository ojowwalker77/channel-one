// Refusals carry what they mean (src/errors.ts), so clients branch on a tag, not on message text.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signRequest } from "../src/auth.ts";
import { Channel, RelayError } from "../src/client.ts";
import { tagForStatus } from "../src/errors.ts";
import { generateIdentity } from "../src/identity.ts";
import { startRelay } from "../src/relay/bun.ts";
import { devHumanAuth } from "../src/relay/human.ts";
import { fetchVault } from "../src/vault.ts";
import { checked } from "./check.ts";

setDefaultTimeout(30_000);

const dataDir = mkdtempSync(join(tmpdir(), "kiwi-tags-"));
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

const caught = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as RelayError);

test("not the owner, not a member, removed, gone: each says so", async () => {
  const owner = await generateIdentity("human");
  const made = await Channel.create(relay, owner, { name: "human" });
  const ownerCh = new Channel(made.access, relay, owner);
  const agent = await generateIdentity("win");
  const ask = await Channel.requestJoin(relay, made.code, agent, { name: "win" });
  await ownerCh.approve((await checked(ownerCh, relay, made.code, [{ id: agent, requestId: ask.requestId }]))[0]!);
  const st = await Channel.joinStatus(relay, made.code, agent, ask.requestId);
  const memberCh = new Channel((st as { access: import("../src/crypto.ts").ChannelAccess }).access, relay, agent);

  // A member signing an owner route: the relay says NotOwner.
  const body = JSON.stringify({ icon: null });
  const res = await fetch(`${relay}/v1/rooms/${made.access.roomId}/icon`, {
    method: "PUT",
    headers: { authorization: `Bearer ${await signRequest(agent, made.access.roomId, "PUT", "/icon", body)}` },
    body,
  });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "only the channel owner can do that", tag: "NotOwner" });
  void memberCh;

  // A key that isn't a member. (Channel turns this into ChannelGone("removed") for its callers.)
  const eve = await generateIdentity("eve");
  const asEve = await fetch(`${relay}/v1/rooms/${made.access.roomId}/`, { headers: { authorization: `Bearer ${await signRequest(eve, made.access.roomId, "GET", "/")}` } });
  expect(await asEve.json()).toEqual({ error: "not a member of this channel", tag: "NotMember" });

  await ownerCh.remove(agent.pk);
  expect((await caught(Channel.requestJoin(relay, made.code, agent, { name: "win" })))?.tag).toBe("Removed");

  await ownerCh.close();
  expect((await caught(Channel.resume(relay, made.code, owner)))?.tag).toBe("ChannelGone");
});

test("sign-in and vault conflicts say so too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-tags-dev-"));
  const dev = startRelay({ port: 0, hostname: "127.0.0.1", dataDir: dir, human: devHumanAuth() });
  try {
    expect((await caught(fetchVault(dev.url.origin, "nope")))?.tag).toBe("SignInRequired");
    const res = await fetch(`${dev.url.origin}/v1/me/vault`, { method: "PUT", headers: { "x-human-token": "dev:al" }, body: JSON.stringify({ version: 3, blob: "x" }) });
    expect(await res.json()).toMatchObject({ tag: "VaultConflict" });
  } finally {
    dev.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an older relay that sends no tag still gets one, from the status", () => {
  expect(new RelayError(403, "only the channel owner can do that").tag).toBe("Forbidden");
  expect(new RelayError(409, "x", "VaultConflict").tag).toBe("VaultConflict");
  expect(new RelayError(409, "x", "MadeUp").tag).toBe("Conflict");
  expect(tagForStatus(418)).toBe("Internal");
});
