/**
 * `Transfers`: the orchestrator. It composes the source adapter, Iris and
 * the destination adapter into one resumable state machine and reports each
 * state as a `Stream`.
 *
 * What it guarantees:
 *
 * - It burns at most once per transfer on its own. A burn whose outcome is
 *   unknown is searched for on chain, never repeated.
 * - It claims only a message that is, byte for byte, the burn the record
 *   describes (`Message.validate`).
 * - Delivery is read from the destination's nonce. After any failed or
 *   uncertain claim the nonce is read again before anything else happens.
 * - Every burn uses `destinationCaller` zero, so anyone can finish a
 *   transfer this process abandons.
 */
import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Random,
  Schema,
  Stream,
} from "effect"
import { fromHex, toHex, ZERO_BYTES32, type Hex } from "./bytes.ts"
import { Adapters, type ChainAdapter, type FoundBurn } from "./ChainAdapter.ts"
import { FinalityThreshold, type Domain, type Speed } from "./domain.ts"
import {
  AttestationTimeout,
  BurnOutcomeUnknown,
  FeeAboveCeiling,
  InvalidTransfer,
  MalformedMessage,
  MessageMismatch,
  TransferBusy,
  TransferNotFound,
  type BurnError,
  type ClaimError,
  type InvalidAddress,
  type IrisError,
  type ReadError,
  type StoreError,
  type TransferError,
  type UnsupportedDomain,
} from "./errors.ts"
import { Iris } from "./Iris.ts"
import * as Message from "./message.ts"
import { quote, TransfersConfig } from "./policy.ts"
import { Relayer } from "./Relayer.ts"
import { expectedBurnOf, isTerminal, Transfer } from "./Transfer.ts"
import { TransferStore } from "./TransferStore.ts"

/** A transfer to make. */
export interface TransferRequest {
  /** The record's id. Random when left out. */
  readonly id?: string
  readonly sourceDomain: Domain
  readonly destinationDomain: Domain
  /** Who burns, in the source chain's address form: the source signer. */
  readonly sender: string
  /** The wallet that receives, in the destination chain's address form. */
  readonly recipient: string
  /** USDC subunits (6 decimals). */
  readonly amount: bigint
  /** Default `"standard"`. */
  readonly speed?: Speed
  /** Hook data to attach to the burn. Default none. */
  readonly hookData?: Uint8Array
}

/** Everything `create` can fail with. */
export type CreateError =
  | UnsupportedDomain
  | InvalidTransfer
  | InvalidAddress
  | FeeAboveCeiling
  | IrisError
  | ReadError
  | StoreError

class AttestationPending extends Schema.TaggedError<AttestationPending>()(
  "AttestationPending",
  {}
) {}

/** `Tag: reason` of a failure, for the record's `error`. */
const describe = (error: { readonly _tag: string }): string =>
  "reason" in error && typeof error.reason === "string"
    ? `${error._tag}: ${error.reason}`
    : error._tag

/** Burn failures that trying again will not cure: the transfer is `failed`. */
const BURN_REFUSED: ReadonlyArray<BurnError["_tag"]> = [
  "InvalidAddress",
  "InsufficientBalance",
  "TransactionFailed",
]

/** The orchestrator. */
export class Transfers extends Context.Service<
  Transfers,
  {
    /**
     * Quotes and records a transfer in `burning`. Signs and sends nothing.
     *
     * Fails with: `UnsupportedDomain`, `InvalidTransfer`, `InvalidAddress`,
     * `FeeAboveCeiling`, `IrisError`, `ChainError`, `ChainIdMismatch`,
     * `StoreError`.
     */
    readonly create: (
      request: TransferRequest
    ) => Effect.Effect<Transfer, CreateError>
    /**
     * Drives a recorded transfer as far as it can go, emitting the record
     * first as it is and then after every change. This is also how a
     * transfer is resumed: it picks up from the record's status.
     *
     * The stream ends after `complete` or `failed`, or fails with the error
     * that stopped it; the record keeps that error and a status to resume
     * from.
     *
     * Fails with: any `TransferError`.
     */
    readonly run: (id: string) => Stream.Stream<Transfer, TransferError>
    /** `create`, then `run`. Fails with: any `TransferError`. */
    readonly start: (
      request: TransferRequest
    ) => Stream.Stream<Transfer, TransferError>
    /**
     * Names the burn transaction of a transfer that is `burning` or
     * `attesting`, for a burn made elsewhere or lost by a crash. A wrong
     * hash cannot misdirect anything: its message will not validate.
     *
     * Fails with: `TransferNotFound`, `TransferBusy`, `InvalidTransfer`,
     * `StoreError`.
     */
    readonly attachBurn: (
      id: string,
      transactionHash: string
    ) => Effect.Effect<
      Transfer,
      TransferNotFound | TransferBusy | InvalidTransfer | StoreError
    >
    /**
     * Lets a transfer burn again after `BurnOutcomeUnknown` or `failed`.
     * Only for a caller certain that no burn was sent: a second burn is a
     * second transfer.
     *
     * Fails with: `TransferNotFound`, `TransferBusy`, `InvalidTransfer`,
     * `StoreError`.
     */
    readonly retryBurn: (
      id: string
    ) => Effect.Effect<
      Transfer,
      TransferNotFound | TransferBusy | InvalidTransfer | StoreError
    >
    /** Fails with: `TransferNotFound`, `StoreError`. */
    readonly get: (
      id: string
    ) => Effect.Effect<Transfer, TransferNotFound | StoreError>
  }
