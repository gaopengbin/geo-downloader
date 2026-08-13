import type { MouseEvent, PropsWithChildren, ReactNode } from 'react'
import { Minus, Square, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { ThemeSwitcher } from '@/components/theme/theme-switcher'
import { StarButton } from '@/features/promo/star-button'
import { SponsorDialog } from '@/features/promo/sponsor-dialog'
import { CommunityDialog } from '@/features/promo/community-dialog'
import { ResumableTasksButton } from '@/features/tasks/resumable-tasks-button'
import { isTauriRuntime } from '@/lib/tauri'

async function withCurrentWindow(action: 'minimize' | 'toggleMaximize' | 'close') {
  if (!isTauriRuntime()) return

  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const appWindow = getCurrentWindow()

  if (action === 'minimize') {
    await appWindow.minimize()
    return
  }

  if (action === 'close') {
    await appWindow.close()
    return
  }

  const isMaximized = await appWindow.isMaximized()
  if (isMaximized) {
    await appWindow.unmaximize()
  } else {
    await appWindow.maximize()
  }
}

async function startModalWindowDrag(event: MouseEvent<HTMLElement>) {
  if (event.button !== 0 || !isTauriRuntime()) return
  if (getComputedStyle(document.body).pointerEvents !== 'none') return
  const target = event.target as HTMLElement
  if (target.closest('button, a, input, select, textarea, [role="button"], [data-no-drag]')) return

  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().startDragging()
}

interface AppShellProps extends PropsWithChildren {
  modeSlot?: ReactNode
  headerExtras?: ReactNode
}

export function AppShell({ children, modeSlot, headerExtras }: AppShellProps) {
  const { t } = useTranslation()
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div
        data-tauri-drag-region
        onMouseDown={(event) => void startModalWindowDrag(event)}
        className="relative z-[60] flex h-12 items-center justify-between gap-4 border-b border-border/60 bg-background/95 px-4 pointer-events-auto backdrop-blur"
      >
        <div data-tauri-drag-region className="flex select-none items-center gap-3">
          <div data-tauri-drag-region className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-sm">
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3 3 9l9 6 9-6-9-6Z" />
                <path d="m3 15 9 6 9-6" />
              </svg>
            </div>
            <span data-tauri-drag-region className="text-sm font-semibold tracking-tight">
              <span className="text-primary">GeoD</span>
              <span className="text-foreground/85">ownloader</span>
            </span>
          </div>
          <div className="ml-1 flex items-center gap-0.5">
            <StarButton />
            <SponsorDialog />
            <CommunityDialog />
          </div>
        </div>
        {modeSlot && (
          <div data-tauri-drag-region className="flex flex-1 justify-center">
            <div>{modeSlot}</div>
          </div>
        )}
        <div className="flex items-center gap-1">
          {headerExtras}
          <ResumableTasksButton />
          <ThemeSwitcher />
          <Button aria-label={t('app.window.minimize')} size="icon" variant="ghost" onClick={() => void withCurrentWindow('minimize')}>
            <Minus className="size-4" />
          </Button>
          <Button aria-label={t('app.window.maximize')} size="icon" variant="ghost" onClick={() => void withCurrentWindow('toggleMaximize')}>
            <Square className="size-3.5" />
          </Button>
          <Button
            aria-label={t('app.window.close')}
            size="icon"
            variant="ghost"
            className="hover:bg-destructive hover:text-destructive-foreground"
            onClick={() => void withCurrentWindow('close')}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      {children}
    </div>
  )
}
