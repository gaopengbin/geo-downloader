import { Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { PanelSection } from '@/components/layout/panel-section'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { changeAppLanguage, type AppLanguage } from '@/i18n'
import { normalizeLanguage } from '@/i18n/language'

export function LanguageSection() {
  const { t, i18n } = useTranslation()
  const language = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language)

  return (
    <PanelSection
      icon={Languages}
      title={t('language.title')}
      description={t('language.description')}
      dataAgentTarget="settings-language"
    >
      <div className="space-y-1.5">
        <Label>{t('language.label')}</Label>
        <Select
          value={language}
          onValueChange={(value) => void changeAppLanguage(value as AppLanguage)}
        >
          <SelectTrigger aria-label={t('language.label')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zh-CN">{t('language.chinese')}</SelectItem>
            <SelectItem value="en-US">{t('language.english')}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs leading-5 text-muted-foreground">{t('language.hint')}</p>
      </div>
    </PanelSection>
  )
}
