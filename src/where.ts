// Where a claim is being made from. Recorded on the claim so another agent can
// see which checkout holds the path before they write into it.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { loadMachine } from "./machine.ts";

/** `/Users/me/proj` becomes `~/proj`. A checkout outside the home directory stays as it is. */
export function hideHome(path: string): string {
  const home = homedir();
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

/** This computer's label and the git checkout, when either is visible. The checkout never includes the home directory. */
export function claimPlace(): { machine?: string; checkout?: string } {
  const machine = loadMachine()?.label;
  let checkout: string | undefined;
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (top) checkout = hideHome(top);
  } catch {
    checkout = undefined;
  }
  return { ...(machine ? { machine } : {}), ...(checkout ? { checkout } : {}) };
}
