import { describe, expect, it } from 'vitest'
import {
  ALL_REGISTER_NAMES,
  createRegisterFile,
  lookupRegister,
  mergeRegisterWrite,
  readRegister,
  reg,
  registerFamily,
  subRegister,
  writeRegister,
} from './registers'
import { REG64_NAMES, type Reg64 } from './types'

const START = 0x1111_2222_3333_4444n

/** Write `value` into the register named `name`, starting from `START` in its base. */
function writeOn(name: string, value: bigint): bigint {
  const file = createRegisterFile()
  const r = reg(name)
  file[r.base] = START
  return writeRegister(file, r, value)
}

describe('register table', () => {
  it('knows all 16 registers at 64 bits', () => {
    for (const name of REG64_NAMES) {
      const r = lookupRegister(name)
      expect(r, name).toBeDefined()
      expect(r?.size).toBe(64)
      expect(r?.base).toBe(name)
    }
  })

  it('has exactly 68 names (16×4 plus ah, bh, ch, dh)', () => {
    expect(ALL_REGISTER_NAMES).toHaveLength(68)
  })

  it.each([
    ['rax', ['rax', 'eax', 'ax', 'ah', 'al']],
    ['rbx', ['rbx', 'ebx', 'bx', 'bh', 'bl']],
    ['rcx', ['rcx', 'ecx', 'cx', 'ch', 'cl']],
    ['rdx', ['rdx', 'edx', 'dx', 'dh', 'dl']],
    ['rsi', ['rsi', 'esi', 'si', 'sil']],
    ['rdi', ['rdi', 'edi', 'di', 'dil']],
    ['rbp', ['rbp', 'ebp', 'bp', 'bpl']],
    ['rsp', ['rsp', 'esp', 'sp', 'spl']],
    ['r8', ['r8', 'r8d', 'r8w', 'r8b']],
    ['r9', ['r9', 'r9d', 'r9w', 'r9b']],
    ['r10', ['r10', 'r10d', 'r10w', 'r10b']],
    ['r11', ['r11', 'r11d', 'r11w', 'r11b']],
    ['r12', ['r12', 'r12d', 'r12w', 'r12b']],
    ['r13', ['r13', 'r13d', 'r13w', 'r13b']],
    ['r14', ['r14', 'r14d', 'r14w', 'r14b']],
    ['r15', ['r15', 'r15d', 'r15w', 'r15b']],
  ] as [Reg64, string[]][])('family of %s is %j', (base, names) => {
    expect(registerFamily(base).map((r) => r.name)).toEqual(names)
  })

  it('gives the right widths', () => {
    expect(reg('eax').size).toBe(32)
    expect(reg('ax').size).toBe(16)
    expect(reg('al').size).toBe(8)
    expect(reg('ah').size).toBe(8)
    expect(reg('r9w').size).toBe(16)
    expect(reg('r9d').size).toBe(32)
    expect(reg('r9b').size).toBe(8)
    expect(reg('sil').size).toBe(8)
    expect(reg('bpl').size).toBe(8)
  })

  it('places ah, bh, ch, dh at bits 15–8 and everything else at bit 0', () => {
    for (const name of ALL_REGISTER_NAMES) {
      const r = reg(name)
      const high = ['ah', 'bh', 'ch', 'dh'].includes(name)
      expect(r.highByte, name).toBe(high)
      expect(r.shift, name).toBe(high ? 8 : 0)
    }
  })

  it('marks the names that need a REX prefix', () => {
    for (const name of ['sil', 'dil', 'spl', 'bpl', 'r8', 'r8d', 'r8w', 'r8b', 'r15', 'r15b']) {
      expect(reg(name).needsRex, name).toBe(true)
    }
    for (const name of ['rax', 'eax', 'ax', 'al', 'ah', 'rsi', 'esi', 'si', 'rsp', 'bp']) {
      expect(reg(name).needsRex, name).toBe(false)
    }
  })

  it('is case-insensitive and rejects unknown names', () => {
    expect(lookupRegister('RAX')?.name).toBe('rax')
    expect(lookupRegister('Eax')?.name).toBe('eax')
    expect(lookupRegister('rex')).toBeUndefined()
    expect(lookupRegister('r16')).toBeUndefined()
    expect(lookupRegister('r8l')).toBeUndefined()
    expect(lookupRegister('eip')).toBeUndefined()
    expect(() => reg('nope')).toThrow()
  })

  it('finds the low part of a given width', () => {
    expect(subRegister('rax', 32).name).toBe('eax')
    expect(subRegister('rax', 8).name).toBe('al')
    expect(subRegister('r9', 16).name).toBe('r9w')
    expect(subRegister('rdi', 8).name).toBe('dil')
    expect(subRegister('rsp', 64).name).toBe('rsp')
  })
})

describe('write rules on rax = 0x1111222233334444', () => {
  it('mov al, 7 changes only the low 8 bits', () => {
    expect(writeOn('al', 7n)).toBe(0x1111_2222_3333_4407n)
  })

  it('mov ah, 5 changes only bits 15–8', () => {
    expect(writeOn('ah', 5n)).toBe(0x1111_2222_3333_0544n)
  })

  it('mov ax, 7 changes only the low 16 bits', () => {
    expect(writeOn('ax', 7n)).toBe(0x1111_2222_3333_0007n)
  })

  it('mov eax, 7 zeroes the upper 32 bits', () => {
    expect(writeOn('eax', 7n)).toBe(0x0000_0000_0000_0007n)
  })

  it('mov rax, 7 replaces everything', () => {
    expect(writeOn('rax', 7n)).toBe(7n)
  })
})

