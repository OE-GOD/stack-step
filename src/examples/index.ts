/**
 * Ready-made programs for the stepper's Examples menu.
 *
 * They are also test fixtures: the emulator tests run every program to the end and
 * compare what it prints with `expectedOutput`.
 *
 * House style (the same style the lessons use):
 *   - Intel syntax as gcc writes it, 4-space indent, one short `#` comment per line
 *   - every function keeps the stack lined up to 16 bytes before a `call`
 *   - arguments go in rdi, rsi, rdx, rcx; `mov eax, 0` before printf/scanf
 *   - only caller-saved registers are used for scratch work
 */

export interface ExampleProgram {
  /** Stable id, used in links: #/stepper?example=<id> */
  id: string
  /** Short name shown in the menu. */
  title: string
  /** One plain sentence: what to watch for. */
  description: string
  source: string
  /** Exactly what the program prints when it runs to the end (given `stdin`). */
  expectedOutput: string
  /** What the student types when the program asks for input (scanf). */
  stdin?: string
}

const helloWorld = String.raw`# Hello World: print one line of text.
    .intel_syntax noprefix
    .text
    .globl  main
    .type   main, @function

message:
    .string "Hello World!\n"

main:
    push    rbp                  # save the caller's rbp
    mov     rbp, rsp             # rbp marks the start of our stack frame
    lea     rdi, message[rip]    # 1st argument: the address of the text
    mov     eax, 0               # printf rule: no floating-point arguments
    call    printf@PLT           # print the text
    mov     eax, 0               # main returns 0: everything went well
    pop     rbp                  # put the caller's rbp back
    ret                          # go back to the caller
`

const helloCount = String.raw`# printf returns how many characters it printed. The answer is in eax.
# This program prints a line, then prints that count.
    .intel_syntax noprefix
    .text
    .globl  main
    .type   main, @function

message:
    .string "Hello World!\n"
report:
    .string "printf printed %d characters.\n"

main:
    push    rbp
    mov     rbp, rsp

    lea     rdi, message[rip]    # 1st argument: the text
    mov     eax, 0
    call    printf@PLT           # after this call, eax = 13

    mov     esi, eax             # 2nd argument: the count from printf
    lea     rdi, report[rip]     # 1st argument: the text with %d in it
    mov     eax, 0
    call    printf@PLT

    mov     eax, 0
    pop     rbp
    ret
`

const pushPop = String.raw`# push and pop: the last value pushed is the first value popped.
# Part 1 pops in the SAME order as the pushes: the two values swap.
# Part 2 pops in REVERSE order: the values go back where they were.
    .intel_syntax noprefix
    .text
    .globl  main
    .type   main, @function

main:
    mov     rax, 1
    mov     rcx, 2

    # Part 1: swap
    push    rax                  # the stack holds 1
    push    rcx                  # the stack holds 1, then 2 on top
    pop     rax                  # rax = 2 (the top value)
    pop     rcx                  # rcx = 1

    # Part 2: save and restore
    push    rax                  # save rax (2)
    push    rcx                  # save rcx (1)
    mov     rax, 100             # use the registers for something else
    mov     rcx, 200
    pop     rcx                  # rcx = 1 again (reverse order)
    pop     rax                  # rax = 2 again

    mov     eax, 0
    ret
`

const locals = String.raw`# Local variables live on the stack, below rbp.
# .equ gives each offset a name, so count[rbp] means -8[rbp].
    .intel_syntax noprefix
    .text
    .globl  main
    .type   main, @function

    .equ    count, -8            # count is the box at rbp-8 (a 64-bit variable)
    .equ    total, -16           # total is the box at rbp-16

report:
    .string "count = %ld, total = %ld\n"

main:
    push    rbp
    mov     rbp, rsp
    sub     rsp, 16              # make room for 2 boxes (16 bytes)

    mov     qword ptr count[rbp], 5      # count = 5
    mov     qword ptr total[rbp], 100    # total = 100

    mov     rax, count[rbp]      # copy count into a register
    add     total[rbp], rax      # total = total + count

    mov     rdx, total[rbp]      # 3rd argument: total
    mov     rsi, count[rbp]      # 2nd argument: count
    lea     rdi, report[rip]     # 1st argument: the text (%ld = a 64-bit number)
    mov     eax, 0
    call    printf@PLT

    mov     eax, 0
    mov     rsp, rbp             # free the local variables
    pop     rbp
    ret
`

