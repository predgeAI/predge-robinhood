// PredgeSettlement constructor: (no args)
// NOTE: On Circle Arc, `msg.value` on payForRoute is native USDC. On Robinhood Chain the
// native gas token is ETH, so this contract records ETH-denominated payments. The bytecode
// is identical and correct; only the economic meaning of the token differs. See README.
import { compileAndDeploy } from "./_compile.mjs";
await compileAndDeploy({
  sourcePath: new URL("../contracts/PredgeSettlement.sol", import.meta.url).pathname,
  contractName: "PredgeSettlement",
  outFile: "PredgeSettlement.json",
});
