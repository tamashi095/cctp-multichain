/**
 * The fee and speed policy: what a transfer authorizes Circle to keep, and
 * whether it goes Fast or Standard.
 *
 * Fees: https://developers.circle.com/cctp/concepts/fees
 * Allowance: https://developers.circle.com/cctp/concepts/fast-transfer-allowance
 */
import { Context, Duration, Effect, Schedule } from "effect"
import {
  FinalityThreshold,
  type ChainRef,
  type Domain,
  type Speed,
} from "./domain.ts"
import { FeeAboveCeiling, IrisError } from "./errors.ts"
import { Iris } from "./Iris.ts"

/** The knobs of the orchestrator. Every one has a working default. */
export interface TransfersConfigService {
  /** The most a transfer may authorize as `maxFee`, in basis points of the amount. Default 100 (1%). */
  readonly maxFeeCeilingBps: number
  /**
   * Headroom added to Circle's quoted fee, in basis points of the fee, so a
   * small fee change between quote and burn does not slow a Fast transfer
   * down. Circle keeps only the fee it charges. Default 1000 (10%).
   */
  readonly feeBufferBps: number
  /** How often Iris is asked for the attestation. */
  readonly attestationPoll: Schedule.Schedule<unknown>
  /** How long one run waits for the attestation before `AttestationTimeout`. */
  readonly attestationTimeout: Duration.Input
  /** How often the destination nonce is read while a relayer works. */
  readonly relayerPoll: Schedule.Schedule<unknown>
  /** How long a relayer has before the transfer falls back to a self-claim. */
  readonly relayerTimeout: Duration.Input
  /** A Fast message this many blocks from its `expirationBlock` is attested again first. */
  readonly reattestMargin: bigint
}

/**
 * The orchestrator's configuration: a `Context.Reference`, so the defaults
 * are in force with no setup. Override with
 * `Layer.succeed(TransfersConfig, { ...defaultTransfersConfig, ... })`.
 */
export const defaultTransfersConfig: TransfersConfigService = {
  maxFeeCeilingBps: 100,
  feeBufferBps: 1000,
  // 40 requests a second gets a client blocked for five minutes: stay far below.
  attestationPoll: Schedule.min([
    Schedule.exponential("2 seconds", 1.5),
    Schedule.spaced("30 seconds"),
  ]).pipe(Schedule.jittered),
  attestationTimeout: "45 minutes",
  relayerPoll: Schedule.spaced("3 seconds"),
  relayerTimeout: "2 minutes",
  reattestMargin: 20n,
}

export const TransfersConfig = Context.Reference<TransfersConfigService>(
  "cctp-multichain/core/TransfersConfig",
  { defaultValue: () => defaultTransfersConfig }
)

/** `ceil(amount × bps / 10 000)` for a fee Circle quotes in (fractional) basis points. */
export const feeFor = (amount: bigint, minimumFeeBps: number): bigint => {
  // Four decimals of a basis point is finer than any fee Circle publishes.
  const scaled = BigInt(Math.round(minimumFeeBps * 10_000))
  return (amount * scaled + 99_999_999n) / 100_000_000n
}

/** What a transfer will authorize, and at which speed. */
export interface Quote {
  /** The speed in force, which is Standard when Fast was asked for and is not on offer. */
  readonly speed: Speed
  readonly minFinalityThreshold: number
  /** Circle's fee for this amount now. */
  readonly fee: bigint
  /** The fee with headroom, never above the ceiling: the burn's `maxFee`. */
  readonly maxFee: bigint
  /** Why a Fast request became Standard. */
  readonly downgraded?: "notFastSource" | "insufficientAllowance"
}

/**
 * Quotes a transfer: reads Circle's fee for the route (and the Fast
 * allowance for a Fast request) and applies the ceiling.
 *
 * Fast becomes Standard when the source offers no Fast Transfer or Circle's
 * allowance is below the amount.
 *
 * Fails with: `FeeAboveCeiling` when Circle's fee alone is above the
 * ceiling, `IrisError`.
 */
export const quote = Effect.fn("Transfers.quote")(function* (request: {
  readonly source: ChainRef
  readonly destinationDomain: Domain
  readonly amount: bigint
  readonly speed: Speed
}): Effect.fn.Return<Quote, IrisError | FeeAboveCeiling, Iris> {
  const iris = yield* Iris
  const config = yield* TransfersConfig
  const { amount, source } = request

  let speed = request.speed
  let downgraded: Quote["downgraded"]
  if (speed === "fast" && !source.fastSource) {
    speed = "standard"
    downgraded = "notFastSource"
  } else if (speed === "fast") {
    const { allowance } = yield* iris.fastAllowance
    // The allowance is in whole USDC; amounts are in subunits.
    if (Number(amount) / 1e6 > allowance) {
      speed = "standard"
      downgraded = "insufficientAllowance"
    }
  }

  const minFinalityThreshold = FinalityThreshold[speed]
  const fees = yield* iris.fees(source.domain, request.destinationDomain)
  const entry = fees.find((f) => f.finalityThreshold === minFinalityThreshold)
  if (entry === undefined)
    return yield* new IrisError({
      endpoint: "fees",
      retryable: false,
      reason: `no fee for threshold ${minFinalityThreshold}`,
    })

  const fee = feeFor(amount, entry.minimumFee)
  const ceiling = (amount * BigInt(config.maxFeeCeilingBps)) / 10_000n
  if (fee > ceiling)
    return yield* new FeeAboveCeiling({ amount, maxFee: fee, ceiling })
  const buffered = fee + (fee * BigInt(config.feeBufferBps) + 9_999n) / 10_000n
  return {
    speed,
    minFinalityThreshold,
    fee,
    maxFee: buffered > ceiling ? ceiling : buffered,
    ...(downgraded === undefined ? {} : { downgraded }),
  }
})
