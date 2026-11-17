/**
 * The stepper page, tested in a real browser, in both Playwright projects (desktop
 * 1280×800, phone 360×740):
 *
 *   E2E_DEV=1 E2E_PORT=5194 npx playwright test e2e/stepper.spec.ts
 *
 * It also runs against the built site (no E2E_DEV).
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { exampleById } from '../src/examples'
import { makeProblem } from '../src/features/practice/generators'
import { stepperRoute } from '../src/lib/share'
import {
  blockStorage,
  breakpointLines,
  chooseExample,
  codeEditor,
  control,
  controlBar,
  copiedText,
  cursorToEndOf,
  expectNoSidewaysScroll,
  expectStatus,
  explanation,
  fakeClipboard,
  inputBox,
  isPhone,
  lineNumberCell,
  markedCurrentLine,
  MOD,
  openStepper,
  outputText,
  pageTop,
  pasteIntoEditor,
  pressStep,
  registerRow,
  registerValue,
  rspBox,
  setCode,
  setRunSpeed,
  showTab,
  statusLine,
  stepCount,
  stepperPage,
  stepToTheEnd,
  visibleLineNumberCell,
  watchForErrors,
} from './helpers'

/** The 1-based line of an example that contains `text`. */
function lineOf(exampleId: string, text: string): number {
  const lines = (exampleById(exampleId)?.source ?? '').split('\n')
  const index = lines.findIndex((line) => line.includes(text))
  if (index < 0) throw new Error(`"${text}" is not in ${exampleId}`)
  return index + 1
}

const MOV_PROGRAM = `    .intel_syntax noprefix
    .globl main
main:
    mov     rax, -1          # all 64 bits are 1
    mov     eax, 5           # a 32-bit write clears the top half
    push    rax
    pop     rbx
    ret
`

let errors: string[] = []

// The first visit makes a fresh dev server prepare CodeMirror, which can reload the page
// once. Do that here, so no test is cut off by it.
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await page.goto('/#/stepper')
  await page.locator('.cm-content').waitFor()
  await page.waitForLoadState('networkidle')
  await page.reload()
  await page.locator('.cm-content').waitFor()
  await page.close()
})

test.beforeEach(({ page }) => {
  errors = watchForErrors(page)
})

test.afterEach(() => {
  expect(errors, 'the browser console must stay free of errors').toEqual([])
})

test.describe('running a program', () => {
  test('Hello World: Step until the end prints the text and says that it ended', async ({
    page,
  }) => {
    await openStepper(page, '?example=hello-world')
    await expectStatus(page, 'ready')
    await expect(statusLine(page)).toContainText('Ready')
    await stepToTheEnd(page)

    expect(await outputText(page)).toBe('Hello World!\n')
    await expectStatus(page, 'ended')
    await expect(statusLine(page)).toContainText('Ended')
    await expect(stepperPage(page).getByText('Press Reset to run it again.')).toBeVisible()
    await expect(control(page, 'Step')).toBeDisabled()
    await expect(control(page, 'Run')).toBeDisabled()
  })

  test('Run at the instant speed: factorial prints "5! = 120"', async ({ page }) => {
    await openStepper(page, '?example=factorial')
    await stepperPage(page).getByRole('slider', { name: 'Run speed' }).fill('10')
    await control(page, 'Run').click()
    await expectStatus(page, 'ended')
    expect(await outputText(page)).toBe('5! = 120\n')
  })

  test('the speed slider and Run / Pause', async ({ page }) => {
    await openStepper(page, '?example=factorial')
    // The page's clock moves only when the test says so.
    await page.clock.install()
    const slider = stepperPage(page).getByRole('slider', { name: 'Run speed' })
    await slider.fill('1')
    await expect(slider).toHaveAttribute('aria-valuetext', '1 of 10')

    await control(page, 'Run').click()
    await expectStatus(page, 'running')
    await expect(control(page, 'Pause')).toBeVisible()
    await control(page, 'Pause').click()
    await expectStatus(page, 'paused')
    await expect(control(page, 'Run')).toBeVisible()
    const paused = await stepCount(page)
    expect(paused).toBeGreaterThanOrEqual(1)
    await page.clock.runFor(5000)
    expect(await stepCount(page), 'nothing runs while paused').toBe(paused)

    // Speed 9: a step every 40 ms, so Run gets to the end quickly.
    await slider.fill('9')
    await control(page, 'Run').click()
    await page.clock.runFor(10_000)
    await expectStatus(page, 'ended')
    expect(await outputText(page)).toBe('5! = 120\n')
  })

  test('Back undoes a step, and Reset goes back to the start', async ({ page }) => {
    await setUpMovProgram(page)
    await pressStep(page, 1)
    expect(await registerValue(page, 'rax')).toBe('0xffffffffffffffff')
    await pressStep(page, 1)
    expect(await registerValue(page, 'rax')).toBe('0x0000000000000005')

    await control(page, 'Back').click()
    expect(await registerValue(page, 'rax')).toBe('0xffffffffffffffff')
    expect(await stepCount(page)).toBe(1)

    await pressStep(page, 2)
    await control(page, 'Reset').click()
    expect(await stepCount(page)).toBe(0)
    expect(await registerValue(page, 'rax')).toBe('0x0000000000000000')
    await expectStatus(page, 'ready')
    await expect(control(page, 'Back')).toBeDisabled()
    await expect(control(page, 'Reset')).toBeDisabled()
  })

  test('the register that changed is marked, the others are not', async ({ page }) => {
    await setUpMovProgram(page)
    await pressStep(page, 1)
    const rax = await registerRow(page, 'rax')
    const rbx = await registerRow(page, 'rbx')
    await expect(rax.getByRole('button')).toHaveAccessibleName('rax: 0xffffffffffffffff, changed')
    await expect(rbx.getByRole('button')).not.toHaveAccessibleName(/changed/)
    // Bold with a dot: never color alone.
    await expect(rax.locator('[data-hex]').locator('..')).toHaveCSS('font-weight', '700')
  })

  test('a register row opens into its parts, and shows the cleared top half', async ({ page }) => {
    await setUpMovProgram(page)
    await pressStep(page, 2)
    const rax = await registerRow(page, 'rax')
    const button = rax.getByRole('button')
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    for (const part of ['eax', 'ax', 'ah', 'al']) {
      await expect(rax.getByText(part, { exact: true }).first()).toBeVisible()
    }
    await expect(rax.getByText('32 bits', { exact: true })).toBeVisible()
    await expect(rax.getByText(/also set the top 32 bits of/)).toBeVisible()
    await expect(rax.getByText(/Unsigned: 5/)).toBeVisible()
    await expectNoSidewaysScroll(page)
    await button.click()
    await expect(rax.getByText('32 bits', { exact: true })).toHaveCount(0)
  })

  test('the rsp marker moves down a box after push', async ({ page }) => {
    await setUpMovProgram(page)
    await pressStep(page, 2)
    const before = await (await rspBox(page)).getAttribute('data-stack-box')
    await pressStep(page, 1) // push rax
    const box = await rspBox(page)
    const after = await box.getAttribute('data-stack-box')
    expect(BigInt(after ?? '0') - BigInt(before ?? '0')).toBe(-8n)
    // The box is labelled with the register it came from (the words may change).
    await expect(box).toContainText('rax')
    // A screen reader hears what the box is first, and where rsp points last.
    await expect(box.getByRole('button')).toHaveAccessibleName(/^\S.*, rsp points here$/)
  })

  test('a stack box opens into its 8 bytes, lowest address first', async ({ page }) => {
    await setUpMovProgram(page)
    await pressStep(page, 3)
    const box = await rspBox(page)
    await box.getByRole('button').click()
    const bytes = box.locator('ol li')
    await expect(bytes).toHaveCount(8)
    // 5 is little-endian: the lowest address holds 05.
    await expect(bytes.first()).toContainText('05')
    await expect(bytes.nth(7)).toContainText('00')
    await expectNoSidewaysScroll(page)
  })
})