const sumLoop = String.raw`# Add the numbers from low to high: 1 + 2 + ... + 10 = 55.
    .intel_syntax noprefix
    .text
    .globl  main
    .type   main, @function

report:
    .string "The sum from %d to %d is %d.\n"

main:
    push    rbp
    mov     rbp, rsp

    mov     ecx, 1               # ecx = the current number (starts at low)
    mov     edx, 10              # edx = high
    mov     eax, 0               # eax = the sum so far

loop_start:
    cmp     ecx, edx             # compare the current number with high
    jg      loop_end             # bigger than high? then stop
    add     eax, ecx             # sum = sum + current number
    inc     ecx                  # go to the next number
    jmp     loop_start

loop_end:
    mov     ecx, eax             # 4th argument: the sum
    mov     esi, 1               # 2nd argument: low (3rd, high, is still in edx)
    lea     rdi, report[rip]     # 1st argument: the text
    mov     eax, 0
    call    printf@PLT

    mov     eax, 0
    pop     rbp
    ret
`

const factorial = String.raw`# Factorial with a loop: 5! = 5 * 4 * 3 * 2 * 1 = 120.
    .intel_syntax noprefix
    .text
    .globl  main
    .type   main, @function

report:
    .string "%d! = %d\n"

main:
    push    rbp
    mov     rbp, rsp

    mov     ecx, 5               # ecx = n, it counts down to 1
    mov     eax, 1               # eax = the answer so far

loop_start:
    cmp     ecx, 1
    jle     loop_end             # n is 1 or less? then stop
    imul    eax, ecx             # answer = answer * n
    dec     ecx                  # n = n - 1
    jmp     loop_start

loop_end:
    mov     edx, eax             # 3rd argument: the answer
    mov     esi, 5               # 2nd argument: 5, the n we started with
    lea     rdi, report[rip]     # 1st argument: the text
    mov     eax, 0
    call    printf@PLT

    mov     eax, 0
    pop     rbp
    ret
`

const power = String.raw`# Power with a loop: 2 to the power 10 = 1024.
    .intel_syntax noprefix
    .text
    .globl  main
    .type   main, @function

report:
    .string "%d to the power %d is %d.\n"

main:
    push    rbp
    mov     rbp, rsp

    mov     esi, 2               # esi = the base
    mov     edx, 10              # edx = the exponent
    mov     eax, 1               # eax = the answer so far
    mov     ecx, edx             # ecx = how many times we still multiply

loop_start:
    cmp     ecx, 0
    je      loop_end             # nothing left to multiply? then stop
    imul    eax, esi             # answer = answer * base
    dec     ecx
    jmp     loop_start

loop_end:
    mov     ecx, eax             # 4th argument: the answer
    lea     rdi, report[rip]     # 1st argument (2nd and 3rd are still in esi, edx)
    mov     eax, 0
    call    printf@PLT

    mov     eax, 0
    pop     rbp
    ret
`

const arrayMax = String.raw`# Find the biggest number in an array.
    .intel_syntax noprefix
    .data
numbers:
    .quad   12, 7, 41, 3, 25     # five numbers, 8 bytes each
    .equ    HOW_MANY, 5

    .text
    .globl  main
    .type   main, @function

report:
    .string "The biggest number is %ld.\n"

main:
    push    rbp
    mov     rbp, rsp

    lea     rdi, numbers[rip]    # rdi = the address of the first number
    mov     rax, [rdi]           # rax = the biggest so far (the first number)
    mov     ecx, 1               # ecx = how many numbers we have checked

loop_start:
    cmp     ecx, HOW_MANY
    jge     loop_end             # checked them all? then stop
    add     rdi, 8               # point at the next number
    mov     rdx, [rdi]           # rdx = that number
    cmp     rdx, rax
    jle     not_bigger           # not bigger? keep the old one
    mov     rax, rdx             # remember the new biggest number
not_bigger:
    inc     ecx
    jmp     loop_start

loop_end:
    mov     rsi, rax             # 2nd argument: the biggest number
    lea     rdi, report[rip]     # 1st argument: the text
    mov     eax, 0
    call    printf@PLT

    mov     eax, 0
    pop     rbp
    ret
`

