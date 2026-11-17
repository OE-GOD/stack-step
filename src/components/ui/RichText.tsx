import { Fragment, type ReactNode } from 'react'
import { InlineCode } from './InlineCode'
import { NoWrap } from './NoWrap'

export interface RichTextProps {
  /** A message in which code is wrapped in backticks: "`mov` copies a value." */
  text: string
}

/*
 * The marks that touch a piece of code, with no space in between: the comma after it, the
 * bracket in front of it. At most three on each side. Letters and digits are not marks.
 * A closing mark is never taken from the text in front of the code, and an opening mark
 * never from the text after it.
 */
const MARKS_BEFORE_CODE = /[^\s\p{L}\p{N})\]}”’]{1,3}$/u
const MARKS_AFTER_CODE = /^[^\s\p{L}\p{N}([{“‘]{1,3}/u

/**
 * Shows a message string and puts the parts in backticks in a code font. Every message
 * from the emulator, every lesson summary and every topic blurb is written this way.
 *
 * A mark that touches the code, such as the comma in "`rax`, then", stays on the same
 * line as the code: a line never starts with a lonely comma or period.
 *
 * It renders text and <code> only, so put it inside a <p>, a <li>, a heading, …
 * A backtick that has no partner is shown as it is.
 */
export function RichText({ text }: RichTextProps): ReactNode {
  // After the split, the parts at odd positions are code.
  const parts = text.split('`')
  // An even number of parts means an odd number of backticks: the last one has no partner.
  if (parts.length % 2 === 0) {
    const tail = parts.pop() ?? ''
    parts[parts.length - 1] += `\`${tail}`
  }

  // Move the marks that touch each piece of code out of the text around it.
  const marksBefore: string[] = []
  const marksAfter: string[] = []
  for (let index = 1; index < parts.length; index += 2) {
    if (parts[index] === '') continue
    const textBefore = parts[index - 1]
    const textAfter = parts[index + 1]
    const before = MARKS_BEFORE_CODE.exec(textBefore)?.[0] ?? ''
    const after = MARKS_AFTER_CODE.exec(textAfter)?.[0] ?? ''
    parts[index - 1] = textBefore.slice(0, textBefore.length - before.length)
    parts[index + 1] = textAfter.slice(after.length)
    marksBefore[index] = before
    marksAfter[index] = after
  }

  return parts.map((part, index) => {
    if (part === '') return null
    if (index % 2 === 0) return <Fragment key={index}>{part}</Fragment>
    const before = marksBefore[index]
    const after = marksAfter[index]
    if (before === '' && after === '') return <InlineCode key={index}>{part}</InlineCode>
    return (
      <NoWrap key={index}>
        {before}
        <InlineCode>{part}</InlineCode>
        {after}
      </NoWrap>
    )
  })
}
