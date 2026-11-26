/**
 * The parts of Circle's EVM contracts this library calls.
 *
 * Interfaces: https://developers.circle.com/cctp/references/contract-interfaces
 * Source: https://github.com/circlefin/evm-cctp-contracts (src/v2), where
 * `usedNonces` and the `DepositForBurn` event are declared.
 */
import { parseAbi } from "viem"

export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
])

export const tokenMessengerV2Abi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
])

export const messageTransmitterV2Abi = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
  // 0 while unused, NONCE_USED (1) once received.
  "function usedNonces(bytes32 nonce) view returns (uint256)",
])
