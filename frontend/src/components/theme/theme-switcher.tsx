import { useEffect, useRef, useState } from 'react'
import { Moon, Palette, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTheme, type ThemeAccent } from './theme-provider'

const ACCENTS: { value: ThemeAccent; label: string; color: string }[] = [
  { value: 'zinc', label: '中性灰', color: 'bg-zinc-900' },
  { value: 'indigo', label: '靛蓝', color: 'bg-indigo-500' },
  { value: 'blue', label: '湛蓝', color: 'bg-blue-600' },
  { value: 'green', label: '翠绿', color: 'bg-green-600' },
  { value: 'violet', label: '紫罗兰', color: 'bg-violet-600' },
  { value: 'orange', label: '橙色', color: 'bg-orange-500' },
]

export function ThemeSwitcher() {
  const { accent, resolvedMode, setMode, setAccent } = useTheme()
  const isDark = resolvedMode === 'dark'
  const [accentMenuOpen, setAccentMenuOpen] = useState(false)
  const accentMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!accentMenuOpen) return

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!accentMenuRef.current?.contains(event.target as Node)) {
        setAccentMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccentMenuOpen(false)
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [accentMenuOpen])

  return (
    <>
      {/* 一键切换亮/暗 */}
      <Button
        size="icon"
        variant="ghost"
        aria-label={isDark ? '切换到浅色' : '切换到深色'}
        title={isDark ? '切换到浅色' : '切换到深色'}
        onClick={() => setMode(isDark ? 'light' : 'dark')}
      >
        {isDark ? <Moon className="size-4" /> : <Sun className="size-4" />}
      </Button>

      <div ref={accentMenuRef} className="relative z-[100]">
        <Button
          size="icon"
          variant="ghost"
          aria-label="主色"
          aria-haspopup="menu"
          aria-expanded={accentMenuOpen}
          title="主色"
          onClick={() => setAccentMenuOpen((open) => !open)}
        >
          <Palette className="size-4" />
        </Button>
        {accentMenuOpen && (
          <div
            role="menu"
            aria-label="选择主色"
            className="pointer-events-auto absolute right-0 top-[calc(100%+0.25rem)] z-[100] w-36 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {ACCENTS.map((a) => (
              <button
                key={a.value}
                type="button"
                role="menuitemradio"
                aria-checked={accent === a.value}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                onClick={() => {
                  setAccent(a.value)
                  setAccentMenuOpen(false)
                }}
              >
                <span className={`inline-block size-3 rounded-full ${a.color}`} />
                <span className="flex-1">{a.label}</span>
                {accent === a.value && (
                  <span className="text-xs text-muted-foreground">当前</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
