// PredgeAgentValidator constructor: (address validator_)
import { compileAndDeploy } from "./_compile.mjs";
import { env } from "../lib/robinhood.mjs";
const e = env();
const validator = e.VALIDATOR_ADDRESS || e.DEPLOYER_ADDRESS;
await compileAndDeploy({
  sourcePath: new URL("../contracts/PredgeAgentValidator.sol", import.meta.url).pathname,
  contractName: "PredgeAgentValidator",
  args: [validator],
  outFile: "PredgeAgentValidator.json",
});
