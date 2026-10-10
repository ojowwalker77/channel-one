// GET /info: the owner key and name only for someone holding the join code. No fingerprint is 426
// before the room is opened (GLM-1).

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

test("no fingerprint is 426 before any room lookup, and names no owner", async () => {
  const r = await info();
  expect(r.status).toBe(426);
  expect(String(r.body.error)).toContain("update kiwi");
  expect(r.body.tag).toBe("UpdateRequired");
  expect(r.body.ownerPk).toBeUndefined();
  const missing = "cd".repeat(16);
  const res = await fetch(`${relay}/v1/rooms/${missing}/info`);
  expect(res.status).toBe(426);
  expect(existsSync(join(dataDir, `${missing}.sqlite`))).toBe(false);
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
  // Without it, the probe is told to update. An empty owner key must not be sent as a fingerprint.
  await expect(probe.info()).rejects.toMatchObject({ status: 426 });
});
