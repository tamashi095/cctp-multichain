/**
 * The Sui adapter, over Circle's CCTP V2 packages.
 *
 * Burn: `deposit_for_burn` → `handler::burn` → `complete_burn`, one
 * programmable transaction. Claim: `receive_message` → `prepare_mint` →
 * `handler::mint` → `complete_mint`. Delivery oracle:
 * `message_transmitter_v2::state::is_nonce_used`, read by simulation.
 * https://developers.circle.com/cctp/references/sui-packages
 *
 * It works through `client.core`, so any `@mysten/sui` client will do.
 */
import { Clock, Effect, Option, Stream } from "effect"
import {
  ObjectError,
  type ClientWithCoreApi,
  type SuiClientTypes,
} from "@mysten/sui/client"
import type { Transaction } from "@mysten/sui/transactions"
import {
  isValidSuiAddress,
  normalizeSuiAddress,
  SUI_TYPE_ARG,
} from "@mysten/sui/utils"
import { toHex, ZERO_BYTES32, type Hex } from "../core/bytes.ts"
import type { ChainAdapter, FoundBurn } from "../core/ChainAdapter.ts"
import type { SuiChainRef } from "../core/domain.ts"
import {
  ChainError,
  ChainIdMismatch,
  InsufficientBalance,
  InsufficientGas,
  InvalidAddress,
  MalformedMessage,
  MessageExpired,
  NonceAlreadyUsed,
  reasonOf,
  RecipientDenied,
  SignerError,
  SignerUnavailable,
  SubmissionUnknown,
  TransactionFailed,
} from "../core/errors.ts"
import * as Message from "../core/message.ts"
import {
  burnTransaction,
  claimRefusal,
  claimTransaction,
  DepositForBurnEvent,
  depositForBurnEventType,
  isNonceUsedTransaction,
} from "./ptb.ts"
import { SuiSigner } from "./SuiSigner.ts"

export interface SuiAdapterOptions {
  /** Any `@mysten/sui` client: gRPC, GraphQL or JSON-RPC. */
  readonly client: ClientWithCoreApi
  /** Events per page in `findBurns`. Default 50, the servers' usual cap. */
  readonly eventLimit?: number
  /** Pages `findBurns` reads when it has no cursor to stop at. Default 10. */
  readonly maxPages?: number
}

/** A simulated sender for views: reads need one, and it signs nothing. */
const VIEW_SENDER = ZERO_BYTES32

/**
 * On Sui a message's `expirationBlock` is a time in milliseconds, compared
 * with the chain's clock. A message this close to it is attested again
 * rather than raced.
 */
const EXPIRY_MARGIN_MS = 60_000n

/**
 * The adapter for `chain`. It uses the `SuiSigner` in the context when one
 * is provided and is read-only otherwise: writes then fail with
 * `SignerUnavailable`.
 */
