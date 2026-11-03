import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export const Checkbox = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(
  ({ className, ...props }, ref) => <span className="relative inline-flex size-5 shrink-0 items-center justify-center align-middle">
    <input ref={ref} type="checkbox" className={cn('peer absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed', className)} {...props}/>
    <span aria-hidden="true" data-checkbox-control className="pointer-events-none size-4 rounded-[3px] border border-muted-foreground/80! bg-background transition-colors peer-hover:border-primary! peer-checked:border-primary! peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background peer-disabled:opacity-40"/>
    <Check aria-hidden="true" strokeWidth={3} className="pointer-events-none absolute size-3 text-primary-foreground opacity-0 peer-checked:opacity-100 peer-disabled:text-primary-foreground/40"/>
  </span>,
)
Checkbox.displayName = 'Checkbox'
