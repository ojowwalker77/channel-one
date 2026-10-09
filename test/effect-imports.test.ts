// Effect is imported per module ("effect/Schema"), never from the package root:
// one root import pulls all of Effect into the Worker (59KB gzipped becomes 135KB).

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === "dist") return [];
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

test("nothing imports from the root of 'effect'", () => {
  const root = join(import.meta.dir, "..");
  const offenders = [...sources(join(root, "src")), ...sources(join(root, "web/src"))].filter((f) => /from\s+["']effect["']/.test(readFileSync(f, "utf8")));
  expect(offenders.map((f) => relative(root, f))).toEqual([]);
});
