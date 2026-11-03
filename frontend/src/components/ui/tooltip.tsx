import type { ComponentProps, ReactElement, ReactNode } from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

type TooltipProps = {
  content?: ReactNode
  children: ReactElement
  side?: ComponentProps<typeof TooltipPrimitive.Content>['side']
}

/** Use asChild so a tooltip never changes a card's flex/grid layout. */
export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  if (content == null || content === '') return children
  return <TooltipPrimitive.Provider delayDuration={350}>
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content data-geod-tooltip side={side} sideOffset={6} collisionPadding={8} hideWhenDetached
          className="z-[60] max-h-[min(20rem,var(--radix-tooltip-content-available-height))] max-w-[min(24rem,var(--radix-tooltip-content-available-width))] overflow-y-auto whitespace-pre-wrap rounded-md border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-md [overflow-wrap:anywhere]">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  </TooltipPrimitive.Provider>
}
