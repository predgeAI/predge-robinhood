// PredgeValidatorBond constructor: (address validator_, uint64 disputeWindow_)
import { compileAndDeploy } from "./_compile.mjs";
import { env } from "../lib/robinhood.mjs";
const e = env();
const validator = e.VALIDATOR_ADDRESS || e.DEPLOYER_ADDRESS;
const disputeWindow = BigInt(e.BOND_DISPUTE_WINDOW || "1");
await compileAndDeploy({
  sourcePath: new URL("../contracts/PredgeValidatorBond.sol", import.meta.url).pathname,
  contractName: "PredgeValidatorBond",
  args: [validator, disputeWindow],
  outFile: "PredgeValidatorBond.json",
});
