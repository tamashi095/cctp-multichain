/**
 * The EVM adapter: one implementation, configured per chain from the
 * registry.
 *
 * Burn: `approve`, then `TokenMessengerV2.depositForBurn` (or
 * `depositForBurnWithHook`). Claim: `MessageTransmitterV2.receiveMessage`.
 * Delivery oracle: `MessageTransmitterV2.usedNonces`.
 * https://developers.circle.com/cctp/references/contract-interfaces
 */
import { Effect, Option, Stream } from "effect"
import {
  BaseError,
  encodeFunctionData,
  getAbiItem,
  getAddress,
  isAddress,
  pad,
  zeroAddress,
  type PublicClient,
} from "viem"
import { toHex, type Hex } from "../core/bytes.ts"
import type { ChainAdapter, FoundBurn } from "../core/ChainAdapter.ts"
import type { EvmChainRef } from "../core/domain.ts"
import {
  ChainError,
  ChainIdMismatch,
  InsufficientBalance,
  InsufficientGas,
  InvalidAddress,
  MalformedMessage,
  MessageExpired,
  NonceAlreadyUsed,
  SignerError,
  SignerUnavailable,
  SubmissionUnknown,
  TransactionFailed,
} from "../core/errors.ts"
import * as Message from "../core/message.ts"
import {
  erc20Abi,
  messageTransmitterV2Abi,
  tokenMessengerV2Abi,
} from "./abi.ts"
import { EvmSigner } from "./EvmSigner.ts"

/** The reads the adapter makes: any viem public client has them. */
export type EvmReadClient = Pick<
  PublicClient,
  | "getChainId"
  | "readContract"
  | "estimateGas"
  | "getGasPrice"
  | "getBalance"
  | "getBlock"
  | "getBlockNumber"
  | "getLogs"
  | "waitForTransactionReceipt"
>

export interface EvmAdapterOptions {
  /** A viem public client for this chain. */
  readonly client: EvmReadClient
  /** Blocks per `eth_getLogs` request in `findBurns`. Default 2000. */
  readonly logRange?: bigint
  /** How far back `findBurns` looks without a cursor. Default 10 000 blocks. */
  readonly lookback?: bigint
}

/**
 * Gas limits are the live estimate plus 30%: a fixed limit reverted in
 * production, and gas used after refunds is not a safe limit.
 */
const withHeadroom = (estimate: bigint): bigint => (estimate * 130n) / 100n

const depositForBurnEvent = getAbiItem({
  abi: tokenMessengerV2Abi,
  name: "DepositForBurn",
})

const reason = (cause: unknown): string =>
  cause instanceof BaseError ? cause.shortMessage : String(cause)

/**
 * The adapter for `chain`. It uses the `EvmSigner` in the context when one
 * is provided and is read-only otherwise: writes then fail with
 * `SignerUnavailable`.
 */
