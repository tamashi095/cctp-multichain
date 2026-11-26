/**
 * Captures the fixtures in `test/fixtures/captured.json` from public
 * endpoints. Read-only: it signs nothing and sends no transaction.
 *
 *   bun scripts/capture-fixtures.ts
 *
 * It finds recent mainnet burns (Base → Solana, Base → another EVM chain,
 * Solana → EVM), asks Iris for their attested messages, and records one real
 * `deposit_for_burn` and one real `receive_message` Solana transaction so the
 * instruction builders can be compared with what Circle's programs accepted.
 */
import { writeFileSync } from "node:fs"
import { Connection, PublicKey } from "@solana/web3.js"
import { createPublicClient, getAbiItem, http } from "viem"
import { base } from "viem/chains"
import { mainnet } from "../src/core/registry.ts"
import { tokenMessengerV2Abi } from "../src/evm/abi.ts"
import { Discriminator } from "../src/solana/instructions.ts"

const IRIS = "https://iris-api.circle.com"
const hex = (bytes: Uint8Array) => "0x" + Buffer.from(bytes).toString("hex")

const iris = async (domain: number, transactionHash: string) => {
  const response = await fetch(
    `${IRIS}/v2/messages/${domain}?transactionHash=${transactionHash}`
  )
  return { httpStatus: response.status, body: await response.json() }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Public endpoints rate-limit: wait and ask again. */
const patiently = async <A>(call: () => Promise<A>): Promise<A> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call()
    } catch (error) {
      if (attempt === 8 || !String(error).includes("429")) throw error
      await sleep(5_000 * (attempt + 1))
    }
  }
}

const evmBurns = async () => {
  const client = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
  })
  const finalized = (await client.getBlock({ blockTag: "finalized" })).number
  const wanted = new Map<string, unknown>()
  for (
    let to = finalized;
    wanted.size < 2 && to > finalized - 40_000n;
    to -= 2_000n
  ) {
    await sleep(600)
    const logs = await client.getLogs({
      address: mainnet.base.tokenMessenger,
      event: getAbiItem({ abi: tokenMessengerV2Abi, name: "DepositForBurn" }),
      args: { burnToken: mainnet.base.usdc },
      fromBlock: to - 1_999n,
      toBlock: to,
      strict: true,
    })
    for (const log of logs) {
      const key =
        log.args.destinationDomain === 5 ? "baseToSolana" : "baseToEvm"
      const plain =
        log.args.hookData === "0x" && BigInt(log.args.destinationCaller) === 0n
      if (!plain || wanted.has(key)) continue
      if (
        key === "baseToEvm" &&
        ![0, 1, 2, 3, 7].includes(log.args.destinationDomain)
      )
        continue
      const attested = await iris(6, log.transactionHash)
      if (attested.body?.messages?.length !== 1) continue
      if (attested.body.messages[0].status !== "complete") continue
      wanted.set(key, {
        sourceDomain: 6,
        transactionHash: log.transactionHash,
        blockNumber: String(log.blockNumber),
        depositor: log.args.depositor,
        iris: attested,
      })
    }
  }
  return Object.fromEntries(wanted)
}

const solana = async () => {
  const connection = new Connection(
    process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    { disableRetryOnRateLimit: true }
  )
  const programs = {
    burn: new PublicKey(mainnet.solana.tokenMessengerMinter),
    receive: new PublicKey(mainnet.solana.messageTransmitter),
  }
  const starts = (data: Uint8Array, d: ReadonlyArray<number>) =>
    d.every((byte, i) => data[i] === byte)
  const out: Record<string, unknown> = {}
  for (const [kind, program] of Object.entries(programs)) {
    const signatures = await patiently(() =>
      connection.getSignaturesForAddress(program, { limit: 60 }, "finalized")
    )
    for (const entry of signatures) {
      if (entry.err !== null || out[kind] !== undefined) continue
      await sleep(1_000)
      // A version this client cannot read (v1, SIMD-0385) is skipped.
      const transaction = await patiently(() =>
        connection.getTransaction(entry.signature, {
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        })
      ).catch(() => null)
      if (transaction === null) continue
      const { message } = transaction.transaction
      const keys = message.getAccountKeys({
        accountKeysFromLookups: transaction.meta?.loadedAddresses ?? null,
      })
      for (const instruction of message.compiledInstructions) {
        if (!keys.get(instruction.programIdIndex)?.equals(program)) continue
        const isBurn =
          kind === "burn" &&
          starts(instruction.data, Discriminator.depositForBurn)
        const isReceive =
          kind === "receive" &&
          starts(instruction.data, Discriminator.receiveMessage)
        if (!isBurn && !isReceive) continue
        const header = message.header
        const accounts = instruction.accountKeyIndexes.map((index) => ({
          pubkey: keys.get(index)!.toBase58(),
          isSigner: message.isAccountSigner(index),
          isWritable: message.isAccountWritable(index),
        }))
        const record: Record<string, unknown> = {
          signature: entry.signature,
          slot: transaction.slot,
          numRequiredSignatures: header.numRequiredSignatures,
          data: hex(instruction.data),
          accounts,
        }
        if (isBurn) {
          const attested = await iris(5, entry.signature)
          if (attested.body?.messages?.[0]?.status !== "complete") continue
          record.iris = attested
        }
        if (isReceive) {
          // The fee recipient named by the TokenMessenger account at capture time.
          const tokenMessenger = await patiently(() =>
            connection.getAccountInfo(new PublicKey(accounts[9]!.pubkey))
          )
          record.tokenMessengerData = hex(tokenMessenger!.data)
        }
        out[kind] = record
        break
      }
    }
  }
  return out
}

const captured = {
  _comment:
    "REAL data captured by scripts/capture-fixtures.ts from Circle's Iris (iris-api.circle.com), Base and Solana mainnet. Read-only.",
  capturedAt: new Date().toISOString(),
  ...(await evmBurns()),
  solana: await solana(),
}
writeFileSync(
  new URL("../test/fixtures/captured.json", import.meta.url),
  JSON.stringify(captured, null, 2) + "\n"
)
console.log(Object.keys(captured), Object.keys(captured.solana))