test.describe('problems and input', () => {
  test('a program with an error shows the message and cannot run', async ({ page }) => {
    await openStepper(page, '?example=hello-world')
    await setCode(page, 'main:\n    mov [rax], [rbx]\n    ret\n')
    const problems = stepperPage(page).locator('[data-problems]')
    // The assembler's message for line 2 (its words may change; the line may not).
    await expect(problems.getByRole('button', { name: 'Line 2', exact: true })).toBeVisible()
    await expect(page.locator('.cm-gutters [aria-label="Error on line 2"]')).toHaveCount(1)
    await expect(control(page, 'Step')).toBeDisabled()
    await expect(control(page, 'Run')).toBeDisabled()
    await expectStatus(page, 'problems')
    await expect(
      stepperPage(page).getByText('Fix the problem in the code to run it.').first(),
    ).toBeVisible()

    // Fixing the code makes it runnable again. (A quiet note stays: the line
    // `.intel_syntax noprefix` is missing.)
    await setCode(page, 'main:\n    mov rax, rbx\n    ret\n')
    await expect(problems.getByText(/Fix th/)).toHaveCount(0)
    await expect(problems).toContainText('.intel_syntax noprefix')
    await expect(control(page, 'Step')).toBeEnabled()
  })

  test('scanf asks for input, takes "41", and the program prints the answer', async ({ page }) => {
    await openStepper(page, '?example=read-number')
    await stepToTheEnd(page)
    await expectStatus(page, 'waiting')
    await expect(statusLine(page)).toContainText('Waiting for input')

    await showTab(page, 'Output')
    // The box is labelled with the emulator's prompt (its words may change).
    const input = stepperPage(page).getByRole('region', { name: 'Output' }).getByRole('textbox')
    await expect(input).toHaveAccessibleName(/\S/)
    await expect(input).toBeFocused()
    await input.fill('41')
    await input.press('Enter')

    await stepToTheEnd(page)
    await expectStatus(page, 'ended')
    expect(await outputText(page)).toBe('Type a number: 41 plus 1 is 42.\n')
  })

  test('editing a running program starts it again and says so; a comment keeps the place', async ({
    page,
  }) => {
    await setUpMovProgram(page)
    await pressStep(page, 2)
    // A new comment does not change what the program does: the machine stays at step 2.
    await codeEditor(page).click()
    await page.keyboard.press(`${MOD}+End`)
    await page.keyboard.type('# a comment')
    await expect(stepperPage(page)).not.toHaveAttribute('data-edit-pending', 'true')
    expect(await stepCount(page)).toBe(2)
    await expect(explanation(page)).toContainText(
      'Your change did not change the program, so you are still at step 2.',
    )
    // A new instruction does: the program starts again from the top.
    await page.keyboard.type('\n    nop')
    await expect(stepperPage(page)).not.toHaveAttribute('data-edit-pending', 'true')
    expect(await stepCount(page)).toBe(0)
    await expect(
      stepperPage(page).getByText(
        'You changed the code, so the program started again from the top.',
      ),
    ).toBeVisible()
  })
})

test.describe('loading and sharing', () => {
  test('?example=factorial loads that example', async ({ page }) => {
    await openStepper(page, '?example=factorial')
    await expect(codeEditor(page)).toContainText('# Factorial with a loop')
    await expect(stepperPage(page).getByLabel('Example', { exact: true })).toHaveValue('factorial')
    await expect(stepperPage(page).getByText('Multiply 5 * 4 * 3 * 2')).toBeVisible()
  })

  test('the Example menu loads a program', async ({ page }) => {
    await openStepper(page, '?example=hello-world')
    await chooseExample(page, 'A call inside a call')
    await expect(codeEditor(page)).toContainText('show_double')
    await expectStatus(page, 'ready')
  })

  test('Share link copies a link that opens the same code', async ({ page }) => {
    await fakeClipboard(page)
    await openStepper(page, '?example=hello-world')
    const program = 'main:\n    mov rax, 0x1234   # shared by a classmate\n    ret\n'
    await setCode(page, program)
    await stepperPage(page).getByRole('button', { name: 'Share', exact: true }).click()
    await expect(
      stepperPage(page).getByRole('status').filter({ hasText: 'Link copied.' }),
    ).toHaveCount(1)
    const link = await copiedText(page)
    expect(link).toMatch(/#\/stepper\?s=v1\./)

    await page.goto(link ?? '')
    await expect(codeEditor(page)).toContainText('# shared by a classmate')
    await pressStep(page, 1)
    expect(await registerValue(page, 'rax')).toBe('0x0000000000001234')
  })

  test('without a clipboard, the link is shown in a field to copy', async ({ page }) => {
    await fakeClipboard(page, false)
    await openStepper(page, '?example=factorial')
    await stepperPage(page).getByRole('button', { name: 'Share', exact: true }).click()
    const field = stepperPage(page).getByLabel('Copy this link to share the program')
    await expect(field).toBeVisible()
    await expect(field).toHaveValue(/#\/stepper\?s=v1\./)
    await expectNoSidewaysScroll(page)
    // The link belongs to the program it was made from: an edit closes the field.
    await setCode(page, 'main:\n    mov rax, 2\n    ret\n')
    await expect(field).toHaveCount(0)
  })

  test('a damaged link shows a friendly notice and opens another program', async ({ page }) => {
    await openStepper(page, '?s=v1.not-a-real-link')
    await expect(stepperPage(page).getByText(/This link is damaged/)).toBeVisible()
    await expect(control(page, 'Step')).toBeEnabled()
  })
})

test.describe('keyboard', () => {
  test('Ctrl/Cmd + Enter steps, also in the editor; S steps outside it', async ({ page }) => {
    await setUpMovProgram(page)
    await codeEditor(page).click()
    const before = await codeEditor(page).textContent()
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(stepperPage(page)).toHaveAttribute('data-steps', '1')
    // No line break was typed into the program.
    expect(await codeEditor(page).textContent()).toBe(before)
    await expect(statusLine(page)).toContainText('Paused at line 5')

    await page.keyboard.press(`${MOD}+Shift+Enter`)
    await expect(stepperPage(page)).toHaveAttribute('data-steps', '0')

    // With the keyboard focus outside the editor, the single keys work too.
    await page.keyboard.press('Escape')
    await page.locator('h1').click()
    await page.keyboard.press('s')
    await expect(stepperPage(page)).toHaveAttribute('data-steps', '1')
    await page.keyboard.press('b')
    await expect(stepperPage(page)).toHaveAttribute('data-steps', '0')
  })

  test('the Keys button lists the keys', async ({ page }) => {
    test.skip(isPhone(page), 'A touch screen has no Ctrl or Alt key, so the button is hidden.')
    await openStepper(page)
    await stepperPage(page).getByRole('button', { name: 'Keys (keyboard shortcuts)' }).click()
    const panel = stepperPage(page).getByRole('group', { name: 'Keyboard shortcuts' })
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Run / Pause')
    await expect(panel).toContainText('click a line number')
    await expectNoSidewaysScroll(page)
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
  })
})

test.describe('breakpoints', () => {
  test('a click on a line number sets a breakpoint, and Run stops there', async ({ page }) => {
    await openStepper(page, '?example=hello-world')
    // Line 16: `mov eax, 0` after the call.
    await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^16$/ }).click()
    await stepperPage(page).getByRole('slider', { name: 'Run speed' }).fill('10')
    await control(page, 'Run').click()
    await expectStatus(page, 'paused')
    await expect(statusLine(page)).toContainText('Paused at line 16 (breakpoint)')
    expect(await outputText(page)).toBe('Hello World!\n')
  })
})