describe('write rules on the other families', () => {
  it.each([
    ['bl', 0x1111_2222_3333_4407n],
    ['bh', 0x1111_2222_3333_0744n],
    ['bx', 0x1111_2222_3333_0007n],
    ['ebx', 0x7n],
    ['cl', 0x1111_2222_3333_4407n],
    ['ch', 0x1111_2222_3333_0744n],
    ['cx', 0x1111_2222_3333_0007n],
    ['ecx', 0x7n],
    ['dl', 0x1111_2222_3333_4407n],
    ['dh', 0x1111_2222_3333_0744n],
    ['dx', 0x1111_2222_3333_0007n],
    ['edx', 0x7n],
    ['sil', 0x1111_2222_3333_4407n],
    ['si', 0x1111_2222_3333_0007n],
    ['esi', 0x7n],
    ['dil', 0x1111_2222_3333_4407n],
    ['di', 0x1111_2222_3333_0007n],
    ['edi', 0x7n],
    ['bpl', 0x1111_2222_3333_4407n],
    ['bp', 0x1111_2222_3333_0007n],
    ['ebp', 0x7n],
    ['spl', 0x1111_2222_3333_4407n],
    ['sp', 0x1111_2222_3333_0007n],
    ['esp', 0x7n],
    ['r8b', 0x1111_2222_3333_4407n],
    ['r8w', 0x1111_2222_3333_0007n],
    ['r8d', 0x7n],
    ['r12b', 0x1111_2222_3333_4407n],
    ['r12w', 0x1111_2222_3333_0007n],
    ['r12d', 0x7n],
    ['r15b', 0x1111_2222_3333_4407n],
    ['r15w', 0x1111_2222_3333_0007n],
    ['r15d', 0x7n],
  ] as [string, bigint][])('writing 7 to %s', (name, expected) => {
    expect(writeOn(name, 7n)).toBe(expected)
  })

  it('a 32-bit write of all ones still clears the top half', () => {
    expect(writeOn('r8d', 0xffff_ffffn)).toBe(0x0000_0000_ffff_ffffn)
    expect(writeOn('edi', 0xffff_ffffn)).toBe(0x0000_0000_ffff_ffffn)
  })

  it('uses only the low bits of the value being written', () => {
    expect(writeOn('al', 0x1ffn)).toBe(0x1111_2222_3333_44ffn)
    expect(writeOn('ax', 0x12_3456n)).toBe(0x1111_2222_3333_3456n)
    expect(writeOn('eax', 0x1_0000_0002n)).toBe(0x2n)
    expect(writeOn('ah', 0xabcdn)).toBe(0x1111_2222_3333_cd44n)
  })

  it('stores negative numbers as two’s complement', () => {
    expect(writeOn('al', -1n)).toBe(0x1111_2222_3333_44ffn)
    expect(writeOn('ax', -2n)).toBe(0x1111_2222_3333_fffen)
    expect(writeOn('eax', -1n)).toBe(0x0000_0000_ffff_ffffn)
    expect(writeOn('rax', -1n)).toBe(0xffff_ffff_ffff_ffffn)
  })

  it('never touches other registers', () => {
    const file = createRegisterFile()
    for (const name of REG64_NAMES) file[name] = START
    writeRegister(file, reg('eax'), 9n)
    for (const name of REG64_NAMES) {
      expect(file[name], name).toBe(name === 'rax' ? 9n : START)
    }
  })
})

describe('reading parts of a register', () => {
  it('reads each part of 0x1111222233334455', () => {
    const file = createRegisterFile()
    file.rax = 0x1111_2222_3333_4455n
    expect(readRegister(file, reg('rax'))).toBe(0x1111_2222_3333_4455n)
    expect(readRegister(file, reg('eax'))).toBe(0x3333_4455n)
    expect(readRegister(file, reg('ax'))).toBe(0x4455n)
    expect(readRegister(file, reg('ah'))).toBe(0x44n)
    expect(readRegister(file, reg('al'))).toBe(0x55n)
  })

  it('reads the parts of r9 and rsi', () => {
    const file = createRegisterFile()
    file.r9 = 0xaabb_ccdd_1122_3344n
    file.rsi = 0xaabb_ccdd_1122_3344n
    expect(readRegister(file, reg('r9d'))).toBe(0x1122_3344n)
    expect(readRegister(file, reg('r9w'))).toBe(0x3344n)
    expect(readRegister(file, reg('r9b'))).toBe(0x44n)
    expect(readRegister(file, reg('esi'))).toBe(0x1122_3344n)
    expect(readRegister(file, reg('si'))).toBe(0x3344n)
    expect(readRegister(file, reg('sil'))).toBe(0x44n)
  })

  it('write then read gives the value back for every name', () => {
    for (const name of ALL_REGISTER_NAMES) {
      const file = createRegisterFile()
      const r = reg(name)
      file[r.base] = START
      writeRegister(file, r, 0xa5n)
      expect(readRegister(file, r), name).toBe(0xa5n)
    }
  })
})

describe('mergeRegisterWrite (pure form of the rule)', () => {
  it('does not change its input', () => {
    const old = START
    const merged = mergeRegisterWrite(old, reg('ah'), 0xffn)
    expect(old).toBe(START)
    expect(merged).toBe(0x1111_2222_3333_ff44n)
  })

  it('always returns an unsigned 64-bit value', () => {
    for (const name of ALL_REGISTER_NAMES) {
      const merged = mergeRegisterWrite(0xffff_ffff_ffff_ffffn, reg(name), -1n)
      expect(merged >= 0n && merged <= 0xffff_ffff_ffff_ffffn, name).toBe(true)
    }
  })
})
