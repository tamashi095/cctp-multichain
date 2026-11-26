/**
 * The Solana adapter, over Circle's two CCTP V2 programs.
 *
 * Burn: `TokenMessengerMinterV2.deposit_for_burn` (or `..._with_hook`).
 * Claim: `MessageTransmitterV2.receive_message`. Delivery oracle: the
 * message's used-nonce account.
 * https://developers.circle.com/cctp/references/solana-programs
 */
import { Effect, Option, Stream } from "effect"
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js"
import { fromHex, toHex, type Hex } from "../core/bytes.ts"
import type { ChainAdapter, FoundBurn } from "../core/ChainAdapter.ts"
import type { SolanaChainRef } from "../core/domain.ts"
import {
  ChainError,
  ChainIdMismatch,
  InsufficientBalance,
  InsufficientGas,
  InvalidAddress,
  MalformedMessage,
  NonceAlreadyUsed,
  reasonOf,
  RecipientAccountMissing,
  SignerError,
  SignerUnavailable,
  SubmissionUnknown,
  TransactionFailed,
} from "../core/errors.ts"
import * as Message from "../core/message.ts"
import {
  associatedTokenAccount,
  createAssociatedTokenAccountIdempotent,
  decodeDepositForBurn,
  depositForBurnInstruction,
  feeRecipientOf,
  programsOf,
  receiveMessageInstruction,
  tokenMessengerAccount,
  usedNonceAccount,
} from "./instructions.ts"
import { SolanaSigner } from "./SolanaSigner.ts"

export interface SolanaAdapterOptions {
  readonly connection: Connection
  /**
   * Address lookup tables to compile transactions with. A bare
   * `receive_message` fits a transaction without one, with a few bytes to
   * spare; a priority fee, or hook data, needs a table holding the CCTP
   * accounts.
   *
   * TODO(unverified): Circle's documentation names no lookup table, so none
   * is built in. Supply the address of one you have checked.
   */
  readonly lookupTables?: ReadonlyArray<string>
  /** A priority fee in micro-lamports per compute unit. Default none. */
  readonly computeUnitPrice?: number
  /** Signatures `findBurns` reads per request. Default 100. */
  readonly signatureLimit?: number
}

/** Data sizes of the accounts a burn and a claim create, for the rent they cost. */
const TOKEN_ACCOUNT_SIZE = 165
/** UsedNonce: discriminator and a bool. */
const USED_NONCE_SIZE = 9
/** MessageSent: discriminator, rent payer, created-at, and the message as `bytes`. */
const messageSentSize = (hookLength: number) =>
  8 + 32 + 8 + 4 + Message.BURN_MESSAGE_MIN_LENGTH + hookLength

/**
 * The adapter for `chain`. It uses the `SolanaSigner` in the context when
 * one is provided and is read-only otherwise: writes then fail with
 * `SignerUnavailable`.
 */
