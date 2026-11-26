/**
 * Circle's CCTP V2 calls on Sui, as programmable transactions.
 *
 * Sources:
 * - The calls, their order and their arguments:
 *   https://developers.circle.com/cctp/quickstarts/transfer-usdc-sui-arc
 * - Signatures, events and abort codes: github.com/circlefin/sui-cctp at
 *   b23b83b0d957bb9dfd876e6c1aa02dbf89d88eba (`packages/*_v2`,
 *   `packages/stablecoin_handler`), and `treasury.move` in
 *   github.com/circlefin/stablecoin-sui for the deny-list abort.
 *
 * Plain builders: nothing here reads the network or sets a sender or gas.
 * `test/sui-ptb.test.ts` compares them with real transactions.
 */
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import {
  coinWithBalance,
  Transaction,
  type TransactionArgument,
} from "@mysten/sui/transactions"
import { SUI_CLOCK_OBJECT_ID, SUI_DENY_LIST_OBJECT_ID } from "@mysten/sui/utils"
import type { Hex } from "../core/bytes.ts"
import type { Domain, SuiChainRef } from "../core/domain.ts"

/** The stablecoin handler's witness type, the second type argument of the `complete_*` calls. */
const handlerAuth = (chain: SuiChainRef) =>
  `${chain.stablecoinHandlerPackage}::handler::Auth`

/** The arguments of `deposit_for_burn`. There is one call, with or without hook data. */
export interface DepositForBurnArgs {
  readonly amount: bigint
  readonly destinationDomain: Domain
  /** bytes32, passed as a Move `address`. */
  readonly mintRecipient: Hex
  /** bytes32; zeros for "anyone may claim". */
  readonly destinationCaller: Hex
  readonly maxFee: bigint
  readonly minFinalityThreshold: number
  readonly hookData: Uint8Array
}

/**
 * The three calls of a burn, on `coin`: `deposit_for_burn` →
 * `handler::burn` → `complete_burn`, which emits the message.
 */
export const addBurn = (
  tx: Transaction,
  chain: SuiChainRef,
  coin: TransactionArgument | ReturnType<typeof coinWithBalance>,
  args: DepositForBurnArgs
): void => {
  const [burnReceipt, returnedCoin] = tx.moveCall({
    target: `${chain.tokenMessengerMinterPackage}::deposit_for_burn::deposit_for_burn`,
    arguments: [
      coin,
      tx.pure.u32(args.destinationDomain),
      tx.pure.address(args.mintRecipient),
      tx.pure.address(args.destinationCaller),
      tx.pure.u256(args.maxFee),
      tx.pure.u32(args.minFinalityThreshold),
      tx.pure.vector("u8", args.hookData),
      tx.object(chain.tokenMessengerMinterState),
    ],
    typeArguments: [chain.usdc],
  })
  const [completeBurnTicket] = tx.moveCall({
    target: `${chain.stablecoinHandlerPackage}::handler::burn`,
    arguments: [
      tx.object(chain.stablecoinHandlerState),
      burnReceipt!,
      returnedCoin!,
      tx.object(SUI_DENY_LIST_OBJECT_ID),
      tx.object(chain.usdcTreasury),
    ],
  })
  tx.moveCall({
    target: `${chain.tokenMessengerMinterPackage}::deposit_for_burn::complete_burn`,
    arguments: [
      completeBurnTicket!,
      tx.object(chain.tokenMessengerMinterState),
      tx.object(chain.messageTransmitterState),
    ],
    typeArguments: [chain.usdc, handlerAuth(chain)],
  })
}

/**
 * A burn of exactly `amount` USDC of the sender's, taken from coin objects
 * and the address balance as the SDK finds them when the transaction is
 * built.
 */
export const burnTransaction = (
  chain: SuiChainRef,
  args: DepositForBurnArgs
): Transaction => {
  const tx = new Transaction()
  addBurn(
    tx,
    chain,
    coinWithBalance({ type: chain.usdc, balance: args.amount }),
    args
  )
  return tx
}

/**
 * Circle's four-call claim: `receive_message` → `prepare_mint` →
 * `handler::mint` → `complete_mint`. USDC is minted to the message's own
 * recipient as a `Coin<USDC>`.
 */
