import { useState, type ReactNode } from 'react'
import { PageContainer, PageHeader } from '../layout/Page'
import { Badge } from './Badge'
import { Button } from './Button'
import { ButtonLink } from './ButtonLink'
import { Callout } from './Callout'
import { IconButton } from './IconButton'
import * as icons from './icons'
import { InlineCode } from './InlineCode'
import { Input } from './Input'
import { Kbd } from './Kbd'
import { Panel } from './Panel'
import { Popover } from './Popover'
import { RichText } from './RichText'
import { Select } from './Select'
import { NoWrap } from './NoWrap'
import { Loading } from './Spinner'
import { TextLink } from './TextLink'

const VARIANTS = ['primary', 'secondary', 'ghost', 'danger'] as const
const SIZES = ['sm', 'md', 'lg'] as const

const REGISTER_ROWS = [
  { name: 'rax', value: '0x0000000000000005', parts: 'eax 0x00000005, ax 0x0005, al 0x05' },
  { name: 'rbx', value: '0x0000000000000000', parts: 'ebx 0x00000000, bx 0x0000, bl 0x00' },
  { name: 'rsp', value: '0x00007ffffffddff0', parts: 'esp 0xfffddff0, sp 0xdff0, spl 0xf0' },
] as const

function Row({ children }: { children: ReactNode }): ReactNode {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>
}

/**
 * Rows that reach the edges of a flush panel and open on click, as the Registers panel of
 * the stepper does. Move to a row with the Tab key: its focus outline is drawn inside the
 * row, because the panel cuts off anything outside it.
 */
