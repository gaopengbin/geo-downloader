import type { ComponentProps } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Button, type ButtonProps } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function TaskCardActions({ className, ...props }: ComponentProps<'div'>) {
  return <div data-task-card-actions className={cn('mt-2 flex min-w-0 flex-wrap items-center gap-1 border-t pt-2', className)} {...props}/>
}

type TaskCardActionProps = Omit<ButtonProps, 'size' | 'variant' | 'asChild'> & {
  icon: LucideIcon
  danger?: boolean
}

export function TaskCardAction({ icon: Icon, children, danger, className, title, ...props }: TaskCardActionProps) {
  return <Button {...props} data-task-card-action type={props.type ?? 'button'} size="sm" variant="outline"
    title={title ?? (typeof children === 'string' ? children : undefined)}
    className={cn('h-7 min-w-0 max-w-full shrink-0 gap-1 px-1 text-xs', danger && 'text-muted-foreground hover:text-destructive', className)}>
    <Icon aria-hidden="true" className="size-3.5"/>
    <span className="min-w-0 truncate">{children}</span>
  </Button>
}
