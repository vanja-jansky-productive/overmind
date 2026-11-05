import type { HarnessInfo, ModelOption, Session } from '@/api/types'
import { normalizeModels } from '@/lib/models'

/** Short names for chips and copy. Unknown ids show as themselves. */
export const HARNESS_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'pi' }

export function harnessLabel(id: string | null | undefined): string {
  const h = id || 'claude'
  return HARNESS_LABELS[h] ?? h
}

/** A session's harness; rows from older CLIs carry none and are Claude's. */
export function sessionHarness(s: Pick<Session, 'harness'>): string {
  return s.harness || 'claude'
}

/** What a host offers before (or without) GET …/harnesses: Claude alone, with the configured models. */
export function claudeOnly(models: ModelOption[]): HarnessInfo[] {
  return [{ id: 'claude', label: 'Claude Code', command: 'claude', installed: true, models }]
}

/**
 * The harnesses the New session form offers: installed ones with a usable model list (a
 * harness the host reports without models still gets its default). Claude is always first.
 */
export function offeredHarnesses(rows: HarnessInfo[] | null | undefined, claudeModels: ModelOption[]): HarnessInfo[] {
  const list = (rows ?? []).filter((h) => h && typeof h.id === 'string' && h.installed)
  const out = list.map((h) => {
    // Claude: the host's own list (web.models, else its CLI's), else the settings' one.
    const models = h.models?.length ? normalizeModels(h.models) : h.id === 'claude' ? claudeModels : [{ id: '', label: 'Default' }]
    return { ...h, models: withOvermindDefault(models, h) }
  })
  if (!out.some((h) => h.id === 'claude')) out.unshift(...claudeOnly(claudeModels))
  return out.sort((a, b) => Number(b.id === 'claude') - Number(a.id === 'claude'))
}

/**
 * "Opus 5.5": the host's overmind default model for a harness (Settings → Models), or null when
 * none. The default effort is the Effort row's Default chip (`defaultEffortLabel`).
 */
export function overmindDefaultLabel(h: Pick<HarnessInfo, 'defaultModel'>, models: ModelOption[]): string | null {
  return h.defaultModel ? (models.find((m) => m.id === h.defaultModel)?.label ?? h.defaultModel) : null
}

/** The picker's default entry (`id: ''`) names the overmind default model it starts, when one is set. */
export function withOvermindDefault(models: ModelOption[], h: Pick<HarnessInfo, 'defaultModel'>): ModelOption[] {
  const label = overmindDefaultLabel(h, models)
  return label ? models.map((m) => (m.id === '' ? { ...m, label: `Default · ${label}` } : m)) : models
}

/** The remembered harness when still offered, else Claude. */
export function pickHarness(offered: HarnessInfo[], remembered: string | null): string {
  if (remembered && offered.some((h) => h.id === remembered)) return remembered
  return offered[0]?.id ?? 'claude'
}

/**
 * The effort levels a spawn of `modelId` ('' = Default) may pick, lowest first: the model's own when
 * the host lists them (Codex: per model; Default = the model it starts), else the harness's. Empty
 * (an older server) = no effort row.
 */
export function effortsFor(h: Pick<HarnessInfo, 'efforts' | 'models'> | undefined, modelId: string): string[] {
  if (!h) return []
  const own = h.models.find((m) => m.id === modelId)?.efforts
  return own?.length ? own : (h.efforts ?? [])
}

/** The remembered effort while the model takes it, else Default (''): it comes back with a model that does. */
export function pickEffort(levels: string[], remembered: string | null): string {
  return remembered && levels.includes(remembered) ? remembered : ''
}

/** Where the picked effort is remembered, per harness (beside the model's `modelKey`). */
export function effortKey(harness: string): string {
  return `overmind.spawnEffort.${harness}`
}

const EFFORT_LABELS: Record<string, string> = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' }

/** A chip's label: `xhigh` → `XHigh`; an unknown level shows as itself. */
export function effortLabel(level: string): string {
  return EFFORT_LABELS[level] ?? level
}

/** The effort row's Default chip: names the host's overmind default (Settings → Models) when one is set. */
export function defaultEffortLabel(h: Pick<HarnessInfo, 'defaultEffort'>): string {
  return h.defaultEffort ? `Default · ${effortLabel(h.defaultEffort)}` : 'Default'
}

/** Where the picked model is remembered: Claude keeps the old key. */
export function modelKey(harness: string): string {
  return harness === 'claude' ? 'overmind.spawnModel' : `overmind.spawnModel.${harness}`
}
