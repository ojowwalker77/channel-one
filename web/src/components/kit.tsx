import { useEffect, useSyncExternalStore, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react"

import { initials } from "@/lib/format"
import { cx } from "@/lib/utils"

// The few pieces everything is built from. Neutral by default; the accent
// is reserved for the one thing on screen you're most likely to do next.

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"

const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:brightness-110 active:brightness-95",
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
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" | "lg" }) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-[filter,background-color,color] duration-150 select-none disabled:pointer-events-none disabled:opacity-40",
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

export function IconButton({ className, label, active, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        "relative inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] transition-colors duration-150 disabled:opacity-40",
        active ? "bg-wash-2 text-ink" : "text-ink-2 hover:bg-wash hover:text-ink",
        className
      )}
      {...props}
    />
  )
}

export function TextField({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "h-9 w-full rounded-[8px] bg-canvas px-3 text-[14px] text-ink shadow-[inset_0_0_0_1px_var(--line)] outline-none transition-shadow placeholder:text-ink-3 focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-wash)] focus-visible:outline-none",
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

/** Text tabs: the current one in ink, the rest quiet. */
export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-0.5" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            "flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] font-medium transition-colors duration-150",
            o.value === value ? "bg-wash-2 text-ink" : "text-ink-2 hover:text-ink"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A centered modal: alerts, small forms. Escape or a click outside closes it. */
export function Modal({ open, onClose, children, wide }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/15 p-4 dark:bg-black/45" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className={cx("animate-rise max-h-[88svh] w-full overflow-y-auto rounded-[14px] bg-raised shadow-pop", wide ? "max-w-[520px]" : "max-w-[340px]")}>
        {children}
      </div>
    </div>
  )
}

/** An alert: title, message, and actions on the right. */
export function Alert({ open, onClose, title, message, children }: { open: boolean; onClose: () => void; title: ReactNode; message?: ReactNode; children: ReactNode }) {
  return (
    <Modal open={open} onClose={onClose}>
      <div className="px-5 pt-5 pb-4">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
        {message && <div className="mt-1 text-[13px] leading-normal text-ink-2">{message}</div>}
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

/** The wordmark. Type does the work; there is no logo to decorate. */
export function Wordmark({ className }: { className?: string }) {
  return <span className={cx("font-semibold tracking-[-0.03em] text-ink", className)}>channel-one</span>
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
