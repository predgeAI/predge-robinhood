#!/usr/bin/env bash
# M2 end to end, one command: a dispute on Arbitrum One settled with USDC burned on Base over CCTP V2.
#
#   scripts/m2-run.sh --circle-env ~/predge-circle-mainnet/.env                 # DRY RUN (default): checks + simulation, sends nothing
#   scripts/m2-run.sh --circle-env ~/predge-circle-mainnet/.env --yes-mainnet   # sends real mainnet transactions
#
# Options: --id <label>      dispute label (default: m2-<escrow address prefix>, so a re-run resumes the same dispute)
#          --amount 0.10     USDC burned on Base (max 1)
#
# Steps: preflight balances -> deploy escrow from the current commit (only if the recorded one is not built from
# this source) -> open -> approve -> burn -> wait for Circle attestation -> fund -> verdict (score 0) -> resolve ->
# withdraw -> --verify. Each step is recorded in deploy/arbitrum-one/cctp-m2-<id>.json before it is sent, so after
# an error simply re-run the same command: finished steps are skipped and nothing is sent twice.
# Everything printed (tx hashes included) is also appended to deploy/arbitrum-one/m2-run-<id>-<time>.log.
# Keys are read from .env and the Circle env file by the node scripts and are never printed.
set -euo pipefail
set +x
cd "$(dirname "$0")/.."

CIRCLE_ENV="" ; ID="" ; AMOUNT="0.10" ; SEND=0
while [ $# -gt 0 ]; do
  case "$1" in
    --circle-env) CIRCLE_ENV="${2:?}"; shift 2 ;;
    --id) ID="${2:?}"; shift 2 ;;
    --amount) AMOUNT="${2:?}"; shift 2 ;;
    --yes-mainnet) SEND=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done
[ -n "$CIRCLE_ENV" ] || { echo "--circle-env <path to the mainnet Circle .env> is required" >&2; exit 64; }
[ -f "$CIRCLE_ENV" ] || { echo "Circle env file not found: $CIRCLE_ENV" >&2; exit 64; }
[ -f .env ] || { echo ".env with PRIVATE_KEY (the validator / deployer key) is required in $(pwd)" >&2; exit 64; }

mkdir -p deploy/arbitrum-one
LOG="deploy/arbitrum-one/m2-run-${ID:-auto}-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG") 2>&1
echo "== M2 run $(date -u +%FT%TZ)  commit $(git rev-parse --short HEAD)  mode $([ $SEND = 1 ] && echo SEND-MAINNET || echo DRY-RUN)"
if [ -n "$(git status --porcelain -- contracts script scripts)" ]; then
  echo "!! uncommitted changes in contracts/ or script(s)/: commit or stash them first"; exit 1
fi
[ -d node_modules/ethers ] || npm ci --no-audit --no-fund
export NETWORK=arbitrum-one

STEP="node script/cctp-m2-dispute.mjs"
escrow_addr() { node -e 'const f="deploy/arbitrum-one/PredgeCctpDisputeEscrow.json";try{console.log(JSON.parse(require("fs").readFileSync(f,"utf8")).address)}catch{}'; }
label() { [ -n "$ID" ] && echo "$ID" || { a="$(escrow_addr)"; [ -n "$a" ] && echo "m2-${a:2:8}" || echo "m2-new"; }; }

echo; echo "== 1/4 preflight (balances, validator key)"
$STEP --preflight --amount "$AMOUNT"

echo; echo "== 2/4 escrow"
if node script/deploy-cctp-escrow.mjs --check-current; then
  :
elif [ $SEND = 1 ]; then
  echo "deploying PredgeCctpDisputeEscrow from commit $(git rev-parse HEAD)"
  node script/deploy-cctp-escrow.mjs
  node script/deploy-cctp-escrow.mjs --check-current
else
  node script/deploy-cctp-escrow.mjs --estimate
  echo; echo "DRY RUN: the escrow would be deployed now; steps open..withdraw need it, so the plan stops here."
  echo "Re-run with --yes-mainnet to send. Log: $LOG"; exit 0
fi
L="$(label)"
ARGS=(--id "$L" --amount "$AMOUNT" --score 0 --circle-env "$CIRCLE_ENV")
echo "dispute label $L"

if [ $SEND = 0 ]; then
  echo; echo "== 3/4 plan (read-only simulation)"
  $STEP "${ARGS[@]}"
  echo; echo "DRY RUN finished, nothing sent. Re-run with --yes-mainnet to send. Log: $LOG"; exit 0
fi

echo; echo "== 3/4 send"
node -e 'require.resolve("@circle-fin/developer-controlled-wallets")' 2>/dev/null || npm i --no-save --no-audit --no-fund @circle-fin/developer-controlled-wallets
for s in open approve burn fund verdict resolve withdraw; do
  echo; echo "-- $s"
  $STEP "${ARGS[@]}" --step "$s" --yes
done

echo; echo "== 4/4 verify"
$STEP "${ARGS[@]}" --verify
echo; echo "done. State: deploy/arbitrum-one/cctp-m2-$L.json  Log: $LOG"
