/**
 * The CCTP V2 message codec and the validator that binds an attested message
 * to the burn we made.
 *
 * Layout (big-endian, addresses as bytes32):
 * https://developers.circle.com/cctp/references/technical-guide#message-format
 *
 * The codec is plain byte packing; `decode` and `validate` are its Effect
 * faces.
 */
import { Effect } from "effect"
import { bytesToUint, fromHex, toHex, uintToBytes, type Hex } from "./bytes.ts"
import type { Domain } from "./domain.ts"
import { MalformedMessage, MessageMismatch, reasonOf } from "./errors.ts"

/** Byte offsets and lengths of every field, header then burn body. */
export const Layout = {
  version: [0, 4],
  sourceDomain: [4, 4],
  destinationDomain: [8, 4],
  nonce: [12, 32],
  sender: [44, 32],
  recipient: [76, 32],
  destinationCaller: [108, 32],
  minFinalityThreshold: [140, 4],
  finalityThresholdExecuted: [144, 4],
  bodyVersion: [148, 4],
  burnToken: [152, 32],
  mintRecipient: [184, 32],
  amount: [216, 32],
  messageSender: [248, 32],
  maxFee: [280, 32],
  feeExecuted: [312, 32],
  expirationBlock: [344, 32],
} as const satisfies Record<string, readonly [number, number]>

/** Header (148) plus a burn body without hook data (228). */
export const BURN_MESSAGE_MIN_LENGTH = 376
/** Message and burn-body version of CCTP V2. */
export const MESSAGE_VERSION = 1

/**
 * The fields Circle's attestation service fills in after the burn. They are
 * zero in the message the source chain emits.
 */
const ATTESTER_FILLED = [
  "nonce",
  "finalityThresholdExecuted",
  "feeExecuted",
  "expirationBlock",
] as const

/** A decoded CCTP V2 burn message. */
export interface BurnMessage {
  readonly version: number
  readonly sourceDomain: Domain
  readonly destinationDomain: Domain
  readonly nonce: Hex
  /** The source chain's token messenger. */
  readonly sender: Hex
  /** The destination chain's token messenger. */
  readonly recipient: Hex
  readonly destinationCaller: Hex
  readonly minFinalityThreshold: number
  readonly finalityThresholdExecuted: number
  readonly bodyVersion: number
  readonly burnToken: Hex
  readonly mintRecipient: Hex
  readonly amount: bigint
  /** Who called `depositForBurn`. */
  readonly messageSender: Hex
  readonly maxFee: bigint
  readonly feeExecuted: bigint
  /** Zero for a message that never expires (Standard). */
  readonly expirationBlock: bigint
  readonly hookData: Uint8Array
}

type Field = keyof typeof Layout

const slice = (message: Uint8Array, field: Field): Uint8Array => {
  const [offset, length] = Layout[field]
  return message.subarray(offset, offset + length)
}

/** Decodes a burn message. Throws a `RangeError` when it is too short. */
export const decodeBurnMessage = (message: Uint8Array): BurnMessage => {
  if (message.length < BURN_MESSAGE_MIN_LENGTH)
    throw new RangeError(
      `burn message is ${message.length} bytes, shorter than ${BURN_MESSAGE_MIN_LENGTH}`
    )
  const uint32 = (field: Field) => Number(bytesToUint(slice(message, field)))
  const uint256 = (field: Field) => bytesToUint(slice(message, field))
  const bytes32 = (field: Field) => toHex(slice(message, field))
  return {
    version: uint32("version"),
    sourceDomain: uint32("sourceDomain"),
    destinationDomain: uint32("destinationDomain"),
    nonce: bytes32("nonce"),
    sender: bytes32("sender"),
    recipient: bytes32("recipient"),
    destinationCaller: bytes32("destinationCaller"),
    minFinalityThreshold: uint32("minFinalityThreshold"),
    finalityThresholdExecuted: uint32("finalityThresholdExecuted"),
    bodyVersion: uint32("bodyVersion"),
    burnToken: bytes32("burnToken"),
    mintRecipient: bytes32("mintRecipient"),
    amount: uint256("amount"),
    messageSender: bytes32("messageSender"),
    maxFee: uint256("maxFee"),
    feeExecuted: uint256("feeExecuted"),
    expirationBlock: uint256("expirationBlock"),
    hookData: message.slice(BURN_MESSAGE_MIN_LENGTH),
  }
}

/** Encodes a burn message. Throws a `RangeError` on a field of the wrong size. */
export const encodeBurnMessage = (m: BurnMessage): Uint8Array => {
  const out = new Uint8Array(BURN_MESSAGE_MIN_LENGTH + m.hookData.length)
  const put = (field: Field, value: number | bigint | Hex) => {
    const [offset, length] = Layout[field]
    const bytes =
      typeof value === "string"
        ? fromHex(value)
        : uintToBytes(BigInt(value), length)
    if (bytes.length !== length)
      throw new RangeError(`${field} must be ${length} bytes`)
    out.set(bytes, offset)
  }
  put("version", m.version)
  put("sourceDomain", m.sourceDomain)
  put("destinationDomain", m.destinationDomain)
  put("nonce", m.nonce)
  put("sender", m.sender)
  put("recipient", m.recipient)
  put("destinationCaller", m.destinationCaller)
  put("minFinalityThreshold", m.minFinalityThreshold)
  put("finalityThresholdExecuted", m.finalityThresholdExecuted)
  put("bodyVersion", m.bodyVersion)
  put("burnToken", m.burnToken)
  put("mintRecipient", m.mintRecipient)
  put("amount", m.amount)
  put("messageSender", m.messageSender)
  put("maxFee", m.maxFee)
  put("feeExecuted", m.feeExecuted)
  put("expirationBlock", m.expirationBlock)
  out.set(m.hookData, BURN_MESSAGE_MIN_LENGTH)
  return out
}

