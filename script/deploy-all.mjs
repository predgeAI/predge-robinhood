// Compile + deploy the whole Predge agent-settlement stack in one process (shared provider +
// signer). Order: Validator -> Job -> Bond -> Settlement (the bond binds to the job, so the
// job has to exist first). Target chain comes from NETWORK:
//   npm run deploy-all                         # Robinhood Chain testnet (46630)
//   NETWORK=rh-mainnet npm run deploy-all      # Robinhood Chain mainnet (4663)
//   NETWORK=arbitrum-one npm run deploy-all    # Arbitrum One (42161)
//
// Prereq: `npm run genwallet` has written .env, and DEPLOYER_ADDRESS holds ETH on the target
// chain (testnet: https://faucet.testnet.chain.robinhood.com).
import { readFileSync, existsSync } from "node:fs";
import { compileAndDeploy } from "./_compile.mjs";
import { env, EXPLORER, CHAIN_ID, NETWORK, IS_MAINNET } from "../lib/robinhood.mjs";

const e = env();
const validator = e.VALIDATOR_ADDRESS || e.DEPLOYER_ADDRESS;
// 1 s is fine for a testnet demo; on mainnet a verdict stays challengeable for a day.
const disputeWindow = BigInt(e.BOND_DISPUTE_WINDOW || (IS_MAINNET ? "86400" : "1"));

console.log(`\n=== Predge → ${NETWORK.name} (chainId ${CHAIN_ID}) ===`);
console.log(`explorer: ${EXPLORER}\n`);

// ONLY=A,B redeploys just those and binds them to the siblings already on chain; the rest of
// this stack is live and addressed elsewhere, so a one-contract fix must not replace it all.
const ONLY = (process.env.ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);
const wanted = (name) => ONLY.length === 0 || ONLY.includes(name);

// Addresses already recorded for this network, so a partial run can wire against them.
const deployedAddress = (name) => {
  const p = new URL(`../deploy/${NETWORK.deployDir}${name}.json`, import.meta.url).pathname;
  if (!existsSync(p)) throw new Error(`${name} is not deployed on ${NETWORK.name}; deploy it too`);
  return JSON.parse(readFileSync(p, "utf8")).address;
};

const results = {};
if (ONLY.length) console.log(`deploying only: ${ONLY.join(", ")}\n`);

if (wanted("PredgeAgentValidator")) {
  results.PredgeAgentValidator = await compileAndDeploy({
    sourcePath: new URL("../contracts/PredgeAgentValidator.sol", import.meta.url).pathname,
    contractName: "PredgeAgentValidator",
    args: [validator],
    outFile: "PredgeAgentValidator.json",
  });
}

if (wanted("AgentJob")) {
  results.AgentJob = await compileAndDeploy({
    sourcePath: new URL("../contracts/AgentJob.sol", import.meta.url).pathname,
    contractName: "AgentJob",
    outFile: "AgentJob.json",
  });
}

// The bond settles a challenge by reading what the provider submitted to this job contract,
// so the job address is part of the bond's identity and is fixed at construction.
if (wanted("PredgeValidatorBond")) {
  const jobAddress = results.AgentJob?.address || deployedAddress("AgentJob");
  results.PredgeValidatorBond = await compileAndDeploy({
    sourcePath: new URL("../contracts/PredgeValidatorBond.sol", import.meta.url).pathname,
    contractName: "PredgeValidatorBond",
    args: [validator, jobAddress, disputeWindow],
    outFile: "PredgeValidatorBond.json",
  });
}

if (wanted("PredgeSettlement")) {
  results.PredgeSettlement = await compileAndDeploy({
    sourcePath: new URL("../contracts/PredgeSettlement.sol", import.meta.url).pathname,
    contractName: "PredgeSettlement",
    outFile: "PredgeSettlement.json",
  });
}

console.log("\n=== Deployment summary ===");
for (const [name, r] of Object.entries(results)) {
  console.log(`${name.padEnd(22)} ${r.address}`);
}
console.log("\nAddresses also written to deploy/*.json");
