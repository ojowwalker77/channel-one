// Every relay route and the check it needs, each asserted to refuse without it.
// A guard for the Effect rewrite (docs/plans/effect.md): a router rewrite that
// drops one owner() or one signature check fails here, before and after.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signRequest } from "../src/auth.ts";
import { Channel } from "../src/client.ts";
import { decodeJoinCode } from "../src/crypto.ts";
import { generateIdentity, type Identity } from "../src/identity.ts";
import { newMachine, registerMachine, vouchFor } from "../src/machine.ts";
import { CLOSE_REMOVED, WS_PROTOCOL } from "../src/protocol.ts";
import { startRelay } from "../src/relay/bun.ts";
import { devHumanAuth } from "../src/relay/human.ts";
import { checked } from "./check.ts";

setDefaultTimeout(30_000);

const dataDir = mkdtempSync(join(tmpdir(), "kiwi-auth-table-"));
let server: ReturnType<typeof startRelay>;
let relay: string;
let roomId: string;
let owner: Identity;
let member: Identity;
let stranger: Identity;
let requestId: string;
let ownerCh: Channel;
let code: string;
let linked: Awaited<ReturnType<typeof newMachine>> & { linked: { name: null; at: number } };

beforeAll(async () => {
  // A sign-in relay (dev sign-in: the token dev:<name> is dev_<name>), so the human-session checks are live.
  server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir, human: devHumanAuth() });
  relay = server.url.origin;
  owner = await generateIdentity("alice");
  member = await generateIdentity("win");
  stranger = await generateIdentity("eve");
  const made = await Channel.create(relay, owner, { name: "alice", kind: "human" }, [], undefined, "dev:alice");
  roomId = made.access.roomId;
  code = made.code;
  ownerCh = new Channel(made.access, relay, owner, undefined, async () => "dev:alice");
  const m = await newMachine(relay);
  await registerMachine(m);
  await fetch(`${relay}/v1/machines/${m.identity.pk}/confirm`, { method: "POST", headers: { "x-human-token": "dev:alice" }, body: "{}" });
  linked = { ...m, linked: { name: null, at: Date.now() } };
  const ask = await Channel.requestJoin(relay, made.code, member, { name: "win" }, null, await vouchFor(linked, decodeJoinCode(made.code).roomId, member.pk));
  await ownerCh.approve((await checked(ownerCh, relay, made.code, [{ id: member, requestId: ask.requestId }]))[0]!);
  // A pending request from someone else, for the request routes.
  const other = await generateIdentity("pat");
  requestId = (await Channel.requestJoin(relay, made.code, other, { name: "pat" }, null, await vouchFor(linked, roomId, other.pk))).requestId;
});
afterAll(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

/** A request to a room route, signed by `as` (or not signed), with an optional human session. */
async function room(method: string, path: string, opts: { as?: Identity; human?: string; body?: unknown } = {}): Promise<number> {
  const body = opts.body === undefined ? (method === "GET" || method === "DELETE" ? "" : "{}") : JSON.stringify(opts.body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.as) headers.authorization = `Bearer ${await signRequest(opts.as, roomId, method, path, body)}`;
  if (opts.human) headers["x-human-token"] = opts.human;
  const res = await fetch(`${relay}/v1/rooms/${roomId}${path}`, { method, headers, body: body || undefined });
  return res.status;
}

const refused = (s: number) => s === 401 || s === 403;

describe("member routes refuse anyone who isn't a member", () => {
  const routes: [string, string][] = [
    ["GET", "/"],
    ["GET", "/messages"],
    ["POST", "/messages"],
    ["GET", "/keys"],
    ["GET", "/icon"],
    ["GET", "/members"],
    ["DELETE", "/members/me"],
  ];
  for (const [method, path] of routes) {
    test(`${method} ${path}`, async () => {
      expect(refused(await room(method, path))).toBe(true);
      expect(refused(await room(method, path, { as: stranger }))).toBe(true);
      // A member gets past authentication (whatever the body then makes of it).
      if (method !== "DELETE") expect(refused(await room(method, path, { as: member }))).toBe(false);
    });
  }
});

describe("owner routes need the owner key AND the owning person's session", () => {
  const pk = "A".repeat(43);
  const routes: [string, string][] = [
    ["PUT", "/icon"],
    ["PUT", "/title"],
    ["GET", "/requests?v=2"],
    ["POST", `/requests/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/nonce`],
    ["POST", `/requests/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/deny`],
    ["POST", "/members"],
    ["DELETE", `/members/${pk}`],
    ["POST", "/epochs"],
    ["DELETE", "/"],
  ];
  for (const [method, path] of routes) {
    test(`${method} ${path}`, async () => {
      expect(refused(await room(method, path))).toBe(true);
      expect(refused(await room(method, path, { as: stranger, human: "dev:alice" }))).toBe(true);
      // A member, even with the owner's session: not the owner key.
      expect(refused(await room(method, path, { as: member, human: "dev:alice" }))).toBe(true);
      // The owner key with no session, or someone else's: a copied key file alone does nothing.
      expect(refused(await room(method, path, { as: owner }))).toBe(true);
      expect(refused(await room(method, path, { as: owner, human: "dev:bob" }))).toBe(true);
    });
  }
  test("and with both, they get through (GET /requests as the example)", async () => {
    expect(await room("GET", "/requests?v=2", { as: owner, human: "dev:alice" })).toBe(200);
  });
});

describe("routes with their own checks", () => {
  test("POST /create needs a signature and, here, a session", async () => {
    const fresh = "f".repeat(32);
    const create = async (opts: { as?: Identity; human?: string }) => {
      const body = "{}";
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.as) headers.authorization = `Bearer ${await signRequest(opts.as, fresh, "POST", "/create", body)}`;
      if (opts.human) headers["x-human-token"] = opts.human;
      return (await fetch(`${relay}/v1/rooms/${fresh}/create`, { method: "POST", headers, body })).status;
    };
    expect(refused(await create({}))).toBe(true);
    expect(refused(await create({ as: stranger }))).toBe(true);
  });

  test("POST /requests needs a session or a linked computer's vouch on a sign-in relay", async () => {
    expect(await room("POST", "/requests", { body: {} })).not.toBe(200);
    const unvouched = await generateIdentity("x");
    const status = await room("POST", "/requests", { as: unvouched, body: { pk: unvouched.pk } });
    expect(status === 400 || refused(status)).toBe(true);
  });

  test("GET /usage is the owning person's only", async () => {
    expect(refused(await room("GET", "/usage"))).toBe(true);
    expect(refused(await room("GET", "/usage", { human: "dev:bob" }))).toBe(true);
    expect(await room("GET", "/usage", { human: "dev:alice" })).toBe(200);
  });

  test("a request's status and reveal need the requester's own signature", async () => {
    expect(refused(await room("GET", `/requests/${requestId}`))).toBe(true);
    expect(await room("GET", `/requests/${requestId}`, { as: stranger })).toBe(404);
    expect(refused(await room("POST", `/requests/${requestId}/reveal`))).toBe(true);
    expect(await room("POST", `/requests/${requestId}/reveal`, { as: stranger, body: { nonce: "x" } })).not.toBe(200);
  });

  test("GET /info is public (the join code is the secret)", async () => {
    expect(await room("GET", "/info")).toBe(200);
  });
});

