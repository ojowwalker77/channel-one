// A room created by an older relay, before a column this one reads existed (members.read_only,
// from member scopes). 0.8.6 read it without adding it first, and every such channel's member
// list and sends failed with 500. The room must be brought up to date before anything reads it.

import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "../src/client.ts";
import { generateIdentity } from "../src/identity.ts";
import { startRelay } from "../src/relay/bun.ts";

const dataDir = mkdtempSync(join(tmpdir(), "mc-old-room-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

test("a room from before read_only: members and sends work, and the column is added", async () => {
  let server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
  const owner = await generateIdentity("human");
  const { access } = await Channel.create(server.url.origin, owner, { name: "human" });
  server.stop(true);

  // Make it the room an older relay left behind.
  const file = join(dataDir, `${access.roomId}.sqlite`);
  let db = new Database(file);
  db.run("ALTER TABLE members DROP COLUMN read_only");
  db.close();

  server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
  try {
    const ch = new Channel(access, server.url.origin, owner);
    expect((await ch.members()).map((m) => m.name)).toContain("human");
    expect(await ch.send("still here")).toBeGreaterThan(0);
  } finally {
    server.stop(true);
  }
  db = new Database(file);
  const cols = (db.query("PRAGMA table_info(members)").all() as { name: string }[]).map((c) => c.name);
  db.close();
  expect(cols).toContain("read_only");
});

test("a room from before the usage row: its stored bytes are counted once, and a send keeps them right", async () => {
  let server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
  const owner = await generateIdentity("human");
  const { access } = await Channel.create(server.url.origin, owner, { name: "human" });
  await new Channel(access, server.url.origin, owner).send("before");
  server.stop(true);

  // The previous layout: three counter rows, no usage row.
  const file = join(dataDir, `${access.roomId}.sqlite`);
  let db = new Database(file);
  const before = (db.query("SELECT COALESCE(SUM(LENGTH(ct)), 0) AS n FROM msgs").get() as { n: number }).n;
  db.run("DELETE FROM meta WHERE k = 'usage'");
  db.run("INSERT INTO meta (k, v) VALUES ('bytes', ?), ('day', '2026-01-01'), ('day_count', '7')", [String(before)]);
  db.close();

  server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
  try {
    expect(await new Channel(access, server.url.origin, owner).send("after")).toBeGreaterThan(0);
  } finally {
    server.stop(true);
  }
  db = new Database(file);
  const stored = (db.query("SELECT COALESCE(SUM(LENGTH(ct)), 0) AS n FROM msgs").get() as { n: number }).n;
  const usage = JSON.parse((db.query("SELECT v FROM meta WHERE k = 'usage'").get() as { v: string }).v) as { bytes: number; n: number };
  db.close();
  expect(usage.bytes).toBe(stored);
  expect(usage.n).toBe(1);
});
