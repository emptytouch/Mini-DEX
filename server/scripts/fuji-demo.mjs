// Fuji 端到端演练：登录 -> 充值 -> 两个地址成交 -> 提现（真实上链）。
// 跑：node scripts/fuji-demo.mjs        （在 server/ 目录下，这样能解析到 viem）
// 可用环境变量覆盖：API_URL / RPC_URL / CHAIN_ID / VAULT_ADDRESS / USDC_ADDRESS / WAVAX_ADDRESS
//
// 两个演示地址：
//   A = 0x19E7...（部署者，水龙头账户，私钥 0x1111...1111 是公开的测试键）
//   B = 0x7C85...（anvil 账户 #3，由 A 转一点 AVAX 给它付 gas）
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, getAddress, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// 账号 A = 部署者本人（私钥从 contracts/.env 读，该文件 gitignore，不会进仓库也不会进聊天记录）
function readEnvFile(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (/^\s*(#|$)/.test(line)) continue;
      const i = line.indexOf("=");
      if (i < 0) continue;
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch { /* 读不到就让下面的报错去说 */ }
  return out;
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const deployEnv = readEnvFile(join(root, "contracts", ".env"));
const deployerKey = process.env.PRIVATE_KEY ?? deployEnv.PRIVATE_KEY;
if (!deployerKey) throw new Error("读不到部署者私钥：在 contracts/.env 里填 PRIVATE_KEY，或用 PRIVATE_KEY=0x... 跑本脚本");

const API = process.env.API_URL ?? "http://localhost:8790";
const RPC = process.env.RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 43113);
const VAULT = getAddress(process.env.VAULT_ADDRESS ?? "0xBf448A2b6D987BCbA9591E6f72D0156Bef1503f0");
const USDC = getAddress(process.env.USDC_ADDRESS ?? "0xb268B7f56726b9256ffF6C27F90513238360aBA7");
const WAVAX = getAddress(process.env.WAVAX_ADDRESS ?? "0x9497e2f5438d8aE167b0BA5B9bC328D03e4E1204");

const A = privateKeyToAccount(deployerKey);
const B = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");

const pub = createPublicClient({ transport: http(RPC) });
const walletA = createWalletClient({ account: A, transport: http(RPC) });
const walletB = createWalletClient({ account: B, transport: http(RPC) });

const erc20 = parseAbi([
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const vaultAbi = parseAbi([
  "function deposit(address token, uint256 amount)",
  "function withdraw(address token, uint256 amount, uint256 nonce, uint256 deadline, bytes signature)",
  "function balances(address,address) view returns (uint256)",
]);

// Fuji 的公共 RPC 在连续发交易时会返回偏旧的 pending nonce，所以本地自己数 nonce。
const nonces = new Map();
const nextNonce = async (address) => {
  if (!nonces.has(address)) nonces.set(address, await pub.getTransactionCount({ address, blockTag: "pending" }));
  const n = nonces.get(address);
  nonces.set(address, n + 1);
  return n;
};

const tx = async (hash, label) => {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
  console.log(`  ${label.padEnd(34)} ${hash}`);
  return hash;
};

const write = async (wallet, account, req) =>
  tx(await wallet.writeContract({ ...req, nonce: await nextNonce(account.address) }), req.label);

const api = async (path, init = {}) => {
  const res = await fetch(API + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.auth ? { authorization: `Bearer ${init.auth}` } : {}) },
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
};
const must = async (path, init) => {
  const r = await api(path, init);
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

async function login(account) {
  const { nonce } = await must(`/auth/nonce?address=${account.address}`);
  const signature = await account.signTypedData({
    domain: { name: "MiniDex", version: "1", chainId: CHAIN_ID },
    types: { Login: [{ name: "address", type: "address" }, { name: "nonce", type: "string" }, { name: "statement", type: "string" }] },
    primaryType: "Login",
    message: { address: account.address, nonce, statement: "Sign in to MiniDex" },
  });
  const { token } = await must("/auth/login", { method: "POST", body: JSON.stringify({ address: account.address, nonce, signature }) });
  console.log(`  登录成功 ${account.address}`);
  return token;
}

async function waitBalance(auth, asset, want) {
  for (let i = 0; i < 60; i++) {
    const b = await must("/balances", { auth });
    if (Number(b[asset].available) >= want) return b;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`等 ${asset} 余额 >= ${want} 超时`);
}

async function deposit(account, wallet, auth, token, decimals, human, label) {
  const amount = BigInt(human) * 10n ** BigInt(decimals);
  await write(wallet, account, { address: token, abi: erc20, functionName: "mint", args: [account.address, amount], gas: 200000n, label: `${label} mint ${human}` });
  await write(wallet, account, { address: token, abi: erc20, functionName: "approve", args: [VAULT, amount], gas: 200000n, label: `${label} approve` });
  await write(wallet, account, { address: VAULT, abi: vaultAbi, functionName: "deposit", args: [token, amount], gas: 300000n, label: `${label} deposit ${human}` });
  return auth;
}

// ---------------------------------------------------------------- 1. 登录
console.log("\n【1】EIP-712 登录");
const authA = await login(A);
const authB = await login(B);

// ---------------------------------------------------------------- 2. B 的 gas
console.log("\n【2】给 B 转一点 AVAX 付 gas");
const bBal = await pub.getBalance({ address: B.address });
if (bBal < 10n ** 16n) {
  await tx(await walletA.sendTransaction({ to: B.address, value: 3n * 10n ** 16n, gas: 21000n, nonce: await nextNonce(A.address) }), "A -> B 0.03 AVAX");
} else {
  console.log(`  B 已有 ${formatEther(bBal)} AVAX，跳过`);
}

// ---------------------------------------------------------------- 3. 充值
console.log("\n【3】链上充值（真实交易）");
await deposit(A, walletA, authA, USDC, 6, "500", "A");
await deposit(A, walletA, authA, WAVAX, 18, "5", "A");
await deposit(B, walletB, authB, USDC, 6, "500", "B");
await deposit(B, walletB, authB, WAVAX, 18, "5", "B");

console.log("\n  等后端监听到 Deposit 事件并记账…");
const showBal = (who, b) => console.log(`  ${who}  USDC ${b.USDC.available}（锁 ${b.USDC.locked}） / WAVAX ${b.WAVAX.available}（锁 ${b.WAVAX.locked}）`);
await waitBalance(authA, "WAVAX", 5);
await waitBalance(authB, "WAVAX", 5);
showBal("A", await must("/balances", { auth: authA }));
showBal("B", await must("/balances", { auth: authB }));

// ---------------------------------------------------------------- 4. 两个地址成交
console.log("\n【4】两个地址成交：A 挂卖单，B 吃单");
const cfg = await must("/config");
const ob = await must("/orderbook?depth=1");
const bid = Number(ob.bids[0]?.[0] ?? 0);
const ask = Number(ob.asks[0]?.[0] ?? 0);
console.log(`  当前盘口 买 ${bid || "—"} / 卖 ${ask || "—"}${cfg.marketMaker ? "（做市镜像 Binance）" : "（无做市，空簿）"}`);

// 做市开着的时候价差只有 1 个 tick（买 10.943 / 卖 10.944），用户单无论挂在哪都会被
// 做市账户先吃掉，演示不出「两个真实地址互成交」。所以这一步要求关掉做市跑。
if (cfg.marketMaker) {
  throw new Error("做市模块开着：价差只有 1 tick，B 的市价单一定会先吃做市账户。请用 MARKET_MAKER= 的端口重跑本脚本。");
}

const sellPrice = "10.950";
console.log(`  A 挂限价卖单 ${sellPrice} × 1 WAVAX`);
const s = await must("/orders", { method: "POST", auth: authA, body: JSON.stringify({ side: "sell", type: "limit", price: sellPrice, qty: "1" }) });
console.log(`  挂单 id=${s.order.id}  剩余 ${s.order.remaining}（空簿，挂住不吃单）`);

console.log(`  B 市价买入 1 WAVAX`);
const b = await must("/orders", { method: "POST", auth: authB, body: JSON.stringify({ side: "buy", type: "market", qty: "1", tif: "IOC" }) });
if (b.fills.length === 0) throw new Error("B 的市价单没有成交");
for (const f of b.fills) console.log(`  成交 ${f.qty} @ ${f.price}  maker=${f.maker}  taker=${f.taker}`);
if (b.fills.some((f) => f.maker.toLowerCase() !== A.address.toLowerCase())) {
  throw new Error("成交对手方不是 A，两个真实地址没有互成交");
}
console.log(`  ✅ 成交发生在 A(${A.address.slice(0, 10)}…) 和 B(${B.address.slice(0, 10)}…) 两个真实地址之间`);

const balA = await must("/balances", { auth: authA });
const balB = await must("/balances", { auth: authB });
console.log(`  A 余额: USDC ${balA.USDC.available} / WAVAX ${balA.WAVAX.available}`);
console.log(`  B 余额: USDC ${balB.USDC.available} / WAVAX ${balB.WAVAX.available}`);

// ---------------------------------------------------------------- 5. 提现
console.log("\n【5】B 提现 1 WAVAX（链下扣账 -> 后端签名 -> 自己上链）");
const w = await must("/withdraw", { method: "POST", auth: authB, body: JSON.stringify({ token: "WAVAX", amount: "1" }) });
console.log(`  后端签名 ok：token=${w.token} tokenAddress=${w.tokenAddress} amount=${w.amount} nonce=${w.nonce}`);
const before = await pub.readContract({ address: WAVAX, abi: erc20, functionName: "balanceOf", args: [B.address] });
const wHash = await write(walletB, B, {
  address: VAULT, abi: vaultAbi, functionName: "withdraw",
  args: [getAddress(w.tokenAddress), BigInt(w.amount), BigInt(w.nonce), BigInt(w.deadline), w.signature],
  gas: 300000n, label: "B Vault.withdraw 1 WAVAX",
});
const after = await pub.readContract({ address: WAVAX, abi: erc20, functionName: "balanceOf", args: [B.address] });
console.log(`  B 链上 WAVAX 到账 +${Number(after - before) / 1e18}`);
console.log(`  链下 WAVAX 可用 ${(await must("/balances", { auth: authB })).WAVAX.available}`);
console.log(`\n提现交易哈希: ${wHash}`);
