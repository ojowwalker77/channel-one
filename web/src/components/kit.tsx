import { Dialog } from "@base-ui/react/dialog"
import { Component, useSyncExternalStore, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref } from "react"

import { initials } from "@/lib/format"
import { noteSignInGone } from "@/lib/session"
import { cx } from "@/lib/utils"
import { Tooltip } from "./ui/tooltip"

// The few pieces everything is built from. Neutral by default; the accent
// (solid ink) is reserved for the one thing on screen you're most likely to do
// next. Menus, tooltips and popovers live in ./ui, on Base UI.

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"

const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink hover:opacity-90 active:opacity-80",
  secondary: "bg-wash-2 text-ink hover:bg-[color-mix(in_srgb,var(--ink)_11%,transparent)]",
  ghost: "text-ink-2 hover:bg-wash hover:text-ink",
  danger: "text-alert hover:bg-[color-mix(in_srgb,var(--alert)_9%,transparent)]",
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: "sm" | "md" | "lg"
}) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-[opacity,background-color,color] duration-150 select-none disabled:pointer-events-none disabled:opacity-40",
        size === "sm" && "h-7 rounded-[7px] px-2.5 text-[13px]",
        size === "md" && "h-8 rounded-[8px] px-3.5 text-[13px]",
        size === "lg" && "h-10 rounded-[10px] px-5 text-[14px]",
        BUTTON[variant],
        className
      )}
      {...props}
    />
  )
}

/** A control that's only an icon. Its label shows as a tooltip and is what screen readers say. */
export function IconButton({
  className,
  label,
  active,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  active?: boolean
  ref?: Ref<HTMLButtonElement>
}) {
  return (
    <Tooltip label={label}>
      <button
        type={type}
        aria-label={label}
        className={cx(
          "relative inline-flex shrink-0 items-center justify-center rounded-[8px] transition-colors duration-150 disabled:opacity-40",
          !/(^|\s)size-/.test(className ?? "") && "size-8",
          active ? "bg-wash-2 text-ink" : "text-ink-2 hover:bg-wash hover:text-ink data-popup-open:bg-wash-2 data-popup-open:text-ink",
          className
        )}
        {...props}
      />
    </Tooltip>
  )
}

export function TextField({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "h-9 w-full rounded-[8px] bg-canvas px-3 text-[14px] text-ink shadow-[inset_0_0_0_1px_var(--line)] transition-shadow outline-none placeholder:text-ink-3 focus:shadow-[inset_0_0_0_1px_var(--ring),0_0_0_3px_var(--wash-2)] focus-visible:outline-none",
        className
      )}
      {...props}
    />
  )
}

/**
 * A monogram. Agents are rounded squares and people are circles, so you can
 * tell who's a person at a glance without a single colour.
 */
