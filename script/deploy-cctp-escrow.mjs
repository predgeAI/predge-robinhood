// PredgeCctpDisputeEscrow on Arbitrum One: disputes raised here, settled with USDC burned on Base
// over CCTP V2. Constructor: (usdc, messageTransmitterV2, registry, tokenMessengerV2, sourceDomain, localDomain).
//
//   NETWORK=arbitrum-one node script/deploy-cctp-escrow.mjs --estimate   compile + gas estimate, sends nothing
//   NETWORK=arbitrum-one node script/deploy-cctp-escrow.mjs              deploy (the owner runs this)
//
// CCTP addresses and domains: developers.circle.com/cctp/references/contract-addresses
// (checked 2026-10-10: TokenMessengerV2 and MessageTransmitterV2 identical on Base, Arbitrum and Arc;
// Base = 6, Arbitrum = 3, Arc = 26).
import { readFileSync } from "node:fs";
import { compileAndDeploy, compileContract } from "./_compile.mjs";
import { NETWORK_NAME, makeProvider, DEFAULT_RPC, env } from "../lib/robinhood.mjs";
import { ContractFactory, formatEther, getAddress } from "ethers";

if (NETWORK_NAME !== "arbitrum-one") {
  console.error("This escrow is wired for Arbitrum One (domain 3) receiving from Base (domain 6). Set NETWORK=arbitrum-one.");
  process.exit(1);
}
const registry = JSON.parse(readFileSync(new URL("../deploy/arbitrum-one/PredgeAgentValidator.json", import.meta.url), "utf8")).address;
const ARGS = [
  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC on Arbitrum One
  "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", // MessageTransmitterV2
  getAddress(registry), // PredgeAgentValidator (ERC-8004 validation registry) on Arbitrum One
  "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", // TokenMessengerV2 (same on Base)
  6, // source domain: Base
  3, // local domain: Arbitrum One
];
const sourcePath = new URL("../contracts/PredgeCctpDisputeEscrow.sol", import.meta.url).pathname;

if (process.argv.includes("--estimate")) {
  const { abi, bytecode } = await compileContract({ sourcePath, contractName: "PredgeCctpDisputeEscrow" });
  const provider = makeProvider(env().RPC_URL || DEFAULT_RPC);
  const tx = await new ContractFactory(abi, bytecode).getDeployTransaction(...ARGS);
  const from = env().DEPLOYER_ADDRESS || undefined;
  const gas = await provider.estimateGas({ ...tx, from });
  const fee = await provider.getFeeData();
  console.log("args:", ARGS.join(", "));
  console.log(`gas ${gas} at ${fee.gasPrice} wei = ${formatEther(gas * fee.gasPrice)} ETH (Arbitrum estimate includes the L1 data component)`);
  process.exit(0);
}

await compileAndDeploy({ sourcePath, contractName: "PredgeCctpDisputeEscrow", args: ARGS, outFile: "PredgeCctpDisputeEscrow.json" });
