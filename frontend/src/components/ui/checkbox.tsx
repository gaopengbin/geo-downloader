import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export const Checkbox = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(
  ({ className, ...props }, ref) => <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
    <input ref={ref} type="checkbox" className={cn('peer size-4 cursor-pointer appearance-none rounded-sm border border-input bg-background checked:border-primary checked:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50', className)} {...props}/>
    <Check aria-hidden="true" className="pointer-events-none absolute size-3 text-primary-foreground opacity-0 peer-checked:opacity-100"/>
  </span>,
)
Checkbox.displayName = 'Checkbox'
