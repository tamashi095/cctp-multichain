/**
 * Captures `test/fixtures/captured-sui.json` from public endpoints.
 * Read-only: it signs nothing and sends no transaction.
 *
 *   bun scripts/capture-sui-fixtures.ts
 *
 * For mainnet and testnet it records the chain identifier, one real claim on
 * Sui (the transaction, and the message it carried, with Iris's record of
 * it) and real burns on Sui (the transaction, its `DepositForBurn` event and
 * the message Iris attested for it).
 */
import { writeFileSync } from "node:fs"
import { SuiGrpcClient } from "@mysten/sui/grpc"

// https://developers.circle.com/cctp/references/sui-packages
const NETWORKS = {
  mainnet: {
    rpc: "https://fullnode.mainnet.sui.io:443",
    iris: "https://iris-api.circle.com",
    messageTransmitter:
      "0x16bcfcfc465f96281663a344641c017de84529370e11aa3879d0dce43ad6db87",
    tokenMessengerMinter:
      "0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830",
  },
  testnet: {
    rpc: "https://fullnode.testnet.sui.io:443",
    iris: "https://iris-api-sandbox.circle.com",
    messageTransmitter:
      "0xe9678cd42a81886e18e21361088071f275105636a4d3751e1d7f255211f73bbe",
    tokenMessengerMinter:
      "0x267d3c0cb776eace2840f27e4d33da9c6d952f9749403f1fe6579f4962ed3c64",
  },
} as const

const hex = (bytes: Uint8Array) => "0x" + Buffer.from(bytes).toString("hex")
const json = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, v) =>
      typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? hex(v) : v
    )
  )
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The bytes of a BCS `vector<u8>` pure input. */
const vectorU8 = (bcs: Uint8Array): Uint8Array => {
  let length = 0
  let shift = 0
  let offset = 0
  for (;;) {
    const byte = bcs[offset++]!
    length |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  // A copy: a Buffer's slice shares its pool.
  return Uint8Array.from(bcs.subarray(offset, offset + length))
}

const capture = async (name: keyof typeof NETWORKS) => {
  const network = NETWORKS[name]
  const client = new SuiGrpcClient({ network: name, baseUrl: network.rpc })
  const iris = async (path: string) => {
    const response = await fetch(network.iris + path)
    return {
      httpStatus: response.status,
      body: await response.json().catch(() => null),
    }
  }
  const transactionsOf = async function* (eventType: string) {
    let before: string | null = null
    for (let page = 0; page < 12; page++) {
      const events = await client.core.listEvents({
        filter: { eventType },
        order: "descending",
        limit: 50,
        ...(before === null ? {} : { before }),
      })
      for (const event of events.events) {
        await sleep(150)
        const result = await client.core.getTransaction({
          digest: event.transactionDigest,
          include: { transaction: true, events: true, effects: true },
        })
        if (result.$kind === "Transaction")
          yield { event, transaction: result.Transaction }
      }
      if (!events.hasNextPage || events.endCursor === null) return
      before = events.endCursor
    }
  }
  const moveCalls = (transaction: {
    transaction: { commands: Array<Record<string, unknown>> }
  }) =>
    transaction.transaction.commands.map((c) => {
      const call = c.MoveCall as
        { module: string; function: string } | undefined
      return call === undefined
        ? String(c.$kind)
        : `${call.module}::${call.function}`
    })

  const out: Record<string, unknown> = {
    chainIdentifier: (await client.core.getChainIdentifier()).chainIdentifier,
  }

  // A claim made with exactly Circle's four calls.
  try {
    for await (const { transaction } of transactionsOf(
      `${network.messageTransmitter}::receive_message::MessageReceived`
    )) {
      const calls = moveCalls(transaction)
      const at = calls.indexOf("receive_message::receive_message")
      if (
        at < 0 ||
        calls.length !== at + 4 ||
        calls[at + 1] !== "handle_receive_message::prepare_mint" ||
        calls[at + 2] !== "handler::mint" ||
        calls[at + 3] !== "handle_receive_message::complete_mint"
      )
        continue
      const call = transaction.transaction.commands[at] as unknown as {
        MoveCall: { arguments: Array<{ Input?: number }> }
      }
      const pure = transaction.transaction.inputs[
        call.MoveCall.arguments[0]!.Input ?? 0
      ] as {
        Pure?: { bytes: string }
      }
      if (pure.Pure === undefined) continue
      const message = vectorU8(Buffer.from(pure.Pure.bytes, "base64"))
      const sourceDomain = new DataView(message.buffer).getUint32(4)
      if (![0, 1, 2, 3, 5, 6, 7, 10, 11, 14].includes(sourceDomain)) continue
      out.claim = {
        digest: transaction.digest,
        status: transaction.status,
        sender: transaction.transaction.sender,
        inputs: json(transaction.transaction.inputs),
        commands: json(transaction.transaction.commands),
        events: json(
          transaction.events.map((e) => ({
            eventType: e.eventType,
            bcs: e.bcs,
          }))
        ),
        message: hex(message),
        iris: await iris(
          `/v2/messages/${sourceDomain}?nonce=${hex(message.slice(12, 44))}`
        ),
      }
      break
    }
  } catch (error) {
    out.claimError = String(error).slice(0, 200)
  }

  // Burns made with Circle's three calls, one to an EVM chain and one to Solana.
  const burns: Record<string, unknown> = {}
  try {
    for await (const { event, transaction } of transactionsOf(
      `${network.tokenMessengerMinter}::deposit_for_burn::DepositForBurn`
    )) {
      const calls = moveCalls(transaction)
      const at = calls.indexOf("deposit_for_burn::deposit_for_burn")
      if (at < 0 || calls[at + 1] !== "handler::burn") continue
      const attested = await iris(
        `/v2/messages/8?transactionHash=${transaction.digest}`
      )
      const entry = attested.body?.messages?.[0]
      if (attested.body?.messages?.length !== 1 || entry?.status !== "complete")
        continue
      const destination = Number(entry.decodedMessage?.destinationDomain)
      const key = destination === 5 ? "toSolana" : "toEvm"
      if (burns[key] !== undefined) continue
      if (
        key === "toEvm" &&
        ![0, 1, 2, 3, 6, 7, 10, 11, 14, 26].includes(destination)
      )
        continue
      burns[key] = {
        digest: transaction.digest,
        sender: transaction.transaction.sender,
        inputs: json(transaction.transaction.inputs),
        commands: json(transaction.transaction.commands),
        event: { eventType: event.eventType, bcs: hex(event.bcs) },
        iris: attested,
      }
      if (burns.toEvm !== undefined && burns.toSolana !== undefined) break
    }
  } catch (error) {
    out.burnsError = String(error).slice(0, 200)
  }
  out.burns = burns
  return out
}

const captured: Record<string, unknown> = {
  _comment:
    "REAL data captured by scripts/capture-sui-fixtures.ts from Sui's public full nodes and Circle's Iris (mainnet and sandbox). Read-only.",
  capturedAt: new Date().toISOString(),
}
for (const name of ["mainnet", "testnet"] as const)
  captured[name] = await capture(name).catch((error) => ({
    error: String(error),
  }))
writeFileSync(
  new URL("../test/fixtures/captured-sui.json", import.meta.url),
  JSON.stringify(captured, null, 2) + "\n"
)
console.log(Object.keys(captured))
