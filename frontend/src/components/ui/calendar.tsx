import { ChevronLeft, ChevronRight } from 'lucide-react'
import { DayPicker, type DropdownProps } from 'react-day-picker'
import { zhCN } from 'react-day-picker/locale'
import 'react-day-picker/style.css'

import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export type CalendarProps = React.ComponentProps<typeof DayPicker>

/** 用 shadcn Select 渲染 v10 的月/年下拉，避免原生 <select> 系统外观 */
function ShadcnDropdown({ value, options = [], onChange, className }: DropdownProps) {
  const handleChange = (next: string) => {
    if (!onChange) return
    const fakeEvent = {
      target: { value: next },
      currentTarget: { value: next },
    } as unknown as React.ChangeEvent<HTMLSelectElement>
    onChange(fakeEvent)
  }
  return (
    <Select value={value !== undefined ? String(value) : undefined} onValueChange={handleChange}>
      <SelectTrigger
        className={cn(
          'h-7 w-auto min-w-[68px] gap-1 px-2 text-xs font-medium shadow-none focus:ring-1',
          className,
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-64">
        {options.map((opt) => (
          <SelectItem
            key={opt.value}
            value={String(opt.value)}
            disabled={opt.disabled}
            className="text-xs"
          >
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ChevronComponent({ orientation }: { orientation?: 'left' | 'right' | 'up' | 'down' }) {
  if (orientation === 'right') return <ChevronRight className="size-4" />
  return <ChevronLeft className="size-4" />
}

/**
 * 基于 react-day-picker v10 默认 CSS（CSS Grid）的轻量包装。
 * 用 shadcn Select 替换原生月/年下拉，用 lucide chevron 替换默认箭头。
 */
function Calendar({ className, ...props }: CalendarProps) {
  return (
    <DayPicker
      locale={zhCN}
      navLayout="around"
      className={cn('rdp-tif p-2', className)}
      components={{
        Dropdown: ShadcnDropdown,
        Chevron: ChevronComponent,
      }}
      {...props}
    />
  )
}
Calendar.displayName = 'Calendar'

export { Calendar }
