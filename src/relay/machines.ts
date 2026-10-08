// Linking a computer to a person, so agents started on it join already vouched
// for as theirs. Shared by the Cloudflare and Bun relays.
//
//   kiwi setup                          relay                         person (signed in, web)
//   machine key, label  ── register ──►  pending link (15 min)
//   prints a code, opens the browser ──────────────────────────────►  sees label + the same code
//                                         linked to their user  ◄──── confirms
//   polls (signed by the machine key) ◄─ linked, and to whom
//
// Afterwards `kiwi join` sends a vouch signed by the machine key; the relay
// sets the agent's sponsor to the machine's person. The owner still approves.

import { verifyRequest } from "../auth.ts";
import { verify, verifyText } from "../identity.ts";
import { MACHINE_SCOPE, machineCode, vouchStatement } from "../vouch.ts";
import { inlineText } from "../membership.ts";
import { HUMAN_HEADER, type HumanAuth } from "./human.ts";
import { HttpError } from "./room.ts";

/** A computer as the relay knows it: its public key, the label its person sees, and whose it is. */
export interface MachineRecord {
  pk: string;
  label: string;
  user: string | null;
  created: number;
  linked?: number;
}

export interface MachineStore {
  get(pk: string): Promise<MachineRecord | null>;
  put(rec: MachineRecord): Promise<void>;
  remove(rec: MachineRecord): Promise<void>;
  listFor(user: string): Promise<{ pk: string; label: string; linked: number }[]>;
}

/** How long a pending link waits for its person to confirm. */
const LINK_TTL_MS = 15 * 60_000;
/** Who vouches for an agent key: the person its machine is linked to, if the machine's signature checks out. */
export async function vouchedBy(store: MachineStore, roomId: string, agentPk: string, machine: unknown): Promise<string | null> {
  const m = machine as { pk?: unknown; sig?: unknown } | undefined;
  if (!m || typeof m.pk !== "string" || typeof m.sig !== "string") return null;
  const rec = await store.get(m.pk);
  if (!rec?.user) return null;
  return (await verifyText(m.pk, m.sig, vouchStatement(roomId, agentPk))) ? rec.user : null;
}

/** Routes under /v1/machines and /v1/me/machines; null when the path isn't one of them. */
export async function onMachineHttp(req: Request, store: MachineStore, human: HumanAuth | null): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();
  if (!path.startsWith("/v1/machines") && !path.startsWith("/v1/me/machines")) return null;
  if (!human) throw new HttpError(404, "this relay has no sign-in, so computers can't be linked");
  const body = method === "GET" || method === "DELETE" ? "" : await req.text();
  const person = async () => {
    const user = await human.verify(req.headers.get(HUMAN_HEADER) ?? "");
    if (!user) throw new HttpError(401, "sign in first");
    return user;
  };
  const signedBy = async (pk: string) => {
    const who = await verifyRequest((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""), MACHINE_SCOPE, method, path, body);
    if (who !== pk) throw new HttpError(401, "not signed by this computer's key");
  };

  // A computer asks to be linked: it proves it holds its key, and names itself.
  if (path === "/v1/machines" && method === "POST") {
    let b: { pk?: unknown; label?: unknown; ts?: unknown; sig?: unknown };
    try {
      b = JSON.parse(body);
    } catch {
      throw new HttpError(400, "bad json");
    }
    if (typeof b.pk !== "string" || typeof b.ts !== "number" || !(await verify(b as object))) throw new HttpError(400, "bad signature");
    if (Math.abs(Date.now() - b.ts) > 5 * 60_000) throw new HttpError(400, "clock is off by more than 5 minutes");
    const prior = await store.get(b.pk);
    if (prior?.user) return Response.json({ status: "linked" });
    await store.put({ pk: b.pk, label: inlineText(b.label, 60) || "A computer", user: null, created: Date.now() });
    return Response.json({ status: "pending", code: await machineCode(b.pk) });
  }

  const one = /^\/v1\/machines\/([A-Za-z0-9_-]{20,})(\/public|\/confirm)?$/.exec(path);
  if (one) {
    const pk = one[1]!;
    const rec = await store.get(pk);
    const fresh = rec && (rec.user || Date.now() - rec.created < LINK_TTL_MS);
    // What the confirm page shows. Nothing secret: the label the computer gave itself.
    if (one[2] === "/public" && method === "GET") {
      if (!fresh) throw new HttpError(404, "this link expired; run kiwi setup again");
      return Response.json({ label: rec!.label, status: rec!.user ? "linked" : "pending", code: await machineCode(pk), created: rec!.created });
    }
    // The person confirms: this computer is mine.
    if (one[2] === "/confirm" && method === "POST") {
      const user = await person();
      if (!fresh) throw new HttpError(404, "this link expired; run kiwi setup again");
      if (rec!.user && rec!.user !== user) throw new HttpError(409, "this computer is already linked to someone else");
      await store.put({ ...rec!, user, linked: Date.now() });
      return Response.json({ status: "linked", label: rec!.label });
    }
    // The computer checks on its link, or unlinks itself.
    if (!one[2] && method === "GET") {
      await signedBy(pk);
      if (!fresh) return Response.json({ status: "expired" });
      const name = rec!.user ? ((await human.profile?.(rec!.user).catch(() => null))?.name ?? null) : null;
      return Response.json({ status: rec!.user ? "linked" : "pending", name });
    }
    if (!one[2] && method === "DELETE") {
      await signedBy(pk);
      if (rec) await store.remove(rec);
      return Response.json({ removed: true });
    }
  }

  // A person's computers, and removing one from the web.
  if (path === "/v1/me/machines" && method === "GET") return Response.json({ machines: await store.listFor(await person()) });
  const mine = /^\/v1\/me\/machines\/([A-Za-z0-9_-]{20,})$/.exec(path);
  if (mine && method === "DELETE") {
    const user = await person();
    const rec = await store.get(mine[1]!);
    if (!rec || rec.user !== user) throw new HttpError(404, "not one of your computers");
    await store.remove(rec);
    return Response.json({ removed: true });
  }
  throw new HttpError(404, "not found");
}
