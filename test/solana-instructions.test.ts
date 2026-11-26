import { createHash } from "node:crypto"
import { assert, describe, it } from "@effect/vitest"
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js"
import { fromHex, toHex } from "../src/core/bytes.ts"
import * as Message from "../src/core/message.ts"
import { mainnet, testnet } from "../src/core/registry.ts"
import {
  associatedTokenAccount,
  decodeDepositForBurn,
  depositForBurnInstruction,
  Discriminator,
  encodeDepositForBurn,
  encodeReceiveMessage,
  feeRecipientOf,
  receiveMessageInstruction,
  usedNonceAccount,
  type DepositForBurnArgs,
} from "../src/solana/instructions.ts"
import captured from "./fixtures/captured.json" with { type: "json" }
// Circle's IDLs: github.com/circlefin/solana-cctp-contracts, examples/target/idl,
// at ec16e95d28ee47f7832df4203ae07b5981d146fc.
import transmitterIdl from "./fixtures/idl/message_transmitter_v2.json" with { type: "json" }
import messengerIdl from "./fixtures/idl/token_messenger_minter_v2.json" with { type: "json" }

interface IdlAccount {
  name: string
  writable?: boolean
  signer?: boolean
  address?: string
  pda?: { seeds: Array<{ kind: string; value?: Array<number> }> }
}
interface Idl {
  address: string
  instructions: Array<{
    name: string
    discriminator: Array<number>
    accounts: Array<IdlAccount>
    args: Array<{ name: string; type: { defined: { name: string } } }>
  }>
  types: Array<{
    name: string
    type: { fields: Array<{ name: string; type: string }> }
  }>
}

const instructionOf = (idl: Idl, name: string) =>
  idl.instructions.find((i) => i.name === name)!

/** Reads instruction data the way the IDL's argument struct says. */
const readArgs = (idl: Idl, name: string, data: Uint8Array) => {
  const instruction = instructionOf(idl, name)
  const struct = idl.types.find(
    (t) => t.name === instruction.args[0]!.type.defined.name
  )!
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 8
  const out: Record<string, unknown> = {}
  for (const field of struct.type.fields) {
    switch (field.type) {
      case "u64":
        out[field.name] = view.getBigUint64(offset, true)
        offset += 8
        break
      case "u32":
        out[field.name] = view.getUint32(offset, true)
        offset += 4
        break
      case "pubkey":
        out[field.name] = toHex(data.slice(offset, offset + 32))
        offset += 32
        break
      case "bytes": {
        const length = view.getUint32(offset, true)
        out[field.name] = toHex(data.slice(offset + 4, offset + 4 + length))
        offset += 4 + length
        break
      }
      default:
        throw new Error(`unhandled IDL type ${field.type}`)
    }
  }
  assert.strictEqual(offset, data.length, "no trailing bytes")
  return out
}

/** Checks built accounts against the IDL's: order, flags, fixed addresses, constant-seed PDAs. */
const assertAccounts = (
  idl: Idl,
  name: string,
  instruction: TransactionInstruction
) => {
  const accounts = instructionOf(idl, name).accounts
  assert.strictEqual(instruction.programId.toBase58(), idl.address)
  accounts.forEach((account, i) => {
    const key = instruction.keys[i]!
    assert.strictEqual(
      key.isSigner,
      account.signer === true,
      `${account.name} signer`
    )
    assert.strictEqual(
      key.isWritable,
      account.writable === true,
      `${account.name} writable`
    )
    if (account.address !== undefined)
      assert.strictEqual(key.pubkey.toBase58(), account.address, account.name)
    const seeds = account.pda?.seeds
    if (seeds !== undefined && seeds.every((s) => s.kind === "const"))
      assert.strictEqual(
        key.pubkey.toBase58(),
        PublicKey.findProgramAddressSync(
          seeds.map((s) => Uint8Array.from(s.value!)),
          new PublicKey(idl.address)
        )[0].toBase58(),
        account.name
      )
  })
  return accounts.length
}

const args: DepositForBurnArgs = {
  amount: 1_234_567_890_123n,
  destinationDomain: 6,
  mintRecipient: new Uint8Array(32).fill(0xaa),
  destinationCaller: new Uint8Array(32),
  maxFee: 4_242n,
  minFinalityThreshold: 1000,
  hookData: new Uint8Array(),
}
const owner = Keypair.generate().publicKey
const eventAccount = Keypair.generate().publicKey
const burnAccounts = {
  owner,
  eventRentPayer: owner,
  burnTokenAccount: associatedTokenAccount(
    owner,
    new PublicKey(mainnet.solana.usdc)
  ),
  messageSentEventData: eventAccount,
}

