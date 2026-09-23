#!/usr/bin/env bash
# 设置 / 查看 Vault 的单笔提现限额 —— 演示「链上余额硬上限」用。
#
# 用法：
#   bash scripts/set-withdraw-limit.sh                 # 查看当前限额
#   bash scripts/set-withdraw-limit.sh USDC 50         # USDC 单笔最多 50
#   bash scripts/set-withdraw-limit.sh USDC 0          # 0 = 不限（演示完记得还原）
#   bash scripts/set-withdraw-limit.sh WAVAX 0.5
#
# 只从本地 .env 读私钥，不打印、不进 shell 历史。
set -euo pipefail
cd "$(dirname "$0")/.."   # 仓库根目录

# ---- 读配置 ----
# contracts/.env 里的 PRIVATE_KEY 必须是 Vault.owner（只有 owner 能改限额）
PRIVATE_KEY=$(grep -E '^PRIVATE_KEY=' contracts/.env | head -1 | cut -d= -f2-)
: "${PRIVATE_KEY:?contracts/.env 里没有 PRIVATE_KEY}"

envval() { grep -E "^$1=" server/.env | head -1 | cut -d= -f2- | tr -d '\r'; }
VAULT=$(envval VAULT_ADDRESS)
RPC=$(envval RPC_URL)
USDC=$(envval USDC_ADDRESS)
WAVAX=$(envval WAVAX_ADDRESS)
: "${VAULT:?server/.env 里没有 VAULT_ADDRESS}"

TOKEN_ARG="${1:-}"
AMOUNT_ARG="${2:-}"

token_addr() {
  case "$(echo "$1" | tr '[:lower:]' '[:upper:]')" in
    USDC)  echo "$USDC" ;;
    WAVAX) echo "$WAVAX" ;;
    *) echo "未知代币：$1（只支持 USDC / WAVAX）" >&2; exit 1 ;;
  esac
}

# 人类可读金额 -> 代币最小单位（USDC 6 位小数，WAVAX 18 位）
# 纯字符串拼接：18 位小数超出双精度能精确表示的范围，不能走浮点。
to_wei() {
  local human="$1" decimals="$2"
  awk -v a="$human" -v d="$decimals" 'BEGIN{
    n = split(a, p, ".");
    if (n > 2) { print "金额格式不对：" a > "/dev/stderr"; exit 1 }
    int_part = p[1]; frac = (n > 1) ? p[2] : "";
    if (length(frac) > d) { print "小数位超过 " d " 位：" a > "/dev/stderr"; exit 1 }
    while (length(frac) < d) frac = frac "0";
    out = int_part frac;
    sub(/^0+/, "", out);
    print (out == "") ? "0" : out;
  }'
}

echo "Vault : $VAULT"
echo "RPC   : $RPC"
echo

if [ -z "$TOKEN_ARG" ]; then
  echo "当前限额（0 = 不限）："
  printf '  USDC  : %s\n' "$(cast call "$VAULT" 'withdrawLimit(address)(uint256)' "$USDC"  --rpc-url "$RPC")"
  printf '  WAVAX : %s\n' "$(cast call "$VAULT" 'withdrawLimit(address)(uint256)' "$WAVAX" --rpc-url "$RPC")"
  echo
  echo "用法：bash scripts/set-withdraw-limit.sh USDC 50"
  exit 0
fi

: "${AMOUNT_ARG:?缺数量。用法：bash scripts/set-withdraw-limit.sh USDC 50}"
ADDR=$(token_addr "$TOKEN_ARG")
case "$(echo "$TOKEN_ARG" | tr '[:lower:]' '[:upper:]')" in
  USDC)  WEI=$(to_wei "$AMOUNT_ARG" 6) ;;
  WAVAX) WEI=$(to_wei "$AMOUNT_ARG" 18) ;;
esac

echo "把 $(echo "$TOKEN_ARG" | tr '[:lower:]' '[:upper:]') 的单笔限额设成 ${AMOUNT_ARG}（= ${WEI} 最小单位）…"
cast send "$VAULT" 'setWithdrawLimit(address,uint256)' "$ADDR" "$WEI" \
  --rpc-url "$RPC" --private-key "$PRIVATE_KEY" > /dev/null

echo -n "新限额："
cast call "$VAULT" 'withdrawLimit(address)(uint256)' "$ADDR" --rpc-url "$RPC"