export const make = (
  chain: SolanaChainRef,
  options: SolanaAdapterOptions
): Effect.Effect<ChainAdapter> =>
  Effect.gen(function* () {
    const { connection } = options
    const signerOption = yield* Effect.serviceOption(SolanaSigner)
    const domain = chain.domain
    const programs = programsOf(chain)
    const mint = new PublicKey(chain.usdc)

    const rpc = <A>(method: string, call: () => Promise<A>) =>
      Effect.tryPromise({
        try: call,
        catch: (cause) =>
          new ChainError({ domain, method, reason: reasonOf(cause) }),
      })

    /** Circle's programs have one id on every cluster: a wrong RPC must fail loudly. */
    const checkCluster = rpc("getGenesisHash", () =>
      connection.getGenesisHash()
    ).pipe(
      Effect.flatMap((actual) =>
        actual === chain.genesisHash
          ? Effect.void
          : Effect.fail(
              new ChainIdMismatch({
                domain,
                expected: chain.genesisHash,
                actual,
              })
            )
      )
    )

    const publicKey = (address: string) =>
      Effect.try({
        try: () => new PublicKey(address),
        catch: () =>
          new InvalidAddress({
            family: "solana",
            address,
            reason: "not a base58 public key",
          }),
      })

    const signer = Option.match(signerOption, {
      onNone: () => Effect.fail(new SignerUnavailable({ family: "solana" })),
      onSome: (s) =>
        Effect.map(s.address, (address) => ({
          publicKey: new PublicKey(address),
          sign: s.signTransaction,
        })),
    })

    const isNonceUsed = Effect.fn("SolanaAdapter.isNonceUsed")(function* (
      nonce: Hex
    ) {
      yield* checkCluster
      const account = yield* rpc("getAccountInfo", () =>
        connection.getAccountInfo(usedNonceAccount(chain, fromHex(nonce)))
      )
      // As the program's own `is_nonce_used`: no data is unused; then the flag.
      return (
        account !== null &&
        account.owner.equals(programs.messageTransmitter) &&
        account.data.length >= USED_NONCE_SIZE &&
        account.data[8] === 1
      )
    })

    const lookupTables = Effect.forEach(options.lookupTables ?? [], (address) =>
      rpc("getAddressLookupTable", () =>
        connection.getAddressLookupTable(new PublicKey(address))
      ).pipe(
        Effect.flatMap(({ value }) =>
          value === null
            ? Effect.fail(
                new ChainError({
                  domain,
                  method: "getAddressLookupTable",
                  reason: `no lookup table at ${address}`,
                })
              )
            : Effect.succeed<AddressLookupTableAccount>(value)
        )
      )
    )

    /**
     * Compile, check the payer can afford it, simulate, sign, send and wait
     * for confirmation. `rent` is what the instructions will lock up.
     */
    const transact = Effect.fnUntraced(function* (
      account: {
        readonly publicKey: PublicKey
        readonly sign: SolanaSigner["Service"]["signTransaction"]
      },
      instructions: ReadonlyArray<TransactionInstruction>,
      rent: bigint,
      extraSigners: ReadonlyArray<Keypair> = []
    ) {
      const tables = yield* lookupTables
      const latest = yield* rpc("getLatestBlockhash", () =>
        connection.getLatestBlockhash()
      )
      const transaction = yield* Effect.try({
        try: () => {
          const compiled = new TransactionMessage({
            payerKey: account.publicKey,
            recentBlockhash: latest.blockhash,
            instructions: [
              ...(options.computeUnitPrice === undefined
                ? []
                : [
                    ComputeBudgetProgram.setComputeUnitPrice({
                      microLamports: options.computeUnitPrice,
                    }),
                  ]),
              ...instructions,
            ],
          }).compileToV0Message(tables)
          const built = new VersionedTransaction(compiled)
          // Fails here, before anything is signed, when it is over the size limit.
          built.serialize()
          return built
        },
        catch: (cause) =>
          new TransactionFailed({
            domain,
            reason: `the transaction cannot be built: ${reasonOf(cause)}`,
          }),
      })

      const fee = yield* rpc("getFeeForMessage", () =>
        connection.getFeeForMessage(transaction.message)
      )
      const available = BigInt(
        yield* rpc("getBalance", () => connection.getBalance(account.publicKey))
      )
      const required = BigInt(fee.value ?? 5000) + rent
      if (available < required)
        return yield* new InsufficientGas({
          domain,
          address: account.publicKey.toBase58(),
          required,
          available,
        })

      const simulated = yield* rpc("simulateTransaction", () =>
        connection.simulateTransaction(transaction, { sigVerify: false })
      )
      if (simulated.value.err !== null)
        return yield* new TransactionFailed({
          domain,
          reason: `simulation failed: ${JSON.stringify(simulated.value.err)} ${(simulated.value.logs ?? []).slice(-3).join(" | ")}`,
        })

      if (extraSigners.length > 0) transaction.sign([...extraSigners])
      const signed = yield* account.sign(transaction)
      const unknown = (transactionHash?: string) => (cause: unknown) =>
        new SubmissionUnknown({
          domain,
          reason: reasonOf(cause),
          ...(transactionHash === undefined ? {} : { transactionHash }),
        })
      const signature = yield* Effect.tryPromise({
        try: () => connection.sendRawTransaction(signed.serialize()),
        catch: unknown(),
      })
      const confirmed = yield* Effect.tryPromise({
        try: () =>
          connection.confirmTransaction({ signature, ...latest }, "confirmed"),
        catch: unknown(signature),
      })
      if (confirmed.value.err !== null)
        return yield* new TransactionFailed({
          domain,
          transactionHash: signature,
          reason: JSON.stringify(confirmed.value.err),
        })
      return signature
    })

    const rentFor = (size: number) =>
      rpc("getMinimumBalanceForRentExemption", () =>
        connection.getMinimumBalanceForRentExemption(size)
      ).pipe(Effect.map(BigInt))

    /** The claim instruction, after everything that would make it fail for a known reason. */
    const prepareClaim = Effect.fnUntraced(function* (
      payer: PublicKey,
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
      const mintRecipient = fromHex(decoded.mintRecipient)
      const recipientAccount = new PublicKey(mintRecipient)
      if (
        (yield* rpc("getAccountInfo", () =>
          connection.getAccountInfo(recipientAccount)
        )) === null
      )
        return yield* new RecipientAccountMissing({
          domain,
          account: recipientAccount.toBase58(),
        })
      const tokenMessenger = yield* rpc("getAccountInfo", () =>
        connection.getAccountInfo(tokenMessengerAccount(chain))
      )
      const feeRecipient = yield* Effect.try({
        try: () => feeRecipientOf(tokenMessenger?.data ?? new Uint8Array()),
        catch: (cause) =>
          new ChainError({
            domain,
            method: "getAccountInfo",
            reason: reasonOf(cause),
          }),
      })
      return receiveMessageInstruction(
        chain,
        { payer, caller: payer, feeRecipient },
        {
          bytes: message,
          attestation,
          sourceDomain: decoded.sourceDomain,
          nonce: fromHex(decoded.nonce),
          burnToken: fromHex(decoded.burnToken),
          mintRecipient,
        }
      )
    })

    const signaturesOf = (
      account: PublicKey,
      until: string | undefined,
      before?: string
    ) =>
      rpc("getSignaturesForAddress", () =>
        connection.getSignaturesForAddress(
          account,
          {
            limit: options.signatureLimit ?? 100,
            ...(until === undefined || until === "" ? {} : { until }),
            ...(before === undefined ? {} : { before }),
          },
          // Only finalized: a burn that can be rolled back is not a burn yet.
          "finalized"
        )
      )

    /** The top-level burns `depositor` made in one finalized transaction. */
    const burnsIn = Effect.fnUntraced(function* (
      signature: string,
      depositor: PublicKey
    ) {
      const transaction = yield* rpc("getTransaction", () =>
        connection.getTransaction(signature, {
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        })
      ).pipe(
        // A newer transaction version than this client reads cannot be one
        // of ours (burns here are v0): skip it rather than fail the scan.
        Effect.catchIf(
          (error) => /version .* is not supported/i.test(error.reason),
          () => Effect.succeed(null)
        )
      )
      if (transaction === null || transaction.meta?.err) return []
      const { message } = transaction.transaction
      const keys = message.getAccountKeys({
        accountKeysFromLookups: transaction.meta?.loadedAddresses ?? null,
      })
      const burns: Array<FoundBurn> = []
      for (const instruction of message.compiledInstructions) {
        const program = keys.get(instruction.programIdIndex)
        const owner = keys.get(instruction.accountKeyIndexes[0] ?? -1)
        if (
          program === undefined ||
          owner === undefined ||
          !program.equals(programs.tokenMessengerMinter) ||
          !owner.equals(depositor)
        )
          continue
        const args = decodeDepositForBurn(instruction.data)
        if (args !== undefined)
          burns.push({
            transactionHash: signature,
            amount: args.amount,
            destinationDomain: args.destinationDomain,
            mintRecipient: toHex(args.mintRecipient),
            destinationCaller: toHex(args.destinationCaller),
            maxFee: args.maxFee,
            minFinalityThreshold: args.minFinalityThreshold,
            hookData: toHex(args.hookData),
          })
      }
      return burns
    })

    const adapter: ChainAdapter = {
      chain,
      messenger: toHex(programs.tokenMessengerMinter.toBytes()),
      usdc: toHex(mint.toBytes()),
      isNonceUsed,
      toBytes32: (address) =>
        Effect.map(publicKey(address), (key) => toHex(key.toBytes())),
      // USDC is minted to a token account: the wallet's associated one.
      recipientFromAddress: (address) =>
        Effect.map(publicKey(address), (owner) =>
          toHex(associatedTokenAccount(owner, mint).toBytes())
        ),

      burnCursor: Effect.fn("SolanaAdapter.burnCursor")(function* (depositor) {
        const owner = yield* publicKey(depositor)
        yield* checkCluster
        const [latest] = yield* signaturesOf(
          associatedTokenAccount(owner, mint),
          undefined
        )
        return latest?.signature ?? ""
      }),

      burn: Effect.fn("SolanaAdapter.burn")(function* (params) {
        const owner = yield* publicKey(params.sender)
        const account = yield* signer
        if (!account.publicKey.equals(owner))
          return yield* new SignerError({
            family: "solana",
            reason: `the signer is ${account.publicKey.toBase58()}, not the sender ${params.sender}`,
          })
        yield* checkCluster
        const burnTokenAccount = associatedTokenAccount(owner, mint)
        const tokenAccount = yield* rpc("getAccountInfo", () =>
          connection.getAccountInfo(burnTokenAccount)
        )
        // An SPL token account holds its amount as a u64 after mint and owner.
        const available =
          tokenAccount === null || tokenAccount.data.length < 72
            ? 0n
            : new DataView(
                tokenAccount.data.buffer,
                tokenAccount.data.byteOffset
              ).getBigUint64(64, true)
        if (available < params.amount)
          return yield* new InsufficientBalance({
            domain,
            address: params.sender,
            required: params.amount,
            available,
          })
        // The message is stored in a fresh account that signs its own creation.
        const messageSentEventData = Keypair.generate()
        const instruction = yield* Effect.try({
          try: () =>
            depositForBurnInstruction(
              chain,
              {
                owner,
                eventRentPayer: owner,
                burnTokenAccount,
                messageSentEventData: messageSentEventData.publicKey,
              },
              {
                amount: params.amount,
                destinationDomain: params.destinationDomain,
                mintRecipient: fromHex(params.mintRecipient),
                destinationCaller: fromHex(params.destinationCaller),
                maxFee: params.maxFee,
                minFinalityThreshold: params.minFinalityThreshold,
                hookData: params.hookData,
              }
            ),
          catch: (cause) =>
            new TransactionFailed({ domain, reason: reasonOf(cause) }),
        })
        const transactionHash = yield* transact(
          account,
          [instruction],
          yield* rentFor(messageSentSize(params.hookData.length)),
          [messageSentEventData]
        )
        return { transactionHash }
      }),

      findBurns: (filter) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const depositor = yield* publicKey(filter.depositor)
            yield* checkCluster
            const tokenAccount = associatedTokenAccount(depositor, mint)
            // Newest first, a page at a time, back to the cursor.
            return Stream.paginate(undefined as string | undefined, (before) =>
              Effect.gen(function* () {
                const page = yield* signaturesOf(
                  tokenAccount,
                  filter.since,
                  before
                )
                const burns = yield* Effect.forEach(
                  page.filter((entry) => entry.err === null),
                  (entry) => burnsIn(entry.signature, depositor)
                )
                const last = page[page.length - 1]
                return [
                  burns.flat(),
                  page.length < (options.signatureLimit ?? 100) ||
                  last === undefined
                    ? Option.none<string | undefined>()
                    : Option.some<string | undefined>(last.signature),
                ] as const
              })
            )
          })
        ),

      prepareRecipient: Effect.fn("SolanaAdapter.prepareRecipient")(
        function* (recipient) {
          const owner = yield* publicKey(recipient)
          yield* checkCluster
          const tokenAccount = associatedTokenAccount(owner, mint)
          if (
            (yield* rpc("getAccountInfo", () =>
              connection.getAccountInfo(tokenAccount)
            )) !== null
          )
            return
          const account = yield* signer
          yield* transact(
            account,
            [
              createAssociatedTokenAccountIdempotent(
                account.publicKey,
                owner,
                mint
              ),
            ],
            yield* rentFor(TOKEN_ACCOUNT_SIZE)
          )
        }
      ),

      estimateClaimCost: Effect.fn("SolanaAdapter.estimateClaimCost")(
        function* (message, attestation) {
          const account = yield* signer
          const instruction = yield* prepareClaim(
            account.publicKey,
            message,
            attestation
          )
          const latest = yield* rpc("getLatestBlockhash", () =>
            connection.getLatestBlockhash()
          )
          const fee = yield* rpc("getFeeForMessage", () =>
            connection.getFeeForMessage(
              new TransactionMessage({
                payerKey: account.publicKey,
                recentBlockhash: latest.blockhash,
                instructions: [instruction],
              }).compileToV0Message()
            )
          )
          return {
            amount:
              BigInt(fee.value ?? 5000) + (yield* rentFor(USED_NONCE_SIZE)),
            unit: "lamports",
          }
        }
      ),

      claim: Effect.fn("SolanaAdapter.claim")(function* (message, attestation) {
        const account = yield* signer
        const instruction = yield* prepareClaim(
          account.publicKey,
          message,
          attestation
        )
        const transactionHash = yield* transact(
          account,
          [instruction],
          yield* rentFor(USED_NONCE_SIZE)
        )
        return { transactionHash }
      }),

      // TokenMessengerMinterV2 does not read `expirationBlock` (its handlers
      // in programs/v2 never call `expiration_block()`), so nothing expires here.
      expirationHeight: Effect.succeed(Option.none()),
    }
    return adapter
  })
