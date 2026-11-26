/**
 * `Iris`: Circle's attestation service.
 *
 * Hosts and endpoints:
 * https://developers.circle.com/cctp/references/technical-guide#api-hosts-and-endpoints
 * Response shapes: https://developers.circle.com/openapi/cctp.yaml
 *
 * Iris is not trusted for anything a transfer depends on: every message it
 * returns is validated against the burn (`Message.validate`) before use, and
 * the destination chain verifies the attestation's signatures.
 */
import { Context, Effect, Layer, Schema } from "effect"
import { fromHex, isHex, type Hex } from "./bytes.ts"
import type { Domain, Network } from "./domain.ts"
import { IrisError, IrisNotIndexed, reasonOf } from "./errors.ts"

/** Circle's Iris hosts. */
export const IRIS_HOSTS: Record<Network, string> = {
  mainnet: "https://iris-api.circle.com",
  testnet: "https://iris-api-sandbox.circle.com",
}

/**
 * The part of `fetch` this library uses, so a test or another runtime can
 * supply its own without a platform type.
 */
export type FetchLike = (
  url: string,
  init?: {
    readonly method?: string
    readonly headers?: Record<string, string>
    readonly body?: string
    readonly signal?: AbortSignal
  }
) => Promise<{ readonly status: number; json(): Promise<unknown> }>

/** One entry of `GET /v2/burn/USDC/fees`: `minimumFee` is in basis points. */
export const BurnFee = Schema.Struct({
  finalityThreshold: Schema.Number,
  minimumFee: Schema.Number,
})
export type BurnFee = typeof BurnFee.Type

/** `GET /v2/fastBurn/USDC/allowance`: `allowance` is in whole USDC. */
export const FastAllowance = Schema.Struct({
  allowance: Schema.Number,
  lastUpdated: Schema.optionalKey(Schema.String),
})
export type FastAllowance = typeof FastAllowance.Type

