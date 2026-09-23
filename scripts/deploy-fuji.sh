#!/usr/bin/env bash
# 一键部署 mini-dex 到 Avalanche Fuji，并打印可直接粘贴到 server/.env 的几行配置。
#
# 前置：把已充好 AVAX 的钱包私钥填到 contracts/.env 的 PRIVATE_KEY（该文件已被 gitignore）。
# 用法：bash scripts/deploy-fuji.sh
#
# 这个脚本只做「读链 + 部署」，不会删任何文件、不会 kill 任何进程。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/contracts"

if [[ ! -f .env ]]; then
  echo "✗ 找不到 contracts/.env，先按 contracts/.env 里的说明填 PRIVATE_KEY" >&2
  exit 1
fi
# 只导入 .env 里「非空」的项，这样两种用法都可以：
#   bash scripts/deploy-fuji.sh
#   PRIVATE_KEY=0x... bash scripts/deploy-fuji.sh
while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  key="${line%%=*}"; val="${line#*=}"
  key="${key//[[:space:]]/}"
  [[ -z "$key" || -z "$val" ]] && continue
  [[ -n "${!key:-}" ]] && continue
  export "$key=$val"
done < .env

if [[ -z "${PRIVATE_KEY:-}" ]]; then
  echo "✗ contracts/.env 里的 PRIVATE_KEY 还是空的。" >&2
  echo "  把已充好 AVAX 的钱包私钥填进去再跑（这个文件不会提交）。" >&2
  exit 1
fi

RPC="${FUJI_RPC:-https://api.avax-test.network/ext/bc/C/rpc}"
DEPLOYER="$(cast wallet address --private-key "$PRIVATE_KEY")"
BALANCE="$(cast balance "$DEPLOYER" --rpc-url "$RPC")"

echo "部署者      : $DEPLOYER"
echo "余额        : $(cast from-wei "$BALANCE") AVAX"
echo "后端 signer : ${SIGNER_ADDRESS:-（未设置！）}"
echo "RPC         : $RPC"
echo

if [[ "$BALANCE" == "0" ]]; then
  echo "✗ 这个地址在 Fuji 上没有 AVAX，先领水：https://core.app/tools/testnet-faucet/" >&2
  exit 1
fi
if [[ -z "${SIGNER_ADDRESS:-}" ]]; then
  echo "✗ contracts/.env 里缺 SIGNER_ADDRESS" >&2
  exit 1
fi

# 部署前先记下区块号：server 启动时要从这里回放 Deposit 事件，
# 记早了只是多扫几个空块，记晚了就会漏掉早期充值。
FROM_BLOCK="$(cast block-number --rpc-url "$RPC")"
echo "部署前区块高度: $FROM_BLOCK（用作 DEPOSIT_FROM_BLOCK）"
echo

forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast

echo
echo "=================================================================="
echo "# 把下面这几行贴进 server/.env（VAULT/USDC/WAVAX 换成上面的输出）"
echo "CHAIN_ID=43113"
echo "RPC_URL=$RPC"
echo "DEPOSIT_FROM_BLOCK=$FROM_BLOCK"
echo "=================================================================="
echo "部署者地址（充值 / 提现演示用）: $DEPLOYER"
