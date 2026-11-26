/**
 * `Relayer`: an optional service that claims on the destination chain so the
 * user needs no gas there.
 *
 * A relayer is given only a message and Circle's attestation of it, which
 * are public. Every burn uses `destinationCaller` zero, so the mint goes to
 * the message's own recipient whoever submits it: a relayer can be slow or
 * absent, never redirect funds. When it does not deliver in time the
 * transfer falls back to a claim from the user's own wallet.
 */
import { Context, Effect, Layer } from "effect"
import { toHex } from "./bytes.ts"
import type { Domain } from "./domain.ts"
import { reasonOf, RelayerError } from "./errors.ts"
import type { FetchLike } from "./Iris.ts"

/** What a relayer is asked to claim. */
export interface RelayRequest {
  readonly transferId: string
  readonly sourceDomain: Domain
  readonly destinationDomain: Domain
  readonly message: Uint8Array
  readonly attestation: Uint8Array
}

/** The relayer. Not providing it means every transfer is claimed by the user. */
export class Relayer extends Context.Service<
  Relayer,
  {
    /** Transfers below this amount (USDC subunits) are not sent to the relayer. */
    readonly minAmount: bigint
    /**
     * Hands the message over. Success means accepted, not delivered: delivery
     * is read from the destination's nonce.
     *
     * Fails with: `RelayerError`.
     */
    readonly submit: (
      request: RelayRequest
    ) => Effect.Effect<void, RelayerError>
  }
>()("cctp-multichain/core/Relayer") {
  /**
   * A relayer behind one HTTP endpoint: `POST url` with
   * `{ sourceDomain, destinationDomain, message, attestation }` (hex), any
   * 2xx meaning accepted.
   */
  static readonly layerHttp = (options: {
    readonly url: string
    readonly minAmount: bigint
    readonly headers?: Record<string, string>
    readonly fetch?: FetchLike
  }): Layer.Layer<Relayer> =>
    Layer.succeed(
      Relayer,
      Relayer.of({
        minAmount: options.minAmount,
        submit: Effect.fn("Relayer.submit")(function* (request) {
          const fetchFn: FetchLike =
            options.fetch ?? ((url, init) => globalThis.fetch(url, init))
          const response = yield* Effect.tryPromise({
            try: (signal) =>
              fetchFn(options.url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...options.headers,
                },
                body: JSON.stringify({
                  sourceDomain: request.sourceDomain,
                  destinationDomain: request.destinationDomain,
                  message: toHex(request.message),
                  attestation: toHex(request.attestation),
                }),
                signal,
              }),
            catch: (cause) => new RelayerError({ reason: reasonOf(cause) }),
          })
          if (response.status < 200 || response.status >= 300)
            return yield* new RelayerError({
              reason: `HTTP ${response.status}`,
              status: response.status,
            })
        }),
      })
    )
}
