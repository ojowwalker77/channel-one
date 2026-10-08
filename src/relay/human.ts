// Human sign-in at the relay: verifying WorkOS AuthKit access tokens.
//
// When a relay is configured with a WorkOS client id, channels belong to a
// signed-in human. Creating a channel, and every owner action (approve, deny,
// remove, rotate, close), needs that human's live session on top of the owner
// key's signature. An agent holding a copy of the owner key still can't let
// anyone in. Tokens are checked against WorkOS's public keys (JWKS); the relay
// holds no WorkOS secret.

export interface HumanAuth {
  /** The WorkOS client id the web app should sign in with. */
  clientId: string;
  /** The signed-in user's id (`sub`) if the token is valid, else null. */
  verify(token: string): Promise<string | null>;
  /** The user's real name (or email) from WorkOS, so the relay can vouch for "on behalf of whom". */
  profile?(userId: string): Promise<HumanProfile | null>;
}

export interface HumanProfile {
  name: string;
  email?: string;
}

/** Look up a WorkOS user's name with the API key (kept as a Worker secret). */
export function workosProfiles(apiKey: string): (userId: string) => Promise<HumanProfile | null> {
  const cache = new Map<string, HumanProfile>();
  return async (userId) => {
    if (!/^user_[A-Za-z0-9]+$/.test(userId)) return null;
    const hit = cache.get(userId);
    if (hit) return hit;
    const res = await fetch(`https://api.workos.com/user_management/users/${userId}`, { headers: { authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return null;
    const u = (await res.json()) as { first_name?: string | null; last_name?: string | null; email?: string };
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || userId;
    const p = { name, email: u.email };
    cache.set(userId, p);
    return p;
  };
}

interface Jwk {
  kty?: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

const enc = new TextEncoder();

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Verifies RS256 WorkOS access tokens against the client's JWKS (cached,
 * refreshed on an unknown kid). Tokens may be signed by the WorkOS API keys
 * or by the AuthKit domain's, so both sets are accepted when a domain is given.
 */
export function workosHumanAuth(clientId: string, jwksUrls: string | string[] = `https://api.workos.com/sso/jwks/${clientId}`): HumanAuth {
  const urls = Array.isArray(jwksUrls) ? jwksUrls : [jwksUrls];
  const issuers = new Set([
    `https://api.workos.com/user_management/${clientId}`,
    ...urls.filter((u) => !u.startsWith("https://api.workos.com/")).map((u) => new URL(u).origin),
  ]);
  let keys: Promise<Map<string, CryptoKey>> | null = null;
  let fetchedAt = 0;

  const loadKeys = async (): Promise<Map<string, CryptoKey>> => {
    const lists = await Promise.all(
      urls.map(async (u) => {
        const res = await fetch(u);
        return res.ok ? ((await res.json()) as { keys: Jwk[] }).keys : [];
      }),
    );
    const out = new Map<string, CryptoKey>();
    for (const k of lists.flat()) {
      if (k.kty !== "RSA" || !k.kid) continue;
      const importKey = crypto.subtle.importKey as unknown as (f: "jwk", k: Jwk, a: object, x: boolean, u: string[]) => Promise<CryptoKey>;
      out.set(k.kid, await importKey.call(crypto.subtle, "jwk", { kty: "RSA", n: k.n, e: k.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    }
    return out;
  };

  const keyFor = async (kid: string): Promise<CryptoKey | undefined> => {
    if (!keys || Date.now() - fetchedAt > 3600_000) {
      fetchedAt = Date.now();
      keys = loadKeys().catch((e) => {
        keys = null;
        throw e;
      });
    }
    let k = (await keys).get(kid);
    // Key rotation: refetch once (at most every 30s) for a kid we haven't seen.
    if (!k && Date.now() - fetchedAt > 30_000) {
      fetchedAt = Date.now();
      keys = loadKeys();
      k = (await keys).get(kid);
    }
    return k;
  };

  return {
    clientId,
    async verify(token: string): Promise<string | null> {
      try {
        const [h, p, s] = token.split(".");
        if (!h || !p || !s) return null;
        const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h))) as { alg?: string; kid?: string };
        if (header.alg !== "RS256" || !header.kid) return null;
        const key = await keyFor(header.kid);
        if (!key) return null;
        const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(s), enc.encode(`${h}.${p}`));
        if (!ok) return null;
        const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as { sub?: string; exp?: number; nbf?: number; iss?: string };
        const now = Date.now() / 1000;
        if (!claims.sub || !claims.exp || claims.exp < now - 30 || (claims.nbf && claims.nbf > now + 30)) return null;
        // Only tokens issued for this app: WorkOS user management for our client, or our AuthKit domain.
        if (!issuers.has((claims.iss ?? "").replace(/\/$/, ""))) return null;
        return claims.sub;
      } catch {
        return null;
      }
    },
  };
}

/** The human's token travels in its own header, alongside the member-key signature. */
export const HUMAN_HEADER = "x-human-token";
