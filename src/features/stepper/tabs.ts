/** The tabs of the narrow stepper layout, and the ids that tie each tab to its panel. */

export type MachineTab = 'registers' | 'stack' | 'output'

export const MACHINE_TABS: readonly { id: MachineTab; label: string }[] = [
  { id: 'registers', label: 'Registers' },
  { id: 'stack', label: 'Stack' },
  { id: 'output', label: 'Output' },
]

export function tabId(tab: MachineTab): string {
  return `stepper-tab-${tab}`
}

export function tabPanelId(tab: MachineTab): string {
  return `stepper-panel-${tab}`
}
