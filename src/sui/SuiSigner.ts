/**
 * `SuiSigner`: whoever signs Sui transactions, and optionally who pays
 * their gas. The adapter builds the bytes and executes them; this service
 * only signs, so a wallet, a backend keypair and a sponsored setup are the
 * same to it.
 */
import { Context, Effect, Layer } from "effect"
import type { Signer } from "@mysten/sui/cryptography"
import { Transaction } from "@mysten/sui/transactions"
import { fromBase64 } from "@mysten/sui/utils"
import { reasonOf, SignerError } from "../core/errors.ts"

/** The part of a Sui wallet (wallet standard, dapp-kit) this library uses. */
export interface SuiWallet {
  readonly address: string
  /** Answers the bytes it signed, base64, and its signature. */
  readonly signTransaction: (input: {
    readonly transaction: Transaction
  }) => Promise<{ readonly bytes: string; readonly signature: string }>
}

/**
 * Someone else who pays the gas: Sui's sponsored transactions. The sponsor
 * sees the full transaction bytes and may refuse; it cannot change them.
 */
export interface SuiSponsor {
  readonly address: string
  /** The sponsor's signature over the transaction bytes. */
  readonly sign: (bytes: Uint8Array) => Promise<string>
}

/** The Sui signer. */
export class SuiSigner extends Context.Service<
  SuiSigner,
  {
    /** The sender. Fails with: `SignerError`. */
    readonly address: Effect.Effect<string, SignerError>
    /** Who pays the gas when it is not the sender. */
    readonly gasOwner: string | undefined
    /**
     * Signs built transaction bytes, answering the bytes that were signed
     * (a wallet may hand back its own serialization) and every signature
     * needed: the sender's, then the sponsor's.
     *
     * Fails with: `SignerError`. Nothing is sent here.
     */
    readonly signTransaction: (bytes: Uint8Array) => Effect.Effect<
      {
        readonly bytes: Uint8Array
        readonly signatures: ReadonlyArray<string>
      },
      SignerError
    >
  }
>()("cctp-multichain/sui/SuiSigner") {
  /** A signer from its parts. */
  static readonly make = (options: {
    readonly address: string
    readonly sign: (
      bytes: Uint8Array
    ) => Promise<{ readonly bytes: Uint8Array; readonly signature: string }>
    readonly sponsor?: SuiSponsor | undefined
  }): SuiSigner["Service"] => {
    const refuse = (cause: unknown) =>
      new SignerError({ family: "sui", reason: reasonOf(cause) })
    return SuiSigner.of({
      address: Effect.succeed(options.address),
      gasOwner: options.sponsor?.address,
      signTransaction: Effect.fn("SuiSigner.signTransaction")(
        function* (bytes) {
          const own = yield* Effect.tryPromise({
            try: () => options.sign(bytes),
            catch: refuse,
          })
          const sponsor = options.sponsor
          if (sponsor === undefined)
            return { bytes: own.bytes, signatures: [own.signature] }
          const paid = yield* Effect.tryPromise({
            try: () => sponsor.sign(own.bytes),
            catch: refuse,
          })
          return { bytes: own.bytes, signatures: [own.signature, paid] }
        }
      ),
    })
  }

  /** A backend key: any `@mysten/sui/cryptography` signer, such as a keypair. */
  static readonly layerKeypair = (
    keypair: Signer,
    options?: { readonly sponsor?: SuiSponsor }
  ): Layer.Layer<SuiSigner> =>
    Layer.sync(SuiSigner, () =>
      SuiSigner.make({
        address: keypair.toSuiAddress(),
        sign: async (bytes) => ({
          bytes,
          signature: (await keypair.signTransaction(bytes)).signature,
        }),
        sponsor: options?.sponsor,
      })
    )

  /** A connected wallet. */
  static readonly layerWallet = (
    wallet: SuiWallet,
    options?: { readonly sponsor?: SuiSponsor }
  ): Layer.Layer<SuiSigner> =>
    Layer.sync(SuiSigner, () =>
      SuiSigner.make({
        address: wallet.address,
        sign: async (bytes) => {
          const signed = await wallet.signTransaction({
            transaction: Transaction.from(bytes),
          })
          return {
            bytes: fromBase64(signed.bytes),
            signature: signed.signature,
          }
        },
        sponsor: options?.sponsor,
      })
    )
}
