import type { KeyboardEvent, ReactNode } from 'react'
import { cx } from '../../components/ui/cx'
import { MACHINE_TABS, tabId, tabPanelId, type MachineTab } from './tabs'

export interface MachineTabsProps {
  active: MachineTab
  onChange: (tab: MachineTab) => void
  /** Tabs whose content changed in the last step: they get a dot. */
  changed: Readonly<Record<MachineTab, boolean>>
  className?: string
}

/**
 * The tabs of the narrow layout (Registers · Stack · Output), so a student on a phone does
 * not scroll through every panel. Arrow keys, Home and End move between them.
 */
export function MachineTabs({ active, onChange, changed, className }: MachineTabsProps): ReactNode {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = MACHINE_TABS.findIndex((tab) => tab.id === active)
    const count = MACHINE_TABS.length
    let next: number
    if (event.key === 'ArrowRight') next = (index + 1) % count
    else if (event.key === 'ArrowLeft') next = (index - 1 + count) % count
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = count - 1
    else return
    event.preventDefault()
    const tab = MACHINE_TABS[next]
    onChange(tab.id)
    document.getElementById(tabId(tab.id))?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label="What to show"
      className={cx(
        'grid grid-cols-3 gap-1 rounded-xl border border-line bg-surface-2 p-1',
        className,
      )}
    >
      {MACHINE_TABS.map((tab) => {
        const selected = tab.id === active
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId(tab.id)}
            aria-selected={selected}
            aria-controls={tabPanelId(tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={onKeyDown}
            className={cx(
              'relative flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2 text-[0.9375rem] font-semibold whitespace-nowrap transition-colors',
              selected
                ? 'bg-surface text-ink shadow-sm ring-1 ring-line-strong'
                : 'text-muted hover:bg-surface hover:text-ink',
            )}
          >
            {tab.label}
            {changed[tab.id] && (
              <>
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full bg-changed forced-colors:bg-[Highlight]"
                />
                <span className="sr-only">, changed</span>
              </>
            )}
            {/* The bar under the chosen tab: a shape, not only a color. */}
            {selected && (
              <span
                aria-hidden="true"
                className="absolute inset-x-4 bottom-0.5 h-[3px] rounded-full bg-primary forced-colors:bg-[Highlight]"
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
