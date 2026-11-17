import type { ReactNode } from 'react'
import { Link, type LinkProps } from '../../lib/router'
import { buttonClasses, type ButtonSize, type ButtonVariant } from './buttonStyles'

export interface ButtonLinkProps extends LinkProps {
  /** Default 'secondary'. Use 'primary' for the one main action. */
  variant?: ButtonVariant
  /** Default 'md' (44 px tall). */
  size?: ButtonSize
}

/**
 * A link to a route that looks like a <Button>. Use it when a click opens another page.
 *
 * To switch it off for a while (a "Next" link before the question is answered), pass
 * `aria-disabled="true"`. It then looks disabled, has no address and no click handler,
 * and cannot be reached with the Tab key: nobody can follow it, with a mouse, a finger
 * or the keyboard. Screen readers still read it, as a link that is not available.
 */
export function ButtonLink({
  variant,
  size,
  className,
  children,
  ...rest
}: ButtonLinkProps): ReactNode {
  const classes = buttonClasses({ variant, size, className })

  if (rest['aria-disabled'] === true || rest['aria-disabled'] === 'true') {
    const { to: _to, onClick: _onClick, ...anchorProps } = rest
    return (
      // An <a> without an address is not a link for the browser, so the role says it.
      <a role="link" {...anchorProps} className={classes}>
        {children}
      </a>
    )
  }

  return (
    <Link className={classes} {...rest}>
      {children}
    </Link>
  )
}
