import type { ReactNode } from 'react'
import { PageContainer, PageHeader } from '../../components/layout/Page'
import { Button } from '../../components/ui/Button'
import { Callout } from '../../components/ui/Callout'
import { PrinterIcon } from '../../components/ui/icons'
import { CardPreview } from './CardPreview'
import './cheatsheet.css'
import { PrintSheet, ScreenSheet } from './Sheet'
import { usePrintMode } from './usePrintMode'

/**
 * The cheat sheet: the main rules of the course on one page.
 *
 * On screen it is a normal page: two print buttons, a note on how to print, a true-size
 * preview of the index card, and the sheet in readable type. On paper only the sheet is
 * left: the 3×5 inch index card or the letter page (see usePrintMode.ts and
 * cheatsheet.css). Everything marked `cs-screen-only` stays off the paper.
 */
export default function CheatSheetPage(): ReactNode {
  const print = usePrintMode()

  return (
    <PageContainer className="cs-page">
      <div className="cs-screen-only">
        <PageHeader
          title="Cheat sheet"
          lead="The main rules of the course on one page. Print it on an index card or on a letter page."
        />
      </div>

      <div className="cs-top grid items-start gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="cs-screen-only">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button variant="primary" onClick={() => print('card')}>
              <PrinterIcon size={18} />
              Print the index card (3×5 in)
            </Button>
            <Button onClick={() => print('letter')}>
              <PrinterIcon size={18} />
              Print the full page (letter)
            </Button>
          </div>

          <Callout tone="info" label="How to print" className="mt-5 max-w-xl">
            <ol className="list-decimal space-y-1.5 pl-5">
              <li>In the print window, turn off “Headers and footers”.</li>
              <li>Set the scale to 100%. Some print windows call this “Actual size”.</li>
              {/* Chrome hides its Layout setting when the page sets its own paper size, as
                  this page does, so the last step cannot always be followed. */}
              <li>
                For the index card, set the paper size to 3×5 in. Some print windows call this
                “Index card”. If you see a Layout setting, choose Landscape.
              </li>
            </ol>
          </Callout>
        </div>

        <CardPreview />
      </div>

      <div className="cs-screen-only mt-10 md:mt-12">
        <ScreenSheet />
      </div>

      <div className="cs-letter-page">
        <PrintSheet variant="letter" />
      </div>
    </PageContainer>
  )
}
