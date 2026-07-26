import { cn } from '@/lib/utils'
import { useEffect, useState, type ComponentType, type ReactNode, type SVGProps } from 'react'
import { ChevronDown } from 'lucide-react'

interface PanelSectionProps {
  title?: ReactNode
  description?: ReactNode
  icon?: ComponentType<SVGProps<SVGSVGElement>>
  action?: ReactNode
  className?: string
  bodyClassName?: string
  children: ReactNode
  /** 是否可折叠，默认 true（默认展开） */
  collapsible?: boolean
  /** 默认展开状态，默认 true */
  defaultOpen?: boolean
  /** 持久化 key（基于 sessionStorage），传入后才会记忆展开状态 */
  storageKey?: string
  /** 可选 data-tour 错点，供新手引导选择器使用 */
  dataTour?: string
  /** AI 助手受控导航使用的稳定定位标识 */
  dataAgentTarget?: string
}

/** 统一的右侧面板分组容器：白色卡片 + 顶部小标题 + 内容。可折叠。 */
export function PanelSection({
  title,
  description,
  icon: Icon,
  action,
  className,
  bodyClassName,
  children,
  collapsible = true,
  defaultOpen = true,
  storageKey,
  dataTour,
  dataAgentTarget,
}: PanelSectionProps) {
  const computedKey = storageKey ?? (typeof title === 'string' ? `gd:panel:${title}` : undefined)
  const [open, setOpen] = useState<boolean>(() => {
    if (!collapsible) return true
    if (computedKey && typeof sessionStorage !== 'undefined') {
      const v = sessionStorage.getItem(computedKey)
      if (v === '0') return false
      if (v === '1') return true
    }
    return defaultOpen
  })

  useEffect(() => {
    if (!collapsible || !computedKey || typeof sessionStorage === 'undefined') return
    try {
      sessionStorage.setItem(computedKey, open ? '1' : '0')
    } catch {
      // ignore
    }
  }, [open, collapsible, computedKey])

  const hasHeader = Boolean(title || action || collapsible)

  return (
    <section
      data-tour={dataTour}
      data-agent-target={dataAgentTarget}
      className={cn(
        'overflow-hidden rounded-lg border border-border/60 bg-card text-card-foreground shadow-[var(--shadow-soft)]',
        className,
      )}
    >
      {hasHeader && (
        <header
          className={cn(
            'flex items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-3 py-2',
            !open && 'border-b-0',
            collapsible && 'cursor-pointer select-none',
          )}
          onClick={collapsible ? () => setOpen((v) => !v) : undefined}
          role={collapsible ? 'button' : undefined}
          tabIndex={collapsible ? 0 : undefined}
          onKeyDown={
            collapsible
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setOpen((v) => !v)
                  }
                }
              : undefined
          }
        >
          <div className="flex items-center gap-2 min-w-0">
            {Icon && (
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Icon className="size-3.5" />
              </span>
            )}
            <div className="min-w-0">
              {title && <h3 className="truncate text-xs font-semibold">{title}</h3>}
              {description && (
                <p className="truncate text-[11px] text-muted-foreground">{description}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {action && <div onClick={(e) => e.stopPropagation()}>{action}</div>}
            {collapsible && (
              <ChevronDown
                className={cn(
                  'size-4 text-muted-foreground transition-transform',
                  !open && '-rotate-90',
                )}
              />
            )}
          </div>
        </header>
      )}
      {open && <div className={cn('space-y-3 p-3', bodyClassName)}>{children}</div>}
    </section>
  )
}
