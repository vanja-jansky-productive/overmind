import { useState } from 'react'

import { api } from '@/api/client'
import type { SlackBridge, SlackSpawn, SlackStatus } from '@/api/types'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useOvermind } from '@/hooks/useOvermind'
import { useSettings } from '@/hooks/useSettings'
import { refreshSlack, useSlack } from '@/hooks/useSlack'
import { spawnTargets } from '@/lib/sessions'
import { cn } from '@/lib/utils'

const DURATIONS = ['2h', '8h', '1d', '1w'] as const
const select = 'h-8 w-full rounded-lg border bg-card px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
const segItem =
  'h-9 flex-1 gap-1.5 rounded-md px-3 text-[0.8125rem] text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-accent'

/** Every bridge the status knows: `bridges` (with `slack.bridges`), else the one it is. */
function slackBridges(s: SlackStatus | null): SlackBridge[] {
  if (!s?.host) return []
  if (s.bridges?.length) return s.bridges
  return [{ host: s.host, enabled: s.enabled, error: s.error, socket: s.socket ?? null, bot: s.bot ?? null, spawn: s.spawn ?? null }]
}

/** A configured dir (`~/x` or absolute) is the same as one of the host's spawn dirs (absolute). */
function sameDir(conf: string, abs: string): boolean {
  const a = abs.replace(/\/+$/, '')
  const c = conf.replace(/\/+$/, '')
  return a === c || (c.startsWith('~/') && a.endsWith(c.slice(1)))
}

/**
 * Settings → Slack: per bridge (a Slack app), whether a mention of it in a thread no session
 * follows opens a new session (`slack.spawn`) — where, with which model, for how long and for whom.
 * Saved in the bridge's config and live at once.
 */
export function SlackSpawnEditor() {
  const status = useSlack()
  const bridges = slackBridges(status)
  if (!status) return <p className="py-3 text-sm text-dimmer">Loading…</p>
  if (!bridges.length) return <p className="py-3 text-sm text-dimmer">Slack links are not set up on this overmind (slack.host).</p>
  return (
    <div className="flex flex-col gap-3 py-2">
      {bridges.map((b) => (
        <BridgeCard key={b.host} bridge={b} />
      ))}
    </div>
  )
}

function BridgeCard({ bridge }: { bridge: SlackBridge }) {
  const { overmind } = useOvermind()
  const { models } = useSettings()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const targets = spawnTargets(overmind)
  const cur = bridge.spawn ?? null
  const appName = bridge.bot?.name ? `@${bridge.bot.name}` : 'Slack app'

  const save = async (spawn: SlackSpawn | null) => {
    setSaving(true)
    setError(null)
    try {
      await api.setSlackSpawn(bridge.host, spawn)
      await refreshSlack()
    } catch (err) {
      setError((err as Error)?.message || 'could not save')
    } finally {
      setSaving(false)
    }
  }
  const patch = (p: Partial<SlackSpawn>) => cur && void save({ ...cur, ...p })
  const turnOn = () => {
    const host = targets.some((t) => t.name === bridge.host) ? bridge.host : (targets[0]?.name ?? bridge.host)
    void save({ host, dir: targets.find((t) => t.name === host)?.dirs[0]?.path ?? null, minutes: '1d', from: null })
  }

  const hostDirs = targets.find((t) => t.name === cur?.host)?.dirs ?? []
  const dirMatch = cur?.dir ? hostDirs.find((d) => sameDir(cur.dir ?? '', d.path)) : hostDirs[0]
  const durations: string[] = cur && !DURATIONS.includes(String(cur.minutes) as (typeof DURATIONS)[number]) ? [...DURATIONS, String(cur.minutes)] : [...DURATIONS]
  const fromValue = cur?.from === 'anyone' ? 'anyone' : Array.isArray(cur?.from) ? 'list' : 'owner'

  return (
    <div className="rounded-xl border bg-card px-3 py-2">
      <div className="flex items-center gap-2 py-1">
        <span
          className={cn('size-2 shrink-0 rounded-full', bridge.socket?.connected ? 'bg-status-idle' : 'bg-status-error')}
          title={bridge.socket?.connected ? 'Connected to Slack' : (bridge.socket?.error ?? bridge.error ?? 'Not connected')}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{appName}</div>
          <div className="truncate text-xs text-dimmer">bridge on {bridge.host}</div>
        </div>
      </div>
      <label className="flex items-center gap-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm">Open a session on a mention</div>
          <div className="text-xs text-dimmer">Mentioning {appName} in a channel thread no session follows starts one, linked to that thread</div>
        </div>
        <Switch
          checked={!!cur}
          disabled={saving}
          onCheckedChange={(v) => (v ? turnOn() : void save(null))}
          aria-label={`Open a session on a mention of ${appName}`}
        />
      </label>
      {cur ? (
        <div className="flex flex-col gap-3 pb-2">
          <Row label="Host">
            <select aria-label="Host" className={select} disabled={saving} value={cur.host}
              onChange={(e) => {
                const host = e.target.value
                patch({ host, dir: targets.find((t) => t.name === host)?.dirs[0]?.path ?? null })
              }}
            >
              {(targets.some((t) => t.name === cur.host) ? targets : [{ name: cur.host, dirs: [] }, ...targets]).map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
          </Row>
          <Row label="Directory">
            <select aria-label="Directory" className={select} disabled={saving} value={dirMatch?.path ?? cur.dir ?? ''}
              onChange={(e) => patch({ dir: e.target.value || null })}
            >
              {!dirMatch && cur.dir ? <option value={cur.dir}>{cur.dir}</option> : null}
              {hostDirs.map((d) => (
                <option key={d.path} value={d.path}>{d.label} — {d.path}</option>
              ))}
            </select>
          </Row>
          <Row label="Model">
            <select aria-label="Model" className={select} disabled={saving} value={cur.model ?? ''} onChange={(e) => patch({ model: e.target.value || null })}>
              {models.some((m) => m.id === (cur.model ?? '')) ? null : <option value={cur.model ?? ''}>{cur.model}</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </Row>
          <Row label="Linked for">
            <ToggleGroup type="single" value={String(cur.minutes)} onValueChange={(v) => v && patch({ minutes: v })} disabled={saving} spacing={0} aria-label="Linked for" className="w-full rounded-lg bg-muted p-1">
              {durations.map((d) => (
                <ToggleGroupItem key={d} value={d} className={segItem}>{d}</ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Row>
          <Row label="Who can start one" hint={fromValue === 'anyone' ? `Anyone in a channel ${appName} is in can make ${cur.host} act as its user` : undefined}>
            <ToggleGroup type="single" value={fromValue} onValueChange={(v) => v && v !== 'list' && patch({ from: v === 'anyone' ? 'anyone' : null })} disabled={saving} spacing={0} aria-label="Who can start one" className="w-full rounded-lg bg-muted p-1">
              <ToggleGroupItem value="owner" className={segItem}>Only me</ToggleGroupItem>
              {Array.isArray(cur.from) ? (
                <ToggleGroupItem value="list" className={segItem} title={cur.from.join(', ')}>{cur.from.length} people</ToggleGroupItem>
              ) : null}
              <ToggleGroupItem value="anyone" className={segItem}>Anyone</ToggleGroupItem>
            </ToggleGroup>
          </Row>
        </div>
      ) : null}
      {error ? <p className="pb-2 text-xs text-status-error">{error}</p> : null}
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      {children}
      {hint ? <div className="text-xs text-dimmer">{hint}</div> : null}
    </div>
  )
}
