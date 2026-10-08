import { Cancel01Icon, Copy01Icon } from "@hugeicons/core-free-icons"
import { useState, type ReactNode } from "react"

import type { JoinRequest, Member as RosterMember } from "@mc/membership.ts"
import type { ChannelState } from "@mc/state.ts"
import { useAuth } from "@/lib/auth"
import { formatAgo, memberLine, memberName } from "@/lib/format"
import { Icon } from "./icon"
import { Alert, Button, IconButton, Monogram, errorText, toast } from "./kit"

export type Filter = { kind: "from"; name: string } | { kind: "open" } | { kind: "mine" }

type Confirm = { kind: "approve"; req: JoinRequest; mine?: boolean } | { kind: "remove"; member: RosterMember } | { kind: "close" } | { kind: "leave" } | null

interface Props {
  code: string
  me: string
  /** This browser's member key: "(you)" is whoever holds it, not whoever shares your name. */
  myKey: string
  isOwner: boolean
  roster: RosterMember[]
  requests: JoinRequest[]
  online: Map<string, unknown>
  state: ChannelState
  mentions: number
  now: number
  onFilter: (f: Filter) => void
  onApprove: (r: JoinRequest) => Promise<void>
  /** Vouch for an agent as your own, then let it in: both approvals in one step. */
  onApproveOwn: (r: JoinRequest) => Promise<void>
  onDeny: (r: JoinRequest) => Promise<void>
  onRemove: (m: RosterMember) => Promise<void>
  onCloseChannel: () => Promise<void>
  onLeaveChannel: () => Promise<void>
  onDismiss: () => void
}

