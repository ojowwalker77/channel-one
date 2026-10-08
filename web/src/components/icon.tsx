import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"

export type { IconSvgElement }

/** Hugeicons at one consistent weight across the app. */
export function Icon({ icon, size = 18, strokeWidth = 1.6, className }: { icon: IconSvgElement; size?: number; strokeWidth?: number; className?: string }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={strokeWidth} color="currentColor" className={className} aria-hidden />
}