describe("person routes need a sign-in", () => {
  const routes: [string, string][] = [
    ["GET", "/v1/me/vault"],
    ["PUT", "/v1/me/vault"],
    ["DELETE", "/v1/me/vault"],
    ["GET", "/v1/me/channels"],
    ["GET", "/v1/me/usage"],
    ["POST", "/v1/me/devices/transfers"],
    ["GET", "/v1/me/machines"],
    ["POST", `/v1/machines/${"A".repeat(43)}/confirm`],
  ];
  for (const [method, path] of routes) {
    test(`${method} ${path}`, async () => {
      const res = await fetch(`${relay}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      expect(refused(res.status)).toBe(true);
      const bad = await fetch(`${relay}${path}`, { method, headers: { "content-type": "application/json", "x-human-token": "not-a-token" }, body: method === "GET" ? undefined : "{}" });
      expect(refused(bad.status)).toBe(true);
    });
  }
});

describe("the live stream (WebSocket)", () => {
  /** Open the room's socket as `as`; resolves to "open" or the close code if it never opens. */
  const connect = async (as?: Identity) => {
    const u = new URL(`/v1/rooms/${roomId}/ws`, relay);
    u.protocol = "ws:";
    const protocols = as ? [WS_PROTOCOL, await signRequest(as, roomId, "GET", "/ws")] : [WS_PROTOCOL];
    const ws = new WebSocket(u, protocols);
    const opened = await new Promise<"open" | number>((resolve) => {
      ws.onopen = () => resolve("open");
      ws.onclose = (e) => resolve(e.code);
      ws.onerror = () => {};
    });
    return { ws, opened };
  };

  test("no key, or a stranger's, can't open it; a member can", async () => {
    expect((await connect()).opened).not.toBe("open");
    expect((await connect(stranger)).opened).not.toBe("open");
    const m = await connect(member);
    expect(m.opened).toBe("open");
    m.ws.close();
  });

  test("a removed member's open socket is closed (CLOSE_REMOVED), and it can't open another", async () => {
    const bye = await generateIdentity("bye");
    const ask = await Channel.requestJoin(relay, code, bye, { name: "bye" }, null, await vouchFor(linked, roomId, bye.pk));
    const req = (await checked(ownerCh, relay, code, [{ id: bye, requestId: ask.requestId }])).find((r) => r.pk === bye.pk)!;
    await ownerCh.approve(req);
    const { ws, opened } = await connect(bye);
    expect(opened).toBe("open");
    const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)));
    await ownerCh.remove(bye.pk);
    expect(await closed).toBe(CLOSE_REMOVED);
    expect((await connect(bye)).opened).not.toBe("open");
  });
});