export const make = (
  chain: SuiChainRef,
  options: SuiAdapterOptions
): Effect.Effect<ChainAdapter> =>
  Effect.gen(function* () {
    const core = options.client.core
    const signerOption = yield* Effect.serviceOption(SuiSigner)
    const domain = chain.domain

    const rpc = <A>(
      method: string,
      call: (signal: AbortSignal) => Promise<A>
    ) =>
      Effect.tryPromise({
        try: call,
        catch: (cause) =>
          new ChainError({ domain, method, reason: reasonOf(cause) }),
      })

    /** Package and object ids differ per network, but a wrong RPC should say so first. */
    const checkChain = rpc("getChainIdentifier", (signal) =>
      core.getChainIdentifier({ signal })
    ).pipe(
      Effect.flatMap(({ chainIdentifier }) =>
        chainIdentifier === chain.chainIdentifier
          ? Effect.void
          : Effect.fail(
              new ChainIdMismatch({
                domain,
                expected: chain.chainIdentifier,
                actual: chainIdentifier,
              })
            )
      )
    )

    /** Only the full 32-byte form: a short or mistyped id must not be padded into someone else's. */
    const toBytes32 = (address: string) =>
      address.startsWith("0x") &&
      isValidSuiAddress(address) &&
      normalizeSuiAddress(address) !== ZERO_BYTES32
        ? Effect.succeed(normalizeSuiAddress(address) as Hex)
        : Effect.fail(
            new InvalidAddress({
              family: "sui",
              address,
              reason: "not a non-zero address of 0x and 64 hex digits",
            })
          )

    const signer = Option.match(signerOption, {
      onNone: () => Effect.fail(new SignerUnavailable({ family: "sui" })),
      onSome: (s) =>
        Effect.map(s.address, (address) => ({
          address,
          gasPayer: s.gasOwner ?? address,
          gasOwner: s.gasOwner,
          sign: s.signTransaction,
        })),
    })
    type Account = Effect.Success<typeof signer>

    const balanceOf = (owner: string, coinType: string) =>
      rpc("getBalance", (signal) =>
        core.getBalance({ owner, coinType, signal })
      ).pipe(Effect.map(({ balance }) => BigInt(balance.balance)))

    const isNonceUsed = Effect.fn("SuiAdapter.isNonceUsed")(function* (
      nonce: Hex
    ) {
      yield* checkChain
      const view = isNonceUsedTransaction(chain, nonce)
      view.setSender(VIEW_SENDER)
      const result = yield* rpc("simulateTransaction", (signal) =>
        core.simulateTransaction({
          transaction: view,
          include: { commandResults: true },
          checksEnabled: false,
          signal,
        })
      )
      // A view that did not run, or did not answer one boolean byte, is an
      // error. It is never "unused".
      const bytes = result.commandResults?.[0]?.returnValues[0]?.bcs
      if (
        result.$kind !== "Transaction" ||
        bytes?.length !== 1 ||
        bytes[0]! > 1
      )
        return yield* new ChainError({
          domain,
          method: "is_nonce_used",
          reason:
            result.$kind === "FailedTransaction"
              ? (result.FailedTransaction.status.error?.message ?? "failed")
              : "the view returned no boolean",
        })
      return bytes[0] === 1
    })

    const failed = (
      error: SuiClientTypes.ExecutionError | null,
      transactionHash?: string
    ) =>
      new TransactionFailed({
        domain,
        reason: error?.message ?? "the transaction failed",
        ...(transactionHash === undefined ? {} : { transactionHash }),
      })

    /** A failed claim, as the typed reason Circle's code gave when it gave one. */
    const claimFailure = (
      error: SuiClientTypes.ExecutionError | null,
      nonce: Hex,
      transactionHash?: string
    ) => {
      switch (error === null ? undefined : claimRefusal(error)) {
        case "NonceAlreadyUsed":
          return new NonceAlreadyUsed({ domain, nonce })
        case "MessageExpired":
          return new MessageExpired({ domain })
        case "RecipientDenied":
          return new RecipientDenied({
            domain,
            reason: error?.message ?? "denied",
          })
        default:
          return failed(error, transactionHash)
      }
    }

    /**
     * Simulates `transaction` as `account` would send it, and answers what
     * it would cost in MIST. A simulation that fails is the transaction
     * failing, before anything is signed.
     */
    const simulate = Effect.fnUntraced(function* <E>(
      transaction: Transaction,
      account: Account,
      onFailure: (error: SuiClientTypes.ExecutionError | null) => E
    ) {
      transaction.setSender(account.address)
      if (account.gasOwner !== undefined)
        transaction.setGasOwner(account.gasOwner)
      const result = yield* rpc("simulateTransaction", (signal) =>
        core.simulateTransaction({
          transaction,
          include: { effects: true },
          signal,
        })
      )
      if (result.$kind === "FailedTransaction")
        return yield* Effect.fail(
          onFailure(result.FailedTransaction.status.error)
        )
      const gas = result.Transaction.effects.gasUsed
      const cost =
        BigInt(gas.computationCost) +
        BigInt(gas.storageCost) -
        BigInt(gas.storageRebate)
      return cost > 0n ? cost : 0n
    })

    /** Simulate, check the gas payer can afford it, build, sign, execute, and wait for it to be readable. */
    const transact = Effect.fnUntraced(function* <E>(
      transaction: Transaction,
      account: Account,
      onFailure: (
        error: SuiClientTypes.ExecutionError | null,
        transactionHash?: string
      ) => E
    ) {
      const cost = yield* simulate(transaction, account, onFailure)
      // Gas prices and storage move between simulation and execution.
      const required = (cost * 120n) / 100n
      const available = yield* balanceOf(account.gasPayer, SUI_TYPE_ARG)
      if (available < required)
        return yield* new InsufficientGas({
          domain,
          address: account.gasPayer,
          required,
          available,
        })
      const bytes = yield* Effect.tryPromise({
        try: () => transaction.build({ client: options.client }),
        catch: (cause) =>
          new TransactionFailed({
            domain,
            reason: `the transaction cannot be built: ${reasonOf(cause)}`,
          }),
      })
      const signed = yield* account.sign(bytes)
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          core.executeTransaction({
            transaction: signed.bytes,
            signatures: [...signed.signatures],
            include: { effects: true },
            signal,
          }),
        catch: (cause) =>
          new SubmissionUnknown({ domain, reason: reasonOf(cause) }),
      })
      if (result.$kind === "FailedTransaction")
        return yield* Effect.fail(
          onFailure(
            result.FailedTransaction.status.error,
            result.FailedTransaction.digest
          )
        )
      const digest = result.Transaction.digest
      // Executed is final on Sui. Wait until reads (the nonce, Iris) can see it.
      yield* Effect.tryPromise({
        try: (signal) => core.waitForTransaction({ digest, signal }),
        catch: (cause) =>
          new SubmissionUnknown({
            domain,
            transactionHash: digest,
            reason: reasonOf(cause),
          }),
      })
      return digest
    })

    /** The claim transaction, after the checks that need no simulation. */
    const prepareClaim = Effect.fnUntraced(function* (
      message: Uint8Array,
      attestation: Uint8Array
    ) {
      const decoded = yield* Message.decode(message)
      if (decoded.destinationDomain !== domain)
        return yield* new MalformedMessage({
          reason: `message is for domain ${decoded.destinationDomain}, not ${domain}`,
        })
      if (yield* isNonceUsed(decoded.nonce))
        return yield* new NonceAlreadyUsed({ domain, nonce: decoded.nonce })
      return {
        nonce: decoded.nonce,
        transaction: claimTransaction(chain, message, attestation),
      }
    })

    const eventsOf = (
      depositor: string,
      page: {
        readonly order: "ascending" | "descending"
        readonly after?: string
        readonly before?: string
        readonly limit?: number
      }
    ) =>
      rpc("listEvents", (signal) =>
        core.listEvents({
          filter: { sender: depositor },
          limit: page.limit ?? options.eventLimit ?? 50,
          ...(page.after === undefined
            ? page.before === undefined
              ? { order: page.order }
              : { before: page.before }
            : { after: page.after }),
          signal,
        })
      )

    const burnsIn = (
      events: ReadonlyArray<SuiClientTypes.EventEntry>
    ): Array<FoundBurn> =>
      events
        .filter((event) => event.eventType === depositForBurnEventType(chain))
        .map((event) => {
          const burn = DepositForBurnEvent.parse(event.bcs)
          return {
            transactionHash: event.transactionDigest,
            amount: BigInt(burn.amount),
            destinationDomain: burn.destination_domain,
            mintRecipient: burn.mint_recipient as Hex,
            destinationCaller: burn.destination_caller as Hex,
            maxFee: BigInt(burn.max_fee),
            minFinalityThreshold: burn.min_finality_threshold,
            hookData: toHex(Uint8Array.from(burn.hook_data)),
          }
        })

    const adapter: ChainAdapter = {
      chain,
      messenger: chain.messenger,
      usdc: chain.usdcTokenId,
      toBytes32,
      isNonceUsed,

      // Sui mints to whatever 32 bytes the message names. An id that an
      // object or a package lives at is not an account: USDC sent there is lost.
      recipientFromAddress: Effect.fn("SuiAdapter.recipientFromAddress")(
        function* (address) {
          const recipient = yield* toBytes32(address)
          yield* checkChain
          const {
            objects: [found],
          } = yield* rpc("getObjects", (signal) =>
            core.getObjects({ objectIds: [recipient], signal })
          )
          if (found instanceof ObjectError && found.reason !== "unknown")
            return recipient
          if (found === undefined || found instanceof Error)
            return yield* new ChainError({
              domain,
              method: "getObjects",
              reason: found?.message ?? "no answer",
            })
          return yield* new InvalidAddress({
            family: "sui",
            address,
            reason:
              "an object or package lives at this id: USDC minted to it would be lost",
          })
        }
      ),

      burnCursor: Effect.fn("SuiAdapter.burnCursor")(function* (depositor) {
        yield* toBytes32(depositor)
        yield* checkChain
        const latest = yield* eventsOf(depositor, {
          order: "descending",
          limit: 1,
        })
        return latest.startCursor ?? ""
      }),

      burn: Effect.fn("SuiAdapter.burn")(function* (params) {
        const sender = yield* toBytes32(params.sender)
        const account = yield* signer
        if (account.address.toLowerCase() !== sender)
          return yield* new SignerError({
            family: "sui",
            reason: `the signer is ${account.address}, not the sender ${params.sender}`,
          })
        yield* checkChain
        const available = yield* balanceOf(account.address, chain.usdc)
        if (available < params.amount)
          return yield* new InsufficientBalance({
            domain,
            address: account.address,
            required: params.amount,
            available,
          })
        const transactionHash = yield* transact(
          burnTransaction(chain, params),
          account,
          failed
        )
        return { transactionHash }
      }),

      findBurns: (filter) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* toBytes32(filter.depositor)
            yield* checkChain
            const since =
              filter.since === undefined || filter.since === ""
                ? undefined
                : filter.since
            // Indexed events are of executed transactions, which are final.
            // With a cursor: everything after it. Without: the newest pages.
            return Stream.paginate(
              { cursor: since, page: 0 },
              ({ cursor, page }) =>
                Effect.gen(function* () {
                  const events = yield* eventsOf(
                    filter.depositor,
                    since !== undefined
                      ? { order: "ascending", after: cursor! }
                      : cursor === undefined
                        ? { order: "descending" }
                        : { order: "descending", before: cursor }
                  )
                  const more =
                    events.hasNextPage &&
                    events.endCursor !== null &&
                    (since !== undefined || page + 1 < (options.maxPages ?? 10))
                  return [
                    burnsIn(events.events),
                    more
                      ? Option.some({
                          cursor: events.endCursor ?? undefined,
                          page: page + 1,
                        })
                      : Option.none(),
                  ] as const
                })
            )
          })
        ),

      // A Sui address needs nothing prepared: the mint creates a `Coin<USDC>` it owns.
      prepareRecipient: (recipient) => Effect.asVoid(toBytes32(recipient)),

      estimateClaimCost: Effect.fn("SuiAdapter.estimateClaimCost")(
        function* (message, attestation) {
          const account = yield* signer
          const { nonce, transaction } = yield* prepareClaim(
            message,
            attestation
          )
          const amount = yield* simulate(transaction, account, (error) =>
            claimFailure(error, nonce)
          )
          return { amount, unit: "MIST" }
        }
      ),

      claim: Effect.fn("SuiAdapter.claim")(function* (message, attestation) {
        const account = yield* signer
        const { nonce, transaction } = yield* prepareClaim(message, attestation)
        const transactionHash = yield* transact(
          transaction,
          account,
          (error, digest) => claimFailure(error, nonce, digest)
        )
        return { transactionHash }
      }),

      expirationHeight: Clock.currentTimeMillis.pipe(
        Effect.map((now) => Option.some(BigInt(now) + EXPIRY_MARGIN_MS))
      ),
    }
    return adapter
  })
