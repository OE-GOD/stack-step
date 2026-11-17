import { describe, expect, it } from 'vitest'
import { parseReply } from './replyText'

const text = (value: string) => ({ kind: 'text', text: value })
const code = (value: string) => ({ kind: 'code', text: value })
const block = (value: string) => ({ kind: 'block', text: value })

describe('parseReply', () => {
  it('gives plain text back as one part, with its line breaks', () => {
    expect(parseReply('Look at line 3.\nWhat changed?')).toEqual([
      text('Look at line 3.\nWhat changed?'),
    ])
    expect(parseReply('')).toEqual([])
  })

  it('finds code in backticks', () => {
    expect(parseReply('Look at `rsp` before the `push rbx`. Then step.')).toEqual([
      text('Look at '),
      code('rsp'),
      text(' before the '),
      code('push rbx'),
      text('. Then step.'),
    ])
    expect(parseReply('`mov eax, 5`')).toEqual([code('mov eax, 5')])
  })

  it('shows a backtick without a partner as it is', () => {
    expect(parseReply('The ` key is next to 1.')).toEqual([text('The ` key is next to 1.')])
    expect(parseReply('`rax` and then a lonely `')).toEqual([
      code('rax'),
      text(' and then a lonely `'),
    ])
    expect(parseReply('``')).toEqual([text('``')])
  })

  it('does not let code run over a line break', () => {
    expect(parseReply('one ` two\nthree ` four')).toEqual([text('one ` two\nthree ` four')])
  })

  it('never reads the reply as HTML or Markdown: everything else is plain text', () => {
    const reply = '<b>bold</b> **stars** # heading <script>alert(1)</script> [link](http://x)'
    expect(parseReply(reply)).toEqual([text(reply)])
    expect(parseReply('`<img src=x onerror=alert(1)>`')).toEqual([
      code('<img src=x onerror=alert(1)>'),
    ])
  })

  it('shows a fenced block as a block of code, without the fences and the language word', () => {
    expect(parseReply('Fix line 4:\n```asm\npop rbx\nret\n```\nThen run it.')).toEqual([
      text('Fix line 4:\n'),
      block('pop rbx\nret'),
      text('Then run it.'),
    ])
    expect(parseReply('```\nmov eax, 5\n```')).toEqual([block('mov eax, 5')])
    expect(parseReply('before ```mov eax, 5``` after')).toEqual([
      text('before '),
      block('mov eax, 5'),
      text(' after'),
    ])
  })

  it('handles two blocks, and code in the text between them', () => {
    expect(parseReply('```\na\n```\nuse `rax`\n```\nb\n```')).toEqual([
      block('a'),
      text('use '),
      code('rax'),
      text('\n'),
      block('b'),
    ])
  })

  it('shows a block whose closing fence is missing as a block', () => {
    expect(parseReply('Try:\n```asm\npop rbx')).toEqual([text('Try:\n'), block('pop rbx')])
  })

  describe('while the reply is still arriving', () => {
    it('already shows code whose closing backtick has not arrived yet', () => {
      expect(parseReply('Look at `rs', true)).toEqual([text('Look at '), code('rs')])
      // …so the text does not jump when the backtick arrives.
      expect(parseReply('Look at `rsp`', true)).toEqual([text('Look at '), code('rsp')])
    })

    it('hides a backtick that has just arrived', () => {
      expect(parseReply('Look at `', true)).toEqual([text('Look at ')])
    })

    it('still shows complete code before it', () => {
      expect(parseReply('`rax` holds 5 and `rb', true)).toEqual([
        code('rax'),
        text(' holds 5 and '),
        code('rb'),
      ])
    })

    it('leaves a lonely backtick on an earlier line alone', () => {
      expect(parseReply('a ` b\nnext line', true)).toEqual([text('a ` b\nnext line')])
    })

    it('shows the lonely backtick again when the reply is complete', () => {
      expect(parseReply('Look at `rs', false)).toEqual([text('Look at `rs')])
    })
  })
})