function FlushRows(): ReactNode {
  const [openRow, setOpenRow] = useState<string | null>(null)
  return (
    <ul className="font-mono text-sm">
      {REGISTER_ROWS.map(({ name, value, parts }) => {
        const open = openRow === name
        return (
          // The last row has the round corners of the card, so its focus outline has them too.
          <li
            key={name}
            className="border-b border-line last:border-b-0 even:bg-surface-2 last:[&>button]:rounded-b-[11px]"
          >
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpenRow(open ? null : name)}
              className="flex min-h-11 w-full cursor-pointer items-center gap-4 px-4 py-2 text-left hover:bg-primary-soft"
            >
              <span className="w-8 font-semibold">{name}</span>
              <span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>
              {open ? (
                <icons.ChevronDownIcon size={16} className="ml-auto text-muted" />
              ) : (
                <icons.ChevronRightIcon size={16} className="ml-auto text-muted" />
              )}
            </button>
            {open && <p className="px-4 pb-2.5 pl-16 text-muted">{parts}</p>}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Every piece of the shared UI kit on one page, for engineers: open `#/dev/kit` while the
 * dev server runs (the route does not exist in the built site). Switch the theme and
 * narrow the window to see each piece in both themes and on a phone.
 */
export default function KitGallery(): ReactNode {
  return (
    <PageContainer>
      <PageHeader
        title="UI kit"
        lead="The shared pieces in src/components/ui and src/components/layout. Only the dev server shows this page."
      />

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Panel title="Button, ButtonLink, IconButton">
          <div className="space-y-4">
            {SIZES.map((size) => (
              <Row key={size}>
                {VARIANTS.map((variant) => (
                  <Button key={variant} variant={variant} size={size}>
                    {variant} {size}
                  </Button>
                ))}
              </Row>
            ))}
            <Row>
              <Button variant="primary">
                <icons.StepIcon />
                Step
              </Button>
              <Button>
                <icons.StepBackIcon />
                Back
              </Button>
              <Button disabled>Disabled</Button>
              <Button variant="primary" disabled>
                Disabled
              </Button>
              <ButtonLink to="/dev/kit" variant="primary">
                ButtonLink
                <icons.ArrowRightIcon size={18} />
              </ButtonLink>
              <ButtonLink to="/about" aria-disabled="true">
                Disabled link
              </ButtonLink>
            </Row>
            <Row>
              <IconButton label="Step back">
                <icons.StepBackIcon />
              </IconButton>
              <IconButton label="Run" variant="secondary">
                <icons.PlayIcon />
              </IconButton>
              <IconButton label="Step" variant="primary">
                <icons.StepIcon />
              </IconButton>
              <IconButton label="Reset" variant="danger">
                <icons.ResetIcon />
              </IconButton>
              <IconButton label="Copy the link" size="sm">
                <icons.CopyIcon size={18} />
              </IconButton>
              <IconButton label="Help" size="lg" variant="secondary">
                <icons.HelpIcon size={24} />
              </IconButton>
            </Row>
          </div>
        </Panel>

        <Panel
          title="Panel"
          actions={
            <>
              <Badge tone="changed">2 changed</Badge>
              <IconButton label="Help for this panel" size="sm">
                <icons.HelpIcon size={18} />
              </IconButton>
            </>
          }
        >
          <p>
            A titled card with an optional row of actions. The stepper uses one for each box:
            Registers, Stack, Flags, Explanation, Output.
          </p>
          <p className="mt-3 text-muted">
            <RichText text="RichText puts `mov rax, 5` and other code in backticks into a code font." />
          </p>
          <p className="mt-3">
            InlineCode:{' '}
            <NoWrap>
              <InlineCode>qword ptr [rbp-8]</InlineCode>.
            </NoWrap>{' '}
            TextLink: <TextLink to="/about">About Stack Step</TextLink>.
          </p>
        </Panel>

        <Panel title="Callout">
          <div className="space-y-3">
            <Callout tone="info">The top of the stack is where rsp points.</Callout>
            <Callout tone="analogy">
              Registers are your hands. Memory is the fridge. You can only work with what is in your
              hands.
            </Callout>
            <Callout tone="good" role="status">
              <RichText text="rsp is `0x7ffffffddff0`. It went down 8." />
            </Callout>
            <Callout tone="bad" role="status">
              <RichText text="The answer is `0x7ffffffddff0`. rsp goes down when you push." />
            </Callout>
            <Callout tone="warn">
              <RichText text="rsp is not a multiple of 16 at this `call`." />
            </Callout>
          </div>
        </Panel>

        <Panel title="Badge, Kbd, Loading, Popover">
          <div className="space-y-4">
            <Row>
              <Badge>neutral</Badge>
              <Badge tone="primary">primary</Badge>
              <Badge tone="good">
                <icons.CheckIcon size={12} strokeWidth={3} />
                Done
              </Badge>
              <Badge tone="bad">bad</Badge>
              <Badge tone="warn">warn</Badge>
              <Badge tone="changed">changed</Badge>
            </Row>
            <Row>
              <span>
                Step: <Kbd>S</Kbd>
              </span>
              <span>
                Back: <Kbd>B</Kbd>
              </span>
              <span>
                Run: <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd>
              </span>
            </Row>
            <Loading />
            <Row>
              <Popover
                button={
                  <>
                    <icons.KeyboardIcon />
                    Shortcuts
                  </>
                }
                title="Keyboard shortcuts"
              >
                <ul className="space-y-2">
                  <li className="flex justify-between gap-4">
                    Step <Kbd>S</Kbd>
                  </li>
                  <li className="flex justify-between gap-4">
                    Step back <Kbd>B</Kbd>
                  </li>
                  <li className="flex justify-between gap-4">
                    Run <Kbd>R</Kbd>
                  </li>
                </ul>
              </Popover>
              <Popover
                button={<icons.HelpIcon />}
                buttonLabel="What is a box?"
                buttonVariant="ghost"
                align="end"
              >
                A box is 8 bytes of the stack.
              </Popover>
            </Row>
          </div>
        </Panel>

        <Panel title="Input and Select">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="kit-answer" className="mb-1 block font-medium">
                rsp after the push
              </label>
              <Input id="kit-answer" mono placeholder="0x…" autoComplete="off" />
            </div>
            <div>
              <label htmlFor="kit-example" className="mb-1 block font-medium">
                Example program
              </label>
              <Select id="kit-example" defaultValue="sum">
                <option value="hello">Hello World</option>
                <option value="sum">Sum loop</option>
                <option value="factorial">Factorial</option>
              </Select>
            </div>
            <div>
              <label htmlFor="kit-wrong" className="mb-1 block font-medium">
                With aria-invalid
              </label>
              <Input id="kit-wrong" mono defaultValue="0x7ffffffde000" aria-invalid="true" />
            </div>
            <div>
              <label htmlFor="kit-disabled" className="mb-1 block font-medium">
                Disabled
              </label>
              <Input id="kit-disabled" defaultValue="42" disabled />
            </div>
          </div>
        </Panel>

        <Panel title="Icons">
          <ul className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
            {Object.entries(icons).map(([name, Icon]) => (
              <li key={name} className="flex items-center gap-2.5">
                <Icon />
                <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Panel with flush content" flush>
          <FlushRows />
        </Panel>
      </div>
    </PageContainer>
  )
}
