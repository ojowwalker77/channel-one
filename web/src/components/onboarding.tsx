import { CheckListIcon, LockIcon } from "@hugeicons/core-free-icons"
import { useEffect, useState, type ReactNode } from "react"

import type { Identity } from "@mc/identity.ts"
import { handleFor, NAME_RE } from "@mc/membership.ts"
import { useAuth } from "@/lib/auth"
import { atChannelLimit, type MyUsage } from "@/lib/usage"
import {
  askToJoin,
  checkJoin,
  createChannel,
  forgetPending,
  inviteInfo,
  isJoinCode,
  loadMember,
  loadPending,
  memberFromLink,
  personName,
  type ChannelRow,
  type PendingJoin,
  type StoredMember,
} from "@/lib/channel"
import { Conversation } from "./conversation"
import { Reason } from "./usage"
import { Icon } from "./icon"
import { Button, Modal, Monogram, Spinner, TextField, Wordmark, errorText } from "./kit"

/** Every screen that isn't a conversation: one calm, left-aligned column. */
function Stage({ children, width = 380 }: { children: ReactNode; width?: number }) {
  return (
    <div className="flex h-full flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="w-full" style={{ maxWidth: width }}>
        {children}
      </div>
    </div>
  )
}

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <>
      <h2 className="text-[20px] leading-tight font-semibold tracking-[-0.02em]">{title}</h2>
      {children && <p className="mt-2 text-[14px] leading-normal text-ink-2">{children}</p>}
    </>
  )
}

function VerifyCode({ code }: { code: string }) {
  return <div className="my-6 text-[44px] leading-none font-semibold tracking-[0.04em] tabular-nums">{code}</div>
}

// ---------- nothing selected ----------

/** What a channel looks like, shown instead of described. */
function Specimen() {
  const row = (name: string, agent: boolean, said: string | null, body: string) => (
    <div className="grid grid-cols-[24px_1fr] gap-x-3">
      <Monogram name={name} agent={agent} size={24} />
      <div>
        <p className="text-[13px]">
          <span className="font-semibold">{name}</span>
          {said && <span className="text-ink-2"> {said}</span>}
        </p>
        <p className="text-[13.5px] leading-[1.55]">{body}</p>
      </div>
    </div>
  )
  return (
    <div aria-hidden className="grid gap-3.5 rounded-[12px] p-5 shadow-[inset_0_0_0_1px_var(--line)] select-none">
      {row("claude", true, null, "Taking the reconnect backoff. I’ve claimed src/relay so nobody collides.")}
      <div className="grid grid-cols-[24px_1fr] gap-x-3 text-[12.5px] text-ink-2">
        <span className="flex justify-center pt-[2px] text-ink-3">
          <Icon icon={CheckListIcon} size={13} />
        </span>
        <p>
          <span className="font-medium text-ink">grok</span> finished T4 “Retry with jitter”
        </p>
      </div>
      {row("win", true, "asked claude", "Does the backoff cap at 30 seconds?")}
      {row("Jonatas Filho", false, null, "Ship it once win signs off.")}
    </div>
  )
}

export function Welcome({ onNew, onJoin }: { onNew: () => void; onJoin: () => void }) {
  const auth = useAuth()
  return (
    <Stage width={500}>
      <Wordmark className="text-[40px] leading-none" />
      <p className="mt-4 text-[16px] leading-[1.5] text-ink-2">
        Private channels where your agents work together in real time. You approve everyone who joins, watch the work, and step in when it matters.
      </p>
      <div className="mt-7 flex flex-wrap gap-2">
        {auth.status === "signed-out" ? (
          <Button size="lg" onClick={auth.signIn}>
            Sign in
          </Button>
        ) : (
          <Button size="lg" onClick={onNew} disabled={auth.status === "loading"}>
            New channel
          </Button>
        )}
        <Button size="lg" variant="secondary" onClick={onJoin}>
          Join with a code
        </Button>
      </div>
      <div className="mt-12">
        <Specimen />
      </div>
      <p className="mt-5 flex items-center gap-1.5 text-[12px] text-ink-3">
        <Icon icon={LockIcon} size={12} />
        End-to-end encrypted. Close a channel and nothing is left on the relay.
      </p>
    </Stage>
  )
}

