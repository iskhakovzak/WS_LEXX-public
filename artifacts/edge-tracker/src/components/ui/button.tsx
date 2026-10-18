import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-[background-color,color,border-color,box-shadow,transform] duration-[var(--dur-1)] ease-smooth active:scale-[0.98] motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0" +
" hover-elevate active-elevate-2",
  {
    variants: {
      variant: {
        default:
           // @replit: no hover, and add primary border
           // Solid fill is a touch deeper than --primary so white text clears 4.5:1 (WCAG AA).
           "bg-primary-solid text-primary-foreground font-semibold border border-[hsl(var(--primary-solid)/0.6)] shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_6px_18px_-8px_hsl(var(--primary)/0.6)] hover:brightness-110",
        destructive:
          "border border-destructive/30 bg-destructive/12 text-destructive",
        // Glass family: outline = hairline glass pill, secondary = thicker glass pill,
        // ghost = no chrome until hover, then the same glass surface + hairline.
        outline:
          "glass-field text-foreground",
        secondary:
          "glass-field text-foreground bg-[var(--glass-thick-bg)]",
        ghost: "border border-transparent hover:border-[var(--field-border)] hover:bg-[var(--glass-hover-bg)] hover:shadow-[inset_0_1px_0_var(--glass-hi)] data-[state=open]:bg-[var(--glass-hover-bg)]",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        // Control-height scale (index.css): sm 32 / md 36 / lg 40, border included. min-h (not h) so an
        // explicit multi-line button (`h-auto whitespace-normal`) can still grow; the padding never pushes a
        // single line past the token (default used to render 39px next to 36px inputs).
        default: "min-h-9 px-4 py-1.5",
        sm: "min-h-8 px-3 text-xs [&_svg]:size-3.5",
        lg: "min-h-10 px-6 py-2",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8 [&_svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
