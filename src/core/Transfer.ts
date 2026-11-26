/**
 * `Transfer`: the serializable record of one transfer, and its states.
 *
 * The record holds everything the burn committed to, so a resumed transfer
 * validates Circle's message against the record alone. It never holds a key
 * or a signature of ours.
 */
import { Schema } from "effect"
import { fromHex, type Hex } from "./bytes.ts"
import type { ExpectedBurn } from "./message.ts"

/**
 * Where a transfer is.
 *
 * `burning` → `attesting` → `readyToMint` → `minting` → `complete`; `failed`
 * only before anything was burned. `readyToMint` returns to `attesting` when
 * an expired Fast message is attested again.
 */
export const TransferStatus = Schema.Literals([
  "burning",
  "attesting",
  "readyToMint",
  "minting",
  "complete",
  "failed",
])
export type TransferStatus = typeof TransferStatus.Type

const HexString = Schema.String.check(
  Schema.isPattern(/^0x([0-9a-f]{2})*$/, { expected: "lowercase 0x hex" })
)
const Bytes32 = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{64}$/, { expected: "0x and 64 hex digits" })
)

/** One transfer. Persist it through `TransferStore`; encode it with `TransferJson`. */
export class Transfer extends Schema.Class<Transfer>(
  "cctp-multichain/Transfer"
)({
  id: Schema.String,
  network: Schema.Literals(["mainnet", "testnet"]),
  status: TransferStatus,
  sourceDomain: Schema.Number,
  destinationDomain: Schema.Number,
  /** Who burns, in the source chain's address form. */
  sender: Schema.String,
  /** Who receives, in the destination chain's address form (a wallet, not a token account). */
  recipient: Schema.String,
  /** USDC subunits (6 decimals) burned. */
  amount: Schema.BigInt,
  /** The most Circle may keep as its fee, in USDC subunits. */
  maxFee: Schema.BigInt,
  minFinalityThreshold: Schema.Number,
  // What the burn commits to, as the message carries it (bytes32 hex).
  messageSender: Bytes32,
  mintRecipient: Bytes32,
  destinationCaller: Bytes32,
  burnToken: Bytes32,
  sourceMessenger: Bytes32,
  destinationMessenger: Bytes32,
  hookData: HexString,
  /** The source chain's position before the burn: where a lost burn is searched from. */
  burnCursor: Schema.String,
  /** True once a burn may have been broadcast. */
  burnStarted: Schema.Boolean,
  burnTx: Schema.optional(Schema.String),
  nonce: Schema.optional(Bytes32),
  message: Schema.optional(HexString),
  attestation: Schema.optional(HexString),
  /** The `expirationBlock` of a message we asked Circle to attest again. */
  staleExpirationBlock: Schema.optional(Schema.BigInt),
  claimTx: Schema.optional(Schema.String),
  /** Who delivered: our own claim, the relayer, or someone else. */
  claimedBy: Schema.optional(Schema.Literals(["self", "relayer", "other"])),
  /** The last failure, as `Tag: reason`. Informational. */
  error: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}) {}

/** Whether nothing more will happen to `transfer`. */
export const isTerminal = (transfer: Transfer): boolean =>
  transfer.status === "complete" || transfer.status === "failed"

/** What Circle's attested message must say for `transfer`. */
export const expectedBurnOf = (transfer: Transfer): ExpectedBurn => ({
  sourceDomain: transfer.sourceDomain,
  destinationDomain: transfer.destinationDomain,
  sourceMessenger: transfer.sourceMessenger as Hex,
  destinationMessenger: transfer.destinationMessenger as Hex,
  destinationCaller: transfer.destinationCaller as Hex,
  minFinalityThreshold: transfer.minFinalityThreshold,
  burnToken: transfer.burnToken as Hex,
  mintRecipient: transfer.mintRecipient as Hex,
  amount: transfer.amount,
  messageSender: transfer.messageSender as Hex,
  maxFee: transfer.maxFee,
  hookData: fromHex(transfer.hookData),
})

/** `Transfer` as a JSON string and back: bigints as strings, absent fields dropped. */
export const TransferJson = Schema.fromJsonString(Schema.toCodecJson(Transfer))