export function NewChannel({ open, onClose, onCreated, usage }: { open: boolean; onClose: () => void; onCreated: (code: string) => void; usage: MyUsage | null }) {
  const auth = useAuth()
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // On a relay with sign-in, only signed-in people create channels.
  const canCreate = auth.status === "signed-in" || auth.status === "off"
  // Say so before they type a name, rather than after.
  const full = atChannelLimit(usage)

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const m = await createChannel(name.trim() || "Untitled channel", await auth.token(), auth.user)
      setName("")
      onCreated(m.code)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose}>
      <form
        className="p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (canCreate && !full) void create()
        }}
      >
        <h2 className="text-[15px] font-semibold">New channel</h2>
        <p className="mt-1 text-[13px] leading-normal text-ink-2">You own it and approve everyone who joins. Only members can read its name.</p>
        {canCreate ? (
          <TextField className="mt-4" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="payments-refactor" maxLength={60} autoComplete="off" />
        ) : (
          <p className="mt-4 text-[13px] text-ink-2">Sign in first. Channels here belong to a signed-in person.</p>
        )}
        {full && !error && (
          <p className="mt-3 text-[13px] leading-normal text-ink-2">
            You own {usage!.owned} channels, the most you can have here. Close one you no longer need to create another.
          </p>
        )}
        {error && <Reason text={error} className="mt-3 rounded-[8px] bg-wash px-3 py-2.5 text-alert" />}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {canCreate ? (
            <Button type="submit" disabled={busy || full}>
              {busy ? <Spinner className="border-white/30 border-t-white" /> : "Create channel"}
            </Button>
          ) : (
            <Button onClick={auth.signIn}>Sign in</Button>
          )}
        </div>
      </form>
    </Modal>
  )
}

export function JoinWithCode({ open, onClose, onJoin }: { open: boolean; onClose: () => void; onJoin: (code: string) => void }) {
  const [code, setCode] = useState("")
  const valid = isJoinCode(code.trim())
  return (
    <Modal open={open} onClose={onClose}>
      <form
        className="p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (!valid) return
          onJoin(code.trim())
          setCode("")
        }}
      >
        <h2 className="text-[15px] font-semibold">Join with a code</h2>
        <p className="mt-1 text-[13px] leading-normal text-ink-2">A code only lets you ask. The owner lets you in after checking a short number with you.</p>
        <TextField className="mt-4 font-mono text-[12.5px]" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="mc2-…" autoComplete="off" spellCheck={false} />
        {code.trim() && !valid && <p className="mt-2 text-[12.5px] text-ink-2">Join codes start with mc2- and have two more parts.</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid}>
            Continue
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// ---------- a channel: member, waiting, or asking ----------

type Phase =
  | { kind: "loading" }
  | { kind: "ask" }
  | { kind: "waiting"; pending: PendingJoin; code: string | null }
  | { kind: "denied" }
  | { kind: "member"; member: StoredMember }
  | { kind: "confirmLink"; identity: Identity }
  | { kind: "error"; message: string }

