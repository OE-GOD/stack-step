/**
 * The state of a real x86-64 process at one instant, as a debugger (or the built-in
 * tracer) reports it. Every stepping mode produces a list of these.
 */
import type { Bit, Flags, Reg64 } from '../../../src/emulator/types'

export interface NativeState {
  registers: Record<Reg64, bigint>
  rip: bigint
  /** CF, ZF, SF and OF taken out of the flags register. */
  flags: Flags
  /**
   * What the debugger printed next to rip, when it did: `<main+4>` in gdb,
   * `` prog`main + 4 `` in lldb. Used to check that stepping started exactly at `main`.
   */
  location: { symbol: string; offset: number } | null
}

function bit(value: bigint, position: bigint): Bit {
  return (value >> position) & 1n ? 1 : 0
}

/** The four flags the emulator models: CF is bit 0, ZF bit 6, SF bit 7, OF bit 11. */
export function flagsFromRflags(rflags: bigint): Flags {
  return { CF: bit(rflags, 0n), ZF: bit(rflags, 6n), SF: bit(rflags, 7n), OF: bit(rflags, 11n) }
}

/** How the real machine gets to the next comparison point. */
export type NativeStep =
  /** One instruction, going into calls (gdb `stepi`, lldb `thread step-inst`). */
  | 'into'
  /** One instruction, running a whole library call (gdb `nexti`, lldb `thread step-inst-over`). */
  | 'over'
