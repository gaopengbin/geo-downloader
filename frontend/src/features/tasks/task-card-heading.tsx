import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'

export function TaskCardHeading({ title, status, statusTitle, source, zoom, selection }: {
  title: string
  status: ReactNode
  statusTitle?: string
  source?: string
  zoom?: number
  selection?: ReactNode
}) {
  return <div className="min-w-0 space-y-1.5" data-task-card-heading>
    <div className="flex min-w-0 items-start gap-2">
      {selection && <div className="flex shrink-0 items-center pt-0.5">{selection}</div>}
      <p data-task-card-title className="min-w-0 flex-1 truncate font-medium leading-5" title={title}>{title}</p>
      <div data-task-card-status title={statusTitle} className="max-w-[45%] shrink-0 pt-0.5 [&>*]:block [&>*]:max-w-full [&>*]:truncate [&>*]:px-1.5 [&>*]:py-0 [&>*]:text-[11px] [&>*]:leading-5">{status}</div>
    </div>
    {(source || (typeof zoom === 'number' && zoom > 0)) && <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" data-task-card-source>
      <span className="min-w-0 flex-1 truncate" title={source}>{source}</span>
      {typeof zoom === 'number' && zoom > 0 && <Badge variant="outline" className="shrink-0 whitespace-nowrap px-1.5 py-0 text-[11px] font-normal leading-5">z{zoom}</Badge>}
    </div>}
  </div>
}
