// `kiwi doctor` looks at this computer and prints a fix for each problem.
// It does not change anything.

import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RELAY, loadConfig } from "../config.ts";
import { hooksInstalled } from "../hooks.ts";
import { loadMachine, machineStatus } from "../machine.ts";
import { VERSION } from "../version.ts";

const problems: string[] = [];

function ok(line: string): void {
  process.stdout.write(`ok   ${line}\n`);
}

function fix(what: string, how: string): void {
  problems.push(how);
  process.stdout.write(`fix  ${what}\n     ${how}\n`);
}

/** What `kiwi version` prints, or null if that binary can't say. */
function binVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 5_000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = out.trim().split("\n")[0];
      resolve(code === 0 && line ? line : null);
    });
  });
}

async function checkLink(relay: string): Promise<void> {
  const m = loadMachine();
  if (!m?.linked) return fix("this computer isn't linked to an account.", "Run kiwi setup.");
  if (m.relay !== relay) return fix(`this computer is linked at ${m.relay}, not ${relay}.`, "Run kiwi setup again for this relay.");
  const st = await machineStatus(m).catch(() => null);
  if (st?.status === "linked") return ok(`link     ${st.name ?? m.linked.name ?? "your account"} (${m.label})`);
  fix("this computer's link was removed.", "Run kiwi setup again.");
}

async function checkRelay(relay: string): Promise<void> {
  let host: string;
  try {
    host = new URL(relay).hostname;
  } catch {
    return fix(`${relay} is not a URL.`, "Set KIWI_RELAY to the relay's https address.");
  }
  try {
    await lookup(host);
  } catch {
    return fix(`DNS for ${host} did not resolve.`, "Check the name, or the network, then run kiwi doctor again.");
  }
  try {
    const res = await fetch(new URL("/v1/config", relay), { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return fix(`${relay}/v1/config returned ${res.status}.`, "The relay is up but not answering. Check that Kiwi is the thing listening there.");
    const body = (await res.json()) as { workosClientId?: unknown };
    if (!body || typeof body !== "object" || !("workosClientId" in body)) {
      return fix(`${relay}/v1/config answered, but not as a Kiwi relay.`, "Point KIWI_RELAY at your Kiwi relay.");
    }
    ok(`relay    ${relay}  /v1/config answered`);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    fix(`could not reach ${relay} (${why}).`, "Start the relay, or fix KIWI_RELAY, then run kiwi doctor again.");
  }
}

function checkHooks(): void {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  if (!existsSync(dir)) return ok("hooks    Claude Code is not installed here");
  let installed = false;
  try {
    installed = hooksInstalled();
  } catch {
    return fix("Claude Code's settings.json could not be read.", "Fix ~/.claude/settings.json, then run kiwi hooks install.");
  }
  if (installed) return ok("hooks    Claude Code hooks are installed");
  const skipped = loadConfig().claudeHooks === "off";
  fix(
    skipped ? "Claude Code hooks were skipped during setup." : "Claude Code hooks are not installed.",
    "Run kiwi hooks install.",
  );
}

/** Check the install, this computer's link, the relay, and Claude Code hooks. */
export async function doctor(): Promise<void> {
  const relay = (process.env.KIWI_RELAY ?? loadMachine()?.relay ?? DEFAULT_RELAY).replace(/\/+$/, "");
  ok(`version  ${VERSION}`);

  const bin = Bun.which("kiwi");
  if (!bin) {
    fix("`kiwi` is not on PATH.", `Add this to your shell profile: export PATH="${join(homedir(), ".kiwi", "bin")}:$PATH"`);
  } else {
    ok(`PATH     ${bin}`);
    const reported = await binVersion(bin);
    if (reported === null) fix("the kiwi on PATH did not print a version.", "Reinstall kiwi so `kiwi version` works.");
    else if (reported !== VERSION) fix(`the kiwi on PATH is ${reported}; this command is ${VERSION}.`, "Reinstall so the shell and this checkout are the same version.");
  }

  await checkLink(relay);
  await checkRelay(relay);
  checkHooks();
  process.exit(problems.length ? 1 : 0);
}
