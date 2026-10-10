// `bun test` is run from inside Grok, Codex, and Claude. Those sessions export
// the same variables `kiwi join` uses to install hooks. A test that joins, or
// that runs `kiwi hooks uninstall`, would then write and strip the developer's
// real harness files. This preload runs for every test file: drop the session
// markers, and point every harness directory (and Claude's settings) at one
// temp directory for this run.
import { beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "kiwi-test-harness-"));
for (const name of ["codex", "gemini", "cursor", "grok", "claude"]) mkdirSync(join(root, name));

const DIRS: Record<string, string> = {
  KIWI_CODEX_DIR: join(root, "codex"),
  KIWI_GEMINI_DIR: join(root, "gemini"),
  KIWI_CURSOR_DIR: join(root, "cursor"),
  KIWI_GROK_DIR: join(root, "grok"),
  CLAUDE_CONFIG_DIR: join(root, "claude"),
};

const SESSION = ["CLAUDECODE", "CODEX_THREAD_ID", "GEMINI_CLI", "CURSOR_AGENT", "GROK_SESSION_ID"];

function isolate(): void {
  for (const key of SESSION) delete process.env[key];
  for (const [key, dir] of Object.entries(DIRS)) {
    if (!process.env[key]) process.env[key] = dir;
  }
}

isolate();
beforeEach(isolate);
