// Compile + deploy the whole Predge agent-settlement stack in one process (shared provider +
// signer). Order: Validator -> Bond -> Job -> Settlement. Target chain comes from NETWORK:
//   npm run deploy-all                         # Robinhood Chain testnet (46630)
//   NETWORK=rh-mainnet npm run deploy-all      # Robinhood Chain mainnet (4663)
//   NETWORK=arbitrum-one npm run deploy-all    # Arbitrum One (42161)
//
// Prereq: `npm run genwallet` has written .env, and DEPLOYER_ADDRESS holds ETH on the target
// chain (testnet: https://faucet.testnet.chain.robinhood.com).
import { compileAndDeploy } from "./_compile.mjs";
import { env, EXPLORER, CHAIN_ID, NETWORK, IS_MAINNET } from "../lib/robinhood.mjs";

const e = env();
const validator = e.VALIDATOR_ADDRESS || e.DEPLOYER_ADDRESS;
// 1 s is fine for a testnet demo; on mainnet a verdict stays challengeable for a day.
const disputeWindow = BigInt(e.BOND_DISPUTE_WINDOW || (IS_MAINNET ? "86400" : "1"));

console.log(`\n=== Predge → ${NETWORK.name} (chainId ${CHAIN_ID}) ===`);
console.log(`explorer: ${EXPLORER}\n`);

const results = {};

results.PredgeAgentValidator = await compileAndDeploy({
  sourcePath: new URL("../contracts/PredgeAgentValidator.sol", import.meta.url).pathname,
  contractName: "PredgeAgentValidator",
  args: [validator],
  outFile: "PredgeAgentValidator.json",
});

results.PredgeValidatorBond = await compileAndDeploy({
  sourcePath: new URL("../contracts/PredgeValidatorBond.sol", import.meta.url).pathname,
  contractName: "PredgeValidatorBond",
  args: [validator, disputeWindow],
  outFile: "PredgeValidatorBond.json",
});

results.AgentJob = await compileAndDeploy({
  sourcePath: new URL("../contracts/AgentJob.sol", import.meta.url).pathname,
  contractName: "AgentJob",
  outFile: "AgentJob.json",
});

results.PredgeSettlement = await compileAndDeploy({
  sourcePath: new URL("../contracts/PredgeSettlement.sol", import.meta.url).pathname,
  contractName: "PredgeSettlement",
  outFile: "PredgeSettlement.json",
});

console.log("\n=== Deployment summary ===");
for (const [name, r] of Object.entries(results)) {
  console.log(`${name.padEnd(22)} ${r.address}`);
}
console.log("\nAddresses also written to deploy/*.json");
