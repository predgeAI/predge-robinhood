// One compile-and-deploy helper reused by every deploy script — same solc settings and
// (standard EIP-1559) signer for all four contracts. Mirrors predge-rootstock/script/_compile.mjs
// but WITHOUT the legacy-tx hack: Robinhood Chain accepts standard 1559 envelopes.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import solc from "solc";
import { ContractFactory } from "ethers";
import {
  env, makeProvider, makeSigner, withRetry, addressLink, txLink,
  CHAIN_ID, DEFAULT_RPC, FAUCET,
} from "../lib/robinhood.mjs";

export async function compileContract({ sourcePath, contractName }) {
  const source = readFileSync(sourcePath, "utf8");
  const input = {
    language: "Solidity",
    sources: { [`${contractName}.sol`]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Arbitrum Nitro shipped full Cancun (PUSH0/MCOPY/TLOAD/TSTORE/BASEFEE) in the ArbOS 32
      // "Bianca" upgrade (2024). Robinhood Chain is a post-Bianca Orbit L2, so cancun compiles
      // and deploys clean. (These contracts use none of the transient-storage opcodes anyway —
      // the only precompile touched is 0x02 SHA-256, universal on every EVM chain.)
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const fatal = (out.errors || []).filter((e) => e.severity === "error");
  if (fatal.length) {
    console.error("Solc errors:\n" + fatal.map((e) => e.formattedMessage).join("\n"));
    process.exit(1);
  }
  const c = out.contracts[`${contractName}.sol`][contractName];
  console.log(`Compiled ${contractName} (solc ${solc.version()}, evmVersion cancun).`);
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

export async function compileAndDeploy({ sourcePath, contractName, args = [], outFile }) {
  const { abi, bytecode } = await compileContract({ sourcePath, contractName });

  const e = env();
  if (!e.PRIVATE_KEY) {
    console.error("No PRIVATE_KEY in .env — run `npm run genwallet`.");
    process.exit(1);
  }
  const provider = makeProvider(e.ROBINHOOD_RPC || DEFAULT_RPC);
  const wallet = await makeSigner(e.PRIVATE_KEY, provider);
  const bal = await withRetry("getBalance", () => provider.getBalance(wallet.address));
  console.log("Deployer:", wallet.address, "| wei:", bal.toString());
  if (bal === 0n) {
    console.error(`Balance is 0. Fund ${wallet.address} at ${FAUCET} and re-run.`);
    process.exit(1);
  }

  const factory = new ContractFactory(abi, bytecode, wallet);
  const contract = await withRetry("deploy", () => factory.deploy(...args));
  const deployTx = contract.deploymentTransaction();
  await withRetry("waitForDeployment", () => contract.waitForDeployment());
  const addr = await contract.getAddress();
  console.log(`\n${contractName} deployed at: ${addr}`);
  console.log("  " + addressLink(addr));
  console.log("  deploy tx: " + txLink(deployTx.hash));

  const DEPLOY_DIR = new URL("../deploy/", import.meta.url).pathname;
  if (!existsSync(DEPLOY_DIR)) mkdirSync(DEPLOY_DIR, { recursive: true });
  writeFileSync(
    DEPLOY_DIR + outFile,
    JSON.stringify(
      {
        address: addr,
        deployer: wallet.address,
        chainId: Number(CHAIN_ID),
        deployTx: deployTx.hash,
        deployedAt: new Date().toISOString(),
        args: args.map((a) => (typeof a === "bigint" ? a.toString() : a)),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Wrote deploy/${outFile}`);
  return { address: addr, abi, wallet, provider };
}
