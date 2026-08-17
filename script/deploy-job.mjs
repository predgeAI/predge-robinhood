// AgentJob constructor: (no args)
import { compileAndDeploy } from "./_compile.mjs";
await compileAndDeploy({
  sourcePath: new URL("../contracts/AgentJob.sol", import.meta.url).pathname,
  contractName: "AgentJob",
  outFile: "AgentJob.json",
});
