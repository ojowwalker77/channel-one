import { Copy01Icon, Delete02Icon, FingerPrintIcon } from "@hugeicons/core-free-icons"
import { useEffect, useState, type ReactNode } from "react"

import { formatFull, formatShort } from "@/lib/format"
import { cancelled, passkeysAvailable } from "@/lib/passkey"
import { addPasskey, dismissCancelled, removePasskey, resetVault, setUpVault, unlockWithCode, unlockWithPasskey, useVault } from "@/lib/vault"
import { cx } from "@/lib/utils"
import { Icon } from "./icon"
import { Alert, Button, IconButton, Modal, Spinner, TextField, errorText, toast } from "./kit"

// The vault, as the person sees it: one passkey touch and every channel you're
// in is here. lib/vault.ts does the work; VaultCard and PasskeysSheet wire it up.

const LATER = "mc.vault.later"

function brought(n: number): string {
  return n === 0 ? "Your channels are unlocked" : n === 1 ? "1 channel added" : `${n} channels added`
}

/** Report a failed vault step, unless the person just closed the passkey prompt. */
function failed(err: unknown) {
  if (!cancelled(err)) toast(errorText(err), "error")
}

/** The vault card in the sidebar, and the dialogs it opens. Shows nothing once the vault is open. */
export function VaultCard() {
  const vault = useVault()
  const [supported, setSupported] = useState(false)
  const [later, setLater] = useState(() => localStorage.getItem(LATER) === "1")
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const [entering, setEntering] = useState(false)
  // A passkey touch that didn't open the vault: maybe it isn't the person's at all.
  const [stuck, setStuck] = useState(false)
  const [resetting, setResetting] = useState(false)
  useEffect(() => void passkeysAvailable().then(setSupported), [])

  const run = async <T,>(fn: () => Promise<T>, then: (v: T) => void, onFail?: () => void) => {
    setBusy(true)
    try {
      then(await fn())
    } catch (err) {
      failed(err)
      onFail?.()
    } finally {
      setBusy(false)
    }
  }

  const show = (vault.kind === "none" && supported && !later) || vault.kind === "locked"
  return (
    <>
      {show && (
        <VaultPrompt
          state={vault.kind === "none" ? "none" : "locked"}
          busy={busy}
          onSetUp={() => void run(setUpVault, setCode)}
          onUnlock={() =>
            void run(
              unlockWithPasskey,
              (n) => toast(brought(n)),
              () => setStuck(true)
            )
          }
          onRecovery={() => setEntering(true)}
          stuck={stuck}
          resetAt={vault.kind === "locked" ? vault.resetAt : undefined}
          onReset={() => setResetting(true)}
          onLater={
            vault.kind === "none"
              ? () => {
                  localStorage.setItem(LATER, "1")
                  setLater(true)
                }
              : undefined
          }
        />
      )}
      <RecoveryCodeModal code={code} onDone={() => setCode(null)} />
      <Alert
        open={resetting}
        onClose={() => setResetting(false)}
        title="Reset your vault?"
        message="In 24 hours the list of channels saved to it is erased, and you can set up a new one with your passkey. If any device of yours still opens it before then, the reset is cancelled. Your channels themselves aren’t touched."
      >
        <Button variant="secondary" onClick={() => setResetting(false)}>
          Cancel
        </Button>
        <Button variant="danger" onClick={() => (setResetting(false), void run(resetVault, (at) => toast(`Your vault resets ${formatFull(at)}`)))}>
          Reset vault
        </Button>
      </Alert>
      <Alert
        open={vault.kind === "open" && !!vault.cancelled}
        onClose={dismissCancelled}
        title="Someone tried to reset your vault"
        message="A reset was asked for from a session signed in as you, and this browser cancelled it. If that wasn’t you, someone may have your sign-in: sign out everywhere and change your password."
      >
        <Button onClick={dismissCancelled}>OK</Button>
      </Alert>
      <RecoveryEntryModal
        open={entering}
        onClose={() => setEntering(false)}
        onSubmit={async (c) => {
          const n = await unlockWithCode(c)
          setEntering(false)
          toast(brought(n))
        }}
      />
    </>
  )
}