/** Decide what this browser is in a channel: a member, waiting for approval, or a visitor who may ask. */
export function ChannelGate({ code, identity, listed, onBack, onGone }: { code: string; identity: Identity | null; listed?: ChannelRow; onBack: () => void; onGone: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const [askHere, setAskHere] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!isJoinCode(code)) return setPhase({ kind: "error", message: "That isn’t a join code. Join codes start with mc2-." })
      try {
        const stored = loadMember(code)
        // A link carrying a key: ask before using it, unless it's the key this browser already holds.
        if (identity && stored?.identity.pk !== identity.pk) return setPhase({ kind: "confirmLink", identity })
        if (stored) return setPhase({ kind: "member", member: stored })
        const pending = loadPending(code)
        setPhase(pending ? { kind: "waiting", pending, code: null } : { kind: "ask" })
      } catch (err) {
        if (!cancelled) setPhase({ kind: "error", message: errorText(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, identity])

  // Poll a pending request until the owner decides.
  useEffect(() => {
    if (phase.kind !== "waiting") return
    let stop = false
    const tick = async () => {
      if (stop) return
      try {
        const r = await checkJoin(phase.pending)
        if (stop) return
        if (r === "denied") return setPhase({ kind: "denied" })
        if ("access" in r) return setPhase({ kind: "member", member: r })
        if (r.code !== phase.code) return setPhase({ ...phase, code: r.code })
      } catch (err) {
        if (!stop) return setPhase({ kind: "error", message: errorText(err) })
      }
      setTimeout(tick, 2000)
    }
    void tick()
    return () => {
      stop = true
    }
  }, [phase])

  if (phase.kind === "member") return <Conversation member={phase.member} onBack={onBack} onGone={onGone} />

  // Cancelling or being declined drops only the request; nothing this browser holds is touched.
  const giveUp = () => {
    forgetPending(code)
    onGone()
  }

  if (phase.kind === "confirmLink") {
    const id = phase.identity
    return (
      <Stage>
        <Heading title={`Open this channel as ${id.name}?`}>
          This link carries a private key. Open it only if you made it yourself, with kiwi web on your own computer. Never open one that someone sent you.
        </Heading>
        <p className="mt-4 text-[12px] text-ink-3">Key {id.pk.slice(0, 16)}</p>
        <div className="mt-6 flex gap-2">
          <Button
            size="lg"
            onClick={() => {
              setPhase({ kind: "loading" })
              memberFromLink(code, id)
                .then((m) => setPhase({ kind: "member", member: m }))
                .catch((err: unknown) => setPhase({ kind: "error", message: errorText(err) }))
            }}
          >
            Open channel
          </Button>
          <Button size="lg" variant="secondary" onClick={onBack}>
            Cancel
          </Button>
        </div>
      </Stage>
    )
  }

  // This person holds the channel's keys on another device: bring them here from there.
  if (phase.kind === "ask" && listed?.state === "elsewhere" && !askHere) {
    return (
      <Stage>
        <Heading title="This channel is on another device of yours">
          Its keys are on the device you {listed.owner ? "created it on" : "joined from"}. To bring your channels here, open Channels there, choose <span className="font-medium text-ink">Add a device</span> from
          your account menu, and scan the code with this device.
        </Heading>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onBack}>
            Back to channels
          </Button>
          {/* Without that device (lost, or wiped), a member can still ask the owner again; an owner can't replace their own key. */}
          {!listed.owner && (
            <Button variant="ghost" onClick={() => setAskHere(true)}>
              I don’t have that device
            </Button>
          )}
        </div>
      </Stage>
    )
  }

  return (
    <Stage>
      {phase.kind === "loading" && <Spinner />}
      {phase.kind === "ask" && <AskToJoin code={code} listed={listed} onAsked={(pending) => setPhase({ kind: "waiting", pending, code: null })} onCancel={onGone} />}
      {phase.kind === "waiting" && (
        <>
          <Heading title="Waiting for the owner">
            {phase.code ? (
              <>
                They see your request as <span className="font-medium text-ink">{phase.pending.identity.name}</span>, next to this number. If they ask, make sure it matches.
              </>
            ) : (
              <>
                Your request is in as <span className="font-medium text-ink">{phase.pending.identity.name}</span>. When the owner opens it, a 6-digit code shows here and next to your
                request. They let you in once the two match.
              </>
            )}
          </Heading>
          {phase.code && <VerifyCode code={phase.code} />}
          <div className="flex items-center gap-3">
            <Spinner />
            <span className="text-[13px] text-ink-2">This page updates the moment you’re in.</span>
          </div>
          <Button variant="ghost" className="mt-6 -ml-3.5" onClick={giveUp}>
            Cancel request
          </Button>
        </>
      )}
      {(phase.kind === "denied" || phase.kind === "error") && (
        <>
          <Heading title={phase.kind === "denied" ? "The owner didn’t let you in" : "This channel won’t open"}>
            {phase.kind === "denied" ? "Your request was declined. Ask the owner for a new code if that was a mistake." : phase.message}
          </Heading>
          <Button variant="secondary" className="mt-6" onClick={phase.kind === "denied" ? giveUp : onBack}>
            Back to channels
          </Button>
        </>
      )}
    </Stage>
  )
}

function AskToJoin({ code, listed, onAsked, onCancel }: { code: string; listed?: ChannelRow; onAsked: (p: PendingJoin) => void; onCancel: () => void }) {
  const auth = useAuth()
  // People join under their own signed-in name.
  const [name, setName] = useState(() => (auth.user ? handleFor(personName(auth.user), auth.user.email) : ""))
  useEffect(() => {
    if (auth.user && !name) setName(handleFor(personName(auth.user), auth.user.email))
  }, [auth.user, name])
  const [role, setRole] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = NAME_RE.test(name.trim()) && name.trim() !== "human"
  // Who sent this invite, as the relay knows them; "gone" when the channel was closed.
  const [invite, setInvite] = useState<{ ownerName: string | null } | "gone" | "loading">("loading")
  useEffect(() => {
    let cancelled = false
    inviteInfo(code)
      .then((i) => !cancelled && setInvite(i ?? "gone"))
      .catch(() => !cancelled && setInvite({ ownerName: null }))
    return () => {
      cancelled = true
    }
  }, [code])

  if (invite === "loading") return <Spinner />
  if (invite === "gone") {
    return (
      <>
        <Heading title="This invite no longer works">The channel was closed, or the code is wrong. Ask whoever sent it for a new one.</Heading>
        <Button variant="secondary" className="mt-6" onClick={onCancel}>
          Back
        </Button>
      </>
    )
  }

  const owner = invite.ownerName
  const intro =
    listed?.state === "elsewhere"
      ? { title: "Ask to join from this browser", text: "The owner lets this browser in as you, like any new member." }
      : listed?.state === "agents"
        ? { title: "Your agents are in this channel", text: "Ask the owner to let you in as well, so you can watch what they do." }
        : { title: owner ? `${owner} invited you to a channel` : "You’re invited to a channel", text: null }

  // Before sign-in: what this is and what happens next, in plain words.
  if (auth.status === "signed-out") {
    const who = owner ?? "The owner"
    return (
      <>
        <Heading title={intro.title}>{intro.text}</Heading>
        {!intro.text && (
          <>
            <p className="mt-3 text-[14px] leading-normal text-ink-2">
              Kiwi Channels is a private chat where people and their AI agents work together. Here’s what happens:
            </p>
            <ol className="mt-4 grid list-decimal gap-2 pl-5 text-[14px] leading-normal text-ink-2 marker:text-ink-3">
              <li>Sign in, so {owner ?? "the owner"} sees who’s asking.</li>
              <li>{who} lets you in after checking a short number with you.</li>
              <li>Messages are end-to-end encrypted, and only your browser can read them.</li>
            </ol>
          </>
        )}
        <div className="mt-6 flex gap-2">
          <Button size="lg" onClick={auth.signIn}>
            Sign in to continue
          </Button>
          <Button size="lg" variant="secondary" onClick={onCancel}>
            Not now
          </Button>
        </div>
      </>
    )
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        if (!valid) return
        setBusy(true)
        setError(null)
        try {
          onAsked(await askToJoin(code, name.trim(), role.trim() || undefined, await auth.token()))
        } catch (err) {
          setError(errorText(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      <Heading title={intro.title}>{intro.text ?? `A code only lets you ask. ${owner ?? "The owner"} approves every member, person or agent.`}</Heading>
      <label className="mt-6 block text-[12px] font-medium text-ink-2" htmlFor="ask-name">
        Your name in the channel
      </label>
      <TextField id="ask-name" className="mt-1.5" value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-invalid={!!name && !valid} />
      <label className="mt-4 block text-[12px] font-medium text-ink-2" htmlFor="ask-role">
        Role <span className="font-normal text-ink-3">(optional)</span>
      </label>
      <TextField id="ask-role" className="mt-1.5" value={role} onChange={(e) => setRole(e.target.value)} placeholder="reviewer" />
      {error && <p className="mt-3 text-[13px] text-alert">{error}</p>}
      <div className="mt-6 flex gap-2">
        <Button size="lg" type="submit" disabled={!valid || busy}>
          {busy ? <Spinner className="border-white/30 border-t-white" /> : "Ask to join"}
        </Button>
        <Button size="lg" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="mt-6 text-[12px] leading-normal text-ink-3">Your key is made in this browser. Once you’re in, messages are decrypted here and nowhere else.</p>
    </form>
  )
}
