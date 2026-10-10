// GET /info: the owner key for anyone (old clients need it), the owner's name only for someone holding the join code (GLM-1).

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "../src/client.ts";
import { decodeJoinCode } from "../src/crypto.ts";
import { generateIdentity } from "../src/identity.ts";
import { startRelay } from "../src/relay/bun.ts";
import { devHumanAuth } from "../src/relay/human.ts";

setDefaultTimeout(30_000);
const dataDir = mkdtempSync(join(tmpdir(), "kiwi-info-"));
let server: ReturnType<typeof startRelay>;
let relay: string;
let code: string;
let roomId: string;
beforeAll(async () => {
  server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir, human: devHumanAuth() });
  relay = server.url.origin;
  const owner = await generateIdentity("alice");
  ({ code } = await Channel.create(relay, owner, { name: "alice", kind: "human" }, [], undefined, "dev:alice"));
  roomId = decodeJoinCode(code).roomId;
});
afterAll(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

const info = async (fp?: string) => {
  const res = await fetch(`${relay}/v1/rooms/${roomId}/info${fp === undefined ? "" : `?fp=${fp}`}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

test("with the code's fingerprint: everything, the owner's name included", async () => {
  const r = await info(decodeJoinCode(code).ownerFp);
  expect(r.status).toBe(200);
  expect(r.body.ownerName).toBe("Alice (dev)");
});

test("a wrong fingerprint is answered like a missing room", async () => {
  const r = await info("x".repeat(22));
  expect(r).toEqual({ status: 404, body: { error: "no such channel", tag: "ChannelGone" } });
});

test("no fingerprint (clients before 0.8.2): the owner key still, but not the name", async () => {
  const r = await info();
  expect(r.status).toBe(200);
  expect(typeof r.body.ownerPk).toBe("string");
  expect(r.body.ownerName).toBeNull();
});

test("this client sends it: joining still pins the owner", async () => {
  const joiner = await generateIdentity("win");
  const ask = await Channel.requestJoin(relay, code, joiner, { name: "win" }, "dev:bob");
  expect(ask.requestId).toBeTruthy();
});

test("a probe that doesn't know the owner yet (the dashboard's owner link) passes the code's fingerprint", async () => {
  const probe = new Channel({ roomId, ownerPk: "", ownerXpk: "", epoch: 0, keys: {} }, relay, await generateIdentity("probe"));
  const i = await probe.info(decodeJoinCode(code).ownerFp);
  expect(i.ownerName).toBe("Alice (dev)");
  // Without it, it still gets the owner key (the compat path), never a 404 from an empty key's fingerprint.
  expect(typeof (await probe.info()).ownerPk).toBe("string");
});
