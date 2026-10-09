// `kiwi doctor` looks at this computer and prints a fix for each problem.
// It does not change anything. The checks return their findings so tests can
// read them; printing is separate.

import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RELAY, loadConfig } from "../config.ts";
import { hooksInstalled } from "../hooks.ts";
import { loadMachine, machineStatus } from "../machine.ts";
import { VERSION } from "../version.ts";

/** One check. `how` is the plain fix, and only a problem has one. */
export type Finding = { ok: true; what: string } | { ok: false; what: string; how: string };

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

/** The same file as this process: a dev checkout running itself must not spawn. */
function sameBinary(bin: string): boolean {
  try {
    return realpathSync(bin) === realpathSync(process.execPath);
  } catch {
    return false;
  }
}

async function checkInstall(): Promise<Finding[]> {
  const found: Finding[] = [{ ok: true, what: `version  ${VERSION}` }];
  const bin = Bun.which("kiwi");
  if (!bin) {
    found.push({
      ok: false,
      what: "`kiwi` is not on PATH.",
      how: `Add this to your shell profile: export PATH="${join(homedir(), ".kiwi", "bin")}:$PATH"`,
    });
    return found;
  }
  found.push({ ok: true, what: `PATH     ${bin}` });
  if (sameBinary(bin)) return found;
  const reported = await binVersion(bin);
  if (reported === null) found.push({ ok: false, what: "the kiwi on PATH did not print a version.", how: "Reinstall kiwi so `kiwi version` works." });
  else if (reported !== VERSION) found.push({ ok: false, what: `the kiwi on PATH is ${reported}; this command is ${VERSION}.`, how: "Reinstall so the shell and this checkout are the same version." });
  return found;
}

/**
 * Ask the relay who it is. Sign-in is on only when it says so: a relay
 * without WorkOS has no computer links, and `kiwi setup` cannot succeed there.
 * A relay that doesn't answer is reported here, before any link advice.
 */
async function checkRelay(relay: string): Promise<{ finding: Finding; signIn: boolean }> {
  let host: string;
  try {
    host = new URL(relay).hostname;
  } catch {
    return { finding: { ok: false, what: `${relay} is not a URL.`, how: "Set KIWI_RELAY to the relay's https address." }, signIn: false };
  }
  try {
    await lookup(host);
  } catch {
    return { finding: { ok: false, what: `DNS for ${host} did not resolve.`, how: "Check the name, or the network, then run kiwi doctor again." }, signIn: false };
  }
  try {
    const res = await fetch(new URL("/v1/config", relay), { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      return {
        finding: { ok: false, what: `${relay}/v1/config returned ${res.status}.`, how: "The relay is up but not answering. Check that Kiwi is the thing listening there." },
        signIn: false,
      };
    }
    const body = (await res.json()) as { workosClientId?: unknown };
    if (!body || typeof body !== "object" || !("workosClientId" in body)) {
      return { finding: { ok: false, what: `${relay}/v1/config answered, but not as a Kiwi relay.`, how: "Point KIWI_RELAY at your Kiwi relay." }, signIn: false };
    }
    const signIn = typeof body.workosClientId === "string" && body.workosClientId.length > 0;
    return { finding: { ok: true, what: `relay    ${relay}  /v1/config answered` }, signIn };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { finding: { ok: false, what: `could not reach ${relay} (${why}).`, how: "Start the relay, or fix KIWI_RELAY, then run kiwi doctor again." }, signIn: false };
  }
}

/** The link, and only the link. Call this after the relay has answered and said sign-in is on. */
async function checkLink(relay: string): Promise<Finding> {
  const m = loadMachine();
  if (!m?.linked) return { ok: false, what: "this computer isn't linked to an account.", how: "Run kiwi setup." };
  if (m.relay !== relay) return { ok: false, what: `this computer is linked at ${m.relay}, not ${relay}.`, how: "Run kiwi setup again for this relay." };
  try {
    const st = await machineStatus(m);
    if (st.status === "linked") return { ok: true, what: `link     ${st.name ?? m.linked.name ?? "your account"} (${m.label})` };
    // "expired" is the relay's word for a link it no longer has (removed, or left unused).
    if (st.status === "expired") return { ok: false, what: "this computer's link was removed.", how: "Run kiwi setup again." };
    return { ok: false, what: `this computer's link is ${st.status}, not confirmed.`, how: "Run kiwi setup and confirm it in the browser." };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, what: `couldn't check this computer's link (${why}).`, how: "The relay answered /v1/config, but the link check failed. Run kiwi doctor again." };
  }
}

function checkHooks(): Finding {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  if (!existsSync(dir)) return { ok: true, what: "hooks    Claude Code is not installed here" };
  let installed = false;
  try {
    installed = hooksInstalled();
  } catch {
    return { ok: false, what: "Claude Code's settings.json could not be read.", how: "Fix ~/.claude/settings.json, then run kiwi hooks install." };
  }
  if (installed) return { ok: true, what: "hooks    Claude Code hooks are installed" };
  // The person said no during setup. That is a choice, not a broken install.
  if (loadConfig().claudeHooks === "off") return { ok: true, what: "hooks    skipped at setup (kiwi hooks install adds them)" };
  return { ok: false, what: "Claude Code hooks are not installed.", how: "Run kiwi hooks install." };
}

/** Every check, relay before link. A link check exists only when the relay requires sign-in. */
export async function doctorChecks(): Promise<Finding[]> {
  const relay = (process.env.KIWI_RELAY ?? loadMachine()?.relay ?? DEFAULT_RELAY).replace(/\/+$/, "");
  const found = await checkInstall();
  const relayCheck = await checkRelay(relay);
  found.push(relayCheck.finding);
  if (relayCheck.finding.ok && relayCheck.signIn) found.push(await checkLink(relay));
  found.push(checkHooks());
  return found;
}

/** Print findings the way the command shows them. */
export function printFindings(findings: Finding[]): void {
  for (const f of findings) {
    if (f.ok) process.stdout.write(`ok   ${f.what}\n`);
    else process.stdout.write(`fix  ${f.what}\n     ${f.how}\n`);
  }
}

/** Check the install, this computer's link, the relay, and Claude Code hooks. */
export async function doctor(): Promise<void> {
  const findings = await doctorChecks();
  printFindings(findings);
  process.exit(findings.some((f) => !f.ok) ? 1 : 0);
}
