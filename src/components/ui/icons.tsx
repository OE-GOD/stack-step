/**
 * The site's icons: small inline SVG drawings, so there is no icon package to download.
 *
 * Every icon is decoration (`aria-hidden`). The control that holds it must say what it
 * does in words: visible text, an `aria-label`, or <VisuallyHidden>.
 * An icon takes the color of the text around it (`currentColor`).
 */
import type { ReactNode, SVGProps } from 'react'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Width and height in pixels (or any CSS length). Default 20. */
  size?: number | string
}

function Svg({ size = 20, children, ...rest }: IconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
      className={rest.className === undefined ? 'shrink-0' : `shrink-0 ${rest.className}`}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/* ───────────────────────────── Navigation ───────────────────────────── */

export function MenuIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  )
}

export function CloseIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  )
}

export function ArrowRightIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Svg>
  )
}

export function ArrowLeftIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Svg>
  )
}

export function ChevronDownIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  )
}

export function ChevronRightIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M9 6l6 6-6 6" />
    </Svg>
  )
}

export function HomeIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M4 11l8-7 8 7" />
      <path d="M6 9.5V20h12V9.5" />
    </Svg>
  )
}

/* ─────────────────────────────── Theme ──────────────────────────────── */

export function SunIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </Svg>
  )
}

export function MoonIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a7 7 0 0 0 10 10z" />
    </Svg>
  )
}

/* ───────────────────────── Feedback and notes ───────────────────────── */

export function CheckIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Svg>
  )
}

export function CheckCircleIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.7 2.7L16 9.8" />
    </Svg>
  )
}

export function XCircleIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </Svg>
  )
}

export function InfoIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.5v.01" />
    </Svg>
  )
}

export function WarningIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M12 3.5 2.5 20h19L12 3.5z" />
      <path d="M12 10v4.5M12 17.5v.01" />
    </Svg>
  )
}

export function HelpIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.6-2.5 2-2.5 4M12 17v.01" />
    </Svg>
  )
}

export function LightbulbIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-4 10.5c.7.6 1 1.3 1 2V16h6v-.5c0-.7.3-1.4 1-2A6 6 0 0 0 12 3z" />
    </Svg>
  )
}

/* ──────────────────────── Running a program ─────────────────────────── */

export function PlayIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M7 4.5v15l12-7.5L7 4.5z" />
    </Svg>
  )
}

export function PauseIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M8.5 5v14M15.5 5v14" />
    </Svg>
  )
}

/** One step forward. */
export function StepIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M6 5v14l10-7L6 5z" />
      <path d="M19 5v14" />
    </Svg>
  )
}

/** One step back. */
export function StepBackIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M18 5v14L8 12l10-7z" />
      <path d="M5 5v14" />
    </Svg>
  )
}

/** Back to the start. */
export function ResetIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5L4 9" />
      <path d="M4 4.5V9h4.5" />
    </Svg>
  )
}

/* ─────────────────────────────── Pages ──────────────────────────────── */

export function BookIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M12 6.5C10 5.2 7.5 4.7 4 5v13.5c3.5-.3 6 .2 8 1.5 2-1.3 4.5-1.8 8-1.5V5c-3.5-.3-6 .2-8 1.5z" />
      <path d="M12 6.5V20" />
    </Svg>
  )
}

export function PencilIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M4 20l1-4.5L16.5 4a2.1 2.1 0 0 1 3 3L8 18.5 4 20z" />
      <path d="M14.5 6l3.5 3.5" />
    </Svg>
  )
}

export function PrinterIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M7 8V4h10v4" />
      <path d="M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <path d="M7 13.5h10V20H7z" />
    </Svg>
  )
}

export function ChartIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M4 20h16" />
      <path d="M7.5 20v-6M12 20V5M16.5 20v-9" />
    </Svg>
  )
}

/* ─────────────────────────────── Tools ──────────────────────────────── */

export function KeyboardIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6.5 10v.01M10 10v.01M14 10v.01M17.5 10v.01M8 14h8" />
    </Svg>
  )
}

export function LinkIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M10 13.5a4 4 0 0 0 5.7.3l3-3a4 4 0 0 0-5.7-5.6l-1.2 1.1" />
      <path d="M14 10.5a4 4 0 0 0-5.7-.3l-3 3a4 4 0 0 0 5.7 5.6l1.2-1.1" />
    </Svg>
  )
}

export function CopyIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5.5 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v.5" />
    </Svg>
  )
}
