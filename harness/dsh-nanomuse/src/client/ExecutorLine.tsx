/**
 * Where the line is drawn: under the chat's name in the header (`MuseHeader`), not above the
 * composer. The name and the face are already the chat's identity, and the line is one more
 * fact about it, so it belongs beside them rather than in a second place further down.
 *
 * This module owns the wording and the device's icon; the drawing is the header's.
 */
import { type ReactNode } from 'react'
import { type Translate } from './api.ts'
import { currentExecutor } from './device-task.ts'
import { useOwner } from './owner-store.ts'
import { type OwnerTarget } from './session-owner.ts'
import { IconLaptop, IconPhone } from './icons.tsx'
import type { LiveDevice } from './live.ts'

/**
 * The line, in the UI language.
 *
 * Exported so it can be worded without a renderer, the way the row's rules are: which of the
 * three sentences is used, and with which name, is the whole of the decision.
 */
export function executorText(t: Translate, target: OwnerTarget, fallback: string): string {
  if (target.kind === 'local') return t('exSelf')
  const device = target.name.trim() || fallback
  return target.online ? t('exRuns', { device }) : t('exOffline', { device })
}

/** The device's own icon, so the line reads at a glance without its words. */
export function deviceIcon(devices: readonly LiveDevice[], id: string): (p: { size?: number }) => ReactNode {
  return devices.find((d) => d.id === id)?.kind === 'phone' ? IconPhone : IconLaptop
}

/**
 * Who runs the conversation on screen, as a hook. The line under the chat's name reads it too
 * (`MuseHeader`), so the same answer is used wherever it is shown: the header's seat and this
 * one are different places, and a rule copied into both is a rule that drifts.
 */
export function useExecutorTarget(sessionId: string | null | undefined): OwnerTarget {
  useOwner(sessionId)
  return currentExecutor()
}
