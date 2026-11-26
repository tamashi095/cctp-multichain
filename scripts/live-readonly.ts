/**
 * Read-only checks against mainnet: the delivery oracle of each family, on
 * nonces from the captured fixtures (which were delivered) and on a nonce
 * nobody used, and Sui's recipient check. It signs nothing, sends nothing
 * and needs no key. Not run by the tests or CI.
 *
 *   bun scripts/live-readonly.ts
 */
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Connection } from "@solana/web3.js"
import { Effect } from "effect"
import { createPublicClient, http } from "viem"
import {
  mainnet,
  Message,
  type ChainAdapter,
  type Hex,
} from "../src/core/index.ts"
import { EvmAdapter } from "../src/evm/index.ts"
import { SolanaAdapter } from "../src/solana/index.ts"
import { SuiAdapter } from "../src/sui/index.ts"
import sui from "../test/fixtures/captured-sui.json" with { type: "json" }
import other from "../test/fixtures/captured.json" with { type: "json" }

const nonceOf = (message: string) =>
  Message.decodeBurnMessage(
    Uint8Array.from(Buffer.from(message.slice(2), "hex"))
  ).nonce
const UNUSED = `0x${"0badc0de".repeat(8)}` as Hex

const check = (
  name: string,
  adapter: Effect.Effect<ChainAdapter>,
  delivered: Hex
) =>
  Effect.gen(function* () {
    const a = yield* adapter
    const used = yield* a.isNonceUsed(delivered)
    const unused = yield* a.isNonceUsed(UNUSED)
    console.log(
      `${name}: delivered nonce used=${used}, unused nonce used=${unused}`
    )
    return a
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => void console.log(`${name}: ${JSON.stringify(error)}`))
    )
  )

const program = Effect.gen(function* () {
  const suiAdapter = yield* check(
    "sui",
    SuiAdapter.make(mainnet.sui, {
      client: new SuiGrpcClient({
        network: "mainnet",
        baseUrl:
          process.env.SUI_RPC_URL ?? "https://fullnode.mainnet.sui.io:443",
      }),
    }),
    nonceOf(sui.mainnet.claim.message)
  )
  if (suiAdapter !== undefined) {
    const account = yield* Effect.result(
      suiAdapter.recipientFromAddress(sui.mainnet.burns.toEvm.sender)
    )
    const object = yield* Effect.result(
      suiAdapter.recipientFromAddress(mainnet.sui.usdcTreasury)
    )
    console.log(
      `sui: an account is accepted=${account._tag === "Success"}, an object id is accepted=${object._tag === "Success"}`
    )
  }
  yield* check(
    "arbitrum",
    EvmAdapter.make(mainnet.arbitrum, {
      client: createPublicClient({
        transport: http(
          process.env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc"
        ),
      }),
    }),
    nonceOf(other.baseToEvm.iris.body.messages[0]!.message)
  )
  yield* check(
    "solana",
    SolanaAdapter.make(mainnet.solana, {
      connection: new Connection(
        process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"
      ),
    }),
    nonceOf(other.baseToSolana.iris.body.messages[0]!.message)
  )
})

Effect.runPromise(program)
