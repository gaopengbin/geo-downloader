import { memo, type ComponentPropsWithoutRef } from 'react'
import { MapPin } from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { parseAssistantActionHref } from '@/features/assistant/assistant-actions'
import { cn } from '@/lib/utils'

interface AssistantMarkdownProps {
  content: string
  onAction?: (href: string) => void
}

export const AssistantMarkdown = memo(function AssistantMarkdown({
  content,
  onAction,
}: AssistantMarkdownProps) {
  return (
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) =>
        parseAssistantActionHref(url) ? url : defaultUrlTransform(url)
      }
      components={{
        h1: ({ className, ...props }) => (
          <h1 className={cn('mb-2 mt-3 text-base font-semibold first:mt-0', className)} {...props} />
        ),
        h2: ({ className, ...props }) => (
          <h2 className={cn('mb-1.5 mt-3 text-sm font-semibold first:mt-0', className)} {...props} />
        ),
        h3: ({ className, ...props }) => (
          <h3 className={cn('mb-1 mt-2.5 text-sm font-medium first:mt-0', className)} {...props} />
        ),
        p: ({ className, ...props }) => (
          <p className={cn('my-2 first:mt-0 last:mb-0', className)} {...props} />
        ),
        ul: ({ className, ...props }) => (
          <ul className={cn('my-2 list-disc space-y-1 pl-5', className)} {...props} />
        ),
        ol: ({ className, ...props }) => (
          <ol className={cn('my-2 list-decimal space-y-1 pl-5', className)} {...props} />
        ),
        li: ({ className, ...props }) => (
          <li className={cn('pl-0.5 marker:text-muted-foreground', className)} {...props} />
        ),
        blockquote: ({ className, ...props }) => (
          <blockquote
            className={cn('my-2 border-l-2 border-primary/40 pl-3 text-muted-foreground', className)}
            {...props}
          />
        ),
        a: ({ className, href, children, ...props }) => {
          const action = parseAssistantActionHref(href)
          if (action && href) {
            return (
              <button
                type="button"
                className={cn(
                  'inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2 hover:text-primary/80',
                  className,
                )}
                title={`定位到${action.label}`}
                onClick={() => onAction?.(href)}
              >
                <MapPin className="size-3.5 shrink-0" />
                {children}
              </button>
            )
          }
          return (
            <a
              {...props}
              href={href}
              className={cn('font-medium text-primary underline underline-offset-2', className)}
              target="_blank"
              rel="noreferrer noopener"
            >
              {children}
            </a>
          )
        },
        pre: ({ className, ...props }) => (
          <pre
            className={cn(
              'my-2 max-w-full overflow-x-auto rounded-md border bg-background p-3 text-xs leading-5',
              className,
            )}
            {...props}
          />
        ),
        code: ({ className, ...props }) => (
          <code
            className={cn(
              'rounded bg-background/80 px-1 py-0.5 font-mono text-[0.9em] before:content-none after:content-none',
              className,
            )}
            {...props}
          />
        ),
        table: ({ className, ...props }) => (
          <div className="my-2 max-w-full overflow-x-auto rounded-md border">
            <table className={cn('w-full min-w-80 border-collapse text-xs', className)} {...props} />
          </div>
        ),
        th: ({ className, ...props }) => (
          <th
            className={cn(
              'border-b border-r bg-background px-2 py-1.5 text-left font-medium last:border-r-0',
              className,
            )}
            {...props}
          />
        ),
        td: ({ className, ...props }) => (
          <td
            className={cn('border-b border-r px-2 py-1.5 align-top last:border-r-0', className)}
            {...props}
          />
        ),
        tr: ({ className, ...props }) => (
          <tr className={cn('last:[&_td]:border-b-0', className)} {...props} />
        ),
        hr: ({ className, ...props }) => (
          <hr className={cn('my-3 border-border', className)} {...props} />
        ),
        input: ({ className, ...props }) => (
          <input
            {...props}
            className={cn('mr-1.5 accent-primary', className)}
            disabled
          />
        ),
        img: ImagePlaceholder,
      }}
    >
      {content}
    </ReactMarkdown>
  )
})

function ImagePlaceholder({ alt }: ComponentPropsWithoutRef<'img'>) {
  return (
    <span className="text-xs text-muted-foreground">
      {alt ? `[图片：${alt}]` : '[远程图片已隐藏]'}
    </span>
  )
}