/** Passkeys, from the account menu. */
export function PasskeysSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const vault = useVault()
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const wraps = vault.kind === "open" || vault.kind === "locked" ? vault.wraps : []
  const step = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <PasskeysModal
        open={open && code === null}
        onClose={onClose}
        wraps={wraps}
        busy={busy}
        onAdd={() => void step(async () => (await addPasskey(), toast("Passkey added")))}
        onRemove={(w) => void step(async () => setCode(await removePasskey(w)))}
      />
      <RecoveryCodeModal code={code} onDone={() => setCode(null)} />
    </>
  )
}

export interface WrapRow {
  id: string
  kind: "passkey" | "recovery"
  label: string
  created: number
}

/** A quiet card above the channel list: set up the vault once, or unlock it on a new browser. */
export function VaultPrompt({
  state,
  busy,
  onSetUp,
  onUnlock,
  onRecovery,
  onLater,
  stuck,
  resetAt,
  onReset,
}: {
  state: "none" | "locked"
  busy: boolean
  onSetUp: () => void
  onUnlock: () => void
  onRecovery: () => void
  onLater?: () => void
  /** A touch didn't open it. */
  stuck?: boolean
  resetAt?: number
  onReset?: () => void
}) {
  const text =
    state === "none"
      ? "Save them to a passkey. On any browser you sign in to, a touch brings them all back."
      : stuck
        ? "This vault doesn’t open with that passkey. If you didn’t set it up, or you’ve lost every passkey and the recovery code, reset it."
        : "They’re saved to a passkey. Touch it to bring every channel to this browser."
  return (
    <div className="mx-3 mt-1 mb-2 rounded-[10px] bg-wash p-3">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold">
        <Icon icon={FingerPrintIcon} size={15} className="text-ink-2" />
        {state === "none" ? "Your channels on every device" : "Unlock your channels"}
      </p>
      <p className="mt-1 text-[12.5px] leading-normal text-ink-2">{text}</p>
      {resetAt && (
        <p className="mt-1.5 text-[12.5px] leading-normal font-medium text-alert">
          A reset was asked for. Your vault is erased {formatFull(resetAt)} unless a device that has it opens Channels first.
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1">
        <Button size="sm" onClick={state === "none" ? onSetUp : onUnlock} disabled={busy}>
          {busy ? <Spinner className="size-3.5 border-accent-ink/30 border-t-accent-ink" /> : state === "none" ? "Set up passkey" : "Use passkey"}
        </Button>
        {state === "locked" && (
          <Button size="sm" variant="ghost" onClick={onRecovery} disabled={busy}>
            Use recovery code
          </Button>
        )}
        {state === "locked" && stuck && !resetAt && onReset && (
          <Button size="sm" variant="danger" onClick={onReset} disabled={busy}>
            Reset vault
          </Button>
        )}
        {onLater && (
          <Button size="sm" variant="ghost" onClick={onLater} disabled={busy}>
            Not now
          </Button>
        )}
      </div>
    </div>
  )
}

/** Shown once, right after the vault is made or the code is replaced. */
export function RecoveryCodeModal({ code, onDone }: { code: string | null; onDone: () => void }) {
  const [saved, setSaved] = useState(false)
  return (
    <Modal open={code !== null} onClose={() => saved && onDone()}>
      <div className="p-5">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Save your recovery code</h2>
        <p className="mt-1 text-[13px] leading-normal text-ink-2">
          If you lose every passkey, this code is the only other way into your vault. It won’t be shown again. Keep it in a password manager or on paper.
        </p>
        <div className="mt-4 flex items-center gap-2 rounded-[10px] bg-wash px-3 py-2.5">
          <code className="min-w-0 flex-1 font-mono text-[13.5px] leading-relaxed tracking-wide break-all select-all">{code}</code>
          <IconButton label="Copy" onClick={() => code && navigator.clipboard.writeText(code).then(() => toast("Copied"))}>
            <Icon icon={Copy01Icon} size={16} />
          </IconButton>
        </div>
        <label className="mt-4 flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="size-4 accent-[var(--accent)]" />
          I’ve saved it somewhere safe
        </label>
        <div className="mt-5 flex justify-end">
          <Button disabled={!saved} onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** Type the recovery code instead of touching a passkey. */
export function RecoveryEntryModal({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (code: string) => Promise<void> }) {
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSubmit(value)
      setValue("")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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
          void submit()
        }}
      >
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Use your recovery code</h2>
        <p className="mt-1 text-[13px] leading-normal text-ink-2">The code you saved when you set up your passkey. Spaces and dashes don’t matter.</p>
        <TextField autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="XXXX-XXXX-XXXX-…" spellCheck={false} autoComplete="off" className="mt-4 font-mono tracking-wide" />
        {error && <p className="mt-2 text-[12.5px] text-alert">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || value.trim().length < 8}>
            {busy ? <Spinner className="size-3.5 border-accent-ink/30 border-t-accent-ink" /> : "Unlock"}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** Your passkeys and recovery code: add one, remove one, or replace the code. */
export function PasskeysModal({
  open,
  onClose,
  wraps,
  busy,
  onAdd,
  onRemove,
}: {
  open: boolean
  onClose: () => void
  wraps: WrapRow[]
  busy: boolean
  onAdd: () => void
  onRemove: (w: WrapRow) => void
}) {
  const [removing, setRemoving] = useState<WrapRow | null>(null)
  const passkeys = wraps.filter((w) => w.kind === "passkey")
  const recovery = wraps.find((w) => w.kind === "recovery")
  return (
    <>
      <Modal open={open && !removing} onClose={onClose} wide>
        <div className="p-5">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Passkeys</h2>
          <p className="mt-1 text-[13px] leading-normal text-ink-2">Any of these unlocks your channels on a browser you sign in to. Add one for each phone or computer you use.</p>
          <ul className="mt-4 divide-y divide-line rounded-[10px] shadow-[inset_0_0_0_1px_var(--line)]">
            {passkeys.map((w) => (
              <Row key={w.id} title={w.label} note={`Added ${formatShort(w.created)}`}>
                <IconButton label={`Remove ${w.label}`} onClick={() => setRemoving(w)} disabled={busy || passkeys.length === 1}>
                  <Icon icon={Delete02Icon} size={16} />
                </IconButton>
              </Row>
            ))}
            <Row title="Recovery code" note={recovery ? `Made ${formatShort(recovery.created)}. A new one replaces it whenever a passkey is removed.` : "None"} />
          </ul>
          <div className="mt-5 flex justify-between gap-2">
            <Button variant="secondary" onClick={onAdd} disabled={busy}>
              {busy ? <Spinner /> : "Add a passkey"}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
      <Alert
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.label ?? "this passkey"}?`}
        message="Your vault gets a new key, opened by the passkey you touch next and a new recovery code. Your other passkeys stop working until you add them again. Browsers that already have your channels keep them; to shut one out, leave or close its channels."
      >
        <Button variant="secondary" onClick={() => setRemoving(null)}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            if (removing) onRemove(removing)
            setRemoving(null)
          }}
        >
          Remove
        </Button>
      </Alert>
    </>
  )
}

function Row({ title, note, children }: { title: string; note: string; children?: ReactNode }) {
  return (
    <li className={cx("flex items-center gap-3 px-3 py-2.5")}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{title}</span>
        <span className="block text-[12px] text-ink-3">{note}</span>
      </span>
      {children}
    </li>
  )
}
