import type { ReactNode } from 'react'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { InlineCode } from '../../components/ui/InlineCode'
import { useRoute } from '../../lib/router'

/** Shown for every address that is not in the route table. */
export default function NotFoundPage(): ReactNode {
  const { path } = useRoute()
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 md:px-6 md:py-16">
      <div className="rounded-2xl border border-line bg-surface px-5 py-10 text-center shadow-xs md:px-10 md:py-14">
        <h1 className="text-3xl leading-tight font-extrabold tracking-tight md:text-4xl">
          Page not found
        </h1>
        <p className="mt-4 text-lg text-balance text-muted">
          Stack Step has no page at this address: <InlineCode>{path}</InlineCode>
        </p>
        <p className="mt-2 text-lg text-balance text-muted">
          The address may have a typing mistake. You can start again from one of these pages.
        </p>
        <p className="mt-8 flex flex-wrap justify-center gap-3">
          <ButtonLink to="/" variant="primary">
            Go to the home page
          </ButtonLink>
          <ButtonLink to="/stepper">Go to the stepper</ButtonLink>
        </p>
      </div>
    </div>
  )
}
