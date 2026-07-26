import { Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useAssistantStore } from '@/features/assistant/assistant-store'
import { cn } from '@/lib/utils'

export function AssistantButton() {
  const open = useAssistantStore((state) => state.open)
  const toggle = useAssistantStore((state) => state.toggle)

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label="GeoD AI 助手"
      aria-pressed={open}
      title="GeoD AI 助手"
      className={cn(open && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary')}
      onClick={toggle}
    >
      <Sparkles className="size-4" />
    </Button>
  )
}
