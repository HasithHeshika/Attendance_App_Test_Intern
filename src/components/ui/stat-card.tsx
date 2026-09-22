import * as React from "react"
import { cn } from "@/lib/utils"
import { Card } from "@/components/ui/card"

export type Tone = "primary" | "success" | "warning" | "warnStrong" | "destructive" | "brand" | "muted"

const toneMap: Record<Tone, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  warnStrong: "bg-warn-strong/10 text-warn-strong",
  destructive: "bg-destructive/10 text-destructive",
  brand: "bg-brand/10 text-brand",
  muted: "bg-muted text-muted-foreground",
}

// A whisper of the tone colour bleeding from the top-right corner — gives each card
// its own identity without shouting. Mirrors the dashboard hero's gradient wash.
const washMap: Record<Tone, string> = {
  primary: "from-primary/[0.06]",
  success: "from-success/[0.06]",
  warning: "from-warning/[0.07]",
  warnStrong: "from-warn-strong/[0.08]",
  destructive: "from-destructive/[0.08]",
  brand: "from-brand/[0.06]",
  muted: "from-muted/30",
}

interface StatCardProps {
  label: React.ReactNode
  value: React.ReactNode
  icon?: React.ElementType
  tone?: Tone
  hint?: React.ReactNode
  /** Small node rendered next to the value — a trend pill, delta chip, etc. */
  trend?: React.ReactNode
  /** Optional trailing element (chart, breakdown). Anchored to the bottom for an even KPI row. */
  trailing?: React.ReactNode
  /** Wrap a long label onto 2 lines instead of truncating with an ellipsis — for tight grids
   *  (many columns) where a single-line label would otherwise get cut off. */
  wrapLabel?: boolean
  className?: string
}

/** Compact KPI tile for dashboards / overviews. Use inside a grid; cards align as a row. */
export function StatCard({ label, value, icon: Icon, tone = "primary", hint, trend, trailing, wrapLabel, className }: StatCardProps) {
  return (
    <Card
      className={cn(
        // Micro-interaction: a subtle GPU-cheap hover lift + shadow. Reduced-motion no-ops.
        "group relative isolate flex h-full flex-col overflow-hidden p-3 sm:p-5 transition-[transform,box-shadow] duration-200 ease-out",
        "hover:-translate-y-0.5 hover:shadow-soft",
        "motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        className,
      )}
    >
      {/* Tone wash — faint at rest, a touch warmer on hover. Pointer-events-none, behind content. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 -z-10 bg-gradient-to-bl to-transparent opacity-70 transition-opacity duration-300 group-hover:opacity-100",
          washMap[tone],
        )}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn(
            "text-[10px] sm:text-xs font-medium uppercase tracking-wide text-muted-foreground",
            wrapLabel ? "line-clamp-2 break-words" : "truncate",
          )}>{label}</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className="text-xl sm:text-2xl font-semibold leading-tight tracking-tight text-foreground">{value}</p>
            {trend}
          </div>
          {hint && <p className="mt-0.5 text-[11px] sm:text-xs text-muted-foreground">{hint}</p>}
        </div>
        {Icon && (
          <div className={cn(
            // Icon chip gives a little pop on card hover.
            "flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-lg transition-transform duration-200 ease-out",
            "group-hover:scale-110 group-hover:-rotate-3 motion-reduce:group-hover:scale-100 motion-reduce:group-hover:rotate-0",
            toneMap[tone],
          )}>
            <Icon className="h-4.5 w-4.5 sm:h-5 sm:w-5" />
          </div>
        )}
      </div>
      {trailing && <div className="mt-auto pt-2.5 sm:pt-3">{trailing}</div>}
    </Card>
  )
}