test.describe('phone layout', () => {
  test('nothing scrolls sideways, also after stepping and switching tabs', async ({ page }) => {
    test.skip(!isPhone(page), 'The tabs belong to the narrow layout.')
    await openStepper(page, '?example=nested-call')
    await expectNoSidewaysScroll(page)
    await pressStep(page, 13)
    for (const tab of ['Registers', 'Stack', 'Output'] as const) {
      await showTab(page, tab)
      await expectNoSidewaysScroll(page)
    }
    await (await registerRow(page, 'rsp')).getByRole('button').click()
    await expectNoSidewaysScroll(page)
    await (await rspBox(page)).getByRole('button').click()
    await expectNoSidewaysScroll(page)
  })

  test('the controls stay at the bottom of the screen, thumb-sized', async ({ page }) => {
    test.skip(!isPhone(page), 'The bar belongs to the narrow layout.')
    await openStepper(page, '?example=hello-world')
    const step = control(page, 'Step')
    const viewport = page.viewportSize()
    const box = await step.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport?.height ?? 0)
    // After scrolling down to the panels, Step is still on the screen.
    await showTab(page, 'Stack')
    await page.evaluate(() => window.scrollBy(0, 600))
    const moved = await step.boundingBox()
    expect((moved?.y ?? 0) + (moved?.height ?? 0)).toBeLessThanOrEqual(viewport?.height ?? 0)
    await step.click()
    expect(await stepCount(page)).toBe(1)
  })

  test('a tab whose content changed shows a dot', async ({ page }) => {
    test.skip(!isPhone(page), 'The tabs belong to the narrow layout.')
    await setUpMovProgram(page)
    await pressStep(page, 1)
    await expect(page.getByRole('tab', { name: /^Registers\s*,\s*changed$/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Output', exact: true })).toBeVisible()
  })
})

test('desktop: code, controls, explanation, registers and stack fit on the screen', async ({
  page,
}) => {
  test.skip(isPhone(page), 'The three columns belong to the wide layout.')
  await openStepper(page, '?example=hello-world')
  await pressStep(page, 5)
  const viewport = page.viewportSize()
  const bottom = viewport?.height ?? 0
  for (const locator of [
    codeEditor(page),
    control(page, 'Step'),
    stepperPage(page).getByRole('region', { name: 'Explanation' }),
    await registerRow(page, 'r15'),
    await rspBox(page),
  ]) {
    const box = await locator.boundingBox()
    expect(box, 'on the screen').not.toBeNull()
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(bottom)
  }
})

test('the MiniStepper demo steps on its own', async ({ page }) => {
  await page.goto('/#/stepper?demo=ministepper')
  const mini = page.locator('[data-ministepper]').first()
  await expect(mini).toBeVisible()
  await mini.getByRole('button', { name: 'Step', exact: true }).click()
  await mini.getByRole('button', { name: 'Step', exact: true }).click()
  await expect(mini.locator('[data-register="rax"] [data-hex]')).toHaveText('0x0000000000000005')
  await expect(mini).toContainText('Step 2 · ran line 2')
  await expectNoSidewaysScroll(page)
})

test.describe('the real editor in the page', () => {
  test('the line that runs next is marked in the editor and follows every step', async ({
    page,
  }) => {
    await openStepper(page, '?example=hello-world')
    // Hello World: push (11), mov (12), lea (13), mov (14), call printf (15), mov (16).
    await expect.poll(() => markedCurrentLine(page)).toBe(11)
    for (const line of [12, 13, 14, 15]) {
      await pressStep(page)
      await expect.poll(() => markedCurrentLine(page)).toBe(line)
    }
    // The call: now the program is inside printf, and line 15 says so.
    await pressStep(page)
    await expect.poll(() => markedCurrentLine(page)).toBeNull()
    const tag = page.locator('.cm-ss-library-tag')
    await expect(tag).toHaveText('inside printf')
    // The whole tag and the line's mark are in sight (the tag can make the line taller).
    await expect(tag).toBeInViewport({ ratio: 1 })
    await expect(page.locator('.cm-gutters .cm-ss-hourglass')).toBeInViewport({ ratio: 1 })
    await expect(
      page.locator('.cm-gutters [aria-label="Line 15: the program is inside printf"]'),
    ).toHaveCount(1)
    // The tag stays in sight, although the line with its comment is wider than the editor.
    const editorBox = await page.locator('.cm-scroller').boundingBox()
    const tagBox = await tag.boundingBox()
    expect(tagBox, 'the tag is drawn').not.toBeNull()
    expect((tagBox?.x ?? 0) + (tagBox?.width ?? 0)).toBeLessThanOrEqual(
      (editorBox?.x ?? 0) + (editorBox?.width ?? 0) + 1,
    )
    // The library step runs printf; then line 16 runs next.
    await pressStep(page)
    await expect.poll(() => markedCurrentLine(page)).toBe(16)
    expect(await outputText(page)).toBe('Hello World!\n')
  })

  test('Ctrl/Cmd + B sets a breakpoint; Run (speed 9) stops there, and Run again moves on', async ({
    page,
  }) => {
    await openStepper(page, '?example=hello-world')
    await cursorToEndOf(page, 'call    printf@PLT')
    await page.keyboard.press(`${MOD}+b`)
    await expect.poll(() => breakpointLines(page)).toEqual([15])

    await stepperPage(page).getByRole('slider', { name: 'Run speed' }).fill('9')
    await control(page, 'Run').click()
    await expectStatus(page, 'paused')
    await expect(statusLine(page)).toContainText('Paused at line 15 (breakpoint)')
    await expect.poll(() => markedCurrentLine(page)).toBe(15)
    // Said once for screen readers (the explanation is quiet while Run plays).
    await expect(
      stepperPage(page)
        .getByRole('status')
        .filter({ hasText: /^Paused at line 15 \(breakpoint\), \d+ steps\.$/ }),
    ).toHaveCount(1)

    await control(page, 'Run').click()
    await expectStatus(page, 'ended')
    expect(await outputText(page)).toBe('Hello World!\n')
  })

  test('a breakpoint stays with its line of code while the student edits', async ({ page }) => {
    await openStepper(page, '?example=hello-world')
    // Line 16: `mov eax, 0` after the call.
    await lineNumberCell(page, 16).click()
    await expect.poll(() => breakpointLines(page)).toEqual([16])

    // A new line above it: the breakpoint moves down with its instruction.
    await cursorToEndOf(page, 'mov     rbp, rsp')
    await page.keyboard.press('Enter')
    await page.keyboard.type('nop   # a new line')
    await expect.poll(() => breakpointLines(page)).toEqual([17])
    await expect(stepperPage(page)).not.toHaveAttribute('data-edit-pending', 'true')
    await stepperPage(page).getByRole('slider', { name: 'Run speed' }).fill('10')
    await control(page, 'Run').click()
    await expect(statusLine(page)).toContainText('Paused at line 17 (breakpoint)')

    // Undo takes the new line away: the breakpoint goes back up with it.
    await codeEditor(page).focus()
    for (let i = 0; i < 4 && (await codeEditor(page).textContent())?.includes('a new line'); i++) {
      await page.keyboard.press(`${MOD}+z`)
    }
    await expect(codeEditor(page)).not.toContainText('a new line')
    await expect.poll(() => breakpointLines(page)).toEqual([16])

    // Deleting the line itself takes its breakpoint away. (Long lines wrap on a wide
    // screen, so the line is selected with the mouse: from its start to the next line.)
    await selectWholeLine(page, '# main returns 0')
    await page.keyboard.press('Delete')
    await expect(codeEditor(page)).not.toContainText('# main returns 0')
    await expect.poll(() => breakpointLines(page)).toEqual([])

    // Loading an example starts without breakpoints.
    await lineNumberCell(page, 12).click()
    await expect.poll(() => breakpointLines(page)).toEqual([12])
    await chooseExample(page, 'Factorial (loop)')
    await expect.poll(() => breakpointLines(page)).toEqual([])
  })

  test('the "Line N" of a problem takes the cursor to that line of code', async ({ page }) => {
    await openStepper(page, '?example=hello-world')
    // An unknown instruction on the last line, far below the first lines.
    await codeEditor(page).focus()
    await page.keyboard.press(`${MOD}+End`)
    await page.keyboard.type('\n    mvo rax, 1')
    await expect(stepperPage(page)).not.toHaveAttribute('data-edit-pending', 'true')
    await page.locator('.cm-scroller').evaluate((scroller) => scroller.scrollTo(0, 0))
    await page.locator('h1').click()

    await stepperPage(page)
      .locator('[data-problems]')
      .getByRole('button', { name: 'Line 20', exact: true })
      .click()
    await expect(codeEditor(page)).toBeFocused()
    // The message of the line opens under it.
    await expect(page.locator('.cm-tooltip .cm-ss-message')).toContainText('Line 20')
    const line = page.locator('.cm-line', { hasText: 'mvo rax, 1' })
    await expect(line).toBeInViewport()
  })

  test('pasted curly quotes and special spaces are explained and shown; typed quotes are plain', async ({
    page,
  }) => {
    await openStepper(page, '?example=hello-world')
    const nbsp = String.fromCharCode(0xa0)
    const pasted = [
      '    .intel_syntax noprefix',
      'main:',
      `    mov${nbsp}${nbsp}rax, 5`,
      '    ret',
      'msg:',
      `    .string ${String.fromCharCode(0x201c)}Hi${String.fromCharCode(0x201d)}`,
      '',
    ].join('\n')
    await codeEditor(page).focus()
    await page.keyboard.press(`${MOD}+a`)
    await pasteIntoEditor(page, pasted)
    await expect(stepperPage(page)).not.toHaveAttribute('data-edit-pending', 'true')

    // The curly quote is an error on line 6 that can be read under the code; Step waits.
    const problems = stepperPage(page).locator('[data-problems]')
    await expect(problems.getByRole('button', { name: 'Line 6', exact: true })).toBeVisible()
    await expect(page.locator('.cm-gutters [aria-label="Error on line 6"]')).toHaveCount(1)
    await expect(control(page, 'Step')).toBeDisabled()
    // The special spaces of line 3 are a note, and each one shows as a visible mark.
    await expect(problems.getByRole('button', { name: 'Line 3', exact: true })).toBeAttached()
    await expect(page.locator('.cm-ss-odd-space')).toHaveCount(2)

    // Typing the quotes again (as a phone keyboard would: curly ones) fixes the line.
    await cursorToEndOf(page, '.string')
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    await page.keyboard.type(
      `.string ${String.fromCharCode(0x201c)}Hi${String.fromCharCode(0x201d)}`,
    )
    await expect(codeEditor(page)).toContainText('.string "Hi"')
    await expect(stepperPage(page)).not.toHaveAttribute('data-edit-pending', 'true')
    await expect(control(page, 'Step')).toBeEnabled()
  })

  test('the editor keeps its height when problems appear (they are listed in the Explanation)', async ({
    page,
  }) => {
    await openStepper(page, '?example=hello-world')
    const height = async () => (await codeEditor(page).locator('..').boundingBox())?.height ?? 0
    await expect.poll(height).toBeGreaterThan(150)
    const before = await height()
    await setCode(page, 'main:\n    mov [rax], [rbx]\n    push 5, 6\n    ret\n')
    await expect(explanation(page).locator('[data-problems]')).toBeVisible()
    expect(Math.abs((await height()) - before)).toBeLessThanOrEqual(1)
    // Fixed again: the list goes away, and the editor still keeps its height.
    await setCode(page, 'main:\n    mov rax, rbx\n    ret\n')
    await expect(explanation(page).getByText(/Fix th/)).toHaveCount(0)
    expect(Math.abs((await height()) - before)).toBeLessThanOrEqual(1)
  })

  test('Ctrl/Cmd + Enter keeps the keyboard focus in the editor; Esc then Tab leaves it', async ({
    page,
  }) => {
    await setUpMovProgram(page)
    await codeEditor(page).focus()
    await page.keyboard.press(`${MOD}+Enter`)
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(stepperPage(page)).toHaveAttribute('data-steps', '2')
    await expect(codeEditor(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Tab')
    // The next stop after the editor: the Step button.
    await expect(control(page, 'Step')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(stepperPage(page)).toHaveAttribute('data-steps', '3')
  })
})

test.describe('back, links, reload and storage', () => {
  test('Back goes all the way to the start', async ({ page }) => {
    await openStepper(page, '?example=hello-world')
    await pressStep(page, 7)
    const back = control(page, 'Back')
    for (let i = 0; i < 20 && (await back.isEnabled()); i++) await back.click()
    expect(await stepCount(page)).toBe(0)
    await expectStatus(page, 'ready')
    await expect.poll(() => markedCurrentLine(page)).toBe(11)
    expect(await outputText(page)).toBe('')
  })

  test('a practice link applies its starting state and note; an edit makes it your own', async ({
    page,
  }) => {
    const code = [
      '    .intel_syntax noprefix',
      'main:',
      '    mov     rax, qword ptr [rsp+8]   # the box above the top of the stack',
      '    add     rax, rbx',
      '    ret',
      '',
    ].join('\n')
    const route = stepperRoute({
      code,
      options: {
        initialRegisters: { rbx: 0x10n },
        initialRsp: 0x7ffffffddfe0n,
        initialMemory: [{ address: 0x7ffffffddfe8n, bytes: 8, value: 0x2an, label: 'x' }],
      },
      note: 'This is the problem you just tried.',
    })
    await page.goto(`/#${route}`)
    await expect(codeEditor(page)).toBeVisible()
    await expect(stepperPage(page).getByText('This is the problem you just tried.')).toBeVisible()
    expect(await registerValue(page, 'rbx')).toBe('0x0000000000000010')
    expect(await registerValue(page, 'rsp')).toBe('0x00007ffffffddfe0')
    await pressStep(page, 2)
    expect(await registerValue(page, 'rax')).toBe('0x000000000000003a')

    // The first edit: the address no longer holds the link, and nothing starts again.
    await cursorToEndOf(page, 'add     rax, rbx')
    await page.keyboard.type('   # mine now')
    await expect(page).toHaveURL(/#\/stepper$/)
    await expect(codeEditor(page)).toBeFocused()
    await expect(stepperPage(page)).not.toHaveAttribute('data-edit-pending', 'true')

    // A reload brings back the edited program with the same starting state.
    await page.reload()
    await expect(codeEditor(page)).toContainText('# mine now')
    await pressStep(page, 2)
    expect(await registerValue(page, 'rax')).toBe('0x000000000000003a')
  })

  test('a reload brings back the last program, also right after typing', async ({ page }) => {
    await openStepper(page)
    await setCode(page, 'main:\n    mov rax, 3\n    ret\n')
    await codeEditor(page).focus()
    await page.keyboard.press(`${MOD}+End`)
    await page.keyboard.type('# the last keys before the reload')
    await page.reload()
    await expect(codeEditor(page)).toContainText('# the last keys before the reload')
  })

  test('the page works when the browser blocks storage, and says that it cannot save', async ({
    page,
  }) => {
    await blockStorage(page)
    await openStepper(page)
    await expect(codeEditor(page)).toContainText('Hello World')
    await expect(stepperPage(page).locator('[data-cannot-save]')).toContainText(
      'does not let Stack Step save your program',
    )
    await pressStep(page, 2)
    expect(await stepCount(page)).toBe(2)
    await setCode(page, 'main:\n    mov rax, 9\n    ret\n')
    await pressStep(page)
    expect(await registerValue(page, 'rax')).toBe('0x0000000000000009')
  })
})

test('phone: the scanf box and the last line of code are never under the bar', async ({ page }) => {
  test.skip(!isPhone(page), 'The bar belongs to the narrow layout.')
  await openStepper(page, '?example=read-number')
  await stepToTheEnd(page)
  await expectStatus(page, 'waiting')
  const bar = await stepperPage(page).locator('[data-stepper-bar]').boundingBox()
  const input = stepperPage(page).getByRole('region', { name: 'Output' }).getByRole('textbox')
  await expect(input).toBeFocused()
  const box = await input.boundingBox()
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(bar?.y ?? 0)

  // Whatever the browser scrolls into view stops above the bar (and the page ends below it).
  const room = await page.evaluate(() => ({
    scroll: getComputedStyle(document.documentElement).scrollPaddingBottom,
    body: getComputedStyle(document.body).paddingBottom,
  }))
  const barHeight = `${Math.round(bar?.height ?? 0)}px`
  expect(room).toEqual({ scroll: barHeight, body: barHeight })

  // The editor's last line, scrolled into its view, is above the bar too.
  await page.locator('h1').click()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.locator('.cm-scroller').evaluate((scroller) => scroller.scrollTo(0, 1e6))
  const last = await page.locator('.cm-line').last().boundingBox()
  const barNow = await stepperPage(page).locator('[data-stepper-bar]').boundingBox()
  expect((last?.y ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual(barNow?.y ?? 0)
})

/** Select a whole line of code, line break included: a click at its start, a Shift+click below. */
async function selectWholeLine(page: Page, text: string): Promise<void> {
  const line = page.locator('.cm-line', { hasText: text }).first()
  const next = line.locator('xpath=following-sibling::div[contains(@class, "cm-line")][1]')
  await next.scrollIntoViewIfNeeded()
  // The start of the lines in sight, beside the gutter (scrolling may have moved the code
  // sideways, under the gutter).
  await page.locator('.cm-scroller').evaluate((scroller) => (scroller.scrollLeft = 0))
  const left = ((await page.locator('.cm-content').boundingBox())?.x ?? 0) + 3
  const from = await line.boundingBox()
  const to = await next.boundingBox()
  await page.mouse.click(left, (from?.y ?? 0) + 4)
  await page.keyboard.down('Shift')
  await page.mouse.click(left, (to?.y ?? 0) + 4)
  await page.keyboard.up('Shift')
}

/** Open the stepper with MOV_PROGRAM in the editor. */
async function setUpMovProgram(page: Page): Promise<void> {
  await openStepper(page, '?example=hello-world')
  await setCode(page, MOV_PROGRAM)
  await expectStatus(page, 'ready')
}

/* ─────────────── What the design, accessibility and code reviews asked for ─────────────── */

test.describe('layout on small and short screens', () => {
  test('phone: the tabs and panels under the explanation do not move from step to step', async ({
    page,
  }) => {
    test.skip(!isPhone(page), 'The tabs belong to the narrow layout.')
    await openStepper(page, '?example=push-pop')
    const tablist = stepperPage(page).getByRole('tablist')
    // At the top of the page, the code, the explanation and the tabs are all in sight.
    await expect(tablist).toBeInViewport({ ratio: 1 })
    await expect(explanation(page)).toBeInViewport({ ratio: 1 })
    // A touch screen has no Ctrl or Alt key: no Keys button there.
    await expect(
      stepperPage(page).getByRole('button', { name: 'Keys (keyboard shortcuts)' }),
    ).toBeHidden()
    const first = await pageTop(tablist)
    for (let i = 0; i < 10; i++) {
      await pressStep(page)
      expect(await pageTop(tablist), `after step ${i + 1}`).toBe(first)
    }
  })

  test('phone: the Step button stays in one place, also at the end of the page', async ({
    page,
  }) => {
    test.skip(!isPhone(page), 'The bar belongs to the narrow layout.')
    await openStepper(page, '?example=push-pop')
    await showTab(page, 'Stack')
    const toEnd = () =>
      page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const step = control(page, 'Step')
    await toEnd()
    const first = await step.boundingBox()
    for (let i = 0; i < 5; i++) {
      await step.click()
      await toEnd()
      expect(await step.boundingBox()).toEqual(first)
    }
    // At the very end of the page, the footer is above the bar, not under it.
    const footer = await page.locator('footer').boundingBox()
    const bar = await controlBar(page).boundingBox()
    expect((footer?.y ?? 0) + (footer?.height ?? 0)).toBeLessThanOrEqual((bar?.y ?? 0) + 1)
  })

  for (const size of [
    { name: 'a phone held sideways', width: 740, height: 360 },
    { name: '200 % zoom', width: 640, height: 400 },
  ]) {
    test(`${size.name}: the line that runs next is always above the bar`, async ({ page }) => {
      test.skip(!isPhone(page), 'The bar belongs to the narrow layout.')
      await page.setViewportSize({ width: size.width, height: size.height })
      await openStepper(page, '?example=sum-loop')
      const barTop = (await controlBar(page).boundingBox())?.y ?? 0
      for (let i = 0; i < 8; i++) {
        await pressStep(page)
        // The editor scrolls the line into sight on its next frame.
        await expect
          .poll(
            async () => {
              const line = await page.locator('.cm-ss-line-current').boundingBox()
              return line !== null && line.y >= 0 && line.y + line.height <= barTop + 1
            },
            `step ${i + 1}: the line that runs next is above the bar`,
          )
          .toBe(true)
      }
    })
  }

  test('a short screen with the keyboard open: the bar slides away while you type', async ({
    page,
  }) => {
    test.skip(!isPhone(page), 'The bar belongs to the narrow layout.')
    // A 740 px phone whose on-screen keyboard leaves 400 px.
    await page.setViewportSize({ width: 360, height: 400 })
    await openStepper(page, '?example=hello-world')
    const bar = controlBar(page)
    await codeEditor(page).click()
    await expect(bar).toHaveAttribute('data-tucked', 'true')
    await expect(bar).not.toBeInViewport()
    // Done typing: the bar comes back.
    await page.locator('h1').click()
    await expect(bar).not.toHaveAttribute('data-tucked', 'true')
    await expect(control(page, 'Step')).toBeInViewport()
  })

  test('1024×768: the explanation shows each whole step (steps without a tip)', async ({
    page,
  }) => {
    test.skip(isPhone(page), 'The wide layout.')
    await page.setViewportSize({ width: 1024, height: 768 })
    await openStepper(page, '?example=push-pop')
    const text = explanation(page).locator('[data-explanation-text]')
    for (let i = 0; i < 14; i++) {
      await pressStep(page)
      const hidden = await text.evaluate((box) => box.scrollHeight - box.clientHeight)
      expect(hidden, `step ${i + 1}`).toBeLessThanOrEqual(4)
    }
  })

  test('a Chromebook screen (1366×655): everything is on the screen without scrolling', async ({
    page,
  }) => {
    test.skip(isPhone(page), 'The wide layout.')
    await page.setViewportSize({ width: 1366, height: 655 })
    await openStepper(page, '?example=hello-world')
    // Long lines wrap on a wide screen, so the teaching comments are never cut off.
    await expect(page.locator('.cm-content')).toHaveClass(/cm-lineWrapping/)
    await pressStep(page, 5)
    for (const locator of [
      stepperPage(page).locator('.cm-editor'),
      control(page, 'Step'),
      explanation(page),
      stepperPage(page).locator('[data-next-line]'),
      await registerRow(page, 'r15'),
      stepperPage(page).locator('[data-register="rip"]'),
      stepperPage(page).getByRole('region', { name: 'Flags' }),
      await rspBox(page),
    ]) {
      await expect(locator).toBeInViewport({ ratio: 1 })
    }
  })

  test('waiting for input (desktop): the question and the input box are both in sight', async ({
    page,
  }) => {
    test.skip(isPhone(page), 'The wide layout.')
    await openStepper(page, '?example=read-number')
    await stepToTheEnd(page)
    await expectStatus(page, 'waiting')
    const output = stepperPage(page).getByRole('region', { name: 'Output' })
    await expect(output.locator('[data-output]')).toBeInViewport({ ratio: 1 })
    await expect(await inputBox(page)).toBeInViewport({ ratio: 1 })
  })
})

test.describe('protecting the student', () => {
  test('choosing an example keeps your own program: the menu brings it back, also after a reload', async ({
    page,
  }) => {
    await openStepper(page, '?example=hello-world')
    await setCode(page, 'main:\n    mov rax, 0x77   # my homework\n    ret\n')
    const menu = stepperPage(page).getByLabel('Example', { exact: true })
    await expect(menu).toHaveValue('own')
    await chooseExample(page, 'Factorial (loop)')
    await expect(codeEditor(page)).toContainText('# Factorial with a loop')
    await expect(explanation(page)).toContainText('Your own program is kept')

    await page.reload()
    await expect(codeEditor(page)).toContainText('# Factorial with a loop')
    await menu.selectOption({ label: 'Your own program' })
    await expect(codeEditor(page)).toContainText('# my homework')
    await expect(menu).toHaveValue('own')
    await pressStep(page)
    expect(await registerValue(page, 'rax')).toBe('0x0000000000000077')
  })

  test('typing while Run is on pauses Run at once; then the new program starts', async ({
    page,
  }) => {
    await openStepper(page, '?example=sum-loop')
    await setRunSpeed(page, 5)
    await control(page, 'Run').click()
    await expectStatus(page, 'running')
    await cursorToEndOf(page, 'loop_start:')
    await page.keyboard.press('Enter')
    await expect(stepperPage(page)).not.toHaveAttribute('data-status', 'running')
    const steps = await stepCount(page)
    await page.keyboard.type('nop', { delay: 60 })
    expect(await stepCount(page), 'the old program did not go on').toBeLessThanOrEqual(steps)
    await expect(stepperPage(page)).not.toHaveAttribute('data-edit-pending', 'true')
    expect(await stepCount(page)).toBe(0)
    await expect(explanation(page)).toContainText('You changed the code')
  })

  test('Reset can be undone', async ({ page }) => {
    await openStepper(page, '?example=hello-world')
    await pressStep(page, 4)
    await control(page, 'Reset').click()
    await expect(stepperPage(page)).toHaveAttribute('data-steps', '0')
    await explanation(page).getByRole('button', { name: 'Undo: back to step 4' }).click()
    await expect(stepperPage(page)).toHaveAttribute('data-steps', '4')
    await expect.poll(() => markedCurrentLine(page)).toBe(15)
  })

  test('a typo in the scanf input can be typed again after Back', async ({ page }) => {
    await openStepper(page, '?example=read-number')
    await stepToTheEnd(page)
    let input = await inputBox(page)
    await input.fill('abc')
    await input.press('Enter')
    await expect(explanation(page)).toContainText('Press Back to type it again.')
    await control(page, 'Back').click()
    await pressStep(page)
    await expectStatus(page, 'waiting')
    input = await inputBox(page)
    await input.fill('41')
    await input.press('Enter')
    await stepToTheEnd(page)
    expect(await outputText(page)).toBe('Type a number: 41 plus 1 is 42.\n')
  })
})

test.describe('keyboard and focus', () => {
  test('the focus stays on Step at the end, goes to Step after Reset, stays on Back at the start', async ({
    page,
  }) => {
    await openStepper(page, '?example=hello-world')
    await control(page, 'Step').focus()
    for (let i = 0; i < 12; i++) await page.keyboard.press('Enter')
    await expectStatus(page, 'ended')
    await expect(control(page, 'Step')).toBeFocused()

    await control(page, 'Reset').focus()
    await page.keyboard.press('Enter')
    await expectStatus(page, 'ready')
    await expect(control(page, 'Step')).toBeFocused()

    await page.keyboard.press('Enter')
    await control(page, 'Back').focus()
    await page.keyboard.press('Enter')
    await expect(stepperPage(page)).toHaveAttribute('data-steps', '0')
    await expect(control(page, 'Back')).toBeFocused()
  })

  test('sending the scanf input with Enter moves the focus to Step', async ({ page }) => {
    await openStepper(page, '?example=read-number')
    await stepToTheEnd(page)
    const input = await inputBox(page)
    await expect(input).toBeFocused()
    await input.fill('41')
    await input.press('Enter')
    await expect(control(page, 'Step')).toBeFocused()
  })

  test('R runs and pauses, 0 resets; Ctrl/Cmd + Alt + Enter runs, also in the editor', async ({
    page,
  }) => {
    await openStepper(page, '?example=sum-loop')
    await setRunSpeed(page, 1)
    await page.locator('h1').click()
    await page.keyboard.press('r')
    await expectStatus(page, 'running')
    await page.keyboard.press('r')
    await expectStatus(page, 'paused')
    await page.keyboard.press('0')
    await expectStatus(page, 'ready')
    await expect(
      explanation(page).getByRole('button', { name: /^Undo: back to step/ }),
    ).toBeVisible()

    await codeEditor(page).click()
    const before = await codeEditor(page).textContent()
    await page.keyboard.press(`${MOD}+Alt+Enter`)
    await expectStatus(page, 'running')
    await page.keyboard.press(`${MOD}+Alt+Enter`)
    await expectStatus(page, 'paused')
    expect(await codeEditor(page).textContent()).toBe(before)
  })

  test('the single keys can be switched off in the Keys panel, and the choice is kept', async ({
    page,
  }) => {
    test.skip(isPhone(page), 'A touch screen has no Keys button.')
    await openStepper(page, '?example=hello-world')
    await stepperPage(page).getByRole('button', { name: 'Keys (keyboard shortcuts)' }).click()
    await page.getByLabel('Use the single keys (S, B, R, 0)').uncheck()
    await page.keyboard.press('Escape')
    await page.locator('h1').click()
    await page.keyboard.press('s')
    await page.keyboard.press(`${MOD}+Enter`)
    // Only Ctrl/Cmd + Enter stepped.
    await expect(stepperPage(page)).toHaveAttribute('data-steps', '1')

    await page.reload()
    await expect(codeEditor(page)).toBeVisible()
    await page.locator('h1').click()
    await page.keyboard.press('s')
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(stepperPage(page)).toHaveAttribute('data-steps', '1')
  })

  test('the editor says on the screen how to leave it, when the keyboard brought the focus in', async ({
    page,
  }) => {
    test.skip(isPhone(page), 'The hint is for keyboard users.')
    await openStepper(page, '?example=hello-world')
    await stepperPage(page).getByRole('button', { name: 'Keys (keyboard shortcuts)' }).focus()
    await page.keyboard.press('Tab')
    await expect(codeEditor(page)).toBeFocused()
    const hint = page.getByText('Esc, then Tab: leave the code')
    await expect(hint).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await expect(hint).toHaveCount(0)
  })
})

test.describe('what the code shows', () => {
  test('the line that just ran is marked apart from the line that runs next', async ({ page }) => {
    await openStepper(page, '?example=hello-world')
    await pressStep(page)
    await expect(page.locator('.cm-gutters [aria-label="Line 11 just ran"]')).toHaveCount(1)
    await expect.poll(() => markedCurrentLine(page)).toBe(12)
    const heading = explanation(page).locator('[data-step-heading]')
    await expect(heading).toHaveText('Step 1 · ran line 11')
    await heading.getByRole('button', { name: 'line 11' }).click()
    await expect(page.locator('.cm-line', { hasText: 'push    rbp' }).first()).toBeInViewport()
  })

  test('a run-time error is marked on its line, and says what to do next', async ({ page }) => {
    await openStepper(page, '?example=hello-world')
    await setCode(page, '    .intel_syntax noprefix\nmain:\n    push 5\n    ret\n')
    await pressStep(page, 2)
    await expectStatus(page, 'error')
    await expect(page.locator('.cm-gutters [aria-label="Error on line 4"]')).toHaveCount(1)
    await expect(page.locator('.cm-ss-line-stopped')).toContainText('ret')
    await expect(explanation(page)).toContainText('Press Back to go one step back')
    await explanation(page).getByRole('button', { name: 'Line 4', exact: true }).click()
    await control(page, 'Back').click()
    await expectStatus(page, 'paused')
    await expect(page.locator('.cm-ss-line-stopped')).toHaveCount(0)
  })

  test('after printf, the registers it left junk in say "junk"; only rax and rsp changed', async ({
    page,
  }) => {
    await openStepper(page, '?example=hello-world')
    await pressStep(page, 6)
    const rcx = await registerRow(page, 'rcx')
    await expect(rcx).toHaveAttribute('data-junk', 'true')
    await expect(rcx).toContainText('junk')
    await expect(rcx.getByRole('button')).toHaveAccessibleName(/, junk from the library call$/)
    await expect(stepperPage(page).locator('[data-register][data-changed="true"]')).toHaveCount(2)
  })

  test('leftover boxes below rsp are drawn at full strength, so they can be read', async ({
    page,
  }) => {
    await setUpMovProgram(page)
    await pressStep(page, 4) // after pop rbx
    await showTab(page, 'Stack')
    const leftover = stepperPage(page).locator('[data-stack-box="0x7ffffffddff0"]')
    await expect(leftover).toContainText('leftover')
    const opacity = await leftover.evaluate((box) =>
      Math.min(
        ...[box, ...box.querySelectorAll('*')].map((el) => Number(getComputedStyle(el).opacity)),
      ),
    )
    expect(opacity).toBe(1)
  })

  test('switching a breakpoint does not replay the "changed" flash or the slide-in', async ({
    page,
  }) => {
    await setUpMovProgram(page)
    await pressStep(page, 3) // push rax
    const box = await rspBox(page)
    await box.locator('.animate-slide-in').evaluate((el) => el.setAttribute('data-seen', 'yes'))
    await lineNumberCell(page, 8).click()
    await expect.poll(() => breakpointLines(page)).toEqual([8])
    await expect(box.locator('.animate-slide-in[data-seen="yes"]')).toHaveCount(1)
  })

  test('a very deep stack (sub rsp, 0x80000) stays a short list', async ({ page }) => {
    await openStepper(page, '?example=hello-world')
    await setCode(
      page,
      '    .intel_syntax noprefix\nmain:\n    sub rsp, 0x80000\n    push 7\n    add rsp, 0x80008\n    ret\n',
    )
    await pressStep(page, 2)
    await showTab(page, 'Stack')
    expect(
      await stepperPage(page).locator('[data-stack-box], [data-stack-gap]').count(),
    ).toBeLessThan(40)
    await expect(stepperPage(page).getByText(/^65,53\d more boxes, not set yet$/)).toBeVisible()
    await expect(await rspBox(page)).toContainText('0007')
  })

  test('a breakpoint on a label goes on the next line that has an instruction', async ({
    page,
  }) => {
    await openStepper(page, '?example=sum-loop')
    const label = lineOf('sum-loop', 'loop_start:')
    await (await visibleLineNumberCell(page, label)).click()
    await expect.poll(() => breakpointLines(page)).toEqual([label + 1])
    await setRunSpeed(page, 10)
    await control(page, 'Run').click()
    await expect(statusLine(page)).toContainText(`Paused at line ${label + 1} (breakpoint)`)
  })

  test('a breakpoint on a line with no instruction after it says that it is never reached', async ({
    page,
  }) => {
    await openStepper(page, '?example=hello-world')
    await setCode(page, 'main:\n    mov rax, 1\n    ret\n# the end of my program\n')
    await (await visibleLineNumberCell(page, 4)).click()
    await expect.poll(() => breakpointLines(page)).toEqual([4])
    await expect(explanation(page).locator('[data-problems]')).toContainText(
      'Line 4: this line has no instruction, so the program never stops at its breakpoint.',
    )
  })

  test('Run that goes on after the scanf input stops at a breakpoint on the next line', async ({
    page,
  }) => {
    await openStepper(page, '?example=read-number')
    const after = lineOf('read-number', 'mov     esi, number[rbp]')
    await (await visibleLineNumberCell(page, after)).click()
    await setRunSpeed(page, 9)
    await control(page, 'Run').click()
    await expectStatus(page, 'waiting')
    const input = await inputBox(page)
    await input.fill('41')
    await input.press('Enter')
    await expect(statusLine(page)).toContainText(`Paused at line ${after} (breakpoint)`)
    expect(await outputText(page)).toBe('Type a number: ')
  })
})

test.describe('links and robustness', () => {
  test('a very long note in a link is cut, and the code stays on the screen', async ({ page }) => {
    const route = stepperRoute({
      code: 'main:\n    mov rax, 1\n    ret\n',
      note: 'Watch rax. '.repeat(500),
    })
    await page.goto(`/#${route}`)
    await expect(codeEditor(page)).toBeVisible()
    const note = stepperPage(page).getByText(/^Watch rax\./)
    expect(((await note.textContent()) ?? '').length).toBeLessThanOrEqual(300)
    await expect(codeEditor(page)).toBeInViewport()
  })

  test('Share refuses a program that is too long for a link, and says so', async ({ page }) => {
    await fakeClipboard(page)
    await openStepper(page, '?example=hello-world')
    const comment = `# ${'a long comment '.repeat(5)}\n`
    await setCode(page, `main:\n    ret\n${comment.repeat(1200)}`)
    await stepperPage(page).getByRole('button', { name: 'Share', exact: true }).click()
    await expect(
      stepperPage(page).getByRole('status').filter({ hasText: 'too long to share as a link' }),
    ).toHaveCount(1)
    expect(await copiedText(page)).toBeUndefined()
  })

  test('if the editor cannot load, a plain text box takes its place and the page works', async ({
    page,
  }) => {
    await page.route(/CodeEditor/, (route) => route.abort())
    await page.goto('/#/stepper?example=hello-world')
    const box = stepperPage(page).locator('[data-plain-editor] textarea')
    await expect(box).toBeVisible()
    await expect(box).toHaveAccessibleName('Assembly code')
    await box.fill('main:\n    mov rax, 4\n    ret\n')
    await expect(stepperPage(page)).not.toHaveAttribute('data-edit-pending', 'true')
    await pressStep(page)
    expect(await registerValue(page, 'rax')).toBe('0x0000000000000004')
    // The failed download is reported in the console: expected here.
    errors = errors.filter(
      (text) => !/CodeEditor|code editor|Failed to fetch|Failed to load/i.test(text),
    )
  })
})

/* ───────────────────────────── What the M8 audits asked for ───────────────────────────── */

/** The program a student wrote before following a link (their homework). */
const HOMEWORK = 'main:\n    mov rax, 0x77   # my homework\n    ret\n'

/** The box of an element on the screen; fails the test when it is not drawn. */
async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox()
  expect(box, 'the element is drawn').not.toBeNull()
  return box ?? { x: 0, y: 0, width: 0, height: 0 }
}

/** Make the tutor look switched on (the static site has no tutor function). */
async function tutorOn(page: Page): Promise<void> {
  await page.route('**/api/tutor', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":true}' }),
  )
}

test.describe('a practice problem opened with "Show me"', () => {
  test('shows its whole note, and no notes about whole programs', async ({ page }) => {
    const problem = makeProblem('call-ret', 1)
    const note = problem.stepper.note ?? ''
    expect(note).not.toBe('')
    await page.goto(`/#${stepperRoute(problem.stepper)}`)
    await expect(codeEditor(page)).toBeVisible()
    const box = stepperPage(page).locator('[data-link-note]')
    await expect(box).toContainText(note.replaceAll('`', ''))
    // Its code is shown exactly as the problem wrote it, without `main:` or `.intel_syntax`:
    // the notes about that are noise here.
    await expect(explanation(page).locator('[data-problems]')).toHaveCount(0)
    await expect(stepperPage(page).getByLabel('Example', { exact: true })).toHaveValue('link')

    const sizes = isPhone(page)
      ? [null]
      : [
          { width: 1280, height: 800 },
          { width: 1440, height: 900 },
          { width: 1366, height: 655 },
          { width: 1024, height: 768 },
        ]
    for (const size of sizes) {
      if (size !== null) await page.setViewportSize(size)
      const where = size === null ? 'phone' : `${size.width}×${size.height}`
      // The whole note is in sight: the box is as tall as its text, nothing scrolls.
      await expect
        .poll(() => box.evaluate((el) => el.scrollHeight - el.clientHeight), where)
        .toBeLessThanOrEqual(1)
      // The editor keeps at least its 9 lines on a wide screen, and is on the screen.
      if (size !== null) {
        expect((await boxOf(codeEditor(page).locator('..'))).height, where).toBeGreaterThan(130)
        await expect(codeEditor(page)).toBeInViewport()
        await expect(control(page, 'Step')).toBeInViewport()
      }
    }
  })
})

test.describe("the student's own program is never lost", () => {
  test('editing a lesson example opened in the stepper keeps the earlier program; the menu brings it back', async ({
    page,
  }) => {
    await openStepper(page, '?example=hello-world')
    await setCode(page, HOMEWORK)
    await page.goto('/#/learn/stack-and-rsp')
    await page
      .locator('[data-ministepper]')
      .first()
      .getByRole('link', { name: /Open in the stepper/ })
      .click()
    await expect(codeEditor(page)).toBeVisible()
    const menu = stepperPage(page).getByLabel('Example', { exact: true })
    await expect(menu).toHaveValue('link')
    await expect(menu.locator('option', { hasText: 'Program from the link' })).toHaveCount(1)

    // The first edit makes the lesson's program the student's; their homework goes aside.
    await codeEditor(page).click()
    await page.keyboard.press(`${MOD}+End`)
    await page.keyboard.type('\n    nop   # trying something')
    await expect(stepperPage(page)).not.toHaveAttribute('data-edit-pending', 'true')
    await expect(explanation(page)).toContainText('Your earlier program is kept')
    // It goes away once the student moves on.
    await pressStep(page)
    await expect(explanation(page)).not.toContainText('Your earlier program is kept')

    // After a reload (the edited lesson program is the last one), the homework comes back.
    await page.reload()
    await expect(codeEditor(page)).toContainText('# trying something')
    await menu.selectOption({ label: 'Your earlier program' })
    await expect(codeEditor(page)).toContainText('# my homework')
    await pressStep(page)
    expect(await registerValue(page, 'rax')).toBe('0x0000000000000077')
    // The two changed places: the edited lesson program is the earlier one now.
    await menu.selectOption({ label: 'Your earlier program' })
    await expect(codeEditor(page)).toContainText('# trying something')
  })

  test('a link opened by mistake: "Your own program" brings the program back at once', async ({
    page,
  }) => {
    await openStepper(page, '?example=hello-world')
    await setCode(page, HOMEWORK)
    await page.goto(`/#${stepperRoute({ code: 'main:\n    mov rbx, 1\n    ret\n' })}`)
    await expect(codeEditor(page)).toContainText('mov rbx, 1')
    await stepperPage(page)
      .getByLabel('Example', { exact: true })
      .selectOption({ label: 'Your own program' })
    await expect(codeEditor(page)).toContainText('# my homework')
    await expect(page).toHaveURL(/#\/stepper$/)
  })

  test('says so when the browser cannot save the program any more (a full disk)', async ({
    page,
  }) => {
    // A full disk: saving starts to fail after the page is open.
    await page.addInitScript(() => {
      const store = window as unknown as { __storageFull?: boolean }
      const setItem = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')?.value as (
        this: Storage,
        key: string,
        value: string,
      ) => void
      Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
        if (store.__storageFull === true) throw new DOMException('Full', 'QuotaExceededError')
        setItem.call(this, key, value)
      }
    })
    await openStepper(page, '?example=hello-world')
    const notice = stepperPage(page).locator('[data-cannot-save]')
    await expect(notice).toHaveCount(0)
    await page.evaluate(() => {
      ;(window as unknown as { __storageFull?: boolean }).__storageFull = true
    })
    await setCode(page, HOMEWORK)
    await expect(notice).toContainText(
      'This browser does not let Stack Step save your program. Copy it before you close or reload this page.',
    )
    await expect(notice).toBeInViewport()
  })
})

test.describe('boxes that scroll', () => {
  test('while scanf waits (desktop), the Data card that hides items is a Tab stop', async ({
    page,
  }) => {
    test.skip(isPhone(page), 'The cards scroll only on a wide screen.')
    await openStepper(page, '?example=read-number')
    await stepToTheEnd(page)
    await expectStatus(page, 'waiting')
    const data = stepperPage(page).getByRole('group', { name: 'Data (scrolls)' })
    await expect(data).toHaveAttribute('tabindex', '0')
    await data.focus()
    await expect(data).toBeFocused()
    // The question and the whole input box are in sight.
    await expect(stepperPage(page).locator('[data-output]')).toBeInViewport({ ratio: 1 })
    await expect(await inputBox(page)).toBeInViewport({ ratio: 1 })
    await expect(stepperPage(page).getByRole('button', { name: 'Send' })).toBeInViewport({
      ratio: 1,
    })
  })

  test('a stack box opened at the bottom of the list shows its bytes', async ({ page }) => {
    await openStepper(page, '?example=hello-world')
    await setCode(page, `main:\n${'    push 7\n'.repeat(14)}    ret\n`)
    await pressStep(page, 14)
    const box = await rspBox(page)
    await box.getByRole('button').click()
    const bytes = box.locator('ol')
    await expect(bytes).toBeVisible()
    // The opened bytes are inside the part of the list that is in sight, and on the screen.
    await expect
      .poll(async () => {
        const list = await boxOf(box.locator('xpath=ancestor::ol[1]'))
        const shown = await boxOf(bytes)
        return shown.y + shown.height <= list.y + list.height + 1
      })
      .toBe(true)
    await expect(bytes).toBeInViewport({ ratio: 1 })
  })
})

test.describe('the button of the tutor covers nothing', () => {
  test('wide screen: the right column keeps room for it', async ({ page }) => {
    test.skip(isPhone(page), 'The wide layout.')
    await tutorOn(page)
    await openStepper(page, '?example=read-number')
    const launcher = page.locator('[data-tutor="button"]')
    await expect(launcher).toBeVisible()
    await stepToTheEnd(page)
    const button = await boxOf(launcher)
    for (const name of ['Stack', 'Output', 'Data']) {
      const card = await boxOf(stepperPage(page).getByRole('region', { name, exact: true }))
      const overlaps =
        card.x < button.x + button.width &&
        button.x < card.x + card.width &&
        card.y < button.y + button.height &&
        button.y < card.y + card.height
      expect(overlaps, `the button is not on the ${name} card`).toBe(false)
    }
  })

  test('phone: at the end of the page, the footer is above the button', async ({ page }) => {
    test.skip(!isPhone(page), 'The narrow layout.')
    await tutorOn(page)
    await openStepper(page, '?example=hello-world')
    const launcher = page.locator('[data-tutor="button"]')
    await expect(launcher).toBeVisible()
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await expect
      .poll(async () => {
        const footer = await boxOf(page.locator('footer'))
        const button = await boxOf(launcher)
        return footer.y + footer.height <= button.y + 1
      })
      .toBe(true)
  })
})

test.describe('the MiniStepper (demo page)', () => {
  test('phone: the explanation comes right after the buttons; the link is a 44 px target', async ({
    page,
  }) => {
    test.skip(!isPhone(page), 'The narrow layout.')
    await page.goto('/#/stepper?demo=ministepper')
    const mini = page.locator('[data-ministepper]').first()
    await mini.evaluate((element) => element.scrollIntoView({ block: 'start' }))
    await mini.getByRole('button', { name: 'Step', exact: true }).click()
    // The Step button and what it did are on the screen together.
    await expect(mini.getByRole('button', { name: 'Step', exact: true })).toBeInViewport({
      ratio: 1,
    })
    await expect(mini.locator('[data-step-heading]')).toBeInViewport({ ratio: 1 })
    const step = await boxOf(mini.getByRole('button', { name: 'Step', exact: true }))
    const heading = await boxOf(mini.locator('[data-step-heading]'))
    const registers = await boxOf(mini.locator('[data-register]').first())
    expect(heading.y).toBeGreaterThan(step.y)
    expect(heading.y).toBeLessThan(registers.y)
    const link = await boxOf(mini.getByRole('link', { name: /Open in the stepper/ }))
    expect(link.height).toBeGreaterThanOrEqual(44)
  })

  test('a code listing is a Tab stop only when it scrolls, and a swipe on it moves the page', async ({
    page,
  }) => {
    await page.goto('/#/stepper?demo=ministepper')
    await expect(page.locator('[data-code-listing]').first()).toBeVisible()
    const listings = await page.locator('[data-code-listing]').evaluateAll((boxes) =>
      boxes.map((box) => ({
        scrolls: box.scrollWidth > box.clientWidth + 4 || box.scrollHeight > box.clientHeight + 4,
        tabStop: box.getAttribute('tabindex') === '0',
      })),
    )
    expect(listings.length).toBeGreaterThan(1)
    for (const listing of listings) expect(listing.tabStop).toBe(listing.scrolls)

    if (!isPhone(page)) return
    // A vertical swipe that starts on a code box moves the page.
    const listing = page.locator('[data-ministepper] [data-code-listing]').nth(1)
    await listing.scrollIntoViewIfNeeded()
    await page.evaluate(() => window.scrollBy(0, -100))
    const box = await boxOf(listing)
    const before = await page.evaluate(() => window.scrollY)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.synthesizeScrollGesture', {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
      yDistance: -200,
      gestureSourceType: 'touch',
      speed: 800,
    })
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 50)
  })
})

test.describe('words on a phone are at least 14 px', () => {
  test('the step, the next line, the flags, the controls, rip', async ({ page }) => {
    test.skip(!isPhone(page), 'The phone sizes.')
    await openStepper(page, '?example=hello-world')
    await pressStep(page)
    const sizes = async (selector: string) =>
      stepperPage(page)
        .locator(selector)
        .evaluateAll((nodes) =>
          nodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
        )
    await showTab(page, 'Registers')
    for (const selector of [
      '[data-step-heading]',
      '[data-next-line]',
      '[data-next-line] code',
      '[data-flag] > span:last-of-type',
      '[data-register="rip"] > span:last-child',
      '[data-stepper-bar] button',
    ]) {
      const found = await sizes(selector)
      expect(found.length, selector).toBeGreaterThan(0)
      for (const size of found) expect(size, selector).toBeGreaterThanOrEqual(14)
    }
    // rip has all 16 digits, like every register.
    expect(await registerValue(page, 'rip')).toBe('0x0000000000401127')
    // The "line 11" of the step heading is a 44 px target to a finger: an invisible edge
    // around it (where a scrolling box ends, the box cuts it off, as it cuts its text).
    const line = explanation(page).locator('[data-step-heading] [data-line-button]')
    const target = await line.evaluate((button) => {
      const edge = getComputedStyle(button, '::after')
      const height = button.getBoundingClientRect().height
      return {
        position: edge.position,
        height: height - Number.parseFloat(edge.top) - Number.parseFloat(edge.bottom),
      }
    })
    expect(target.position).toBe('absolute')
    expect(target.height).toBeGreaterThanOrEqual(44)
    // Below the words (inside the box), a tap still hits it.
    const below = await line.evaluate((button) => {
      const box = button.getBoundingClientRect()
      return document.elementFromPoint(box.left + box.width / 2, box.bottom + 10) === button
    })
    expect(below).toBe(true)
  })
})

test('no WCAG 2.1 A/AA problem in the states this page fixed (practice note, scanf, Data)', async ({
  page,
}) => {
  const check = async (what: string) => {
    const results = await new AxeBuilder({ page })
      .include('[data-stepper-page]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`),
      what,
    ).toEqual([])
  }
  await page.goto(`/#${stepperRoute(makeProblem('rip', 1).stepper)}`)
  await expect(codeEditor(page)).toBeVisible()
  await check('a practice link')
  await openStepper(page, '?example=read-number')
  await stepToTheEnd(page)
  await expectStatus(page, 'waiting')
  await check('waiting for input')
})