export function Monogram({ name, agent, size = 28, online, className }: { name: string; agent?: boolean; size?: number; online?: boolean; className?: string }) {
  const letters = initials(name)
  return (
    <span className={cx("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <span
        className={cx(
          "flex size-full items-center justify-center font-semibold text-ink-2 select-none",
          agent ? "bg-wash-2 shadow-[inset_0_0_0_0.5px_var(--line)]" : "bg-[color-mix(in_srgb,var(--ink)_12%,var(--canvas))]"
        )}
        style={{ borderRadius: agent ? size * 0.28 : size / 2, fontSize: Math.round(size * (letters.length > 1 ? 0.36 : 0.42)), letterSpacing: "-0.01em" }}
      >
        {letters}
      </span>
      {online && (
        <span
          className="absolute -right-0.5 -bottom-0.5 rounded-full bg-live shadow-[0_0_0_2px_var(--canvas)]"
          style={{ width: Math.max(7, Math.round(size * 0.26)), height: Math.max(7, Math.round(size * 0.26)) }}
          title="Online"
        />
      )}
    </span>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-label="Loading" className={cx("inline-block size-4 animate-spin rounded-full border-[1.5px] border-wash-2 border-t-ink-2", className)} />
}

/** Text tabs: the current one in ink, the rest quiet. Arrow keys move between them. */
export function Tabs<T extends string>({ value, options, onChange, stretch, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; stretch?: boolean; label?: string }) {
  return (
    <div
      className={cx("flex items-center gap-0.5", stretch && "rounded-[9px] bg-wash p-0.5")}
      role="tablist"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
        e.preventDefault()
        const at = options.findIndex((o) => o.value === value)
        const next = options[(at + (e.key === "ArrowRight" ? 1 : -1) + options.length) % options.length]!
        onChange(next.value)
        // currentTarget is cleared once the handler returns, so keep the list for the next frame.
        const list = e.currentTarget
        requestAnimationFrame(() => list.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          className={cx(
            "flex h-7 items-center justify-center gap-1.5 rounded-[7px] px-2.5 text-[13px] font-medium transition-colors duration-150",
            stretch && "flex-1",
            o.value === value ? "bg-wash-2 text-ink" : "text-ink-2 hover:text-ink"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A centered modal: alerts, small forms. Escape or a click outside closes it; focus stays inside while open. */
export function Modal({ open, onClose, children, wide }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay transition-opacity duration-150 data-starting-style:opacity-0" />
        <Dialog.Popup
          className={cx(
            "fixed top-1/2 left-1/2 z-50 max-h-[88svh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[14px] bg-raised shadow-pop outline-none",
            "transition-[opacity,scale] duration-150 ease-out data-starting-style:scale-[0.98] data-starting-style:opacity-0",
            wide ? "max-w-[520px]" : "max-w-[340px]"
          )}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** An alert: title, message, and actions on the right. */
export function Alert({ open, onClose, title, message, children }: { open: boolean; onClose: () => void; title: ReactNode; message?: ReactNode; children: ReactNode }) {
  return (
    <Modal open={open} onClose={onClose}>
      <div className="px-5 pt-5 pb-4">
        <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em]">{title}</Dialog.Title>
        {message && (
          <Dialog.Description render={<div />} className="mt-1 text-[13px] leading-normal text-ink-2">
            {message}
          </Dialog.Description>
        )}
      </div>
      <div className="flex justify-end gap-2 px-5 pb-5">{children}</div>
    </Modal>
  )
}

// ---------- toasts ----------

interface ToastItem {
  id: number
  text: string
  tone?: "error"
}

let toasts: ToastItem[] = []
const listeners = new Set<() => void>()
let nextId = 1

function emit() {
  for (const l of listeners) l()
}

/** A short notice at the bottom of the window. */
export function toast(text: string, tone?: "error") {
  const id = nextId++
  toasts = [...toasts.slice(-2), { id, text, tone }]
  emit()
  setTimeout(
    () => {
      toasts = toasts.filter((t) => t.id !== id)
      emit()
    },
    tone === "error" ? 6000 : 2200
  )
}

export function Toaster() {
  const items = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => toasts
  )
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cx("animate-rise max-w-md rounded-[10px] bg-ink px-3.5 py-2 text-[13px] font-medium text-canvas shadow-pop", t.tone === "error" && "bg-alert text-white")}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}

/** The wordmark: the product, then the company that makes it, quietly. Type does the work. */
export function Wordmark({ className, byline = true }: { className?: string; byline?: boolean }) {
  return (
    <span className={cx("inline-flex items-baseline gap-[0.35em] whitespace-nowrap", className)}>
      <span className="font-semibold tracking-[-0.03em] text-ink">Channels</span>
      {byline && <span className="text-[max(0.42em,11px)] font-medium tracking-[-0.01em] text-ink-3">by Kiwi Init</span>}
    </span>
  )
}

/** What to tell someone about a failure. A gone sign-in is also reported, so the page can sign out. */
export function errorText(err: unknown): string {
  if (noteSignInGone(err)) return "Your sign-in expired. Sign in again to keep going."
  return err instanceof Error ? err.message : String(err)
}

/** If a view crashes, keep the app alive: say so, and offer a way back. `whole`: the last net, around everything. */
export class Boundary extends Component<{ children: ReactNode; resetKey?: string; whole?: boolean }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false })
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex h-full flex-1 items-center justify-center p-8">
        <div className="max-w-xs">
          <p className="text-[14px] font-semibold">{this.props.whole ? "Channels hit a problem" : "This view hit a problem"}</p>
          <p className="mt-1 text-[13px] leading-normal text-ink-2">{this.props.whole ? "Nothing was lost: your channels and keys are still in this browser. Reload to carry on." : "Nothing was lost. Reload to try again; your other channels still work."}</p>
          <Button className="mt-4" onClick={() => location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    )
  }
}