export const claimTransaction = (
  chain: SuiChainRef,
  message: Uint8Array,
  attestation: Uint8Array
): Transaction => {
  const tx = new Transaction()
  const [receipt] = tx.moveCall({
    target: `${chain.messageTransmitterPackage}::receive_message::receive_message`,
    arguments: [
      tx.pure.vector("u8", message),
      tx.pure.vector("u8", attestation),
      tx.object(chain.messageTransmitterState),
    ],
  })
  const [mintReceipt] = tx.moveCall({
    target: `${chain.tokenMessengerMinterPackage}::handle_receive_message::prepare_mint`,
    arguments: [
      receipt!,
      tx.object(chain.tokenMessengerMinterState),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
    typeArguments: [chain.usdc],
  })
  const [completeMintTicket] = tx.moveCall({
    target: `${chain.stablecoinHandlerPackage}::handler::mint`,
    arguments: [
      tx.object(chain.stablecoinHandlerState),
      mintReceipt!,
      tx.object(chain.tokenMessengerMinterState),
      tx.object(chain.usdcTreasury),
      tx.object(SUI_DENY_LIST_OBJECT_ID),
    ],
  })
  tx.moveCall({
    target: `${chain.tokenMessengerMinterPackage}::handle_receive_message::complete_mint`,
    arguments: [
      completeMintTicket!,
      tx.object(chain.tokenMessengerMinterState),
      tx.object(chain.messageTransmitterState),
    ],
    typeArguments: [chain.usdc, handlerAuth(chain)],
  })
  return tx
}

/** The view `message_transmitter_v2::state::is_nonce_used(&State, u256): bool`, to simulate. */
export const isNonceUsedTransaction = (
  chain: SuiChainRef,
  nonce: Hex
): Transaction => {
  const tx = new Transaction()
  tx.moveCall({
    target: `${chain.messageTransmitterPackage}::state::is_nonce_used`,
    arguments: [
      tx.object(chain.messageTransmitterState),
      tx.pure.u256(BigInt(nonce)),
    ],
  })
  return tx
}

/** The type of the event a burn emits. */
export const depositForBurnEventType = (chain: SuiChainRef) =>
  `${chain.tokenMessengerMinterPackage}::deposit_for_burn::DepositForBurn`

/** `token_messenger_minter_v2::deposit_for_burn::DepositForBurn`, field for field. */
export const DepositForBurnEvent = bcs.struct("DepositForBurn", {
  burn_token: bcs.Address,
  amount: bcs.u256(),
  depositor: bcs.Address,
  mint_recipient: bcs.Address,
  destination_domain: bcs.u32(),
  destination_token_messenger: bcs.Address,
  destination_caller: bcs.Address,
  max_fee: bcs.u256(),
  min_finality_threshold: bcs.u32(),
  hook_data: bcs.vector(bcs.u8()),
})

/** Why a claim failed, when Circle's code says why. */
export type ClaimRefusal =
  "NonceAlreadyUsed" | "MessageExpired" | "RecipientDenied"

/**
 * Reads a failed claim's execution error:
 *
 * - `receive_message` abort 4 (`ENonceAlreadyUsed`): already delivered.
 * - `handle_receive_message` abort 8 (`EExpiredMessage`): on Sui
 *   `expirationBlock` is a time in milliseconds, compared with the clock.
 * - `treasury` abort 1 (`EDeniedAddress`, the USDC package), or Sui's own
 *   coin deny-list error: the recipient or the sender is denied.
 *
 * The match is on module name and code. Package ids are not compared: a
 * location names the package version that ran, which changes on upgrade.
 */
export const claimRefusal = (
  error: SuiClientTypes.ExecutionError
): ClaimRefusal | undefined => {
  if (error.$kind === "CoinDenyListError") return "RecipientDenied"
  if (error.$kind !== "MoveAbort") return undefined
  const module = error.MoveAbort.location?.module
  const code = error.MoveAbort.abortCode
  if (module === "receive_message" && code === "4") return "NonceAlreadyUsed"
  if (module === "handle_receive_message" && code === "8")
    return "MessageExpired"
  if (module === "treasury" && code === "1") return "RecipientDenied"
  return undefined
}
