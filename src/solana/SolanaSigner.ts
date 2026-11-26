/**
 * `SolanaSigner`: whoever signs Solana transactions. The adapter builds the
 * transaction and sends it; this service only signs, so a wallet adapter and
 * a backend keypair are the same to it.
 */
import { Context, Effect, Layer } from "effect"
import type { Keypair, VersionedTransaction } from "@solana/web3.js"
import { reasonOf, SignerError } from "../core/errors.ts"

/** The part of a Solana wallet adapter this library uses. */
export interface SolanaWallet {
  readonly publicKey: { toBase58(): string } | null
  readonly signTransaction?:
    (<T extends VersionedTransaction>(transaction: T) => Promise<T>) | undefined
}

/** The Solana signer. */
export class SolanaSigner extends Context.Service<
  SolanaSigner,
  {
    /** The signing account, base58. Fails with: `SignerError`. */
    readonly address: Effect.Effect<string, SignerError>
    /**
     * Signs, leaving signatures already present in place.
     *
     * Fails with: `SignerError`. Nothing is sent here.
     */
    readonly signTransaction: (
      transaction: VersionedTransaction
    ) => Effect.Effect<VersionedTransaction, SignerError>
  }
>()("cctp-multichain/solana/SolanaSigner") {
  /** A connected wallet adapter (or anything of its shape). */
  static readonly layerWallet = (
    wallet: SolanaWallet
  ): Layer.Layer<SolanaSigner> => {
    const refuse = (cause: unknown) =>
      new SignerError({ family: "solana", reason: reasonOf(cause) })
    return Layer.succeed(
      SolanaSigner,
      SolanaSigner.of({
        address: Effect.suspend(() =>
          wallet.publicKey === null
            ? Effect.fail(refuse("the wallet is not connected"))
            : Effect.succeed(wallet.publicKey.toBase58())
        ),
        signTransaction: Effect.fn("SolanaSigner.signTransaction")(
          function* (transaction) {
            const sign = wallet.signTransaction
            if (sign === undefined)
              return yield* refuse("the wallet cannot sign transactions")
            return yield* Effect.tryPromise({
              try: () => sign(transaction),
              catch: refuse,
            })
          }
        ),
      })
    )
  }

  /** A backend keypair. */
  static readonly layerKeypair = (
    keypair: Keypair
  ): Layer.Layer<SolanaSigner> =>
    Layer.succeed(
      SolanaSigner,
      SolanaSigner.of({
        address: Effect.succeed(keypair.publicKey.toBase58()),
        signTransaction: (transaction) =>
          Effect.try({
            try: () => {
              transaction.sign([keypair])
              return transaction
            },
            catch: (cause) =>
              new SignerError({ family: "solana", reason: reasonOf(cause) }),
          }),
      })
    )
}
