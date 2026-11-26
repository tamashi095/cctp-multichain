/**
 * The error taxonomy. Every failure is a flat `Schema.TaggedError`, so it
 * serializes and is matched by tag. None carries a key, a signature or a
 * signed payload.
 */
import { Schema } from "effect"

/** Iris has not indexed the source transaction yet (HTTP 404). Poll again. */
export class IrisNotIndexed extends Schema.TaggedError<IrisNotIndexed>()(
  "IrisNotIndexed",
  { sourceDomain: Schema.Number, transactionHash: Schema.String }
) {}

/**
 * An Iris request failed or its body did not decode. `retryable` is true for
 * transport failures, HTTP 5xx and 429. Circle blocks a client for five
 * minutes after more than 40 requests a second.
 */
export class IrisError extends Schema.TaggedError<IrisError>()("IrisError", {
  endpoint: Schema.String,
  retryable: Schema.Boolean,
  status: Schema.optionalKey(Schema.Number),
  reason: Schema.String,
}) {}

/**
 * No attestation matching the burn arrived within the configured time. The
 * transfer stays `attesting` and can be resumed: a burn is never lost by
 * waiting.
 */
export class AttestationTimeout extends Schema.TaggedError<AttestationTimeout>()(
  "AttestationTimeout",
  {
    sourceDomain: Schema.Number,
    transactionHash: Schema.String,
    /** Circle's reason for a delayed Fast attestation, when it gave one. */
    delayReason: Schema.optionalKey(Schema.String),
  }
) {}

/** Bytes that are not a CCTP V2 burn message, or an attestation of the wrong shape. */
export class MalformedMessage extends Schema.TaggedError<MalformedMessage>()(
  "MalformedMessage",
  { reason: Schema.String }
) {}

/**
 * An attested message is not the burn this transfer made. `field` names the
 * first field that differs. Such a message is never claimed.
 */
export class MessageMismatch extends Schema.TaggedError<MessageMismatch>()(
  "MessageMismatch",
  { field: Schema.String, reason: Schema.String }
) {}

/** The fee a transfer would authorize is above the configured ceiling. Nothing was burned. */
export class FeeAboveCeiling extends Schema.TaggedError<FeeAboveCeiling>()(
  "FeeAboveCeiling",
  { amount: Schema.BigInt, maxFee: Schema.BigInt, ceiling: Schema.BigInt }
) {}

/** The destination already received this message: the transfer is delivered. */
export class NonceAlreadyUsed extends Schema.TaggedError<NonceAlreadyUsed>()(
  "NonceAlreadyUsed",
  { domain: Schema.Number, nonce: Schema.String }
) {}

/**
 * The destination refused the message because its `expirationBlock` passed.
 * Circle attests it again on request (`Iris.reattest`); nothing is lost.
 */
export class MessageExpired extends Schema.TaggedError<MessageExpired>()(
  "MessageExpired",
  { domain: Schema.Number }
) {}

/** The signer cannot pay for the transaction (gas on EVM; fees and rent on Solana). */
export class InsufficientGas extends Schema.TaggedError<InsufficientGas>()(
  "InsufficientGas",
  {
    domain: Schema.Number,
    address: Schema.String,
    required: Schema.BigInt,
    available: Schema.BigInt,
  }
) {}

/** The sender holds less USDC than the burn needs. Nothing was burned. */
export class InsufficientBalance extends Schema.TaggedError<InsufficientBalance>()(
  "InsufficientBalance",
  {
    domain: Schema.Number,
    address: Schema.String,
    required: Schema.BigInt,
    available: Schema.BigInt,
  }
) {}

/**
 * The recipient's token account does not exist (Solana), so a mint would
 * fail. `prepareRecipient` creates it.
 */
export class RecipientAccountMissing extends Schema.TaggedError<RecipientAccountMissing>()(
  "RecipientAccountMissing",
  { domain: Schema.Number, account: Schema.String }
) {}

/** The RPC or wallet is on another chain than the one configured. */
export class ChainIdMismatch extends Schema.TaggedError<ChainIdMismatch>()(
  "ChainIdMismatch",
  { domain: Schema.Number, expected: Schema.String, actual: Schema.String }
) {}

/** No adapter is registered for this Circle domain. */
export class UnsupportedDomain extends Schema.TaggedError<UnsupportedDomain>()(
  "UnsupportedDomain",
  { domain: Schema.Number }
) {}