const nestedCall = String.raw`# One function calls another: main -> show_double -> printf.
# Watch the stack: every call pushes a return address.
    .intel_syntax noprefix
    .text
    .globl  main
    .type   main, @function

report:
    .string "Double of %d is %d.\n"

# show_double(n) prints n and 2 times n. The value n arrives in edi.
show_double:
    push    rbp
    mov     rbp, rsp
    mov     esi, edi             # 2nd argument: n
    mov     edx, edi
    add     edx, edx             # 3rd argument: n + n
    lea     rdi, report[rip]     # 1st argument: the text
    mov     eax, 0
    call    printf@PLT
    pop     rbp
    ret                          # go back to main

main:
    push    rbp
    mov     rbp, rsp
    mov     edi, 21              # 1st argument for show_double
    call    show_double
    mov     eax, 0
    pop     rbp
    ret
`

const readNumber = String.raw`# Ask for a number with scanf, then print that number plus 1.
    .intel_syntax noprefix
    .text
    .globl  main
    .type   main, @function

    .equ    number, -8           # number is the box at rbp-8

question:
    .string "Type a number: "
pattern:
    .string "%d"
report:
    .string "%d plus 1 is %d.\n"

main:
    push    rbp
    mov     rbp, rsp
    sub     rsp, 16              # room for the local variable (a multiple of 16)

    lea     rdi, question[rip]
    mov     eax, 0
    call    printf@PLT           # show the question

    lea     rsi, number[rbp]     # 2nd argument: the ADDRESS where scanf stores the number
    lea     rdi, pattern[rip]    # 1st argument: the format "%d" (one whole number)
    mov     eax, 0
    call    scanf@PLT            # wait for the number

    mov     esi, number[rbp]     # 2nd argument: the number
    mov     edx, esi
    add     edx, 1               # 3rd argument: the number + 1
    lea     rdi, report[rip]
    mov     eax, 0
    call    printf@PLT

    mov     eax, 0
    mov     rsp, rbp             # free the local variable
    pop     rbp
    ret
`

export const EXAMPLES: readonly ExampleProgram[] = [
  {
    id: 'hello-world',
    title: 'Hello World',
    description: 'Print one line. Watch rdi get the address of the text before the call.',
    source: helloWorld,
    expectedOutput: 'Hello World!\n',
  },
  {
    id: 'hello-count',
    title: 'Hello World + character count',
    description: 'printf returns the number of characters it printed in eax.',
    source: helloCount,
    expectedOutput: 'Hello World!\nprintf printed 13 characters.\n',
  },
  {
    id: 'push-pop',
    title: 'push and pop: swap vs. restore',
    description: 'Pop in the same order to swap two values. Pop in reverse order to restore them.',
    source: pushPop,
    expectedOutput: '',
  },
  {
    id: 'locals',
    title: 'Local variables with .equ',
    description:
      'Two variables live in boxes below rbp. With .equ, count and total are names for their offsets.',
    source: locals,
    expectedOutput: 'count = 5, total = 105\n',
  },
  {
    id: 'sum-loop',
    title: 'Sum from low to high (loop)',
    description: 'A loop with cmp and a conditional jump adds 1 + 2 + ... + 10.',
    source: sumLoop,
    expectedOutput: 'The sum from 1 to 10 is 55.\n',
  },
  {
    id: 'factorial',
    title: 'Factorial (loop)',
    description: 'Multiply 5 * 4 * 3 * 2 with imul inside a loop.',
    source: factorial,
    expectedOutput: '5! = 120\n',
  },
  {
    id: 'power',
    title: 'Power (loop)',
    description: 'Multiply by the base again and again: 2 to the power 10.',
    source: power,
    expectedOutput: '2 to the power 10 is 1024.\n',
  },
  {
    id: 'array-max',
    title: 'Biggest number in an array',
    description: 'Walk through five numbers in memory with [rdi] and keep the biggest.',
    source: arrayMax,
    expectedOutput: 'The biggest number is 41.\n',
  },
  {
    id: 'nested-call',
    title: 'A call inside a call',
    description:
      'main calls show_double, which calls printf. While printf runs, three return addresses are on the stack: one for each call that has not returned yet.',
    source: nestedCall,
    expectedOutput: 'Double of 21 is 42.\n',
  },
  {
    id: 'read-number',
    title: 'Read a number (scanf)',
    description: 'scanf needs the ADDRESS of a variable, so the program uses lea.',
    source: readNumber,
    expectedOutput: 'Type a number: 41 plus 1 is 42.\n',
    stdin: '41\n',
  },
]

export function exampleById(id: string): ExampleProgram | undefined {
  return EXAMPLES.find((example) => example.id === id)
}
