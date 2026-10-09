import { useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { encode } from "uqr"

import { offerLink, offerWaiting, withdrawOffer, type DeviceOffer } from "@mc/devices.ts"
import { displayName, useAuth } from "@/lib/auth"
import { clearOffer, handover, offerChannels, takeChannels } from "@/lib/devices"
import { Button, Modal, Spinner, Wordmark, errorText, toast } from "./kit"

/** A QR code drawn as one path; always dark on light, which is what cameras read best. */
function QrCode({ text, size = 200 }: { text: string; size?: number }) {
  const qr = useMemo(() => encode(text, { ecc: "M", border: 0 }), [text])
  const d = useMemo(() => {
    let p = ""
    qr.data.forEach((row, y) => row.forEach((on, x) => on && (p += `M${x} ${y}h1v1h-1z`)))
    return p
  }, [qr])
  return (
    <div className="inline-flex rounded-[12px] bg-white p-3.5 shadow-[0_0_0_0.5px_var(--line)]">
      <svg width={size} height={size} viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" role="img" aria-label="QR code for your other device">
        <path d={d} fill="#000" />
      </svg>
    </div>
  )
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function takeBack(live: RefObject<DeviceOffer | null>, token: RefObject<() => Promise<string | null>>) {
  const o = live.current
  live.current = null
  if (!o) return
  void token.current().then((t) => {
    if (t) void withdrawOffer(location.origin, t, o.id)
  })
}

type Step = { kind: "confirm" } | { kind: "working" } | { kind: "showing"; offer: DeviceOffer } | { kind: "taken" } | { kind: "expired" } | { kind: "error"; message: string }

/**
 * Hand this browser's channels to another of your devices: confirm what goes,
 * then show a QR code that works once, for ten minutes.
 */
export function AddDeviceModal({ onClose }: { onClose: () => void }) {
  const auth = useAuth()
  const [step, setStep] = useState<Step>({ kind: "confirm" })
  const [now, setNow] = useState(Date.now)
  const [what] = useState(handover)
  const live = useRef<DeviceOffer | null>(null)

  const token = useRef(auth.token)
  useEffect(() => {
    token.current = auth.token
  })
  // Leaving takes the code back, so nothing waits at the relay for no one.
  useEffect(() => () => takeBack(live, token), [])

  // While the code shows: tick the countdown, and notice when the other device takes it.
  useEffect(() => {
    if (step.kind !== "showing") return
    const { offer } = step
    const tick = window.setInterval(() => {
      setNow(Date.now())
      if (Date.now() > offer.expires) {
        live.current = null
        setStep({ kind: "expired" })
      }
    }, 1000)
    const poll = window.setInterval(async () => {
      const t = await auth.token()
      if (!t || Date.now() > offer.expires) return
      if (!(await offerWaiting(location.origin, t, offer.id).catch(() => true))) {
        live.current = null
        setStep((s) => (s.kind === "showing" && s.offer.id === offer.id ? { kind: "taken" } : s))
      }
    }, 2000)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
    }
  }, [step, auth])

  const show = async () => {
    setStep({ kind: "working" })
    try {
      const t = await auth.token()
      if (!t) throw new Error("Sign in first.")
      const offer = await offerChannels(t)
      live.current = offer
      setNow(Date.now())
      setStep({ kind: "showing", offer })
    } catch (err) {
      setStep({ kind: "error", message: errorText(err) })
    }
  }

  const close = () => {
    takeBack(live, token)
    onClose()
  }

  const owned = what.owned === 0 ? "" : what.owned === what.channels ? (what.channels === 1 ? ", which you own" : ", all of which you own") : `, ${what.owned} of which you own`

  return (
    <Modal open onClose={close}>
      <div className="p-5">
        {step.kind === "confirm" && (
          <>
            <h2 className="text-[15px] font-semibold">Add a device</h2>
            {what.channels === 0 ? (
              <p className="mt-1.5 text-[13px] leading-normal text-ink-2">This browser isn’t in any channels yet, so there’s nothing to bring over.</p>
            ) : (
              <>
                <p className="mt-1.5 text-[13px] leading-normal text-ink-2">
                  Bring your channels to your phone or another browser. It gets everything this browser has: {what.channels === 1 ? "1 channel" : `${what.channels} channels`}
                  {owned}.
                </p>
                {what.owned > 0 && <p className="mt-2 text-[13px] leading-normal text-ink-2">On channels you own, it can let people in and close the channel, like this browser.</p>}
                <p className="mt-2 text-[13px] leading-normal text-ink-2">Only scan the code with a device of your own.</p>
              </>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
              {what.channels > 0 && <Button onClick={() => void show()}>Show code</Button>}
            </div>
          </>
        )}
        {step.kind === "working" && <Spinner />}
        {step.kind === "showing" && (
          <>
            <h2 className="text-[15px] font-semibold">Scan with your other device</h2>
            <p className="mt-1.5 text-[13px] leading-normal text-ink-2">
              Point its camera here, then sign in as <span className="font-medium text-ink">{auth.user?.email ?? displayName(auth.user)}</span>.
            </p>
            <div className="mt-5 flex justify-center">
              <QrCode text={offerLink(location.origin, step.offer)} />
            </div>
            <p className="mt-4 text-center text-[12px] text-ink-3 tabular-nums">Works once · expires in {countdown(step.offer.expires - now)}</p>
            <div className="mt-5 flex justify-between gap-2">
              <Button
                variant="ghost"
                className="-ml-3"
                onClick={() => navigator.clipboard.writeText(offerLink(location.origin, step.offer)).then(() => toast("Copied. Open it only on your own device."))}
              >
                Copy link
              </Button>
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
            </div>
          </>
        )}
        {step.kind === "taken" && (
          <>
            <h2 className="text-[15px] font-semibold">Your channels are on your other device</h2>
            <p className="mt-1.5 text-[13px] leading-normal text-ink-2">Channels you join here later won’t follow on their own. Add the device again to bring them over.</p>
            <div className="mt-5 flex justify-end">
              <Button onClick={close}>Done</Button>
            </div>
          </>
        )}
        {(step.kind === "expired" || step.kind === "error") && (
          <>
            <h2 className="text-[15px] font-semibold">{step.kind === "expired" ? "That code expired" : "Couldn’t make a code"}</h2>
            <p className="mt-1.5 text-[13px] leading-normal text-ink-2">{step.kind === "expired" ? "Codes work for ten minutes. Show a new one when your device is ready." : step.message}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
              <Button onClick={() => void show()}>Show a new code</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/**
 * The page a scanned code opens: sign in as the same person, then take the
 * channels the other device offered.
 */
export function TakeChannelsPage({ offer, onDone }: { offer: { id: string; secret: string }; onDone: () => void }) {
  const auth = useAuth()
  const [state, setState] = useState<{ kind: "working" } | { kind: "done"; added: number; kept: number } | { kind: "error"; message: string }>({ kind: "working" })
  const started = useRef(false)

  useEffect(() => {
    if (auth.status !== "signed-in" || started.current) return
    started.current = true
    void (async () => {
      try {
        const t = await auth.token()
        if (!t) throw new Error("Sign in first.")
        const r = await takeChannels(t, offer)
        clearOffer()
        setState({ kind: "done", ...r })
      } catch (err) {
        clearOffer()
        setState({ kind: "error", message: errorText(err) })
      }
    })()
  }, [auth, offer])

  const added = state.kind === "done" ? (state.added === 1 ? "1 channel" : `${state.added} channels`) : ""

  return (
    <div className="flex h-svh flex-col">
      <header className="flex h-[56px] shrink-0 items-center px-5">
        <Wordmark className="text-[15px]" />
      </header>
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-[380px]">
          {auth.status === "off" ? (
            <>
              <h2 className="text-[20px] leading-tight font-semibold tracking-[-0.02em]">This relay can’t do that</h2>
              <p className="mt-2 text-[14px] leading-normal text-ink-2">Bringing channels between devices needs sign-in, and this relay doesn’t use it.</p>
              <Button size="lg" variant="secondary" className="mt-6" onClick={onDone}>
                Back to channels
              </Button>
            </>
          ) : auth.status === "signed-out" ? (
            <>
              <h2 className="text-[20px] leading-tight font-semibold tracking-[-0.02em]">Bring your channels here</h2>
              <p className="mt-2 text-[14px] leading-normal text-ink-2">Sign in with the same account as the device showing the code.</p>
              <Button size="lg" className="mt-6" onClick={auth.signIn}>
                Sign in to continue
              </Button>
            </>
          ) : state.kind === "working" ? (
            <>
              <h2 className="text-[20px] leading-tight font-semibold tracking-[-0.02em]">Bringing your channels here</h2>
              <Spinner className="mt-6" />
            </>
          ) : state.kind === "done" ? (
            <>
              <h2 className="text-[20px] leading-tight font-semibold tracking-[-0.02em]">{state.added ? `${added} added to this device` : "This device already had them"}</h2>
              <p className="mt-2 text-[14px] leading-normal text-ink-2">
                {state.kept > 0 && state.added > 0 ? `${state.kept} more were already here. ` : ""}Still end-to-end encrypted: only your devices hold the keys.
              </p>
              <Button size="lg" className="mt-6" onClick={onDone}>
                Open your channels
              </Button>
            </>
          ) : (
            <>
              <h2 className="text-[20px] leading-tight font-semibold tracking-[-0.02em]">That code didn’t work</h2>
              <p className="mt-2 text-[14px] leading-normal text-ink-2">{state.message}</p>
              <Button size="lg" variant="secondary" className="mt-6" onClick={onDone}>
                Back to channels
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