function Part({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line px-5 py-4 first:border-t-0">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[12px] font-semibold text-ink-2">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function minutesLeft(expires: number, now: number) {
  const m = Math.max(0, Math.round((expires - now) / 60_000))
  return m < 60 ? `${m} min left` : `${Math.floor(m / 60)} h ${m % 60} min left`
}

/** Everything about a channel that isn't the conversation: who's in it, who wants in, and how to leave. */
export function Details(p: Props) {
  const auth = useAuth()
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [busy, setBusy] = useState(false)
  const signInRelay = auth.status !== "off"
  const needsSignIn = p.isOwner && auth.status === "signed-out"
  // A person who asked to join to supervise their agent is shown inside the agent's request.
  const linked = new Set(p.requests.map((r) => r.sponsorRequest).filter(Boolean))
  const requests = p.requests.filter((r) => !linked.has(r.id))
  const active = p.roster.filter((m) => m.active).sort((a, b) => Number(b.owner) - Number(a.owner) || Number(p.online.has(b.name)) - Number(p.online.has(a.name)))
  const former = p.roster.filter((m) => !m.active)
  const facts = [...p.state.facts.values()].sort((a, b) => a.key.localeCompare(b.key))
  const joinCommand = `curl -fsSL ${location.origin}/install | sh && ~/.kiwi/bin/kiwi join ${p.code} --as <name>`
  const taken = confirm?.kind === "approve" && active.some((m) => m.name === confirm.req.name)

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true)
    try {
      await fn()
      toast(done)
      setConfirm(null)
    } catch (err) {
      const message = errorText(err)
      toast(/sign in required/.test(message) ? "Sign in first. Owner actions need your session." : message, "error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="animate-slide-in flex h-full w-full flex-col bg-canvas shadow-[inset_0.5px_0_0_var(--line)] md:w-[340px]">
      <header className="flex h-[56px] shrink-0 items-center justify-between pr-3 pl-5">
        <span className="text-[13px] font-semibold">Details</span>
        <IconButton label="Close details" onClick={p.onDismiss}>
          <Icon icon={Cancel01Icon} size={17} />
        </IconButton>
      </header>

      <div className="flex-1 overflow-y-auto pb-6">
        {needsSignIn && (
          <div className="mx-5 mb-2 rounded-[10px] bg-wash p-3 text-[13px] leading-normal">
            Sign in to approve, remove or close. The owner key alone isn’t enough.
            <Button size="sm" className="mt-2" onClick={auth.signIn}>
              Sign in
            </Button>
          </div>
        )}

        {p.isOwner && requests.length > 0 && (
          <Part title={requests.length === 1 ? "Wants to join" : `${requests.length} want to join`}>
            <div className="grid gap-4">
              {requests.map((r) => {
                // On a sign-in relay, an agent needs its own person's vouch before you can let it in.
                const awaitingSponsor = signInRelay && r.kind !== "human" && !r.sponsoredBy
                const supervisor = r.sponsorRequest ? p.requests.find((x) => x.id === r.sponsorRequest) : undefined
                return (
                  <div key={r.id}>
                    <div className="flex items-start gap-3">
                      <Monogram name={r.name} agent={r.kind !== "human"} size={28} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px] font-medium">
                          {r.name}
                          {r.role && <span className="font-normal text-ink-2">, {r.role}</span>}
                        </p>
                        <p className="text-[12px] leading-snug text-ink-2">
                          {r.kind === "human"
                            ? `Signed in as ${r.sponsoredBy?.name ?? "someone"}`
                            : r.sponsoredBy
                              ? `Agent for ${r.sponsoredBy.name}${supervisor ? `, who joins with it` : ""}`
                              : signInRelay
                                ? "Agent, waiting for the person who runs it to vouch for it"
                                : "Agent"}
                        </p>
                        {r.sponsoredBy?.email && <p className="truncate text-[12px] text-ink-2">{r.sponsoredBy.email}</p>}
                        <p className="text-[12px] text-ink-3">Asked {formatAgo(r.ts, p.now)}</p>
                      </div>
                    </div>
                    <div className="mt-2.5 flex gap-2 pl-10">
                      <Button size="sm" variant="secondary" onClick={() => run(() => p.onDeny(r), `Declined ${r.name}`)}>
                        Decline
                      </Button>
                      {awaitingSponsor ? (
                        <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: "approve", req: r, mine: true })}>
                          I run this agent
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => setConfirm({ kind: "approve", req: r })}>
                          Review and approve
                        </Button>
                      )}
                    </div>
                    {awaitingSponsor && (
                      <p className="mt-2 pl-10 text-[12px] leading-snug text-ink-3">
                        The person who runs it opens the link it printed and confirms it’s theirs. Then you can approve it here.
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </Part>
        )}

        <Part title={`${active.length} ${active.length === 1 ? "member" : "members"}`}>
          <div className="-mx-2 grid">
            {active.map((m) => (
              <div key={m.pk} className="group flex items-center gap-3 rounded-[8px] px-2 py-1.5 hover:bg-wash">
                <Monogram name={memberName(m)} agent={m.kind !== "human"} size={26} online={p.online.has(m.name)} />
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => p.onFilter({ kind: "from", name: m.name })} title="Show only their messages">
                  <p className="truncate text-[13px] font-medium">
                    {memberName(m)}
                    {m.pk === p.myKey && <span className="font-normal text-ink-3"> (you)</span>}
                  </p>
                  <p className="truncate text-[12px] text-ink-2" title={`Key ${m.pk.slice(0, 16)}`}>
                    {memberLine(m)}
                  </p>
                </button>
                {p.isOwner && !m.owner && (
                  <Button size="sm" variant="danger" className="opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => setConfirm({ kind: "remove", member: m })}>
                    Remove
                  </Button>
                )}
              </div>
            ))}
          </div>
          {former.length > 0 && <p className="mt-2 text-[12px] text-ink-3">Left: {former.map((m) => m.name).join(", ")}</p>}
        </Part>

        <Part title="Show">
          <div className="-mx-2 grid text-[13px]">
            <button type="button" className="flex items-center justify-between rounded-[8px] px-2 py-1.5 text-left hover:bg-wash" onClick={() => p.onFilter({ kind: "open" })}>
              Unanswered questions <span className="text-ink-3 tabular-nums">{p.state.openAsks.length}</span>
            </button>
            <button type="button" className="flex items-center justify-between rounded-[8px] px-2 py-1.5 text-left hover:bg-wash" onClick={() => p.onFilter({ kind: "mine" })}>
              Messages to you <span className="text-ink-3 tabular-nums">{p.mentions}</span>
            </button>
          </div>
        </Part>

        {p.isOwner && (
          <Part title="Invite an agent">
            <p className="mb-2 text-[12px] leading-snug text-ink-2">Paste this into the agent’s terminal. Its request shows up here with a code to check.</p>
            <div className="flex items-start gap-1 rounded-[8px] bg-wash p-2.5">
              <code className="min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed break-all text-ink-2">{joinCommand}</code>
              <IconButton label="Copy command" className="size-7" onClick={() => navigator.clipboard.writeText(joinCommand).then(() => toast("Copied. Replace <name> with the agent’s name."))}>
                <Icon icon={Copy01Icon} size={15} />
              </IconButton>
            </div>
          </Part>
        )}

        {p.state.claims.length > 0 && (
          <Part title="Claimed paths">
            <div className="grid gap-2">
              {p.state.claims.map((c) => (
                <div key={`${c.owner}:${c.path}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <code className="truncate font-mono text-[12px]">{c.path}</code>
                    <span className="shrink-0 text-[11.5px] text-ink-3">{minutesLeft(c.expires, p.now)}</span>
                  </div>
                  <p className="truncate text-[12px] text-ink-2">{c.note ? `${c.owner}: ${c.note}` : c.owner}</p>
                </div>
              ))}
            </div>
          </Part>
        )}

        {facts.length > 0 && (
          <Part title="Facts">
            <div className="-mx-2 grid">
              {facts.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className="rounded-[8px] px-2 py-1.5 text-left hover:bg-wash"
                  title="Copy value"
                  onClick={() => navigator.clipboard.writeText(f.value).then(() => toast(`Copied ${f.key}`))}
                >
                  <p className="text-[12.5px] font-medium">{f.key}</p>
                  <p className="font-mono text-[11.5px] break-all text-ink-2">{f.value}</p>
                </button>
              ))}
            </div>
          </Part>
        )}

        <Part title={p.isOwner ? "Close channel" : "Leave channel"}>
          <p className="mb-2.5 text-[12px] leading-snug text-ink-2">
            {p.isOwner
              ? "Deletes every message, member and key on the relay. Everyone’s copy is wiped the next time they connect."
              : "You lose access at once, and the key rotates so you can’t read anything newer."}
          </p>
          <Button size="sm" variant="danger" className="-ml-2.5" onClick={() => setConfirm({ kind: p.isOwner ? "close" : "leave" })}>
            {p.isOwner ? "Close channel" : "Leave channel"}
          </Button>
        </Part>
      </div>

      <Alert
        open={confirm?.kind === "approve"}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "approve" ? (confirm.mine ? `Do you run ${confirm.req.name} yourself?` : `Let ${confirm.req.name} in?`) : ""}
        message={
          confirm?.kind === "approve" && (
            <>
              {confirm.mine ? (
                "It will be listed as your agent and act for you. If someone else runs it, cancel: they vouch for it from its link. Say yes only if you started it and its terminal shows this code."
              ) : <>Approve only if {confirm.req.kind === "human" ? "they show" : "its terminal shows"} this exact code.</>}
              <span className="mt-4 mb-1 block text-[34px] leading-none font-semibold tracking-[0.04em] text-ink tabular-nums">{confirm.req.code}</span>
            </>
          )
        }
      >
        <Button variant="secondary" onClick={() => setConfirm(null)}>
          Cancel
        </Button>
        {confirm?.kind === "approve" && (
          <Button disabled={busy || taken} onClick={() => run(() => (confirm.mine ? p.onApproveOwn : p.onApprove)(confirm.req), `${confirm.req.name} joined`)}>
            {taken ? "That name is taken" : confirm.mine ? "Yes, I run it" : "Approve"}
          </Button>
        )}
      </Alert>

      <Alert
        open={confirm?.kind === "remove"}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "remove" ? `Remove ${memberName(confirm.member)}?` : ""}
        message="They’re disconnected at once, and the key rotates so they can’t read anything new."
      >
        <Button variant="secondary" onClick={() => setConfirm(null)}>
          Cancel
        </Button>
        {confirm?.kind === "remove" && (
          <Button className="bg-alert" disabled={busy} onClick={() => run(() => p.onRemove(confirm.member), `Removed ${confirm.member.name}`)}>
            Remove
          </Button>
        )}
      </Alert>

      <Alert
        open={confirm?.kind === "close" || confirm?.kind === "leave"}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "close" ? "Close this channel for everyone?" : "Leave this channel?"}
        message={confirm?.kind === "close" ? "Everything is deleted and can’t be recovered." : "You’ll need the owner’s approval to come back."}
      >
        <Button variant="secondary" onClick={() => setConfirm(null)}>
          Cancel
        </Button>
        <Button
          className="bg-alert"
          disabled={busy}
          onClick={() => run(confirm?.kind === "close" ? p.onCloseChannel : p.onLeaveChannel, confirm?.kind === "close" ? "Channel closed" : "You left the channel")}
        >
          {confirm?.kind === "close" ? "Close channel" : "Leave channel"}
        </Button>
      </Alert>
    </aside>
  )
}
