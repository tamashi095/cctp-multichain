/**
 * `EvmSigner`: whoever signs and sends EVM transactions. The adapter builds
 * an unsigned transaction and hands it here, so the same adapter runs
 * behind a browser wallet and behind a backend key.
 */
import { Context, Effect, Layer } from "effect"
import {
  BaseError,
  createWalletClient,
  UserRejectedRequestError,
  type Account,
  type Transport,
  type WalletClient,
} from "viem"
import type { Hex } from "../core/bytes.ts"
import type { EvmChainRef } from "../core/domain.ts"
import {
  ChainIdMismatch,
  reasonOf,
  SignerError,
  SubmissionUnknown,
} from "../core/errors.ts"

/** A transaction to sign: a call with its gas limit already estimated. */
export interface UnsignedEvmTransaction {
  readonly to: Hex
  readonly data: Hex
  readonly gas: bigint
}

/** The EVM signer. */
export class EvmSigner extends Context.Service<
  EvmSigner,
  {
    /** The account that signs on `chain`. Fails with: `SignerError`. */
    readonly address: (chain: EvmChainRef) => Effect.Effect<Hex, SignerError>
    /**
     * Signs and broadcasts on `chain`, answering the transaction hash.
     *
     * Fails with: `ChainIdMismatch` (the wallet is on another chain and
     * would not switch), `SignerError` (refused: nothing sent),
     * `SubmissionUnknown` (anything else: it may have been sent).
     */
    readonly sendTransaction: (
      chain: EvmChainRef,
      transaction: UnsignedEvmTransaction
    ) => Effect.Effect<Hex, ChainIdMismatch | SignerError | SubmissionUnknown>
  }
>()("cctp-multichain/evm/EvmSigner") {
  /**
   * A signer over one wallet client per chain. `walletFor` is asked each
   * time, so it may cache.
   */
  static readonly make = (
    walletFor: (chain: EvmChainRef) => WalletClient,
    address?: Hex
  ): EvmSigner["Service"] => {
    const signerError = (cause: unknown) =>
      new SignerError({ family: "evm", reason: reasonOf(cause) })
    const accountOf = (wallet: WalletClient) =>
      Effect.tryPromise({
        try: async () => wallet.account ?? (await wallet.getAddresses())[0],
        catch: signerError,
      }).pipe(
        Effect.flatMap((account) =>
          account === undefined
            ? Effect.fail(signerError("the wallet has no account"))
            : Effect.succeed(account)
        )
      )
    return EvmSigner.of({
      address: (signer: EvmChainRef) =>
        address !== undefined
          ? Effect.succeed(address)
          : accountOf(walletFor(signer)).pipe(
              Effect.map((account) =>
                typeof account === "string" ? account : account.address
              )
            ),
      sendTransaction: Effect.fn("EvmSigner.sendTransaction")(
        function* (chain, transaction) {
          const wallet = walletFor(chain)
          const account = yield* accountOf(wallet)
          const mismatch = (actual: number) =>
            new ChainIdMismatch({
              domain: chain.domain,
              expected: String(chain.chainId),
              actual: String(actual),
            })
          const chainId = yield* Effect.tryPromise({
            try: () => wallet.getChainId(),
            catch: signerError,
          })
          if (chainId !== chain.chainId)
            // A browser wallet can be asked to switch; a refusal sends nothing.
            yield* Effect.tryPromise({
              try: () => wallet.switchChain({ id: chain.chainId }),
              catch: () => mismatch(chainId),
            })
          return yield* Effect.tryPromise({
            try: () =>
              wallet.sendTransaction({
                account,
                chain: null,
                to: transaction.to,
                data: transaction.data,
                gas: transaction.gas,
              }),
            catch: (cause) =>
              cause instanceof BaseError &&
              cause.walk(
                (e) => e instanceof UserRejectedRequestError
              ) instanceof UserRejectedRequestError
                ? signerError(cause.shortMessage)
                : new SubmissionUnknown({
                    domain: chain.domain,
                    reason: reasonOf(cause),
                  }),
          })
        }
      ),
    })
  }

  /** A browser wallet (or any ready `WalletClient`), switched to each chain as needed. */
  static readonly layerWalletClient = (
    wallet: WalletClient
  ): Layer.Layer<EvmSigner> =>
    Layer.succeed(
      EvmSigner,
      EvmSigner.make(() => wallet)
    )

  /** A backend key: a viem `Account` and the transport to reach each chain. */
  static readonly layerAccount = (
    account: Account,
    transportFor: (chain: EvmChainRef) => Transport
  ): Layer.Layer<EvmSigner> =>
    Layer.sync(EvmSigner, () => {
      const wallets = new Map<number, WalletClient>()
      return EvmSigner.make((chain) => {
        const existing = wallets.get(chain.chainId)
        if (existing !== undefined) return existing
        const wallet = createWalletClient({
          account,
          transport: transportFor(chain),
        })
        wallets.set(chain.chainId, wallet)
        return wallet
      }, account.address)
    })
}
