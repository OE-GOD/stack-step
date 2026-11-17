import { memo, useState, type HTMLAttributes, type ReactNode } from 'react'
import {
  DataPanel,
  FIX_THE_CODE,
  FlagsPanel,
  OutputPanel,
  outputChanged,
  PanelBoundary,
  RegistersPanel,
  registersChanged,
  StackPanel,
  stackChanged,
} from '../../components/machine'
import { cx } from '../../components/ui/cx'
import { Panel } from '../../components/ui/Panel'
import { MachineTabs } from './MachineTabs'
import type { SessionState } from './session'
import { tabId, tabPanelId, type MachineTab } from './tabs'

export interface StepperPanelsProps {
  state: SessionState
  /** The wide layout (two columns of panels, no tabs). */
  wide: boolean
  /**
   * The tutor's button is on the screen (bottom right): on a wide screen the right column
   * keeps room for it at its bottom, so it never covers the Output or the Data panel.
   */
  roomForTutor?: boolean
  onSendInput: (text: string) => void
}

/** A panel's place while the program has errors. */
function WaitingPanel({ title }: { title: string }): ReactNode {
  return (
    <Panel title={title}>
      <p className="text-sm text-muted">{FIX_THE_CODE}</p>
    </Panel>
  )
}

/**
 * The machine: Registers (with the four flags in the same card), Stack, Output and Data.
 *
 * Wide screens: two columns of the page's grid (registers · stack over output). Narrow:
 * tabs (Registers · Stack · Output), so a student on a phone does not scroll through
 * every panel; a tab whose content changed in the last step shows a dot. While scanf waits
 * for input, the Output tab opens by itself (the input box is there).
 *
 * It renders several items of the page's grid, so it returns a fragment. Memoised: a key
 * typed in the editor does not render it again (pass a stable `onSendInput`).
 */
export const StepperPanels = memo(function StepperPanels({
  state,
  wide,
  roomForTutor = false,
  onSendInput,
}: StepperPanelsProps): ReactNode {
  const { machine, program } = state
  const [tab, setTab] = useState<MachineTab>('registers')

  // On a phone the input box is in the Output tab: show that tab when scanf waits.
  const status = machine?.status ?? null
  const [seenStatus, setSeenStatus] = useState(status)
  if (status !== seenStatus) {
    setSeenStatus(status)
    if (status === 'waiting-input') setTab('output')
  }

  /** The tab panel attributes on a phone; nothing on a wide screen (no tabs there). */
  const panelProps = (id: MachineTab): HTMLAttributes<HTMLDivElement> =>
    wide
      ? {}
      : { role: 'tabpanel', id: tabPanelId(id), 'aria-labelledby': tabId(id), hidden: tab !== id }

  return (
    <>
      {!wide && (
        <MachineTabs
          active={tab}
          onChange={setTab}
          changed={{
            registers: machine !== null && registersChanged(machine),
            stack: machine !== null && stackChanged(machine),
            output: machine !== null && (outputChanged(machine) || status === 'waiting-input'),
          }}
          className="max-lg:order-1"
        />
      )}

      <div
        {...panelProps('registers')}
        className="flex min-w-0 flex-col gap-3 max-lg:order-1 lg:min-h-0"
      >
        {machine === null ? (
          <WaitingPanel title="Registers" />
        ) : (
          <PanelBoundary title="Registers" resetKey={machine}>
            <RegistersPanel
              machine={machine}
              program={program}
              fill={wide}
              // The flags sit at the bottom of the same card: one card less, so all the
              // registers and rip fit on short laptop screens.
              footer={
                <PanelBoundary title="Flags" resetKey={machine} compact>
                  <FlagsPanel machine={machine} embedded />
                </PanelBoundary>
              }
              className="lg:flex-1"
            />
          </PanelBoundary>
        )}
      </div>

      <div
        data-right-column=""
        className={cx(
          'contents lg:flex lg:min-h-0 lg:min-w-0 lg:flex-col lg:gap-3',
          // The tutor's button: 44 px tall, 16 px above the bottom of the screen.
          roomForTutor && 'lg:pb-16',
        )}
      >
        <div
          {...panelProps('stack')}
          className="min-w-0 max-lg:order-1 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col"
        >
          {machine === null ? (
            <WaitingPanel title="Stack" />
          ) : (
            <PanelBoundary title="Stack" resetKey={machine}>
              <StackPanel
                machine={machine}
                fill={wide}
                listClassName={wide ? undefined : 'max-h-[28rem]'}
                className="lg:flex-1"
              />
            </PanelBoundary>
          )}
        </div>
        <div
          {...panelProps('output')}
          className={cx(
            'flex min-w-0 flex-col gap-3 max-lg:order-1 lg:min-h-0 lg:shrink-0',
            // While scanf waits, the question and the input box need room: the Stack gives some.
            status === 'waiting-input' ? 'lg:max-h-[65%]' : 'lg:max-h-[55%]',
          )}
        >
          {machine === null ? (
            <WaitingPanel title="Output" />
          ) : (
            <>
              <PanelBoundary title="Output" resetKey={machine}>
                <OutputPanel
                  machine={machine}
                  onSendInput={onSendInput}
                  scrollOnWide
                  // While scanf waits, the card keeps its whole height (up to a limit), so
                  // the question it printed and the input box are both in sight; the Data
                  // card under it gives up room instead.
                  className={status === 'waiting-input' ? 'lg:max-h-80 lg:shrink-0' : 'lg:max-h-72'}
                />
              </PanelBoundary>
              {machine.data.length > 0 && (
                <PanelBoundary title="Data" resetKey={machine}>
                  <DataPanel machine={machine} scrollOnWide className="lg:max-h-48" />
                </PanelBoundary>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
})