/** Everything we chose when we burned: what the attested message must say. */
export interface ExpectedBurn {
  readonly sourceDomain: Domain
  readonly destinationDomain: Domain
  /** The source chain's token messenger, as bytes32. */
  readonly sourceMessenger: Hex
  /** The destination chain's token messenger, as bytes32. */
  readonly destinationMessenger: Hex
  readonly destinationCaller: Hex
  readonly minFinalityThreshold: number
  readonly burnToken: Hex
  readonly mintRecipient: Hex
  readonly amount: bigint
  readonly messageSender: Hex
  readonly maxFee: bigint
  readonly hookData: Uint8Array
}

/**
 * The message the source chain emits for `expected`: every attester-filled
 * field zero. Throws a `RangeError` on a malformed expectation.
 */
export const expectedBurnMessage = (expected: ExpectedBurn): Uint8Array =>
  encodeBurnMessage({
    version: MESSAGE_VERSION,
    sourceDomain: expected.sourceDomain,
    destinationDomain: expected.destinationDomain,
    nonce: toHex(new Uint8Array(32)),
    sender: expected.sourceMessenger,
    recipient: expected.destinationMessenger,
    destinationCaller: expected.destinationCaller,
    minFinalityThreshold: expected.minFinalityThreshold,
    finalityThresholdExecuted: 0,
    bodyVersion: MESSAGE_VERSION,
    burnToken: expected.burnToken,
    mintRecipient: expected.mintRecipient,
    amount: expected.amount,
    messageSender: expected.messageSender,
    maxFee: expected.maxFee,
    feeExecuted: 0n,
    expirationBlock: 0n,
    hookData: expected.hookData,
  })

const fieldAt = (index: number): string => {
  for (const [name, [offset, length]] of Object.entries(Layout))
    if (index >= offset && index < offset + length) return name
  return "hookData"
}

/**
 * Why `message` is not the attested form of the burn `expected` describes, or
 * `null` when it is.
 *
 * With the four attester-filled fields zeroed, the message must equal the
 * expected burn byte for byte (so its length, both versions, both domains,
 * both messengers, the destination caller, the threshold, the token, the
 * recipient, the amount, the sender, `maxFee` and the hook data all match).
 * Of the attester-filled fields: the nonce is set, `feeExecuted` is within
 * `maxFee` and below the amount, and the executed finality is one of
 * Circle's two and not below the one asked for.
 */
export const burnMessageProblem = (
  message: Uint8Array,
  expected: ExpectedBurn
): { readonly field: string; readonly reason: string } | null => {
  const want = expectedBurnMessage(expected)
  if (message.length !== want.length)
    return {
      field: "length",
      reason: `${message.length} bytes, expected ${want.length}`,
    }
  const got = message.slice()
  for (const field of ATTESTER_FILLED) {
    const [offset, length] = Layout[field]
    got.fill(0, offset, offset + length)
  }
  const index = got.findIndex((byte, i) => byte !== want[i])
  if (index >= 0)
    return {
      field: fieldAt(index),
      reason: `differs from the burn at byte ${index}`,
    }
  const m = decodeBurnMessage(message)
  if (BigInt(m.nonce) === 0n)
    return { field: "nonce", reason: "zero nonce: not attested" }
  if (m.feeExecuted > m.maxFee)
    return { field: "feeExecuted", reason: "fee above maxFee" }
  if (m.amount === 0n || m.feeExecuted >= m.amount)
    return { field: "feeExecuted", reason: "fee leaves nothing to mint" }
  if (
    (m.finalityThresholdExecuted !== 1000 &&
      m.finalityThresholdExecuted !== 2000) ||
    m.finalityThresholdExecuted < m.minFinalityThreshold
  )
    return {
      field: "finalityThresholdExecuted",
      reason: `executed at ${m.finalityThresholdExecuted}, asked for ${m.minFinalityThreshold}`,
    }
  return null
}

/**
 * Decodes a burn message.
 *
 * Fails with: `MalformedMessage`.
 */
export const decode = (
  message: Uint8Array
): Effect.Effect<BurnMessage, MalformedMessage> =>
  Effect.try({
    try: () => decodeBurnMessage(message),
    catch: (cause) => new MalformedMessage({ reason: reasonOf(cause) }),
  })

/**
 * Accepts an attested message only if it is the burn `expected` describes
 * and its attestation is a whole number of 65-byte signatures.
 *
 * The signatures themselves are not checked here: the destination chain
 * verifies them against Circle's attesters when the message is claimed.
 *
 * Fails with: `MalformedMessage`, `MessageMismatch`.
 */
export const validate = Effect.fnUntraced(function* (
  message: Uint8Array,
  attestation: Uint8Array,
  expected: ExpectedBurn
): Effect.fn.Return<BurnMessage, MalformedMessage | MessageMismatch> {
  if (attestation.length === 0 || attestation.length % 65 !== 0)
    return yield* new MalformedMessage({
      reason: `attestation is ${attestation.length} bytes, not a multiple of 65`,
    })
  const problem = yield* Effect.try({
    try: () => burnMessageProblem(message, expected),
    catch: (cause) => new MalformedMessage({ reason: reasonOf(cause) }),
  })
  if (problem !== null) return yield* new MessageMismatch(problem)
  return yield* decode(message)
})
