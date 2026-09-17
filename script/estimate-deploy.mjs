// Estimate the ETH needed to run deploy-all on the selected NETWORK, without sending anything.
//   NETWORK=rh-mainnet node script/estimate-deploy.mjs
import { ContractFactory, formatEther } from "ethers";
import { compileContract } from "./_compile.mjs";
import { env, makeProvider, DEFAULT_RPC, NETWORK, IS_MAINNET } from "../lib/robinhood.mjs";

const e = env();
const from = e.DEPLOYER_ADDRESS;
const provider = makeProvider(IS_MAINNET ? e.RPC_URL || DEFAULT_RPC : e.ROBINHOOD_RPC || DEFAULT_RPC);
const validator = e.VALIDATOR_ADDRESS || from;
const plan = [
  ["PredgeAgentValidator", [validator]],
  ["PredgeValidatorBond", [validator, IS_MAINNET ? 86400n : 1n]],
  ["AgentJob", []],
  ["PredgeSettlement", []],
];

const fee = await provider.getFeeData();
const price = fee.maxFeePerGas ?? fee.gasPrice;
let totalGas = 0n;
for (const [name, args] of plan) {
  const { abi, bytecode } = await compileContract({
    sourcePath: new URL(`../contracts/${name}.sol`, import.meta.url).pathname,
    contractName: name,
  });
  const tx = await new ContractFactory(abi, bytecode).getDeployTransaction(...args);
  const gas = await provider.estimateGas({ ...tx, from });
  totalGas += gas;
  console.log(`${name.padEnd(22)} gas ${gas}`);
}
const cost = totalGas * price;
console.log(`\n${NETWORK.name}: total gas ${totalGas}, maxFee ${price} wei/gas`);
console.log(`estimated cost ${formatEther(cost)} ETH (fund at least ${formatEther(cost * 2n)} ETH for headroom)`);
console.log(`balance of ${from}: ${formatEther(await provider.getBalance(from))} ETH`);