/** An address is not valid for its chain family. */
export class InvalidAddress extends Schema.TaggedError<InvalidAddress>()(
  "InvalidAddress",
  { family: Schema.String, address: Schema.String, reason: Schema.String }
) {}

/** A request that cannot be a transfer: zero amount, same chain, mixed networks. */
export class InvalidTransfer extends Schema.TaggedError<InvalidTransfer>()(
  "InvalidTransfer",
  { reason: Schema.String }
) {}

/** A write was asked of an adapter that was built without its family's signer. */
export class SignerUnavailable extends Schema.TaggedError<SignerUnavailable>()(
  "SignerUnavailable",
  { family: Schema.String }
) {}

/** The signer or wallet refused to sign, or is not the expected account. Nothing was sent. */
export class SignerError extends Schema.TaggedError<SignerError>()(
  "SignerError",
  { family: Schema.String, reason: Schema.String }
) {}

/** A chain RPC read failed. Nothing was sent. */
export class ChainError extends Schema.TaggedError<ChainError>()("ChainError", {
  domain: Schema.Number,
  method: Schema.String,
  reason: Schema.String,
}) {}

/**
 * A transaction was handed to a wallet or a node and its outcome is not
 * known: it may be pending, included or dropped. A burn in this state is
 * searched for and never repeated; a claim is settled by the nonce.
 */
export class SubmissionUnknown extends Schema.TaggedError<SubmissionUnknown>()(
  "SubmissionUnknown",
  {
    domain: Schema.Number,
    transactionHash: Schema.optionalKey(Schema.String),
    reason: Schema.String,
  }
) {}

/** A transaction was simulated or included and failed (EVM revert, Solana program error). */
export class TransactionFailed extends Schema.TaggedError<TransactionFailed>()(
  "TransactionFailed",
  {
    domain: Schema.Number,
    transactionHash: Schema.optionalKey(Schema.String),
    reason: Schema.String,
  }
) {}

/**
 * A burn may have been broadcast and its transaction id was not recorded.
 * The orchestrator never burns again on its own: find the burn
 * (`ChainAdapter.findBurns`) and `Transfers.attachBurn`, or call
 * `Transfers.retryBurn` once it is certain nothing was sent.
 */
export class BurnOutcomeUnknown extends Schema.TaggedError<BurnOutcomeUnknown>()(
  "BurnOutcomeUnknown",
  { transferId: Schema.String }
) {}

/** The relayer refused or failed. The transfer falls back to a self-claim. */
export class RelayerError extends Schema.TaggedError<RelayerError>()(
  "RelayerError",
  { reason: Schema.String, status: Schema.optionalKey(Schema.Number) }
) {}

/** The transfer store failed to read or write, or held a record that did not decode. */
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  operation: Schema.String,
  reason: Schema.String,
}) {}

/** No transfer with this id is in the store. */
export class TransferNotFound extends Schema.TaggedError<TransferNotFound>()(
  "TransferNotFound",
  { id: Schema.String }
) {}

/** Another fiber of this process is already driving the transfer. */
export class TransferBusy extends Schema.TaggedError<TransferBusy>()(
  "TransferBusy",
  { id: Schema.String }
) {}

/** A failure of any read against a chain. */
export type ReadError = ChainError | ChainIdMismatch

/** Everything a burn can fail with. */
export type BurnError =
  | ReadError
  | InvalidAddress
  | InsufficientBalance
  | InsufficientGas
  | SignerUnavailable
  | SignerError
  | SubmissionUnknown
  | TransactionFailed

/** Everything a claim can fail with. */
export type ClaimError =
  | ReadError
  | MalformedMessage
  | NonceAlreadyUsed
  | MessageExpired
  | RecipientAccountMissing
  | InsufficientGas
  | SignerUnavailable
  | SignerError
  | SubmissionUnknown
  | TransactionFailed

/** Everything the orchestrator can fail with. */
export type TransferError =
  | BurnError
  | ClaimError
  | IrisError
  | AttestationTimeout
  | MessageMismatch
  | FeeAboveCeiling
  | UnsupportedDomain
  | InvalidTransfer
  | BurnOutcomeUnknown
  | StoreError
  | TransferNotFound
  | TransferBusy

/** The reason text of anything thrown, for an error's `reason` field. */
export const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)
