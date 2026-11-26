/**
 * Circle's Solana CCTP V2 instructions, built by hand from Circle's IDLs:
 * discriminators, argument layout (Borsh: little-endian integers, `bytes`
 * as a u32 length then the bytes), accounts and PDA seeds.
 *
 * Sources:
 * - IDLs: github.com/circlefin/solana-cctp-contracts, examples/target/idl
 *   (`token_messenger_minter_v2.json`, `message_transmitter_v2.json`), at
 *   ec16e95d28ee47f7832df4203ae07b5981d146fc; copies in `test/fixtures/idl`,
 *   which `test/solana-instructions.test.ts` checks this file against.
 * - PDA seeds and the accounts `receive_message` forwards to the token
 *   messenger: the programs' sources in the same repository
 *   (the `instructions` directories under programs/v2), and
 *   https://developers.circle.com/cctp/references/solana-programs
 *
 * Plain functions: this is byte packing, wrapped by the adapter.
 */
import { Buffer } from "buffer"
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js"
import type { Domain, SolanaChainRef } from "../core/domain.ts"

/** The SPL Token program: both IDLs name it as `token_program`. */
export const TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
)
/** The SPL Associated Token Account program, as Circle's quickstarts name it. */
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
)

/** Anchor instruction discriminators, from the IDLs. */
export const Discriminator = {
  depositForBurn: [215, 60, 61, 46, 114, 55, 128, 176],
  depositForBurnWithHook: [111, 245, 62, 131, 204, 108, 223, 155],
  receiveMessage: [38, 144, 127, 225, 31, 225, 238, 25],
} as const

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

const pda = (program: PublicKey, ...seeds: Array<Uint8Array>): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, program)[0]

const u32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

const u64 = (value: bigint): Uint8Array => {
  if (value < 0n || value >= 1n << 64n)
    throw new RangeError(`${value} does not fit in a u64`)
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, true)
  return out
}

const concat = (
  ...parts: Array<Uint8Array | ReadonlyArray<number>>
): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** The two program ids of `chain`. */
export const programsOf = (chain: SolanaChainRef) => ({
  messageTransmitter: new PublicKey(chain.messageTransmitter),
  tokenMessengerMinter: new PublicKey(chain.tokenMessengerMinter),
})

/**
 * The associated token account of `owner` for `mint`: the address under the
 * Associated Token Account program for the seeds owner, token program, mint.
 */
export const associatedTokenAccount = (
  owner: PublicKey,
  mint: PublicKey
): PublicKey =>
  pda(
    ASSOCIATED_TOKEN_PROGRAM,
    owner.toBytes(),
    TOKEN_PROGRAM.toBytes(),
    mint.toBytes()
  )

/**
 * The Associated Token Account program's `CreateIdempotent` (instruction 1):
 * creates `owner`'s token account for `mint` and succeeds if it exists.
 * This layout is the SPL program's, not Circle's.
 */
export const createAssociatedTokenAccountIdempotent = (
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey
): TransactionInstruction =>
  new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      {
        pubkey: associatedTokenAccount(owner, mint),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  })

/** The arguments of `deposit_for_burn` (and, with `hookData`, of `deposit_for_burn_with_hook`). */
export interface DepositForBurnArgs {
  readonly amount: bigint
  readonly destinationDomain: Domain
  /** 32 bytes. */
  readonly mintRecipient: Uint8Array
  /** 32 bytes; zeros for "anyone may claim". */
  readonly destinationCaller: Uint8Array
  readonly maxFee: bigint
  readonly minFinalityThreshold: number
  /** Empty for `deposit_for_burn`. */
  readonly hookData: Uint8Array
}