describe("Solana instructions against Circle's IDL", () => {
  it("uses the IDL's program ids on both networks", () => {
    for (const chain of [mainnet.solana, testnet.solana]) {
      assert.strictEqual(chain.tokenMessengerMinter, messengerIdl.address)
      assert.strictEqual(chain.messageTransmitter, transmitterIdl.address)
    }
  })

  it.each([
    ["deposit_for_burn", Discriminator.depositForBurn, messengerIdl],
    [
      "deposit_for_burn_with_hook",
      Discriminator.depositForBurnWithHook,
      messengerIdl,
    ],
    ["receive_message", Discriminator.receiveMessage, transmitterIdl],
  ] as const)(
    "%s has the IDL's discriminator, which is Anchor's hash",
    (name, ours, idl) => {
      assert.deepStrictEqual(
        [...ours],
        instructionOf(idl as Idl, name).discriminator
      )
      const hash = createHash("sha256").update(`global:${name}`).digest()
      assert.deepStrictEqual([...ours], [...hash.subarray(0, 8)])
    }
  )

  it("encodes deposit_for_burn as the IDL lays it out", () => {
    const instruction = depositForBurnInstruction(
      mainnet.solana,
      burnAccounts,
      args
    )
    // The IDL's eighteen accounts, then the two Circle's quickstart adds.
    assert.strictEqual(
      assertAccounts(messengerIdl as Idl, "deposit_for_burn", instruction),
      18
    )
    assert.deepStrictEqual(
      instruction.keys
        .slice(18)
        .map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
      [
        [
          PublicKey.findProgramAddressSync(
            [new TextEncoder().encode("__event_authority")],
            new PublicKey(transmitterIdl.address)
          )[0].toBase58(),
          false,
          false,
        ],
        [transmitterIdl.address, false, false],
      ]
    )
    assert.deepStrictEqual(
      readArgs(messengerIdl as Idl, "deposit_for_burn", instruction.data),
      {
        amount: args.amount,
        destination_domain: 6,
        mint_recipient: toHex(args.mintRecipient),
        destination_caller: toHex(args.destinationCaller),
        max_fee: args.maxFee,
        min_finality_threshold: 1000,
      }
    )
    // The accounts the IDL leaves to the caller.
    assert.isTrue(instruction.keys[0]!.pubkey.equals(owner))
    assert.isTrue(
      instruction.keys[3]!.pubkey.equals(burnAccounts.burnTokenAccount)
    )
    assert.strictEqual(
      instruction.keys[10]!.pubkey.toBase58(),
      mainnet.solana.usdc
    )
    assert.isTrue(instruction.keys[11]!.pubkey.equals(eventAccount))
    assert.strictEqual(
      instruction.keys[17]!.pubkey.toBase58(),
      messengerIdl.address
    )
  })

  it("encodes deposit_for_burn_with_hook when there is hook data", () => {
    const hookData = new Uint8Array([9, 8, 7, 6, 5])
    const instruction = depositForBurnInstruction(
      mainnet.solana,
      burnAccounts,
      {
        ...args,
        hookData,
      }
    )
    assertAccounts(
      messengerIdl as Idl,
      "deposit_for_burn_with_hook",
      instruction
    )
    const read = readArgs(
      messengerIdl as Idl,
      "deposit_for_burn_with_hook",
      instruction.data
    )
    assert.strictEqual(read.hook_data, toHex(hookData))
    assert.strictEqual(read.amount, args.amount)
  })

  it("decodes what it encodes, and nothing else", () => {
    for (const hookData of [new Uint8Array(), new Uint8Array([1, 2, 3])]) {
      const burn = { ...args, hookData }
      assert.deepStrictEqual(
        decodeDepositForBurn(encodeDepositForBurn(burn)),
        burn
      )
    }
    const data = encodeDepositForBurn(args)
    assert.isUndefined(decodeDepositForBurn(data.slice(0, 95)))
    assert.isUndefined(decodeDepositForBurn(Uint8Array.from([...data, 0])))
    assert.isUndefined(decodeDepositForBurn(encodeReceiveMessage(data, data)))
    assert.throws(() =>
      encodeDepositForBurn({ ...args, mintRecipient: new Uint8Array(20) })
    )
    assert.throws(() => encodeDepositForBurn({ ...args, amount: 1n << 64n }))
  })

  it("encodes receive_message as the IDL lays it out", () => {
    const message = fromHex(
      captured.baseToSolana.iris.body.messages[0]!.message
    )
    const attestation = fromHex(
      captured.baseToSolana.iris.body.messages[0]!.attestation
    )
    const decoded = Message.decodeBurnMessage(message)
    const instruction = receiveMessageInstruction(
      mainnet.solana,
      {
        payer: owner,
        caller: owner,
        feeRecipient: Keypair.generate().publicKey,
      },
      {
        bytes: message,
        attestation,
        sourceDomain: decoded.sourceDomain,
        nonce: fromHex(decoded.nonce),
        burnToken: fromHex(decoded.burnToken),
        mintRecipient: fromHex(decoded.mintRecipient),
      }
    )
    // The IDL's nine accounts, then the eleven forwarded to the token messenger.
    assert.strictEqual(
      assertAccounts(transmitterIdl as Idl, "receive_message", instruction),
      9
    )
    assert.strictEqual(instruction.keys.length, 20)
    assert.strictEqual(
      instruction.keys[5]!.pubkey.toBase58(),
      messengerIdl.address
    )
    assert.deepStrictEqual(
      readArgs(transmitterIdl as Idl, "receive_message", instruction.data),
      {
        message: toHex(message),
        attestation: toHex(attestation),
      }
    )
  })
})

