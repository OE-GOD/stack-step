import type { ReactNode } from 'react'
import { cx } from '../../components/ui/cx'
import {
  ArrowRightIcon,
  BookIcon,
  ChartIcon,
  PencilIcon,
  PrinterIcon,
  StepIcon,
  type IconProps,
} from '../../components/ui/icons'
import { NoWrap } from '../../components/ui/NoWrap'
import { TextLink } from '../../components/ui/TextLink'
import { LESSONS } from '../../content/lessonList'
import { Link } from '../../lib/router'

interface Choice {
  to: string
  title: string
  caption: string
  Icon: (props: IconProps) => ReactNode
  /** The main action is filled; the other two are outlined. */
  main: boolean
}

/*
 * The captions are short on purpose: all three fit on one line when the cards stand side
 * by side (from 1024 px), so no card has a caption that breaks while the others do not.
 * The first caption names the page ("the stepper"): the menu calls it "Stepper".
 */
const CHOICES: readonly Choice[] = [
  {
    to: '/stepper',
    title: 'Step Through Code',
    caption: 'Open the stepper with your code.',
    Icon: StepIcon,
    main: true,
  },
  {
    to: '/learn',
    title: 'Learn',
    caption: `${LESSONS.length} short lessons, one idea each.`,
    Icon: BookIcon,
    main: false,
  },
  {
    to: '/practice',
    title: 'Practice',
    caption: 'New problems, instant feedback.',
    Icon: PencilIcon,
    main: false,
  },
]

/**
 * One of the three big choices. The whole card is the link, and its name is everything it
 * shows: the title, then the caption ("Learn 14 short lessons, one idea each."). The name
 * must hold every word that is visible in the link (WCAG 2.5.3, "label in name"), so that
 * a student who uses voice control can say what they see. It starts with the title, so
 * "click Learn" works.
 *
 * Below 1024 px a card is a row (icon, words, arrow) and the three cards are a list. From
 * 1024 px they stand side by side, with the words under the icon. Three cards side by
 * side are too narrow on a tablet: the title and the captions broke unevenly.
 */
function ChoiceCard({ to, title, caption, Icon, main }: Choice): ReactNode {
  return (
    <Link
      to={to}
      className={cx(
        'group flex h-full items-center gap-4 rounded-2xl border p-4 transition-colors md:gap-5 md:p-5 lg:flex-col lg:items-stretch lg:p-6',
        main
          ? 'border-transparent bg-primary text-on-primary shadow-sm hover:bg-primary-hover'
          : 'border-line-strong bg-surface text-ink shadow-xs hover:border-primary hover:bg-primary-soft',
      )}
    >
      <div className="flex items-center justify-between">
        <span
          className={cx(
            'flex size-12 shrink-0 items-center justify-center rounded-xl md:size-14',
            main ? 'bg-on-primary-tint' : 'bg-primary-soft text-primary group-hover:bg-surface',
          )}
        >
          <Icon size={28} />
        </span>
        <ArrowRightIcon
          size={24}
          className={cx(
            'transition-transform group-hover:translate-x-1 max-lg:hidden',
            !main && 'text-primary',
          )}
        />
      </div>
      {/*
        `overflow-wrap:anywhere`: with very large text (a browser set to 175 % and more on a
        phone) a long word may break, so the card never becomes wider than the screen.
      */}
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <h2 className="text-xl leading-snug font-bold md:text-2xl">{title}</h2>
        {/* Not drawn: it keeps "Code" and "Open" apart in the name of the link. */}{' '}
        <p
          className={cx(
            'mt-0.5 leading-snug text-pretty md:mt-1 lg:mt-1.5',
            main ? 'text-on-primary/90' : 'text-muted',
          )}
        >
          {caption}
        </p>
      </div>
      <ArrowRightIcon
        size={22}
        className={cx(
          'transition-transform group-hover:translate-x-1 lg:hidden',
          !main && 'text-primary',
        )}
      />
    </Link>
  )
}

