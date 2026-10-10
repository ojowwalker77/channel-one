// Member scopes: what each member may do in a channel, besides read.
//
// The owner signs a member's scopes into their record at approval, and changes
// them later with an owner-signed scope.set event, so nobody (the relay
// included) can grant themselves more. Every client enforces them in fold: a
// message outside its sender's scopes is refused there and never reaches agents
// or the board. The relay learns one bit per key, "can post", so a read-only
// member can't fill storage either.

import type { Message } from "./protocol.ts";

/** Everything a member may do besides read, which everyone may. */
export const SCOPES = ["post", "ask", "tasks", "claims", "facts"] as const;
export type Scope = (typeof SCOPES)[number];

/** What each scope covers, in the words the owner sees. */
export const SCOPE_LABELS: Record<Scope, string> = {
  post: "write messages",
  ask: "ask questions and say they're blocked",
  tasks: "add, claim and update tasks",
  claims: "claim paths",
  facts: "set and unset facts",
};

/** The presets the owner picks from. Full is everyone's today, and every member's without scopes in their record. */
export const PRESETS = {
  "read-only": [] as Scope[],
  contributor: ["post", "ask", "claims", "facts"] as Scope[],
  full: [...SCOPES] as Scope[],
} as const;
export type Preset = keyof typeof PRESETS;

export const isScope = (x: unknown): x is Scope => typeof x === "string" && (SCOPES as readonly string[]).includes(x);

/**
 * The scopes in a record or event, in a fixed order. Names this version doesn't
 * know are dropped, so an older client reads a newer owner's grant as no more
 * than it understands.
 */
export function readScopes(x: unknown): Scope[] | null {
  if (!Array.isArray(x) || x.length > 32 || !x.every((s) => typeof s === "string" && s.length <= 32)) return null;
  return SCOPES.filter((s) => x.includes(s));
}

/**
 * What goes on the wire: null for full, so a member given full today also gets
 * scopes added later, the way members from before scopes do.
 */
export function wireScopes(scopes: readonly Scope[] | null | undefined): Scope[] | null {
  if (!scopes) return null;
  const known = SCOPES.filter((s) => scopes.includes(s));
  return known.length === SCOPES.length ? null : known;
}

/** A member's scopes: the owner has every one, and so does a member whose record has none (full). */
export function scopesOf(m: { owner?: boolean; scopes?: readonly Scope[] | null }): Scope[] {
  return m.owner || !m.scopes ? [...SCOPES] : SCOPES.filter((s) => m.scopes!.includes(s));
}

/** The relay's one bit: a member with no scope at all may only read. */
export function canPost(scopes: readonly Scope[]): boolean {
  return scopes.length > 0;
}

/**
 * The scope a message needs. "any" means any scope at all (it's housekeeping:
 * announcing yourself, your colour); null means nothing (letting go of a claim
 * only ever shrinks what you hold). Owner-only events are checked as such in fold.
 */
export function scopeFor(m: Pick<Message, "kind" | "ev">): Scope | "any" | null {
  if (m.kind === "ask" || m.kind === "blocking") return "ask";
  if (m.kind !== "event") return "post";
  switch (m.ev?.op) {
    case "task.add":
    case "task.claim":
    case "task.update":
      return "tasks";
    case "claim":
      return "claims";
    case "release":
      return null;
    case "fact.set":
    case "fact.del":
      return "facts";
    default:
      return "any";
  }
}

/** Whether someone with `scopes` may send `m`, and if not, why. */
export function refusal(scopes: readonly Scope[], m: Pick<Message, "kind" | "ev">): string | null {
  const need = scopeFor(m);
  if (need === null) return null;
  if (need === "any") return canPost(scopes) ? null : "can only read";
  return scopes.includes(need) ? null : `may not ${SCOPE_LABELS[need]}`;
}

/** The preset these scopes match, if any. */
export function presetOf(scopes: readonly Scope[]): Preset | null {
  for (const [name, s] of Object.entries(PRESETS) as [Preset, Scope[]][]) {
    if (s.length === scopes.length && s.every((x) => scopes.includes(x))) return name;
  }
  return null;
}

/** "full", "read-only", or the list: "post, ask, claims". */
export function describeScopes(scopes: readonly Scope[]): string {
  return presetOf(scopes) ?? scopes.join(", ");
}

/** What the owner typed: a preset ("read-only", "contributor", "full") or a comma list of scopes ("post,claims"). */
export function parseScopes(s: string): Scope[] | null {
  const t = s.trim().toLowerCase();
  if (t in PRESETS) return [...PRESETS[t as Preset]];
  const parts = t.split(/[\s,]+/).filter((p) => p && p !== "read");
  if (!parts.every(isScope)) return null;
  return SCOPES.filter((x) => parts.includes(x));
}
