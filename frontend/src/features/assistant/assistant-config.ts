import { useQuery } from '@tanstack/react-query'

import { getSettings } from '@/features/settings/settings-api'

export function useAssistantConfig() {
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  })

  return {
    enabled: settingsQuery.data?.ai_assistant_enabled === true,
  }
}