const RawMessage = Schema.Struct({
  status: Schema.String,
  message: Schema.optionalKey(Schema.NullOr(Schema.String)),
  attestation: Schema.optionalKey(Schema.NullOr(Schema.String)),
  delayReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
const RawMessages = Schema.Struct({ messages: Schema.Array(RawMessage) })

/**
 * A message of a source transaction, as Iris reports it. Anything that is
 * not `complete` with well-formed hex is `Pending`: it is asked for again.
 */
export type IrisMessage =
  | {
      readonly _tag: "Attested"
      readonly message: Uint8Array
      readonly attestation: Uint8Array
    }
  | { readonly _tag: "Pending"; readonly delayReason?: string }

const nonEmptyHex = (value: unknown): value is Hex =>
  isHex(value) && value.length > 2

const toIrisMessage = (raw: typeof RawMessage.Type): IrisMessage =>
  raw.status === "complete" &&
  nonEmptyHex(raw.message) &&
  nonEmptyHex(raw.attestation)
    ? {
        _tag: "Attested",
        message: fromHex(raw.message),
        attestation: fromHex(raw.attestation),
      }
    : {
        _tag: "Pending",
        ...(typeof raw.delayReason === "string"
          ? { delayReason: raw.delayReason }
          : {}),
      }

/** Circle's attestation service. */
export class Iris extends Context.Service<
  Iris,
  {
    /** The environment this client talks to. */
    readonly network: Network
    /**
     * Fees for a route, one entry per finality threshold.
     *
     * Fails with: `IrisError`.
     */
    readonly fees: (
      sourceDomain: Domain,
      destinationDomain: Domain
    ) => Effect.Effect<ReadonlyArray<BurnFee>, IrisError>
    /**
     * Circle's remaining Fast Transfer allowance.
     *
     * Fails with: `IrisError`.
     */
    readonly fastAllowance: Effect.Effect<FastAllowance, IrisError>
    /**
     * The messages of a source transaction. `transactionHash` is the chain's
     * own form: lowercase `0x` hex on EVM, a base58 signature on Solana.
     *
     * Fails with: `IrisNotIndexed` (404: ask again), `IrisError`.
     */
    readonly messages: (
      sourceDomain: Domain,
      transactionHash: string
    ) => Effect.Effect<ReadonlyArray<IrisMessage>, IrisNotIndexed | IrisError>
    /**
     * Asks Circle to attest a message again: a Fast message whose
     * `expirationBlock` passed gets a new one.
     *
     * Fails with: `IrisError`.
     */
    readonly reattest: (nonce: Hex) => Effect.Effect<void, IrisError>
  }
>()("cctp-multichain/core/Iris") {
  /**
   * Iris for `network`, or for `baseUrl` when given, over `fetch`
   * (`globalThis.fetch` by default).
   */
  static readonly layer = (options: {
    readonly network: Network
    readonly baseUrl?: string
    readonly fetch?: FetchLike
  }): Layer.Layer<Iris> =>
    Layer.sync(Iris, () => {
      const base = options.baseUrl ?? IRIS_HOSTS[options.network]
      const fetchFn: FetchLike =
        options.fetch ?? ((url, init) => globalThis.fetch(url, init))

      /** One request: the status, and the parsed body of a 200. */
      const request = (
        endpoint: string,
        method: "GET" | "POST",
        path: string
      ) =>
        Effect.tryPromise({
          try: (signal) =>
            fetchFn(base + path, {
              method,
              headers: { Accept: "application/json" },
              signal,
            }).then(async (r) => ({
              status: r.status,
              json: r.status === 200 ? await r.json() : undefined,
            })),
          catch: (cause) =>
            new IrisError({
              endpoint,
              retryable: true,
              reason: reasonOf(cause),
            }),
        })

      const refused = (endpoint: string, status: number) =>
        new IrisError({
          endpoint,
          status,
          retryable: status >= 500 || status === 429,
          reason: `HTTP ${status}`,
        })

      const decode = <A>(
        endpoint: string,
        schema: Schema.Decoder<A>,
        json: unknown
      ): Effect.Effect<A, IrisError> =>
        Schema.decodeUnknownEffect(schema)(json).pipe(
          Effect.mapError(
            (issue) =>
              new IrisError({
                endpoint,
                retryable: false,
                status: 200,
                reason: `unexpected body: ${issue.message}`,
              })
          )
        )

      const get = Effect.fnUntraced(function* <A>(
        endpoint: string,
        path: string,
        schema: Schema.Decoder<A>
      ) {
        const { status, json } = yield* request(endpoint, "GET", path)
        if (status !== 200) return yield* refused(endpoint, status)
        return yield* decode(endpoint, schema, json)
      })

      return Iris.of({
        network: options.network,
        fees: Effect.fn("Iris.fees")(
          function* (sourceDomain, destinationDomain) {
            return yield* get(
              "fees",
              `/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`,
              Schema.Array(BurnFee)
            )
          }
        ),
        fastAllowance: get(
          "fastAllowance",
          "/v2/fastBurn/USDC/allowance",
          FastAllowance
        ).pipe(Effect.withSpan("Iris.fastAllowance")),
        messages: Effect.fn("Iris.messages")(
          function* (sourceDomain, transactionHash) {
            const { status, json } = yield* request(
              "messages",
              "GET",
              `/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(transactionHash)}`
            )
            if (status === 404)
              return yield* new IrisNotIndexed({
                sourceDomain,
                transactionHash,
              })
            if (status !== 200) return yield* refused("messages", status)
            const body = yield* decode("messages", RawMessages, json)
            return body.messages.map(toIrisMessage)
          }
        ),
        reattest: Effect.fn("Iris.reattest")(function* (nonce) {
          const { status } = yield* request(
            "reattest",
            "POST",
            `/v2/reattest/${nonce}`
          )
          if (status !== 200) return yield* refused("reattest", status)
        }),
      })
    })
}
