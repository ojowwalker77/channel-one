// Back up a Bun relay's data directory while it runs.
// Usage: bun scripts/backup-relay.ts <data dir> <backup dir>
//
// Rooms are SQLite files in WAL mode, so copying them can catch a write
// halfway. VACUUM INTO writes a consistent snapshot of each one instead.
// A backup holds ciphertext, member keys and join codes: a channel closed
// after it was taken is still in it. Keep backups as private as the relay.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error("usage: bun scripts/backup-relay.ts <data dir> <backup dir>");
  process.exit(1);
}
mkdirSync(to, { recursive: true, mode: 0o700 });
let n = 0;
for (const f of readdirSync(from)) {
  if (!/^([0-9a-f]{32}|people)\.sqlite$/.test(f)) continue;
  const out = join(to, f);
  if (existsSync(out)) rmSync(out);
  const db = new Database(join(from, f), { readonly: true });
  db.run("VACUUM INTO ?", [out]);
  db.close();
  n++;
}
console.log(`backed up ${n} file${n === 1 ? "" : "s"} to ${to}`);
