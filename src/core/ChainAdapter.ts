/**
 * `ChainAdapter`: what a chain family must be able to do, and `Adapters`, the
 * registry that resolves a Circle domain to its adapter.
 *
 * CCTP has no pairwise logic: a transfer is a burn on the source, Circle's
 * attestation, and a claim on the destination. So the unit of extension is a
 * family (EVM, Solana, Sui), never a route, and the orchestrator talks
 * to both ends through this one interface.
 */
import { Context, Effect, Layer, type Option, type Stream } from "effect"
import type { Hex } from "./bytes.ts"
import type { ChainRef, Domain } from "./domain.ts"
import {
  UnsupportedDomain,
  type BurnError,
  type ClaimError,
  type InvalidAddress,
  type ReadError,
} from "./errors.ts"

/** A burn to make. Addresses of the other chain are already bytes32. */
export interface BurnParams {
  /** Who burns, in this chain's address form. Must be the signer. */
  readonly sender: string
  readonly amount: bigint
  readonly destinationDomain: Domain
  readonly mintRecipient: Hex
  readonly destinationCaller: Hex
  readonly maxFee: bigint
  readonly minFinalityThreshold: number
  /** Empty for a plain burn; otherwise `depositForBurnWithHook` is used. */
  readonly hookData: Uint8Array
}

/** A burn seen on chain. */
export interface FoundBurn {
  /** The chain's own form: what Iris is asked for. */
  readonly transactionHash: string
  readonly amount: bigint
  readonly destinationDomain: Domain
  readonly mintRecipient: Hex
  readonly destinationCaller: Hex
  readonly maxFee: bigint
  readonly minFinalityThreshold: number
  readonly hookData: Hex
}

/** What a claim is expected to cost its sender, in the chain's native unit. */
export interface ClaimCost {
  /** Wei on EVM, lamports on Solana. */
  readonly amount: bigint
  readonly unit: string
}

/** One chain, through its family's adapter. */
export interface ChainAdapter {
  readonly chain: ChainRef
  /** This chain's token messenger as bytes32: the message's `sender` or `recipient`. */
  readonly messenger: Hex
  /** This chain's USDC as bytes32: the message's `burnToken`. */
  readonly usdc: Hex
  /**
   * An address of this chain as the bytes32 a message carries.
   *
   * Fails with: `InvalidAddress`.
   */
  readonly toBytes32: (address: string) => Effect.Effect<Hex, InvalidAddress>
  /**
   * The `mintRecipient` for a wallet on this chain: the address itself on
   * EVM and Sui, its USDC token account on Solana. Sui does not check the
   * recipient, so its adapter refuses an id an object or package lives at.
   *
   * Fails with: `InvalidAddress`, `ChainError`, `ChainIdMismatch`.
   */
  readonly recipientFromAddress: (
    address: string
  ) => Effect.Effect<Hex, InvalidAddress | ReadError>
  /**
   * An opaque position on this chain, taken before a burn, from which
   * `findBurns` later searches for it.
   *
   * Fails with: `InvalidAddress`, `ChainError`, `ChainIdMismatch`.
   */
  readonly burnCursor: (
    depositor: string
  ) => Effect.Effect<string, ReadError | InvalidAddress>
  /**
   * Burns USDC. Succeeds once the transaction is included and succeeded.
   *
   * Fails with: `InvalidAddress`, `InsufficientBalance`, `InsufficientGas`,
   * `SignerUnavailable`, `SignerError`, `TransactionFailed`, `ChainError`,
   * `ChainIdMismatch`, and `SubmissionUnknown` when a transaction may have
   * been sent.
   */
  readonly burn: (
    params: BurnParams
  ) => Effect.Effect<{ readonly transactionHash: string }, BurnError>
  /**
   * The finalized burns `depositor` made after `since`, oldest first on EVM.
   * Never reports a burn that can still be reorganized away.
   *
   * Fails with: `InvalidAddress`, `ChainError`, `ChainIdMismatch`.
   */
  readonly findBurns: (filter: {
    readonly depositor: string
    readonly since?: string
  }) => Stream.Stream<FoundBurn, ReadError | InvalidAddress>
  /**
   * Makes sure `recipient` can be minted to: nothing on EVM; on Solana
   * creates the USDC token account when it is missing, paid by the signer.
   *
   * Fails with: `InvalidAddress`, `InsufficientGas`, `SignerUnavailable`,
   * `SignerError`, `SubmissionUnknown`, `TransactionFailed`, `ChainError`,
   * `ChainIdMismatch`.
   */
  readonly prepareRecipient: (
    recipient: string
  ) => Effect.Effect<void, ClaimError | InvalidAddress>
  /**
   * What claiming this message would cost the signer now.
   *
   * Fails with: as `claim`.
   */
  readonly estimateClaimCost: (
    message: Uint8Array,
    attestation: Uint8Array
  ) => Effect.Effect<ClaimCost, ClaimError>
  /**
   * Claims: submits the message and its attestation, minting to the
   * message's recipient. Succeeds once included and succeeded.
   *
   * Fails with: `NonceAlreadyUsed` (already delivered), `MessageExpired`,
   * `RecipientDenied`, `RecipientAccountMissing`, `InsufficientGas`, `MalformedMessage`,
   * `SignerUnavailable`, `SignerError`, `TransactionFailed`, `ChainError`,
   * `ChainIdMismatch`, and `SubmissionUnknown`. After any failure read
   * `isNonceUsed` before trying again.
   */
  readonly claim: (
    message: Uint8Array,
    attestation: Uint8Array
  ) => Effect.Effect<{ readonly transactionHash: string }, ClaimError>
  /**
   * Whether this chain already received the message with `nonce`: the
   * delivery oracle. A failed read fails; it never answers "unused".
   *
   * Fails with: `ChainError`, `ChainIdMismatch`.
   */
  readonly isNonceUsed: (nonce: Hex) => Effect.Effect<boolean, ReadError>
  /**
   * The height this chain compares a message's `expirationBlock` with, or
   * none when it cannot be read here or the chain does not enforce it.
   *
   * Fails with: `ChainError`, `ChainIdMismatch`.
   */
  readonly expirationHeight: Effect.Effect<Option.Option<bigint>, ReadError>
}

/** The adapters in force, by Circle domain. */
export class Adapters extends Context.Service<
  Adapters,
  {
    /** Fails with: `UnsupportedDomain`. */
    readonly get: (
      domain: Domain
    ) => Effect.Effect<ChainAdapter, UnsupportedDomain>
    readonly all: ReadonlyArray<ChainAdapter>
  }
>()("cctp-multichain/core/Adapters") {
  /** The registry over adapters already built. */
  static readonly make = (
    adapters: ReadonlyArray<ChainAdapter>
  ): Adapters["Service"] => {
    const byDomain = new Map(adapters.map((a) => [a.chain.domain, a]))
    return Adapters.of({
      all: adapters,
      get: (domain) => {
        const adapter = byDomain.get(domain)
        return adapter === undefined
          ? Effect.fail(new UnsupportedDomain({ domain }))
          : Effect.succeed(adapter)
      },
    })
  }

  /**
   * The registry over adapters built here, one per chain:
   * `Adapters.layer([EvmAdapter.make(...), SolanaAdapter.make(...)])`. Each
   * adapter picks up its family's signer from the context when one is
   * provided, and is read-only otherwise.
   */
  static readonly layer = <E, R>(
    adapters: ReadonlyArray<Effect.Effect<ChainAdapter, E, R>>
  ): Layer.Layer<Adapters, E, R> =>
    Layer.effect(Adapters, Effect.map(Effect.all(adapters), Adapters.make))
}
