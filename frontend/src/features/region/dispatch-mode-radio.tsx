import { useTranslation } from 'react-i18next'

import type { DownloadDispatchMode } from './use-multi-feature-submit'

interface Props {
  count: number
  mode: DownloadDispatchMode
  onChange: (m: DownloadDispatchMode) => void
}

export function DispatchModeRadio({ count, mode, onChange }: Props) {
  const { t } = useTranslation()

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">
        {t('dispatch.title', { count })}
      </label>
      <div className="flex flex-col gap-1.5 rounded-md border bg-muted/30 p-2 text-xs">
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            checked={mode === 'merge'}
            onChange={() => onChange('merge')}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">{t('dispatch.merge')}</span>
            <span className="ml-1 text-muted-foreground">
              {t('dispatch.mergeHint')}
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            checked={mode === 'split'}
            onChange={() => onChange('split')}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">{t('dispatch.split')}</span>
            <span className="ml-1 text-muted-foreground">
              {t('dispatch.splitHint', { count })}
            </span>
          </span>
        </label>
      </div>
    </div>
  )
}
