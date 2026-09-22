import * as React from "react"
import { cn } from "@/lib/utils"

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          // text-base (16px) below `md`, not text-sm (14px) — iOS Safari auto-zooms the page
          // on focus of any input under 16px, which shifts the visual viewport without
          // resizing the layout one and leaves fixed-position UI (dialogs, BottomNav, sheets)
          // visually misplaced until the user manually zooms back out. Desktop keeps text-sm.
          "flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-base md:text-sm shadow-xs transition-colors",
          "placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
