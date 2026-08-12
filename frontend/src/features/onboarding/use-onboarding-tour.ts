import { useCallback, useEffect, useRef } from 'react'
import { driver, type Driver, type DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'

import { MAIN_TOUR_STEPS, TOUR_STORAGE_KEY, TOUR_VERSION } from './tour-config'
import { trackTelemetry, type TelemetryTour } from '@/features/telemetry/telemetry-client'

type SeenMap = Record<string, number>

function readSeen(): SeenMap {
  try {
    const raw = localStorage.getItem(TOUR_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') return parsed as SeenMap
    return {}
  } catch {
    return {}
  }
}

function writeSeen(map: SeenMap) {
  try {
    localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 忽略 localStorage 写入异常（隐私模式等）
  }
}

export interface UseOnboardingTourOptions {
  /** 引导唯一 id（用于记忆"已看过"的状态） */
  id: string
  /** 引导步骤；缺省走主界面引导 */
  steps?: DriveStep[]
  /** 是否在首次打开时自动启动；默认 true */
  autoStartOnFirstVisit?: boolean
  /** 自动启动前的延迟，确保目标元素已挂载（毫秒）；默认 600 */
  autoStartDelayMs?: number
}

/**
 * 新手引导 Hook（基于 driver.js）。
 * - 提供 `start()` 手动启动
 * - 首次访问（或 TOUR_VERSION 升级）时自动启动一次
 * - 完成或跳过后写入 localStorage，避免重复打扰
 */
export function useOnboardingTour(options: UseOnboardingTourOptions) {
  const { id, steps = MAIN_TOUR_STEPS, autoStartOnFirstVisit = true, autoStartDelayMs = 600 } = options
  const driverRef = useRef<Driver | null>(null)
  const startedRef = useRef(false)
  const telemetryTour = id.replace(/-v\d+$/, '').replaceAll('-', '_') as TelemetryTour

  const buildDriver = useCallback((): Driver => {
    // 过滤掉指向不存在元素的步骤（条件跳过），避免出现"指向虚空"的居中弹窗
    const filteredSteps = steps.filter((step) => {
      const sel = step.element
      if (!sel) return true
      if (typeof sel === 'string') {
        return document.querySelector(sel) != null
      }
      return true
    })
    // 保存进入引导前的窗口滚动位置，结束后恢复，避免 driver.js
    // scrollIntoView 把整个文档滚走、标题栏消失的问题。
    const savedScrollX = window.scrollX
    const savedScrollY = window.scrollY
    const d = driver({
      showProgress: true,
      allowClose: true,
      overlayOpacity: 0.55,
      stagePadding: 6,
      stageRadius: 8,
      smoothScroll: false,
      progressText: '{{current}} / {{total}}',
      nextBtnText: '下一步',
      prevBtnText: '上一步',
      doneBtnText: '完成',
      onDestroyStarted: () => {
        void trackTelemetry('onboarding_event', {
          tour: telemetryTour,
          action: d.hasNextStep() ? 'dismissed' : 'completed',
        })
        const seen = readSeen()
        seen[id] = TOUR_VERSION
        writeSeen(seen)
        d.destroy()
      },
      onDestroyed: () => {
        // 引导结束后恢复滚动位置
        window.scrollTo(savedScrollX, savedScrollY)
      },
      steps: filteredSteps,
    })
    driverRef.current = d
    return d
  }, [id, steps, telemetryTour])

  const start = useCallback(() => {
    // 每次启动重建实例，确保步骤过滤反映当前 DOM 状态
    if (driverRef.current) {
      driverRef.current.destroy()
      driverRef.current = null
    }
    const d = buildDriver()
    void trackTelemetry('onboarding_event', { tour: telemetryTour, action: 'started' })
    d.drive()
  }, [buildDriver, telemetryTour])

  const reset = useCallback(() => {
    const seen = readSeen()
    delete seen[id]
    writeSeen(seen)
  }, [id])

  // 首次访问自动启动
  useEffect(() => {
    if (!autoStartOnFirstVisit) return
    if (startedRef.current) return
    const seen = readSeen()
    if ((seen[id] ?? 0) >= TOUR_VERSION) return
    startedRef.current = true
    const t = window.setTimeout(() => {
      start()
    }, autoStartDelayMs)
    return () => window.clearTimeout(t)
  }, [autoStartOnFirstVisit, autoStartDelayMs, id, start])

  return { start, reset }
}