/**
 * A small drawing of what the stepper shows: three boxes of the stack, high addresses
 * first, and rsp pointing at the top of the stack. Decoration only, but true: it is the
 * frame of `push rbp`, `mov rbp, rsp`, `sub rsp, 16` (as on the cheat sheet), as the
 * example "Local variables with .equ" has it after its first two `mov` lines (count at
 * rbp-8, total at rbp-16; rsp starts at 0x…dff8, so rbp is 0x…dff0).
 */
function StackDrawing({ className }: { className?: string }): ReactNode {
  const boxes = [
    { y: 14, address: '0x…dff0', label: 'saved rbp', top: false },
    { y: 70, address: '0x…dfe8', label: 'count = 5', top: false },
    { y: 126, address: '0x…dfe0', label: 'total = 100', top: true },
  ]
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 344 188"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {boxes.map((box) => (
        <g key={box.address}>
          <text
            x="84"
            y={box.y + 29}
            textAnchor="end"
            className="fill-muted font-mono text-[12.5px]"
          >
            {box.address}
          </text>
          <rect
            x="96"
            y={box.y}
            width="164"
            height="48"
            rx="9"
            strokeWidth={box.top ? 2 : 1.5}
            className={
              box.top ? 'fill-primary-soft stroke-primary' : 'fill-surface stroke-line-strong'
            }
          />
          <text
            x="114"
            y={box.y + 29}
            className={cx('fill-ink font-mono text-[14px]', box.top && 'font-bold')}
          >
            {box.label}
          </text>
        </g>
      ))}
      {/* The rsp arrow points at the lowest box: the top of the stack. */}
      <path
        d="M300 150h-28m9-8-9 8 9 8"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-rsp"
      />
      <text x="308" y="155" className="fill-rsp font-mono text-[15px] font-bold">
        rsp
      </text>
    </svg>
  )
}

export default function HomePage(): ReactNode {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-8 pb-12 md:px-6 md:pt-14 md:pb-16">
      <div className="flex items-center justify-between gap-8 lg:gap-12">
        <div className="max-w-2xl">
          <h1 className="text-[2rem] leading-[1.15] font-extrabold tracking-tight text-balance md:text-5xl md:leading-[1.1]">
            Learn <NoWrap>x86-64</NoWrap> assembly one step at a time
          </h1>
          <p className="mt-4 text-lg text-pretty text-muted md:mt-5 md:text-xl">
            Stack Step runs your program one line at a time and shows what changes in the registers,
            on the stack and in the flags.
          </p>
        </div>
        <StackDrawing className="hidden w-80 shrink-0 lg:block xl:w-[23rem]" />
      </div>

      <ul className="mt-8 grid gap-3 md:mt-12 md:gap-4 lg:grid-cols-3 lg:gap-5">
        {CHOICES.map((choice) => (
          <li key={choice.to}>
            <ChoiceCard {...choice} />
          </li>
        ))}
      </ul>

      <ul className="mt-5 flex flex-col gap-x-10 md:mt-8 md:flex-row md:flex-wrap">
        <li className="md:flex md:items-center md:gap-2.5">
          {/*
            `relative` keeps the whole 44 px of the link on top: on a phone the words under it
            move up a little over its bottom edge, and must not take that part of the tap.
          */}
          <TextLink to="/cheatsheet" className="relative inline-flex min-h-11 items-center gap-2">
            <PrinterIcon size={18} />
            Open the cheat sheet
          </TextLink>
          {/*
            "Cheat sheet" is an idiom, so say once in plain words what it is.
            On a phone the words stand under the link, in line with its text.
          */}
          <span className="text-muted max-md:-mt-1.5 max-md:block max-md:pb-1.5 max-md:pl-[26px]">
            A one-page summary that you can print.
          </span>
        </li>
        <li>
          <TextLink to="/progress" className="inline-flex min-h-11 items-center gap-2">
            <ChartIcon size={18} />
            See your progress
          </TextLink>
        </li>
      </ul>
    </div>
  )
}
