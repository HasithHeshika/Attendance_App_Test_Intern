"use client"

import * as React from "react"
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"
import { Check, Minus } from "lucide-react"
import { cn } from "@/lib/utils"

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, checked, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    checked={checked}
    className={cn(
      "peer h-4 w-4 shrink-0 rounded-[4px] border border-input shadow-xs transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
      // "some but not all" — a dash on a lighter fill, so it never reads as fully checked
      "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary/30 data-[state=indeterminate]:text-primary",
      className
    )}
    {...props}
  >
    {/* Radix shows the Indicator for BOTH checked and indeterminate, so the icon has to
        be chosen here — a tick for a partial selection would be a lie. */}
    <CheckboxPrimitive.Indicator className={cn("flex items-center justify-center text-current")}>
      {checked === "indeterminate"
        ? <Minus className="h-3.5 w-3.5" strokeWidth={3} />
        : <Check className="h-3.5 w-3.5" strokeWidth={3} />}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
