import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { useAssistantConfig } from '@/features/assistant/assistant-config'
import { useAssistantStore } from '@/features/assistant/assistant-store'
import { cn } from '@/lib/utils'

export function AssistantButton() {
  const { t } = useTranslation()
  const { enabled } = useAssistantConfig()
  const open = useAssistantStore((state) => state.open)
  const toggle = useAssistantStore((state) => state.toggle)

  if (!enabled) return null

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label={t('app.header.assistant')}
      aria-pressed={open}
      title={t('app.header.assistant')}
      className={cn(open && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary')}
      onClick={toggle}
    >
      <Sparkles className="size-4" />
    </Button>
  )
}
