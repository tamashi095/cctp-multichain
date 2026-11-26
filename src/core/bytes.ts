/**
 * Hex and byte helpers. Plain functions: they run on every message and never
 * touch a service. Those that can refuse input throw a `RangeError`; callers
 * at a boundary wrap them (`Message.decode`, the adapters' `toBytes32`).
 */

/** A `0x`-prefixed hex string. */
export type Hex = `0x${string}`

const HEX = "0123456789abcdef"

/** Lowercase `0x` hex of `bytes`. */
export const toHex = (bytes: Uint8Array): Hex => {
  let out = "0x"
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!
  return out as Hex
}

/** Whether `value` is `0x` followed by whole bytes of hex. */
export const isHex = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x([0-9a-fA-F]{2})*$/.test(value)

/** The bytes of a `0x` hex string. Throws a `RangeError` on anything else. */
export const fromHex = (hex: string): Uint8Array => {
  if (!isHex(hex)) throw new RangeError(`not 0x-prefixed hex: ${hex}`)
  const out = new Uint8Array((hex.length - 2) / 2)
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16)
  return out
}

/** `bytes` left-padded with zeros to 32 bytes. Throws when longer than 32. */
export const leftPad32 = (bytes: Uint8Array): Uint8Array => {
  if (bytes.length > 32)
    throw new RangeError(`${bytes.length} bytes do not fit in 32`)
  const out = new Uint8Array(32)
  out.set(bytes, 32 - bytes.length)
  return out
}

/** Thirty-two zero bytes as hex: `destinationCaller` for "anyone may claim". */
export const ZERO_BYTES32 = toHex(new Uint8Array(32))

/** A big-endian unsigned integer of `length` bytes. */
export const uintToBytes = (value: bigint, length: number): Uint8Array => {
  if (value < 0n || value >> BigInt(length * 8) !== 0n)
    throw new RangeError(`${value} does not fit in ${length} bytes`)
  const out = new Uint8Array(length)
  let rest = value
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

/** The big-endian unsigned integer in `bytes`. */
export const bytesToUint = (bytes: Uint8Array): bigint => {
  let out = 0n
  for (const b of bytes) out = (out << 8n) | BigInt(b)
  return out
}
