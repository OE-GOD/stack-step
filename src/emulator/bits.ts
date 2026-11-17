/**
 * Small bit helpers shared by the whole emulator.
 * All values are bigint. "Unsigned" means 0 … 2^size-1.
 */
import type { OperandSize } from './types'

/** All-ones mask for each width. */
export const MASK: Readonly<Record<OperandSize, bigint>> = {
  8: 0xffn,
  16: 0xffffn,
  32: 0xffff_ffffn,
  64: 0xffff_ffff_ffff_ffffn,
}

/** The sign bit for each width. */
export const SIGN_BIT: Readonly<Record<OperandSize, bigint>> = {
  8: 0x80n,
  16: 0x8000n,
  32: 0x8000_0000n,
  64: 0x8000_0000_0000_0000n,
}

/** Keep only the low `size` bits (works for negative input too: two's complement). */
export function truncate(value: bigint, size: OperandSize): bigint {
  return BigInt.asUintN(size, value)
}

/** Read an unsigned `size`-bit value as a signed number. */
export function toSigned(value: bigint, size: OperandSize): bigint {
  return BigInt.asIntN(size, value)
}

/** Sign-extend a `from`-bit value to 64 bits (result is unsigned 64-bit). */
export function signExtend(value: bigint, from: OperandSize): bigint {
  return BigInt.asUintN(64, BigInt.asIntN(from, value))
}

/** 1 when the top bit of a `size`-bit value is set. */
export function signBit(value: bigint, size: OperandSize): 0 | 1 {
  return (value & SIGN_BIT[size]) !== 0n ? 1 : 0
}
