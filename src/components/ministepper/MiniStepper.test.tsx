// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MiniStepper } from './MiniStepper'

afterEach(() => {
  cleanup()
})

const SNIPPET = '    mov rax, -1\n    mov eax, 5\n    ret\n'

function stepButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Step' })
}

describe('MiniStepper', () => {
  it('steps, goes back and resets its own program', () => {
    const { container } = render(<MiniStepper title="Try it" source={SNIPPET} />)
    expect(screen.getByRole('heading', { name: 'Try it' })).toBeDefined()
    // Default registers: the ones the program names (rax).
    const rax = container.querySelector('[data-register="rax"] [data-hex]')
    expect(rax?.textContent).toBe('0x0000000000000000')

    fireEvent.click(stepButton())
    fireEvent.click(stepButton())
    expect(container.querySelector('[data-register="rax"] [data-hex]')?.textContent).toBe(
      '0x0000000000000005',
    )
    expect(screen.getByText('Step 2 · ran line 2')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(container.querySelector('[data-register="rax"] [data-hex]')?.textContent).toBe(
      '0xffffffffffffffff',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(screen.getByRole('button', { name: 'Reset' })).toHaveProperty('disabled', true)
  })

  it('hides the warnings about whole programs, and links to the full stepper', () => {
    render(<MiniStepper source={SNIPPET} />)
    expect(screen.queryByText(/intel_syntax/)).toBeNull()
    expect(screen.queryByText(/main:/)).toBeNull()
    const link = screen.getByRole('link', { name: /Open in the stepper/ })
    expect(link.getAttribute('href')).toMatch(/^#\/stepper\?s=v1\./)
  })

  it('shows the errors of a broken snippet plainly, and does not crash', () => {
    render(<MiniStepper source={'    mov [rax], [rbx]\n'} openInStepper={false} />)
    expect(screen.getByText(/Line 1: you can't move memory into memory/)).toBeDefined()
    expect(stepButton()).toHaveProperty('disabled', true)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('shows the panels it is asked for', () => {
    const { container } = render(
      <MiniStepper
        source={'    push 7\n    pop rbx\n    ret\n'}
        registers={['rbx']}
        showStack
        showFlags
        showRip
      />,
    )
    // Named groups inside the MiniStepper (not landmarks of their own).
    expect(screen.getByRole('group', { name: 'Stack' })).toBeDefined()
    expect(screen.getByRole('group', { name: 'Flags' })).toBeDefined()
    expect(container.querySelector('[data-register="rip"]')).not.toBeNull()
    fireEvent.click(stepButton())
    const stack = screen.getByRole('group', { name: 'Stack' })
    expect(within(stack).getByRole('button', { name: /rsp points here$/ })).toBeDefined()
  })

  it('reads ahead-of-time input for scanf', () => {
    const source = `    .intel_syntax noprefix
pattern:
    .string "%d"
main:
    push rbp
    mov rbp, rsp
    sub rsp, 16
    lea rsi, [rbp-8]
    lea rdi, pattern[rip]
    mov eax, 0
    call scanf
    mov eax, [rbp-8]
    leave
    ret
`
    const { container } = render(<MiniStepper source={source} stdin="42" registers={['rax']} />)
    for (let i = 0; i < 9; i++) fireEvent.click(stepButton())
    expect(container.querySelector('[data-register="rax"] [data-hex]')?.textContent).toBe(
      '0x000000000000002a',
    )
  })
})

describe('MiniStepper on a narrow screen', () => {
  it('puts the explanation right after the buttons, before the registers', () => {
    const { container } = render(<MiniStepper title="Try it" source={SNIPPET} />)
    fireEvent.click(stepButton())
    const order = [
      ...container.querySelectorAll('[data-code-listing], [data-step-heading], [data-register]'),
    ].map((node) =>
      node.hasAttribute('data-code-listing')
        ? 'code'
        : node.hasAttribute('data-step-heading')
          ? 'explanation'
          : 'registers',
    )
    expect(order.slice(0, 3)).toEqual(['code', 'explanation', 'registers'])
    // About 7 lines of code on a phone, more on a bigger screen.
    expect(container.querySelector('[data-code-listing]')?.className).toContain('max-h-[11.25rem]')
  })

  it('makes "Open in the stepper" a 44 px target without making its row taller', () => {
    render(<MiniStepper title="Try it" source={SNIPPET} />)
    const link = screen.getByRole('link', { name: /Open in the stepper/ })
    expect(link.className).toContain('py-3')
    expect(link.className).toContain('-my-3')
  })
})
