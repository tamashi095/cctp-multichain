import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js"
import { fromHex, toHex } from "../src/core/bytes.ts"
import * as Message from "../src/core/message.ts"
import { mainnet } from "../src/core/registry.ts"
import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAccount,
  decodeDepositForBurn,
  depositForBurnInstruction,
  Discriminator,
  tokenMessengerAccount,
  usedNonceAccount,
} from "../src/solana/instructions.ts"
import * as SolanaAdapter from "../src/solana/SolanaAdapter.ts"
import { SolanaSigner } from "../src/solana/SolanaSigner.ts"
import captured from "./fixtures/captured.json" with { type: "json" }

const chain = mainnet.solana
const mint = new PublicKey(chain.usdc)
const blockhash = PublicKey.default.toBase58()

// A real attested Base → Solana message and the state Solana held for it.
const real = captured.baseToSolana.iris.body.messages[0]!
const message = fromHex(real.message)
const attestation = fromHex(real.attestation)
const decoded = Message.decodeBurnMessage(message)
const recipientAccount = new PublicKey(fromHex(decoded.mintRecipient))
const usedNonce = usedNonceAccount(chain, fromHex(decoded.nonce))
const tokenMessengerData = Buffer.from(
  fromHex(captured.solana.receive.tokenMessengerData)
)

const tokenAccountData = (amount: bigint) => {
  const data = Buffer.alloc(165)
  data.writeBigUInt64LE(amount, 64)
  return data
}

/** A scripted cluster: the accounts a test sets, and the transactions it was sent. */
const cluster = () => {
  const state = {
    genesisHash: chain.genesisHash as string,
    accounts: new Map<string, { owner: PublicKey; data: Buffer }>([
      [
        tokenMessengerAccount(chain).toBase58(),
        {
          owner: new PublicKey(chain.tokenMessengerMinter),
          data: tokenMessengerData,
        },
      ],
      [
        recipientAccount.toBase58(),
        { owner: PublicKey.default, data: tokenAccountData(0n) },
      ],
    ]),
    lamports: 1_000_000_000,
    simulationError: null as unknown,
    sendFails: false,
    sent: [] as Array<VersionedTransaction>,
    signatures: [] as Array<{ signature: string; err: null }>,
    transactions: new Map<string, unknown>(),
    signatureRequests: [] as Array<unknown>,
  }
  const connection = {
    getGenesisHash: async () => state.genesisHash,
    getAccountInfo: async (key: PublicKey) =>
      state.accounts.get(key.toBase58()) ?? null,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1 }),
    getFeeForMessage: async () => ({ value: 5_000 }),
    getBalance: async () => state.lamports,
    getMinimumBalanceForRentExemption: async (size: number) =>
      890_880 + size * 6_960,
    simulateTransaction: async () => ({
      value: { err: state.simulationError, logs: ["log"] },
    }),
    sendRawTransaction: async (raw: Uint8Array) => {
      if (state.sendFails) throw new Error("socket hang up")
      state.sent.push(VersionedTransaction.deserialize(raw))
      return `signature${state.sent.length}`
    },
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignaturesForAddress: async (
      _key: PublicKey,
      options: unknown,
      commitment: string
    ) => {
      state.signatureRequests.push([options, commitment])
      return state.signatures
    },
    getTransaction: async (signature: string) =>
      state.transactions.get(signature) ?? null,
  } as unknown as Connection
  return { state, connection }
}

const payer = Keypair.generate()
const signerLayer = SolanaSigner.layerKeypair(payer)

const setup = (signer: Layer.Layer<SolanaSigner> | "none" = signerLayer) => {
  const made = cluster()
  return {
    ...made,
    adapter: SolanaAdapter.make(chain, { connection: made.connection }).pipe(
      Effect.provide(signer === "none" ? Layer.empty : signer)
    ),
  }
}

const instructionsOf = (transaction: VersionedTransaction) =>
  transaction.message.compiledInstructions.map((instruction) => ({
    program:
      transaction.message.staticAccountKeys[
        instruction.programIdIndex
      ]!.toBase58(),
    data: instruction.data,
  }))

