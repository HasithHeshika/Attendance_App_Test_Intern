import * as React from "react"
import { cn } from "@/lib/utils"

interface PageHeaderProps {
  title: React.ReactNode
  description?: React.ReactNode
  icon?: React.ElementType
  /** Right-aligned actions (buttons, filters, etc.) */
  actions?: React.ReactNode
  className?: string
}

/** Consistent page title block used at the top of every feature page.
 *  V2: the icon sits in a gradient chip (the one accent gradient per screen) with
 *  a soft highlight ring — the shared signature that ties every page together. */
export function PageHeader({ title, description, icon: Icon, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="flex items-center gap-3.5 min-w-0">
        {Icon && (
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-brand text-primary-foreground shadow-soft ring-1 ring-inset ring-[hsl(0_0%_100%/0.15)]">
            <Icon className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
