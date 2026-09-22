"use client"

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { AnimatePresence, motion } from "motion/react"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.98]",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-xs",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-xs",
        success: "bg-success text-success-foreground hover:bg-success/90 shadow-xs",
        brand: "bg-brand text-brand-foreground hover:bg-brand/90 shadow-xs",
        outline: "border border-input bg-card hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-11 rounded-md px-6",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)

// Filled, solid-background variants get a material-style ripple on click.
const RIPPLE_VARIANTS = new Set(["default", "destructive", "success", "brand", "secondary"])

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

type RippleDot = { id: number; x: number; y: number }

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, onClick, children, ...props }, ref) => {
    // asChild renders a single arbitrary child via Slot — can't inject ripple nodes.
    if (asChild) {
      return (
        <Slot className={cn(buttonVariants({ variant, size, className }))} ref={ref} onClick={onClick} {...props}>
          {children}
        </Slot>
      )
    }

    const rippleEnabled = variant == null || RIPPLE_VARIANTS.has(variant)
    const [ripples, setRipples] = React.useState<RippleDot[]>([])
    const innerRef = React.useRef<HTMLButtonElement>(null)
    React.useImperativeHandle(ref, () => innerRef.current as HTMLButtonElement)

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      if (rippleEnabled && innerRef.current) {
        const rect = innerRef.current.getBoundingClientRect()
        const dot: RippleDot = { id: Date.now() + Math.random(), x: e.clientX - rect.left, y: e.clientY - rect.top }
        setRipples((prev) => [...prev, dot])
        setTimeout(() => setRipples((prev) => prev.filter((r) => r.id !== dot.id)), 600)
      }
      onClick?.(e)
    }

    return (
      <button
        ref={innerRef}
        className={cn(buttonVariants({ variant, size, className }), rippleEnabled && "overflow-hidden")}
        onClick={handleClick}
        {...props}
      >
        {children}
        {rippleEnabled && (
          <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
            <AnimatePresence>
              {ripples.map((r) => (
                <motion.span
                  key={r.id}
                  initial={{ scale: 0, opacity: 0.3 }}
                  animate={{ scale: 12, opacity: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.6, ease: "easeOut" }}
                  style={{ position: "absolute", top: r.y - 8, left: r.x - 8, width: 16, height: 16, borderRadius: "9999px", backgroundColor: "currentColor" }}
                />
              ))}
            </AnimatePresence>
          </span>
        )}
      </button>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
