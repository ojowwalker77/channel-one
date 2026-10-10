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
