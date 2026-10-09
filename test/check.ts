// The join code check (src/sas.ts), run the way both sides' clients run it.

import { Channel } from "../src/client.ts";
import type { Identity } from "../src/identity.ts";
import type { JoinRequest } from "../src/membership.ts";
import type { SigningBudget } from "../src/sas.ts";

/** One owner device's record of what it signed, in memory. */
export function memoryBudget(): SigningBudget {
  const signed = new Map<string, number[]>();
  return { load: (room) => signed.get(room) ?? [], save: (room, times) => void signed.set(room, times) };
}

/**
 * The owner's device opens the requests (signing its half), each joiner's
 * client reveals its own, and the owner then sees every code.
 */
export async function checked(owner: Channel, relay: string, code: string, joiners: { id: Identity; requestId: string }[], budget = memoryBudget()): Promise<JoinRequest[]> {
  await owner.requests({ budget });
  for (const j of joiners) await Channel.joinStatus(relay, code, j.id, j.requestId);
  return owner.requests({ budget });
}
