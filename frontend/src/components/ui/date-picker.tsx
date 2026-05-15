import { useMemo, useState } from 'react'
import { format, parse, subYears } from 'date-fns'
import { CalendarIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface DatePickerProps {
  value?: string
  onChange?: (value: string) => void
  placeholder?: string
  className?: string
  /** 可选最小日期（YYYY-MM-DD），默认 2014-02-20（Wayback 第一期） */
  minDate?: string
  /** 可选最大日期（YYYY-MM-DD），默认今天 */
  maxDate?: string
  /** 是否显示快捷预设按钮，默认 true */
  showPresets?: boolean
}

const DEFAULT_MIN = '2014-02-20'

export function DatePicker({
  value,
  onChange,
  placeholder = '选择日期',
  className,
  minDate,
  maxDate,
  showPresets = true,
}: DatePickerProps) {
  const [open, setOpen] = useState(false)

  const selected = value ? parse(value, 'yyyy-MM-dd', new Date()) : undefined
  const today = useMemo(() => new Date(), [])
  const minD = useMemo(
    () => parse(minDate ?? DEFAULT_MIN, 'yyyy-MM-dd', new Date()),
    [minDate],
  )
  const maxD = useMemo(
    () => (maxDate ? parse(maxDate, 'yyyy-MM-dd', new Date()) : today),
    [maxDate, today],
  )

  const emit = (day: Date | undefined) => {
    onChange?.(day ? format(day, 'yyyy-MM-dd') : '')
  }

  const handleSelect = (day: Date | undefined) => {
    emit(day)
    if (day) setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'h-7 w-[120px] justify-start px-2 text-left text-xs font-normal',
            !value && 'text-muted-foreground',
            className,
          )}
        >
          <CalendarIcon className="mr-1 size-3" />
          {value || placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        {showPresets && (
          <div className="flex flex-wrap items-center gap-1 border-b p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => {
                emit(today)
                setOpen(false)
              }}
            >
              今天
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => {
                emit(subYears(today, 1))
                setOpen(false)
              }}
            >
              一年前
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => {
                emit(subYears(today, 3))
                setOpen(false)
              }}
            >
              三年前
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => {
                emit(minD)
                setOpen(false)
              }}
            >
              最早
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-6 px-2 text-xs text-muted-foreground"
              onClick={() => {
                emit(undefined)
                setOpen(false)
              }}
            >
              清除
            </Button>
          </div>
        )}
        <Calendar
          mode="single"
          selected={selected}
          onSelect={handleSelect}
          defaultMonth={selected ?? today}
          startMonth={minD}
          endMonth={maxD}
          captionLayout="dropdown"
          disabled={{ before: minD, after: maxD }}
        />
      </PopoverContent>
    </Popover>
  )
}

