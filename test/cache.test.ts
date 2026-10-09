// The message cache every listener on a machine shares.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "kiwi-cache-"));
process.env.KIWI_HOME = dir;
const { appendCache, readCache } = await import("../src/config.ts");
afterAll(() => {
  delete process.env.KIWI_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const msg = (seq: number) => ({ v: 1, id: String(seq), from: "a", kind: "msg", body: `m${seq}`, ts: seq, seq, sigOk: true }) as never;
const lines = (room: string) => readFileSync(join(dir, "cache", `${room}.jsonl`), "utf8").trim().split("\n").length;

test("two listeners appending the same messages store each one once", () => {
  const room = "a".repeat(32);
  appendCache(room, [msg(1), msg(2)]);
  appendCache(room, [msg(1), msg(2), msg(3)]); // a second listener catching up
  appendCache(room, [msg(3)]);
  expect(lines(room)).toBe(3);
  expect(readCache(room).map((m) => m.seq)).toEqual([1, 2, 3]);
});

test("a cache with copies from older versions is rewritten without them", () => {
  const room = "b".repeat(32);
  writeFileSync(join(dir, "cache", `${room}.jsonl`), [1, 2, 2, 3, 3, 3].map((s) => JSON.stringify(msg(s))).join("\n") + "\n");
  expect(readCache(room).map((m) => m.seq)).toEqual([1, 2, 3]);
  expect(lines(room)).toBe(3);
  appendCache(room, [msg(3), msg(4)]);
  expect(lines(room)).toBe(4);
});
