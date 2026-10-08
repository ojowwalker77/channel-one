// This computer's link to its person (see relay/machines.ts for the relay side).
// `kiwi setup` makes a machine key, the person confirms it in their browser,
// and from then on agents started here join already vouched for as theirs.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { signRequest } from "./auth.ts";
import { home, writePrivate } from "./config.ts";
import { generateIdentity, sign, signText, type Identity } from "./identity.ts";
import { MACHINE_SCOPE, vouchStatement } from "./vouch.ts";

export { machineCode } from "./vouch.ts";

export interface MachineFile {
  identity: Identity;
  label: string;
  relay: string;
  /** Set once the person confirmed: who this computer vouches as. */
  linked?: { name: string | null; at: number };
}

const path = () => join(home(), "machine.json");

export function loadMachine(): MachineFile | null {
  try {
    return existsSync(path()) ? (JSON.parse(readFileSync(path(), "utf8")) as MachineFile) : null;
  } catch {
    return null;
  }
}

export function saveMachine(m: MachineFile): void {
  writePrivate(path(), JSON.stringify(m, null, 2) + "\n");
}

export function forgetMachine(): void {
  rmSync(path(), { force: true });
}

/** A fresh, unlinked machine key, labelled after this computer. */
export async function newMachine(relay: string): Promise<MachineFile> {
  const label = (hostname().replace(/\.local$/, "") || "This computer").slice(0, 60);
  return { identity: await generateIdentity("machine"), label, relay };
}

async function machineCall<T>(m: MachineFile, method: string, p: string, body?: object): Promise<T> {
  const text = body ? JSON.stringify(body) : "";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (method !== "POST" || p !== "/v1/machines") headers.authorization = `Bearer ${await signRequest(m.identity, MACHINE_SCOPE, method, p, text)}`;
  const res = await fetch(new URL(p, m.relay), { method, headers, body: method === "GET" || method === "DELETE" ? undefined : text });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `relay returned ${res.status}`);
  return json;
}

/** Ask the relay to link this computer; the person confirms in their browser. */
export async function registerMachine(m: MachineFile): Promise<{ status: string; code?: string }> {
  const signed = await sign(m.identity, { label: m.label, ts: Date.now() });
  return machineCall(m, "POST", "/v1/machines", signed);
}

export function machineStatus(m: MachineFile): Promise<{ status: "pending" | "linked" | "expired"; name: string | null }> {
  return machineCall(m, "GET", `/v1/machines/${m.identity.pk}`);
}

export function unlinkMachine(m: MachineFile): Promise<unknown> {
  return machineCall(m, "DELETE", `/v1/machines/${m.identity.pk}`);
}

/** The link the person opens to confirm this computer. */
export function linkUrl(m: MachineFile): string {
  return `${m.relay}/#link=${m.identity.pk}`;
}

/** This computer's signature vouching for one agent key in one channel. */
export async function vouchFor(m: MachineFile, roomId: string, agentPk: string): Promise<{ pk: string; sig: string }> {
  return { pk: m.identity.pk, sig: await signText(m.identity, vouchStatement(roomId, agentPk)) };
}
