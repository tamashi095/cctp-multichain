import { assert, describe, it } from "@effect/vitest"
import { PublicKey } from "@solana/web3.js"
import { getAddress } from "viem"
import * as viemChains from "viem/chains"
import { isEvm, isSolana } from "../src/core/domain.ts"
import { chainByDomain, Chains, chainsOf } from "../src/core/registry.ts"

/** viem's definition of each registry chain: an independent source for chain ids. */
const viemChain = {
  mainnet: {
    ethereum: viemChains.mainnet,
    avalanche: viemChains.avalanche,
    optimism: viemChains.optimism,
    arbitrum: viemChains.arbitrum,
    base: viemChains.base,
    polygon: viemChains.polygon,
    unichain: viemChains.unichain,
    linea: viemChains.linea,
    worldchain: viemChains.worldchain,
  },
  testnet: {
    ethereum: viemChains.sepolia,
    avalanche: viemChains.avalancheFuji,
    optimism: viemChains.optimismSepolia,
    arbitrum: viemChains.arbitrumSepolia,
    base: viemChains.baseSepolia,
    polygon: viemChains.polygonAmoy,
    unichain: viemChains.unichainSepolia,
    linea: viemChains.lineaSepolia,
    worldchain: viemChains.worldchainSepolia,
  },
} as const

describe.each(["mainnet", "testnet"] as const)("the %s registry", (network) => {
  const chains = chainsOf(network)

  it("gives each chain one domain and one key", () => {
    assert.strictEqual(new Set(chains.map((c) => c.domain)).size, chains.length)
    assert.strictEqual(new Set(chains.map((c) => c.key)).size, chains.length)
    for (const chain of chains) {
      assert.strictEqual(chain.network, network)
      assert.strictEqual(chainByDomain(network, chain.domain), chain)
    }
  })

  it("has the same domains on both networks", () => {
    for (const [key, chain] of Object.entries(Chains[network]))
      assert.strictEqual(
        chain.domain,
        Chains.mainnet[key as keyof typeof Chains.mainnet].domain
      )
  })

  it("has every EVM chain id viem has, and checksummed addresses", () => {
    const evm = chains.filter(isEvm)
    assert.strictEqual(evm.length, Object.keys(viemChain[network]).length)
    for (const chain of evm) {
      const known =
        viemChain[network][chain.key as keyof (typeof viemChain)["mainnet"]]
      assert.strictEqual(chain.chainId, known.id, chain.name)
      for (const address of [
        chain.usdc,
        chain.tokenMessenger,
        chain.messageTransmitter,
      ])
        assert.strictEqual(getAddress(address), address, chain.name)
    }
  })

  it("has Solana's programs and mint as valid keys", () => {
    const [solana] = chains.filter(isSolana)
    assert.isDefined(solana)
    assert.strictEqual(solana!.domain, 5)
    for (const key of [
      solana!.usdc,
      solana!.messageTransmitter,
      solana!.tokenMessengerMinter,
    ])
      assert.strictEqual(new PublicKey(key).toBase58(), key)
  })
})
