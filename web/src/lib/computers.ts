// Linking a computer to your account (kiwi setup prints a #link=<key> page),
// and the list of your linked computers.

/** `#link=<computer key>`: the page `kiwi setup` opens to link that computer. */
export function parseLinkHash(hash: string): string | null {
  const m = /^#link=([A-Za-z0-9_-]{20,})$/.exec(hash)
  return m ? m[1]! : null
}

async function call<T>(path: string, init: RequestInit & { token?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (init.token) headers["x-human-token"] = init.token
  const res = await fetch(path, { ...init, headers })
  const json = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(json.error ?? `the relay returned ${res.status}`)
  return json
}

/** What the computer asked to be called, and whether it's linked already. */
export const computerInfo = (pk: string) => call<{ label: string; status: "pending" | "linked"; created: number }>(`/v1/machines/${pk}/public`)

export const confirmComputer = (pk: string, token: string) => call<{ status: string; label: string }>(`/v1/machines/${pk}/confirm`, { method: "POST", token, body: "{}" })

export interface Computer {
  pk: string
  label: string
  linked: number
  /** Last time it vouched for an agent or checked its link, to the hour; null if it hasn't since linking. */
  used: number | null
  /** When the relay unlinks it if it stays unused. */
  expires: number
}

export const myComputers = (token: string) => call<{ machines: Computer[] }>("/v1/me/machines", { token }).then((r) => r.machines)

export const removeComputer = (pk: string, token: string) => call<unknown>(`/v1/me/machines/${pk}`, { method: "DELETE", token })
