import { Fragment } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { comboLabel, helpKeys, keyLabel, SHORTCUT_HELP, shortcutEnv } from '@/lib/shortcuts'

/** ⌘? / ⌘/: every desktop shortcut, from the same table the key handler uses — the combos of
 *  this environment (Overmind.app's ⌘N only in the app; ⌘ ⇧ ⌥ on macOS, Ctrl / Shift / Alt elsewhere). */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const env = shortcutEnv()
  const mod = keyLabel('mod', env.mac)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            {mod} shortcuts work everywhere, the composer and search included; ↑ ↓ Enter work outside a field; Esc leaves one.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {SHORTCUT_HELP.map((section) => (
            <section key={section.title}>
              <h3 className="pb-1.5 text-[0.6875rem] font-semibold tracking-wider text-dimmer uppercase">{section.title}</h3>
              <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5">
                {section.items.map((item) => (
                  <Fragment key={item.label}>
                    <dt className="flex items-center gap-1 whitespace-nowrap">
                      {helpKeys(item, env).map((combo, i) => (
                        <Fragment key={i}>
                          {i > 0 ? <span className="text-[0.6875rem] text-dimmer">or</span> : null}
                          <KbdGroup aria-label={comboLabel(combo, env.mac)}>
                            {combo.map((k, j) => (
                              <Kbd key={j} className="border border-border">
                                {keyLabel(k, env.mac)}
                              </Kbd>
                            ))}
                          </KbdGroup>
                        </Fragment>
                      ))}
                    </dt>
                    <dd className="text-sm text-muted-foreground">{item.label.replace('mod+', `${mod}+`)}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
