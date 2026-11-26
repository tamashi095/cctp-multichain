/**
 * A scripted Sui client and a recording signer, for adapter and orchestrator
 * tests. The client answers reads from what a test sets and records what it
 * is asked to simulate and execute. It never applies a transaction.
 */
import { Layer } from "effect"
import {
  ObjectError,
  type ClientWithCoreApi,
  type SuiClientTypes,
} from "@mysten/sui/client"
import type { Transaction } from "@mysten/sui/transactions"
import { fromBase64, SUI_TYPE_ARG } from "@mysten/sui/utils"
import { bytesToUint, toHex, uintToBytes } from "../src/core/bytes.ts"
import type { SuiChainRef } from "../src/core/domain.ts"
import { SuiSigner, type SuiSponsor } from "../src/sui/SuiSigner.ts"

interface CommandData {
  MoveCall?: {
    module: string
    function: string
    arguments: Array<{ Input?: number }>
  }
}
interface InputData {
  Pure?: { bytes: string }
}

/** The Move calls of a transaction, as `module::function`. */
export const callsOf = (transaction: Transaction): Array<string> =>
  (transaction.getData().commands as Array<CommandData>).map((c) =>
    c.MoveCall === undefined
      ? "other"
      : `${c.MoveCall.module}::${c.MoveCall.function}`
  )

/** The pure inputs of a transaction, as raw BCS bytes. */
export const pureInputsOf = (transaction: Transaction): Array<Uint8Array> =>
  (transaction.getData().inputs as Array<InputData>).flatMap((input) =>
    input.Pure === undefined ? [] : [fromBase64(input.Pure.bytes)]
  )

export const suiClient = (chain: SuiChainRef) => {
  const state = {
    chainIdentifier: chain.chainIdentifier,
    sui: 1_000_000_000n,
    usdc: 0n,
    /** Balances by owner, for accounts other than the default. */
    suiOf: new Map<string, bigint>(),
    /** Ids an object lives at. */
    objects: new Set<string>(),
    objectsFail: false,
    usedNonces: new Set<string>(),
    viewFails: false,
    simulationError: null as SuiClientTypes.ExecutionError | null,
    executionError: null as SuiClientTypes.ExecutionError | null,
    executeThrows: false,
    digest: "SuiDigest1",
    /** Runs when a transaction is executed, to move the scripted chain on. */
    onExecute: (() => {}) as (calls: Array<string>) => void,
    events: [] as Array<Partial<SuiClientTypes.EventEntry>>,
    simulated: [] as Array<Transaction>,
    executed: [] as Array<{ bytes: Uint8Array; signatures: Array<string> }>,
    eventRequests: [] as Array<Record<string, unknown>>,
  }
  const status = (error: SuiClientTypes.ExecutionError | null) =>
    error === null ? { success: true, error: null } : { success: false, error }
  const result = (error: SuiClientTypes.ExecutionError | null, body: object) =>
    error === null
      ? { $kind: "Transaction", Transaction: { status: status(null), ...body } }
      : {
          $kind: "FailedTransaction",
          FailedTransaction: { status: status(error), ...body },
        }

  const core = {
    getChainIdentifier: async () => ({
      chainIdentifier: state.chainIdentifier,
    }),
    getBalance: async ({
      owner,
      coinType,
    }: {
      owner: string
      coinType: string
    }) => ({
      balance: {
        balance: String(
          coinType === SUI_TYPE_ARG
            ? (state.suiOf.get(owner) ?? state.sui)
            : state.usdc
        ),
      },
    }),
    getObjects: async ({ objectIds }: { objectIds: Array<string> }) => ({
      objects: objectIds.map((objectId) =>
        state.objectsFail
          ? new Error("unavailable")
          : state.objects.has(objectId)
            ? { objectId }
            : new ObjectError("notFound", `Object ${objectId} not found`, {
                reason: "notFound",
                objectId,
              })
      ),
    }),
    simulateTransaction: async ({
      transaction,
    }: {
      transaction: Transaction
    }) => {
      const calls = callsOf(transaction)
      if (calls[0] === "state::is_nonce_used") {
        if (state.viewFails)
          return {
            ...result(
              {
                $kind: "Unknown",
                message: "state object unavailable",
                Unknown: null,
              },
              {}
            ),
            commandResults: [],
          }
        // The nonce is the view's one pure input: a little-endian u256.
        const nonce = toHex(
          uintToBytes(
            bytesToUint(pureInputsOf(transaction)[0]!.slice().reverse()),
            32
          )
        )
        return {
          ...result(null, {}),
          commandResults: [
            {
              returnValues: [
                { bcs: Uint8Array.of(state.usedNonces.has(nonce) ? 1 : 0) },
              ],
              mutatedReferences: [],
            },
          ],
        }
      }
      state.simulated.push(transaction)
      return result(state.simulationError, {
        effects: {
          gasUsed: {
            computationCost: "750000",
            storageCost: "3000000",
            storageRebate: "1000000",
          },
        },
      })
    },
    executeTransaction: async (request: {
      transaction: Uint8Array
      signatures: Array<string>
    }) => {
      if (state.executeThrows) throw new Error("connection reset")
      state.executed.push({
        bytes: request.transaction,
        signatures: request.signatures,
      })
      if (state.executionError === null)
        state.onExecute(callsOf(state.simulated.at(-1)!))
      return result(state.executionError, { digest: state.digest })
    },
    waitForTransaction: async () => ({}),
    listEvents: async (request: Record<string, unknown>) => {
      const asked = Object.fromEntries(
        Object.entries(request).filter(([key]) => key !== "signal")
      )
      state.eventRequests.push(asked)
      return {
        events: asked.limit === 1 ? state.events.slice(-1) : state.events,
        hasNextPage: false,
        startCursor: state.events.length === 0 ? null : "cursor-newest",
        endCursor: state.events.length === 0 ? null : "cursor-end",
      }
    },
  }
  return { state, client: { core } as unknown as ClientWithCoreApi }
}

/** A signer that signs with its name and hands the bytes back unchanged. */
export const suiSigner = (address: string, sponsor?: SuiSponsor) =>
  Layer.succeed(
    SuiSigner,
    SuiSigner.make({
      address,
      sign: async (bytes) => ({ bytes, signature: "sender-signature" }),
      sponsor,
    })
  )