/** Instruction data of a burn. Throws a `RangeError` on a field of the wrong size. */
export const encodeDepositForBurn = (args: DepositForBurnArgs): Uint8Array => {
  if (args.mintRecipient.length !== 32 || args.destinationCaller.length !== 32)
    throw new RangeError("mintRecipient and destinationCaller are 32 bytes")
  const params = concat(
    u64(args.amount),
    u32(args.destinationDomain),
    args.mintRecipient,
    args.destinationCaller,
    u64(args.maxFee),
    u32(args.minFinalityThreshold)
  )
  return args.hookData.length === 0
    ? concat(Discriminator.depositForBurn, params)
    : concat(
        Discriminator.depositForBurnWithHook,
        params,
        u32(args.hookData.length),
        args.hookData
      )
}

/** The burn in `data`, or `undefined` when it is not one of the two burn instructions. */
export const decodeDepositForBurn = (
  data: Uint8Array
): DepositForBurnArgs | undefined => {
  const is = (discriminator: ReadonlyArray<number>) =>
    data.length >= 8 && discriminator.every((byte, i) => data[i] === byte)
  const plain = is(Discriminator.depositForBurn)
  if (!plain && !is(Discriminator.depositForBurnWithHook)) return undefined
  if (data.length < 8 + 88 + (plain ? 0 : 4)) return undefined
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const hookLength = plain ? 0 : view.getUint32(96, true)
  if (data.length !== (plain ? 96 : 100 + hookLength)) return undefined
  return {
    amount: view.getBigUint64(8, true),
    destinationDomain: view.getUint32(16, true),
    mintRecipient: data.slice(20, 52),
    destinationCaller: data.slice(52, 84),
    maxFee: view.getBigUint64(84, true),
    minFinalityThreshold: view.getUint32(92, true),
    hookData: plain ? new Uint8Array() : data.slice(100),
  }
}

/** Instruction data of `receive_message`. */
export const encodeReceiveMessage = (
  message: Uint8Array,
  attestation: Uint8Array
): Uint8Array =>
  concat(
    Discriminator.receiveMessage,
    u32(message.length),
    message,
    u32(attestation.length),
    attestation
  )

const readonly = (pubkey: PublicKey) => ({
  pubkey,
  isSigner: false,
  isWritable: false,
})
const writable = (pubkey: PublicKey) => ({
  pubkey,
  isSigner: false,
  isWritable: true,
})

/**
 * `deposit_for_burn` or `deposit_for_burn_with_hook`: burns from `owner`'s
 * token account. `messageSentEventData` is a fresh account the caller
 * generates and signs with; the message is stored there, and its rent can be
 * reclaimed five days later (`reclaim_event_account`, not built here).
 */
export const depositForBurnInstruction = (
  chain: SolanaChainRef,
  accounts: {
    readonly owner: PublicKey
    readonly eventRentPayer: PublicKey
    readonly burnTokenAccount: PublicKey
    readonly messageSentEventData: PublicKey
  },
  args: DepositForBurnArgs
): TransactionInstruction => {
  const { messageTransmitter: mt, tokenMessengerMinter: tmm } =
    programsOf(chain)
  const mint = new PublicKey(chain.usdc)
  return new TransactionInstruction({
    programId: tmm,
    keys: [
      { pubkey: accounts.owner, isSigner: true, isWritable: false },
      { pubkey: accounts.eventRentPayer, isSigner: true, isWritable: true },
      readonly(pda(tmm, text("sender_authority"))),
      writable(accounts.burnTokenAccount),
      // Exists only for a denylisted owner.
      readonly(pda(tmm, text("denylist_account"), accounts.owner.toBytes())),
      writable(pda(mt, text("message_transmitter"))),
      readonly(pda(tmm, text("token_messenger"))),
      readonly(
        pda(
          tmm,
          text("remote_token_messenger"),
          text(String(args.destinationDomain))
        )
      ),
      readonly(pda(tmm, text("token_minter"))),
      writable(pda(tmm, text("local_token"), mint.toBytes())),
      writable(mint),
      {
        pubkey: accounts.messageSentEventData,
        isSigner: true,
        isWritable: true,
      },
      readonly(mt),
      readonly(tmm),
      readonly(TOKEN_PROGRAM),
      readonly(SystemProgram.programId),
      readonly(pda(tmm, text("__event_authority"))),
      readonly(tmm),
      // Not in the IDL: Circle's quickstart and burns on mainnet also pass
      // the transmitter's event authority and program, so this does too.
      // https://developers.circle.com/cctp/quickstarts/transfer-usdc-solana-to-arc
      readonly(pda(mt, text("__event_authority"))),
      readonly(mt),
    ],
    data: Buffer.from(encodeDepositForBurn(args)),
  })
}

