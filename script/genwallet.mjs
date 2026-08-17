// Generate a fresh Robinhood Chain testnet deployer key. Writes .env (never committed);
// stdout only shows the PUBLIC address so a log/screenshare never leaks the key.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Wallet } from "ethers";
const ENV = new URL("../.env", import.meta.url).pathname;

if (existsSync(ENV) && /^PRIVATE_KEY=0x[0-9a-fA-F]{64}$/m.test(readFileSync(ENV, "utf8"))) {
  console.error(".env already has PRIVATE_KEY — refusing to overwrite. Delete it manually to rotate.");
  process.exit(1);
}
const w = Wallet.createRandom();
const body = [
  "# Robinhood Chain TESTNET · chainId 46630 · native gas token ETH",
  "# Faucet: https://faucet.testnet.chain.robinhood.com",
  "ROBINHOOD_RPC=https://rpc.testnet.chain.robinhood.com/rpc",
  "ROBINHOOD_CHAINID=46630",
  "ROBINHOOD_EXPLORER=https://explorer.testnet.chain.robinhood.com",
  `PRIVATE_KEY=${w.privateKey}`,
  `DEPLOYER_ADDRESS=${w.address}`,
  "",
].join("\n");
writeFileSync(ENV, body, { mode: 0o600 });
console.log("wrote .env (0600)");
console.log("deployer:", w.address);
console.log("fund at: https://faucet.testnet.chain.robinhood.com");