>()("cctp-multichain/core/Transfers") {
  /**
   * The orchestrator over the adapters, Iris and the store in the context.
   * A `Relayer`, when provided, is tried before a self-claim. The
   * `TransfersConfig` in force when the layer is built applies.
   */
  static readonly layer: Layer.Layer<
    Transfers,
    never,
    Adapters | Iris | TransferStore
  > = Layer.effect(
    Transfers,
    Effect.gen(function* () {
      const adapters = yield* Adapters
      const iris = yield* Iris
      const store = yield* TransferStore
      const relayer = yield* Effect.serviceOption(Relayer)
      const config = yield* TransfersConfig
      const running = new Set<string>()

      /** One fiber per transfer: held for as long as the scope is open. */
      const lock = (id: string) =>
        Effect.acquireRelease(
          Effect.suspend(() =>
            running.has(id)
              ? Effect.fail(new TransferBusy({ id }))
              : Effect.sync(() => void running.add(id))
          ),
          () => Effect.sync(() => void running.delete(id))
        )

      const get = Effect.fn("Transfers.get")(function* (id: string) {
        const found = yield* store.get(id)
        if (Option.isNone(found)) return yield* new TransferNotFound({ id })
        return found.value
      })

      const save = Effect.fnUntraced(function* (
        transfer: Transfer,
        patch: Partial<Transfer>
      ) {
        const updatedAt = yield* Clock.currentTimeMillis
        const next = new Transfer({ ...transfer, ...patch, updatedAt })
        yield* store.put(next)
        return next
      })

      /** Records why a step stopped, then lets the failure through. */
      const noting =
        (transfer: Transfer, patch: Partial<Transfer> = {}) =>
        <A, E extends { readonly _tag: string }, R>(
          self: Effect.Effect<A, E, R>
        ) =>
          Effect.tapError(self, (error) =>
            save(transfer, { ...patch, error: describe(error) })
          )

      const create = Effect.fn("Transfers.create")(function* (
        request: TransferRequest
      ): Effect.fn.Return<Transfer, CreateError> {
        const source = yield* adapters.get(request.sourceDomain)
        const destination = yield* adapters.get(request.destinationDomain)
        const invalid = (reason: string) => new InvalidTransfer({ reason })
        if (request.sourceDomain === request.destinationDomain)
          return yield* invalid("source and destination are the same chain")
        if (request.amount <= 0n)
          return yield* invalid("amount must be positive")
        if (
          source.chain.network !== iris.network ||
          destination.chain.network !== iris.network
        )
          return yield* invalid(
            `chains and Iris must share a network (${source.chain.network}, ${destination.chain.network}, ${iris.network})`
          )

        const quoted = yield* quote({
          source: source.chain,
          destinationDomain: request.destinationDomain,
          amount: request.amount,
          speed: request.speed ?? "standard",
        }).pipe(Effect.provideService(Iris, iris))
        if (quoted.maxFee >= request.amount)
          return yield* invalid("the fee would leave nothing to mint")

        const id =
          request.id ??
          (yield* Effect.all([
            Random.nextInt,
            Random.nextInt,
            Random.nextInt,
            Random.nextInt,
          ]))
            .map((n) => (n >>> 0).toString(16).padStart(8, "0"))
            .join("")
        if (Option.isSome(yield* store.get(id)))
          return yield* invalid(`a transfer with id ${id} exists`)

        const now = yield* Clock.currentTimeMillis
        const transfer = new Transfer({
          id,
          network: iris.network,
          status: "burning",
          sourceDomain: request.sourceDomain,
          destinationDomain: request.destinationDomain,
          sender: request.sender,
          recipient: request.recipient,
          amount: request.amount,
          maxFee: quoted.maxFee,
          minFinalityThreshold: quoted.minFinalityThreshold,
          messageSender: yield* source.toBytes32(request.sender),
          mintRecipient: yield* destination.recipientFromAddress(
            request.recipient
          ),
          // Zero: anyone may claim, so no relayer or wallet can strand a transfer.
          destinationCaller: ZERO_BYTES32,
          burnToken: source.usdc,
          sourceMessenger: source.messenger,
          destinationMessenger: destination.messenger,
          hookData: toHex(request.hookData ?? new Uint8Array()),
          burnCursor: yield* source.burnCursor(request.sender),
          burnStarted: false,
          createdAt: now,
          updatedAt: now,
        })
        yield* store.put(transfer)
        return transfer
      })

      const sameBurn = (transfer: Transfer, burn: FoundBurn): boolean =>
        burn.amount === transfer.amount &&
        burn.destinationDomain === transfer.destinationDomain &&
        burn.mintRecipient === transfer.mintRecipient &&
        burn.destinationCaller === transfer.destinationCaller &&
        burn.maxFee === transfer.maxFee &&
        burn.minFinalityThreshold === transfer.minFinalityThreshold &&
        burn.hookData === transfer.hookData

      /** `burning`: burn once, or find the burn whose outcome was lost. */
      const burn = Effect.fnUntraced(function* (
        transfer: Transfer,
        source: ChainAdapter
      ): Effect.fn.Return<Transfer, TransferError> {
        if (transfer.burnTx !== undefined)
          return yield* save(transfer, { status: "attesting" })

        if (transfer.burnStarted) {
          const found = yield* Stream.runCollect(
            source
              .findBurns({
                depositor: transfer.sender,
                since: transfer.burnCursor,
              })
              .pipe(Stream.filter((b) => sameBurn(transfer, b)))
          ).pipe(noting(transfer))
          const [only, ...others] = found
          // None: not sent, or not final yet. Several: cannot tell which is ours.
          if (only === undefined || others.length > 0)
            return yield* Effect.fail(
              new BurnOutcomeUnknown({ transferId: transfer.id })
            ).pipe(noting(transfer))
          return yield* save(transfer, {
            burnTx: only.transactionHash,
            status: "attesting",
            error: undefined,
          })
        }

        const started = yield* save(transfer, { burnStarted: true })
        const sent = yield* source
          .burn({
            sender: transfer.sender,
            amount: transfer.amount,
            destinationDomain: transfer.destinationDomain,
            mintRecipient: transfer.mintRecipient as Hex,
            destinationCaller: transfer.destinationCaller as Hex,
            maxFee: transfer.maxFee,
            minFinalityThreshold: transfer.minFinalityThreshold,
            hookData: fromHex(transfer.hookData),
          })
          .pipe(
            Effect.tapError((error) =>
              save(started, {
                error: describe(error),
                // Only a submission of unknown outcome may have burned.
                burnStarted: error._tag === "SubmissionUnknown",
                ...(BURN_REFUSED.includes(error._tag)
                  ? { status: "failed" as const }
                  : {}),
              })
            )
          )
        return yield* save(started, {
          burnTx: sent.transactionHash,
          status: "attesting",
          error: undefined,
        })
      })

      /** `attesting`: poll Iris until it returns the burn's own message. */
      const attest = Effect.fnUntraced(function* (
        transfer: Transfer
      ): Effect.fn.Return<Transfer, TransferError> {
        const transactionHash = transfer.burnTx
        if (transactionHash === undefined)
          return yield* save(transfer, { status: "burning" })
        const expected = expectedBurnOf(transfer)
        let delayReason: string | undefined

        const attempt = Effect.gen(function* () {
          const messages = yield* iris.messages(
            transfer.sourceDomain,
            transactionHash
          )
          let mismatch: MessageMismatch | MalformedMessage | undefined
          let pending = messages.length === 0
          for (const candidate of messages) {
            if (candidate._tag === "Pending") {
              pending = true
              delayReason = candidate.delayReason ?? delayReason
              continue
            }
            const checked = yield* Message.validate(
              candidate.message,
              candidate.attestation,
              expected
            ).pipe(
              Effect.map((decoded) => ({ decoded, problem: undefined })),
              Effect.catch((problem) =>
                Effect.succeed({ decoded: undefined, problem })
              )
            )
            if (checked.decoded === undefined) mismatch ??= checked.problem
            // The attestation we asked Circle to replace is still being served.
            else if (
              transfer.staleExpirationBlock !== undefined &&
              checked.decoded.expirationBlock === transfer.staleExpirationBlock
            )
              pending = true
            else return { ...candidate, nonce: checked.decoded.nonce }
          }
          if (mismatch !== undefined && !pending) return yield* mismatch
          return yield* new AttestationPending()
        })

        const timeout = () =>
          new AttestationTimeout({
            sourceDomain: transfer.sourceDomain,
            transactionHash,
            ...(delayReason === undefined ? {} : { delayReason }),
          })
        const attested = yield* attempt.pipe(
          Effect.retry({
            schedule: config.attestationPoll,
            while: (error) =>
              error._tag === "IrisNotIndexed" ||
              error._tag === "AttestationPending" ||
              (error._tag === "IrisError" && error.retryable),
          }),
          Effect.catchTag(["IrisNotIndexed", "AttestationPending"], () =>
            Effect.fail(timeout())
          ),
          Effect.timeoutOrElse({
            duration: config.attestationTimeout,
            orElse: () => Effect.fail(timeout()),
          }),
          noting(transfer)
        )
        return yield* save(transfer, {
          status: "readyToMint",
          nonce: attested.nonce,
          message: toHex(attested.message),
          attestation: toHex(attested.attestation),
          staleExpirationBlock: undefined,
          error: undefined,
        })
      })

      /**
       * `readyToMint`: let the relayer deliver, or move to `minting`.
       * `minting`: claim from our own wallet.
       */
      const deliver = Effect.fnUntraced(function* (
        transfer: Transfer,
        destination: ChainAdapter
      ): Effect.fn.Return<Transfer, TransferError> {
        if (
          transfer.nonce === undefined ||
          transfer.message === undefined ||
          transfer.attestation === undefined
        )
          return yield* save(transfer, { status: "attesting" })
        const nonce = transfer.nonce as Hex
        const message = fromHex(transfer.message)
        const attestation = fromHex(transfer.attestation)

        const delivered = (
          by: "self" | "relayer" | "other",
          claimTx?: string
        ) =>
          save(transfer, {
            status: "complete",
            claimedBy: by,
            error: undefined,
            ...(claimTx === undefined ? {} : { claimTx }),
          })
        const reattest = Effect.fnUntraced(function* (expirationBlock: bigint) {
          yield* iris.reattest(nonce).pipe(noting(transfer))
          return yield* save(transfer, {
            status: "attesting",
            message: undefined,
            attestation: undefined,
            staleExpirationBlock: expirationBlock,
            error: undefined,
          })
        })

        // The oracle first: a relayer, another tab or anyone else may have delivered.
        if (yield* destination.isNonceUsed(nonce).pipe(noting(transfer)))
          return yield* delivered(
            transfer.claimTx === undefined ? "other" : "self"
          )

        if (transfer.status === "readyToMint") {
          const { expirationBlock } = yield* Message.decode(message)
          if (expirationBlock > 0n) {
            const height = yield* destination.expirationHeight.pipe(
              noting(transfer)
            )
            if (
              Option.isSome(height) &&
              height.value + config.reattestMargin >= expirationBlock
            )
              return yield* reattest(expirationBlock)
          }

          if (
            Option.isSome(relayer) &&
            transfer.amount >= relayer.value.minAmount
          ) {
            const relayed = yield* relayer.value
              .submit({
                transferId: transfer.id,
                sourceDomain: transfer.sourceDomain,
                destinationDomain: transfer.destinationDomain,
                message,
                attestation,
              })
              .pipe(
                Effect.andThen(
                  destination.isNonceUsed(nonce).pipe(
                    Effect.filterOrFail(
                      (used) => used,
                      () => new AttestationPending()
                    ),
                    Effect.retry({ schedule: config.relayerPoll })
                  )
                ),
                Effect.timeoutOrElse({
                  duration: config.relayerTimeout,
                  orElse: () => Effect.succeed(false),
                }),
                // A relayer only ever costs time: any failure means "claim it ourselves".
                Effect.catch(() => Effect.succeed(false))
              )
            if (relayed) return yield* delivered("relayer")
          }
          return yield* save(transfer, { status: "minting" })
        }

        const outcome = yield* destination
          .prepareRecipient(transfer.recipient)
          .pipe(
            Effect.andThen(destination.claim(message, attestation)),
            Effect.map((claim) => ({ _tag: "Claimed" as const, claim })),
            Effect.catchTag("NonceAlreadyUsed", () =>
              Effect.succeed({ _tag: "Delivered" as const })
            ),
            Effect.catchTag("MessageExpired", () =>
              Effect.succeed({ _tag: "Expired" as const })
            ),
            // Failed or uncertain: the nonce says whether it was delivered after all.
            Effect.catch((error: ClaimError | InvalidAddress) =>
              destination.isNonceUsed(nonce).pipe(
                Effect.catch(() => Effect.succeed(false)),
                Effect.flatMap((used) =>
                  used
                    ? Effect.succeed({ _tag: "Delivered" as const })
                    : Effect.fail(error).pipe(
                        noting(transfer, { status: "readyToMint" })
                      )
                )
              )
            )
          )
        switch (outcome._tag) {
          case "Claimed":
            return yield* delivered("self", outcome.claim.transactionHash)
          case "Delivered":
            return yield* delivered("other")
          case "Expired":
            return yield* reattest(
              (yield* Message.decode(message)).expirationBlock
            )
        }
      })

      /** One transition, persisted. */
      const advance = Effect.fn("Transfers.advance")(function* (
        transfer: Transfer
      ): Effect.fn.Return<Transfer, TransferError> {
        yield* Effect.annotateCurrentSpan({
          "cctp.transfer": transfer.id,
          "cctp.status": transfer.status,
        })
        switch (transfer.status) {
          case "burning":
            return yield* burn(
              transfer,
              yield* adapters.get(transfer.sourceDomain)
            )
          case "attesting":
            return yield* attest(transfer)
          case "readyToMint":
          case "minting":
            return yield* deliver(
              transfer,
              yield* adapters.get(transfer.destinationDomain)
            )
          case "complete":
          case "failed":
            return transfer
        }
      })

      const run = (id: string): Stream.Stream<Transfer, TransferError> =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* lock(id)
            const first = yield* get(id)
            return Stream.concat(
              Stream.make(first),
              Stream.unfold(first, (current) =>
                isTerminal(current)
                  ? Effect.succeed(undefined)
                  : Effect.map(
                      advance(current),
                      (next) => [next, next] as const
                    )
              )
            )
          })
        )

      const edit = (
        id: string,
        change: (
          transfer: Transfer
        ) => Effect.Effect<Partial<Transfer>, InvalidTransfer>
      ) =>
        Effect.gen(function* () {
          yield* lock(id)
          const transfer = yield* get(id)
          return yield* save(transfer, yield* change(transfer))
        }).pipe(Effect.scoped)

      return Transfers.of({
        create,
        get,
        run,
        start: (request) =>
          Stream.unwrap(Effect.map(create(request), (t) => run(t.id))),
        attachBurn: Effect.fn("Transfers.attachBurn")((id, transactionHash) =>
          edit(id, (transfer) =>
            transfer.status === "burning" || transfer.status === "attesting"
              ? Effect.succeed({
                  status: "attesting",
                  burnStarted: true,
                  burnTx: transactionHash,
                  error: undefined,
                })
              : Effect.fail(
                  new InvalidTransfer({
                    reason: `a ${transfer.status} transfer already has its burn`,
                  })
                )
          )
        ),
        retryBurn: Effect.fn("Transfers.retryBurn")((id) =>
          edit(id, (transfer) =>
            transfer.burnTx === undefined &&
            (transfer.status === "burning" || transfer.status === "failed")
              ? Effect.succeed({
                  status: "burning",
                  burnStarted: false,
                  error: undefined,
                })
              : Effect.fail(
                  new InvalidTransfer({
                    reason: "this transfer has burned: it cannot burn again",
                  })
                )
          )
        ),
      })
    })
  )
}

/** The Fast and Standard thresholds, for a caller building its own quote UI. */
export { FinalityThreshold }