export const make = (
  chain: EvmChainRef,
  options: EvmAdapterOptions
): Effect.Effect<ChainAdapter> =>
  Effect.gen(function* () {
    const client = options.client
    const signerOption = yield* Effect.serviceOption(EvmSigner)
    const domain = chain.domain

    const rpc = <A>(method: string, call: () => Promise<A>) =>
      Effect.tryPromise({
        try: call,
        catch: (cause) =>
          new ChainError({ domain, method, reason: reason(cause) }),
      })

    /** Circle's contracts share addresses across chains: a wrong RPC must fail loudly. */
    const checkChain = rpc("eth_chainId", () => client.getChainId()).pipe(
      Effect.flatMap((actual) =>
        actual === chain.chainId
          ? Effect.void
          : Effect.fail(
              new ChainIdMismatch({
                domain,
                expected: String(chain.chainId),
                actual: String(actual),
              })
            )
      )
    )

    const toBytes32 = (address: string) =>
      isAddress(address, { strict: false }) &&
      getAddress(address) !== zeroAddress
        ? Effect.succeed(pad(address.toLowerCase() as Hex, { size: 32 }))
        : Effect.fail(
            new InvalidAddress({
              family: "evm",
              address,
              reason: "not a non-zero 20-byte address",
            })
          )

    const signer = Option.match(signerOption, {
      onNone: () => Effect.fail(new SignerUnavailable({ family: "evm" })),
      onSome: (s) =>
        Effect.map(s.address(chain), (address) => ({
          address,
          send: s.sendTransaction,
        })),
    })

    const isNonceUsed = Effect.fn("EvmAdapter.isNonceUsed")(function* (
      nonce: Hex
    ) {
      yield* checkChain
      const used = yield* rpc("usedNonces", () =>
        client.readContract({
          address: chain.messageTransmitter,
          abi: messageTransmitterV2Abi,
          functionName: "usedNonces",
          args: [nonce],
        })
      )
      return used !== 0n
    })

    /** Simulates through gas estimation; a revert is a `TransactionFailed`. */
    const estimate = (from: Hex | undefined, to: Hex, data: Hex) =>
      Effect.tryPromise({
        try: () =>
          client.estimateGas({
            ...(from === undefined ? {} : { account: from }),
            to,
            data,
          }),
        catch: (cause) =>
          new TransactionFailed({ domain, reason: reason(cause) }),
      })

    const requireGas = Effect.fnUntraced(function* (address: Hex, gas: bigint) {
      const price = yield* rpc("eth_gasPrice", () => client.getGasPrice())
      const available = yield* rpc("eth_getBalance", () =>
        client.getBalance({ address })
      )
      // The price can move before inclusion: ask for a quarter more.
      const required = (gas * price * 125n) / 100n
      if (available < required)
        return yield* new InsufficientGas({
          domain,
          address,
          required,
          available,
        })
      return required
    })

    /** Estimate, check the balance, sign, send, and wait for a successful receipt. */
    const transact = Effect.fnUntraced(function* (
      account: {
        readonly address: Hex
        readonly send: EvmSigner["Service"]["sendTransaction"]
      },
      to: Hex,
      data: Hex,
      gasEstimate: bigint
    ) {
      const gas = withHeadroom(gasEstimate)
      yield* requireGas(account.address, gas)
      const hash = yield* account.send(chain, { to, data, gas })
      const receipt = yield* Effect.tryPromise({
        try: () => client.waitForTransactionReceipt({ hash }),
        catch: (cause) =>
          new SubmissionUnknown({
            domain,
            transactionHash: hash,
            reason: reason(cause),
          }),
      })
      if (receipt.status !== "success")
        return yield* new TransactionFailed({
          domain,
          transactionHash: hash,
          reason: "reverted",
        })
      return hash.toLowerCase()
    })

    const receiveMessage = (message: Uint8Array, attestation: Uint8Array) =>
      encodeFunctionData({
        abi: messageTransmitterV2Abi,
        functionName: "receiveMessage",
        args: [toHex(message), toHex(attestation)],
      })

    /** Everything a claim checks before it spends: the gas a claim needs. */
    const preflightClaim = Effect.fnUntraced(function* (
      from: Hex | undefined,
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
      return yield* estimate(
        from,
        chain.messageTransmitter,
        receiveMessage(message, attestation)
      ).pipe(
        Effect.catch(
          (
            failed
          ): Effect.Effect<
            never,
            TransactionFailed | MessageExpired | NonceAlreadyUsed
          > =>
            // TokenMessengerV2: "Message expired and must be re-signed".
            /message expired/i.test(failed.reason)
              ? Effect.fail(new MessageExpired({ domain }))
              : /nonce already used/i.test(failed.reason)
                ? Effect.fail(
                    new NonceAlreadyUsed({ domain, nonce: decoded.nonce })
                  )
                : Effect.fail(failed)
        )
      )
    })

    const finalizedBlock = rpc("eth_getBlockByNumber", () =>
      client.getBlock({ blockTag: "finalized" })
    ).pipe(Effect.map((block) => block.number))

    const adapter: ChainAdapter = {
      chain,
      messenger: pad(chain.tokenMessenger.toLowerCase() as Hex, { size: 32 }),
      usdc: pad(chain.usdc.toLowerCase() as Hex, { size: 32 }),
      toBytes32,
      recipientFromAddress: toBytes32,
      isNonceUsed,

      burnCursor: Effect.fn("EvmAdapter.burnCursor")(function* (depositor) {
        yield* toBytes32(depositor)
        yield* checkChain
        return String(yield* finalizedBlock)
      }),

      burn: Effect.fn("EvmAdapter.burn")(function* (params) {
        yield* toBytes32(params.sender)
        const account = yield* signer
        if (account.address.toLowerCase() !== params.sender.toLowerCase())
          return yield* new SignerError({
            family: "evm",
            reason: `the signer is ${account.address}, not the sender ${params.sender}`,
          })
        yield* checkChain
        const owner = account.address
        const balance = yield* rpc("balanceOf", () =>
          client.readContract({
            address: chain.usdc,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [owner],
          })
        )
        if (balance < params.amount)
          return yield* new InsufficientBalance({
            domain,
            address: owner,
            required: params.amount,
            available: balance,
          })
        const allowance = yield* rpc("allowance", () =>
          client.readContract({
            address: chain.usdc,
            abi: erc20Abi,
            functionName: "allowance",
            args: [owner, chain.tokenMessenger],
          })
        )
        if (allowance < params.amount) {
          // Exactly the amount: the burn consumes it and nothing stands after.
          const approve = encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [chain.tokenMessenger, params.amount],
          })
          yield* transact(
            account,
            chain.usdc,
            approve,
            yield* estimate(owner, chain.usdc, approve)
          ).pipe(
            // An approval is not a burn: whatever became of it, nothing was burned.
            Effect.catchTag("SubmissionUnknown", (unknown) =>
              Effect.fail(
                new ChainError({
                  domain,
                  method: "approve",
                  reason: unknown.reason,
                })
              )
            )
          )
        }
        const common = [
          params.amount,
          params.destinationDomain,
          params.mintRecipient,
          chain.usdc,
          params.destinationCaller,
          params.maxFee,
          params.minFinalityThreshold,
        ] as const
        const data =
          params.hookData.length === 0
            ? encodeFunctionData({
                abi: tokenMessengerV2Abi,
                functionName: "depositForBurn",
                args: common,
              })
            : encodeFunctionData({
                abi: tokenMessengerV2Abi,
                functionName: "depositForBurnWithHook",
                args: [...common, toHex(params.hookData)],
              })
        const transactionHash = yield* transact(
          account,
          chain.tokenMessenger,
          data,
          yield* estimate(owner, chain.tokenMessenger, data)
        )
        return { transactionHash }
      }),

      findBurns: (filter) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* toBytes32(filter.depositor)
            yield* checkChain
            // Only finalized blocks: a burn that can be reorganized away is not a burn yet.
            const finalized = yield* finalizedBlock
            const lookback = options.lookback ?? 10_000n
            const range = options.logRange ?? 2_000n
            const first =
              filter.since === undefined
                ? finalized > lookback
                  ? finalized - lookback
                  : 0n
                : BigInt(filter.since) + 1n
            return Stream.paginate(first, (fromBlock) =>
              Effect.gen(function* () {
                if (fromBlock > finalized)
                  return [
                    [] as Array<FoundBurn>,
                    Option.none<bigint>(),
                  ] as const
                const toBlock =
                  fromBlock + range - 1n < finalized
                    ? fromBlock + range - 1n
                    : finalized
                const logs = yield* rpc("eth_getLogs", () =>
                  client.getLogs({
                    address: chain.tokenMessenger,
                    event: depositForBurnEvent,
                    args: {
                      burnToken: chain.usdc,
                      depositor: filter.depositor as Hex,
                    },
                    fromBlock,
                    toBlock,
                    strict: true,
                  })
                )
                const burns = logs
                  .filter(
                    (log) =>
                      !log.removed &&
                      log.address.toLowerCase() ===
                        chain.tokenMessenger.toLowerCase()
                  )
                  .map((log): FoundBurn => ({
                    transactionHash: log.transactionHash.toLowerCase(),
                    amount: log.args.amount,
                    destinationDomain: log.args.destinationDomain,
                    mintRecipient: log.args.mintRecipient.toLowerCase() as Hex,
                    destinationCaller:
                      log.args.destinationCaller.toLowerCase() as Hex,
                    maxFee: log.args.maxFee,
                    minFinalityThreshold: log.args.minFinalityThreshold,
                    hookData: log.args.hookData.toLowerCase() as Hex,
                  }))
                return [burns, Option.some(toBlock + 1n)] as const
              })
            )
          })
        ),

      // An EVM account needs nothing prepared to receive USDC.
      prepareRecipient: (recipient) => Effect.asVoid(toBytes32(recipient)),

      estimateClaimCost: Effect.fn("EvmAdapter.estimateClaimCost")(
        function* (message, attestation) {
          yield* checkChain
          const from = Option.isSome(signerOption)
            ? yield* signerOption.value.address(chain)
            : undefined
          const gas = withHeadroom(
            yield* preflightClaim(from, message, attestation)
          )
          const price = yield* rpc("eth_gasPrice", () => client.getGasPrice())
          return { amount: gas * price, unit: "wei" }
        }
      ),

      claim: Effect.fn("EvmAdapter.claim")(function* (message, attestation) {
        const account = yield* signer
        yield* checkChain
        const gas = yield* preflightClaim(account.address, message, attestation)
        const transactionHash = yield* transact(
          account,
          chain.messageTransmitter,
          receiveMessage(message, attestation),
          gas
        )
        return { transactionHash }
      }),

      expirationHeight:
        chain.expirationClock === "parent"
          ? Effect.succeed(Option.none())
          : checkChain.pipe(
              Effect.andThen(
                rpc("eth_blockNumber", () => client.getBlockNumber())
              ),
              Effect.map(Option.some)
            ),
    }
    return adapter
  })