describe("Solana instructions against real mainnet transactions", () => {
  const keysOf = (instruction: TransactionInstruction) =>
    instruction.keys.map((k) => k.pubkey.toBase58())

  it("rebuilds a real deposit_for_burn: same data, same twenty accounts", () => {
    const real = captured.solana.burn
    const data = fromHex(real.data)
    const burn = decodeDepositForBurn(data)!
    const instruction = depositForBurnInstruction(
      mainnet.solana,
      {
        owner: new PublicKey(real.accounts[0]!.pubkey),
        eventRentPayer: new PublicKey(real.accounts[1]!.pubkey),
        burnTokenAccount: new PublicKey(real.accounts[3]!.pubkey),
        messageSentEventData: new PublicKey(real.accounts[11]!.pubkey),
      },
      burn
    )
    assert.strictEqual(toHex(instruction.data), real.data)
    assert.deepStrictEqual(
      keysOf(instruction),
      real.accounts.map((a) => a.pubkey)
    )
    instruction.keys.forEach((key, i) => {
      // A transaction-wide flag is at least what the instruction asks for.
      if (key.isSigner) assert.isTrue(real.accounts[i]!.isSigner, `signer ${i}`)
      if (key.isWritable)
        assert.isTrue(real.accounts[i]!.isWritable, `writable ${i}`)
    })
  })

  it("rebuilds a real receive_message: same data, same twenty accounts", () => {
    const real = captured.solana.receive
    const data = fromHex(real.data)
    const view = new DataView(data.buffer)
    const messageLength = view.getUint32(8, true)
    const message = data.slice(12, 12 + messageLength)
    const attestation = data.slice(16 + messageLength)
    const decoded = Message.decodeBurnMessage(message)
    const instruction = receiveMessageInstruction(
      mainnet.solana,
      {
        payer: new PublicKey(real.accounts[0]!.pubkey),
        caller: new PublicKey(real.accounts[1]!.pubkey),
        feeRecipient: feeRecipientOf(fromHex(real.tokenMessengerData)),
      },
      {
        bytes: message,
        attestation,
        sourceDomain: decoded.sourceDomain,
        nonce: fromHex(decoded.nonce),
        burnToken: fromHex(decoded.burnToken),
        mintRecipient: fromHex(decoded.mintRecipient),
      }
    )
    assert.strictEqual(toHex(instruction.data), real.data)
    assert.deepStrictEqual(
      keysOf(instruction),
      real.accounts.map((a) => a.pubkey)
    )
    instruction.keys.forEach((key, i) => {
      if (key.isSigner) assert.isTrue(real.accounts[i]!.isSigner, `signer ${i}`)
      // The caller is also the payer here, which makes it writable transaction-wide.
      if (i !== 1)
        assert.strictEqual(
          key.isWritable,
          real.accounts[i]!.isWritable,
          `writable ${i}`
        )
    })
    assert.strictEqual(
      usedNonceAccount(mainnet.solana, fromHex(decoded.nonce)).toBase58(),
      real.accounts[4]!.pubkey
    )
  })

  it("fits a bare claim in one transaction without a lookup table", () => {
    const real = captured.solana.receive
    const data = fromHex(real.data)
    const messageLength = new DataView(data.buffer).getUint32(8, true)
    const message = data.slice(12, 12 + messageLength)
    const decoded = Message.decodeBurnMessage(message)
    const payer = Keypair.generate()
    const instruction = receiveMessageInstruction(
      mainnet.solana,
      {
        payer: payer.publicKey,
        caller: payer.publicKey,
        feeRecipient: feeRecipientOf(fromHex(real.tokenMessengerData)),
      },
      {
        bytes: message,
        attestation: data.slice(16 + messageLength),
        sourceDomain: decoded.sourceDomain,
        nonce: fromHex(decoded.nonce),
        burnToken: fromHex(decoded.burnToken),
        mintRecipient: fromHex(decoded.mintRecipient),
      }
    )
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: PublicKey.default.toBase58(),
        instructions: [instruction],
      }).compileToV0Message()
    )
    // Signed only in memory, to measure it. Solana's packet limit is 1232 bytes.
    transaction.sign([payer])
    assert.isAtMost(transaction.serialize().length, 1232)
  })
})