/** The used-nonce account of a message: it exists, marked used, once the message was received. */
export const usedNonceAccount = (
  chain: SolanaChainRef,
  nonce: Uint8Array
): PublicKey =>
  pda(programsOf(chain).messageTransmitter, text("used_nonce"), nonce)

/** The TokenMessenger state account, which names the fee recipient. */
export const tokenMessengerAccount = (chain: SolanaChainRef): PublicKey =>
  pda(programsOf(chain).tokenMessengerMinter, text("token_messenger"))

/**
 * The fee recipient in a TokenMessenger account's data: after the 8-byte
 * discriminator, `denylister`, `owner`, `pending_owner` (32 each),
 * `message_body_version` (u32) and `authority_bump` (u8).
 */
export const feeRecipientOf = (tokenMessengerData: Uint8Array): PublicKey => {
  const offset = 8 + 32 * 3 + 4 + 1
  if (tokenMessengerData.length < offset + 32)
    throw new RangeError("TokenMessenger account data is too short")
  return new PublicKey(tokenMessengerData.slice(offset, offset + 32))
}

/**
 * `receive_message` for a USDC burn message: the transmitter's own accounts,
 * then the accounts it passes on to the token messenger's handler, in the
 * handler's order.
 */
export const receiveMessageInstruction = (
  chain: SolanaChainRef,
  accounts: {
    readonly payer: PublicKey
    readonly caller: PublicKey
    /** From the TokenMessenger account: see `feeRecipientOf`. */
    readonly feeRecipient: PublicKey
  },
  message: {
    readonly bytes: Uint8Array
    readonly attestation: Uint8Array
    readonly sourceDomain: Domain
    /** 32 bytes. */
    readonly nonce: Uint8Array
    /** 32 bytes: the token burned on the source chain. */
    readonly burnToken: Uint8Array
    /** 32 bytes: the token account minted to. */
    readonly mintRecipient: Uint8Array
  }
): TransactionInstruction => {
  const { messageTransmitter: mt, tokenMessengerMinter: tmm } =
    programsOf(chain)
  const mint = new PublicKey(chain.usdc)
  const source = text(String(message.sourceDomain))
  return new TransactionInstruction({
    programId: mt,
    keys: [
      { pubkey: accounts.payer, isSigner: true, isWritable: true },
      { pubkey: accounts.caller, isSigner: true, isWritable: false },
      readonly(pda(mt, text("message_transmitter_authority"), tmm.toBytes())),
      readonly(pda(mt, text("message_transmitter"))),
      writable(usedNonceAccount(chain, message.nonce)),
      readonly(tmm),
      readonly(SystemProgram.programId),
      readonly(pda(mt, text("__event_authority"))),
      readonly(mt),
      // Forwarded to handle_receive_(un)finalized_message:
      readonly(tokenMessengerAccount(chain)),
      readonly(pda(tmm, text("remote_token_messenger"), source)),
      writable(pda(tmm, text("token_minter"))),
      writable(pda(tmm, text("local_token"), mint.toBytes())),
      readonly(pda(tmm, text("token_pair"), source, message.burnToken)),
      writable(associatedTokenAccount(accounts.feeRecipient, mint)),
      writable(new PublicKey(message.mintRecipient)),
      writable(pda(tmm, text("custody"), mint.toBytes())),
      readonly(TOKEN_PROGRAM),
      readonly(pda(tmm, text("__event_authority"))),
      readonly(tmm),
    ],
    data: Buffer.from(encodeReceiveMessage(message.bytes, message.attestation)),
  })
}
