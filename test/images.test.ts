// Message images are the same raster list as icons. SVG is refused on send and dropped on receive.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadImages } from "../src/attach.ts";
import { signRequest } from "../src/auth.ts";
import { Channel } from "../src/client.ts";
import { seal } from "../src/crypto.ts";
import { generateIdentity, sign, type Identity } from "../src/identity.ts";
import { PROTOCOL_VERSION, type ImageAttachment } from "../src/protocol.ts";
import { startRelay } from "../src/relay/bun.ts";
import { checked } from "./check.ts";

setDefaultTimeout(30_000);

const dataDir = mkdtempSync(join(tmpdir(), "kiwi-images-"));
let server: ReturnType<typeof startRelay>;
let relay: string;
let ownerCh: Channel;
let memberCh: Channel;
let member: Identity;

const png: ImageAttachment = { name: "a.png", mime: "image/png", data: Buffer.from("png").toString("base64") };
const svg: ImageAttachment = { name: "b.svg", mime: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64") };

beforeAll(async () => {
  server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
  relay = server.url.origin;
  const owner = await generateIdentity("human");
  const made = await Channel.create(relay, owner, { name: "human" });
  ownerCh = new Channel(made.access, relay, owner);
  member = await generateIdentity("win");
  const ask = await Channel.requestJoin(relay, made.code, member, { name: "win" });
  await ownerCh.approve((await checked(ownerCh, relay, made.code, [{ id: member, requestId: ask.requestId }]))[0]!);
  const st = await Channel.joinStatus(relay, made.code, member, ask.requestId);
  memberCh = new Channel((st as { access: import("../src/crypto.ts").ChannelAccess }).access, relay, member);
});
afterAll(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

test("send refuses an svg attachment", async () => {
  await expect(memberCh.send("look", { imgs: [svg] })).rejects.toThrow(/png, jpg, gif or webp/);
});

test("a png attachment is kept", async () => {
  const seq = await memberCh.send("just png", { imgs: [png] });
  const got = (await ownerCh.history(seq - 1)).messages.find((m) => m.seq === seq);
  expect(got?.imgs).toEqual([png]);
});

/** Post ciphertext the way a member who skipped the send check would. */
async function post(imgs: ImageAttachment[], body: string): Promise<number> {
  const signed = await sign(member, {
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    from: "win",
    kind: "msg" as const,
    body,
    imgs,
    ts: Date.now(),
  });
  const e = memberCh.access.epoch;
  const sealed = await seal(memberCh.access.keys[String(e)]!, memberCh.roomId, signed);
  const raw = JSON.stringify({ ...sealed, e });
  const auth = await signRequest(member, memberCh.roomId, "POST", "/messages", raw);
  const res = await fetch(`${relay}/v1/rooms/${memberCh.roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
    body: raw,
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { seq: number }).seq;
}

test("an svg posted beside a png is dropped on receive, and the png stays", async () => {
  const seq = await post([png, svg], "both");
  const got = (await ownerCh.history(seq - 1)).messages.find((m) => m.seq === seq);
  expect(got?.body).toBe("both");
  expect(got?.imgs).toEqual([png]);
});

test("a message that is only an svg keeps its text and loses the image", async () => {
  const seq = await post([svg], "only svg");
  const got = (await ownerCh.history(seq - 1)).messages.find((m) => m.seq === seq);
  expect(got?.body).toBe("only svg");
  expect(got?.imgs).toBeUndefined();
});

test("the cli refuses an svg file", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-images-cli-"));
  try {
    const path = join(dir, "pic.svg");
    writeFileSync(path, "<svg/>");
    expect(() => loadImages([path])).toThrow(/png, jpg, gif or webp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