describe("SolanaAdapter", () => {
  it.effect("mints to the wallet's associated token account", () =>
    Effect.gen(function* () {
      const adapter = yield* setup("none").adapter
      const owner = Keypair.generate().publicKey
      assert.strictEqual(
        yield* adapter.recipientFromAddress(owner.toBase58()),
        toHex(associatedTokenAccount(owner, mint).toBytes())
      )
      assert.strictEqual(
        yield* adapter.toBytes32(owner.toBase58()),
        toHex(owner.toBytes())
      )
      assert.strictEqual(
        adapter.messenger,
        toHex(new PublicKey(chain.tokenMessengerMinter).toBytes())
      )
      assert.strictEqual(adapter.usdc, toHex(mint.toBytes()))
      assert.strictEqual(
        (yield* Effect.flip(adapter.recipientFromAddress("0xabc")))._tag,
        "InvalidAddress"
      )
    })
  )

  it.effect("reads the used-nonce account as the delivery oracle", () => {
    const { state, adapter } = setup("none")
    const account = (flag: number, owner = chain.messageTransmitter) => ({
      owner: new PublicKey(owner),
      data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, flag]),
    })
    return Effect.gen(function* () {
      const a = yield* adapter
      assert.isFalse(yield* a.isNonceUsed(decoded.nonce))
      state.accounts.set(usedNonce.toBase58(), account(1))
      assert.isTrue(yield* a.isNonceUsed(decoded.nonce))
      state.accounts.set(usedNonce.toBase58(), account(0))
      assert.isFalse(yield* a.isNonceUsed(decoded.nonce))
      // An account someone else owns at that address proves nothing.
      state.accounts.set(
        usedNonce.toBase58(),
        account(1, chain.tokenMessengerMinter)
      )
      assert.isFalse(yield* a.isNonceUsed(decoded.nonce))
      state.genesisHash = mainnet.solana.usdc
      assert.strictEqual(
        (yield* Effect.flip(a.isNonceUsed(decoded.nonce)))._tag,
        "ChainIdMismatch"
      )
    })
  })

  it.effect("claims a real message with one signed receive_message", () => {
    const { state, adapter } = setup()
    return Effect.gen(function* () {
      const a = yield* adapter
      const cost = yield* a.estimateClaimCost(message, attestation)
      assert.strictEqual(cost.unit, "lamports")
      assert.strictEqual(cost.amount, 5_000n + 890_880n + 9n * 6_960n)

      const claim = yield* a.claim(message, attestation)
      assert.strictEqual(claim.transactionHash, "signature1")
      const [sent] = state.sent
      const [instruction] = instructionsOf(sent!)
      assert.strictEqual(instruction!.program, chain.messageTransmitter)
      assert.deepStrictEqual(
        [...instruction!.data.subarray(0, 8)],
        [...Discriminator.receiveMessage]
      )
      assert.strictEqual(sent!.message.compiledInstructions.length, 1)
      assert.isTrue(sent!.message.staticAccountKeys[0]!.equals(payer.publicKey))
      assert.isTrue(sent!.signatures[0]!.some((byte) => byte !== 0))
    })
  })

  it.effect("names why a claim cannot go through, before signing", () =>
    Effect.gen(function* () {
      const tagOf = (
        prepare: (state: ReturnType<typeof cluster>["state"]) => void,
        signer: Layer.Layer<SolanaSigner> | "none" = signerLayer,
        bytes = message
      ) => {
        const made = setup(signer)
        prepare(made.state)
        return Effect.gen(function* () {
          const error = yield* Effect.flip(
            (yield* made.adapter).claim(bytes, attestation)
          )
          assert.strictEqual(made.state.sent.length, 0)
          return error._tag
        })
      }
      assert.strictEqual(yield* tagOf(() => {}, "none"), "SignerUnavailable")
      assert.strictEqual(
        yield* tagOf(
          (s) => void s.accounts.delete(recipientAccount.toBase58())
        ),
        "RecipientAccountMissing"
      )
      assert.strictEqual(
        yield* tagOf(
          (s) =>
            void s.accounts.set(usedNonce.toBase58(), {
              owner: new PublicKey(chain.messageTransmitter),
              data: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 1]),
            })
        ),
        "NonceAlreadyUsed"
      )
      assert.strictEqual(
        yield* tagOf((s) => void (s.lamports = 100)),
        "InsufficientGas"
      )
      assert.strictEqual(
        yield* tagOf(
          (s) =>
            void (s.simulationError = {
              InstructionError: [0, { Custom: 6000 }],
            })
        ),
        "TransactionFailed"
      )
      assert.strictEqual(
        yield* tagOf((s) => void (s.genesisHash = "other")),
        "ChainIdMismatch"
      )
      // A message for another chain is not claimable here.
      assert.strictEqual(
        yield* tagOf(
          () => {},
          signerLayer,
          fromHex(captured.baseToEvm.iris.body.messages[0]!.message)
        ),
        "MalformedMessage"
      )
    })
  )

  it.effect(
    "reports a send that may have gone out as SubmissionUnknown",
    () => {
      const { state, adapter } = setup()
      state.sendFails = true
      return Effect.gen(function* () {
        const error = yield* Effect.flip(
          (yield* adapter).claim(message, attestation)
        )
        assert.strictEqual(error._tag, "SubmissionUnknown")
      })
    }
  )

  it.effect(
    "creates the recipient's token account only when it is missing",
    () => {
      const { state, adapter } = setup()
      const owner = Keypair.generate().publicKey
      return Effect.gen(function* () {
        const a = yield* adapter
        yield* a.prepareRecipient(owner.toBase58())
        assert.strictEqual(state.sent.length, 1)
        const [instruction] = instructionsOf(state.sent[0]!)
        assert.strictEqual(
          instruction!.program,
          ASSOCIATED_TOKEN_PROGRAM.toBase58()
        )
        assert.deepStrictEqual([...instruction!.data], [1])

        state.accounts.set(associatedTokenAccount(owner, mint).toBase58(), {
          owner: PublicKey.default,
          data: tokenAccountData(0n),
        })
        yield* a.prepareRecipient(owner.toBase58())
        assert.strictEqual(state.sent.length, 1)
      })
    }
  )

  const burnParams = {
    sender: payer.publicKey.toBase58(),
    amount: 5_000_000n,
    destinationDomain: 6,
    mintRecipient: `0x${"00".repeat(12)}${"ab".repeat(20)}`,
    destinationCaller: `0x${"00".repeat(32)}`,
    maxFee: 500n,
    minFinalityThreshold: 1000,
    hookData: new Uint8Array(),
  } as const

  it.effect(
    "burns with deposit_for_burn, signed by the owner and the event account",
    () => {
      const { state, adapter } = setup()
      state.accounts.set(
        associatedTokenAccount(payer.publicKey, mint).toBase58(),
        {
          owner: PublicKey.default,
          data: tokenAccountData(6_000_000n),
        }
      )
      return Effect.gen(function* () {
        const burn = yield* (yield* adapter).burn(burnParams)
        assert.strictEqual(burn.transactionHash, "signature1")
        const sent = state.sent[0]!
        assert.strictEqual(sent.message.header.numRequiredSignatures, 2)
        assert.isTrue(
          sent.signatures.every((s) => s.some((byte) => byte !== 0))
        )
        const [instruction] = instructionsOf(sent)
        assert.strictEqual(instruction!.program, chain.tokenMessengerMinter)
        assert.deepStrictEqual(decodeDepositForBurn(instruction!.data), {
          amount: 5_000_000n,
          destinationDomain: 6,
          mintRecipient: fromHex(burnParams.mintRecipient),
          destinationCaller: new Uint8Array(32),
          maxFee: 500n,
          minFinalityThreshold: 1000,
          hookData: new Uint8Array(),
        })
      })
    }
  )

  it.effect(
    "refuses to burn more than the token account holds, or for another sender",
    () => {
      const { state, adapter } = setup()
      return Effect.gen(function* () {
        const a = yield* adapter
        assert.strictEqual(
          (yield* Effect.flip(a.burn(burnParams)))._tag,
          "InsufficientBalance"
        )
        const other = Keypair.generate().publicKey.toBase58()
        assert.strictEqual(
          (yield* Effect.flip(a.burn({ ...burnParams, sender: other })))._tag,
          "SignerError"
        )
        assert.strictEqual(state.sent.length, 0)
      })
    }
  )

  it.effect("finds the sender's finalized burns after the cursor", () => {
    const { state, adapter } = setup("none")
    const owner = Keypair.generate().publicKey
    const args = {
      amount: 77n,
      destinationDomain: 6,
      mintRecipient: new Uint8Array(32).fill(3),
      destinationCaller: new Uint8Array(32),
      maxFee: 1n,
      minFinalityThreshold: 2000,
      hookData: new Uint8Array(),
    }
    const burnBy = (burner: PublicKey) => ({
      meta: { err: null },
      transaction: {
        message: new TransactionMessage({
          payerKey: burner,
          recentBlockhash: blockhash,
          instructions: [
            depositForBurnInstruction(
              chain,
              {
                owner: burner,
                eventRentPayer: burner,
                burnTokenAccount: associatedTokenAccount(burner, mint),
                messageSentEventData: Keypair.generate().publicKey,
              },
              args
            ),
          ],
        }).compileToV0Message(),
      },
    })
    state.signatures = [
      { signature: "mine", err: null },
      { signature: "someoneElse", err: null },
      { signature: "pruned", err: null },
    ]
    state.transactions.set("mine", burnBy(owner))
    state.transactions.set("someoneElse", burnBy(Keypair.generate().publicKey))
    return Effect.gen(function* () {
      const a = yield* adapter
      assert.strictEqual(yield* a.burnCursor(owner.toBase58()), "mine")
      const burns = yield* Stream.runCollect(
        a.findBurns({ depositor: owner.toBase58(), since: "cursor" })
      )
      assert.deepStrictEqual(burns, [
        {
          transactionHash: "mine",
          amount: 77n,
          destinationDomain: 6,
          mintRecipient: toHex(args.mintRecipient),
          destinationCaller: `0x${"00".repeat(32)}`,
          maxFee: 1n,
          minFinalityThreshold: 2000,
          hookData: "0x",
        },
      ])
      // Finalized only, and no further back than the cursor.
      assert.deepStrictEqual(state.signatureRequests.at(-1), [
        { limit: 100, until: "cursor" },
        "finalized",
      ])
    })
  })
})
