// 入口：读 env -> 组装 账本/引擎/登录/链/WS/路由 -> 监听 8787。
import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { Hex } from "viem";
import { OrderBook } from "./engine/orderbook.js";
import { Ledger } from "./ledger.js";
import { createAuth } from "./auth.js";
import { createChain } from "./chain.js";
import { createWs } from "./ws.js";
import { createRoutes } from "./routes.js";
import { startMarketMaker } from "./marketmaker.js";
import { openStore } from "./store.js";
import { parseFixed } from "./fixed.js";

const env = process.env;
const PORT = Number(env.PORT ?? 8787);
// 持久化：默认落 server/data/mini-dex.sqlite（已 gitignore）。DB_PATH=:memory: 退回纯内存（老行为）
const DB_PATH = env.DB_PATH || "./data/mini-dex.sqlite";
const CHAIN_ID = Number(env.CHAIN_ID ?? 31337);
const JWT_SECRET = env.JWT_SECRET ?? "dev-secret-change-me";
// 做市（可选）：MARKET_MAKER=1 开启，把 Binance 盘口镜像到本所订单簿
const MM_ENABLED = ["1", "true", "on"].includes((env.MARKET_MAKER ?? "").toLowerCase());
const MM = {
  address: env.MM_ADDRESS ?? "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720", // 默认 anvil 账户 #9
  symbol: env.MM_SYMBOL ?? "AVAXUSDT",
  levels: Number(env.MM_LEVELS ?? 10),
  scale: Number(env.MM_SCALE ?? 0.05),
  intervalMs: Number(env.MM_INTERVAL_MS ?? 2000),
  minQty: Number(env.MM_MIN_QTY ?? 0.1),
  maxQty: Number(env.MM_MAX_QTY ?? 200),
};

const config = {
  chainId: CHAIN_ID,
  wsUrl: `ws://localhost:${PORT}/ws`,
  vault: env.VAULT_ADDRESS ?? "",
  usdc: env.USDC_ADDRESS ?? "",
  wavax: env.WAVAX_ADDRESS ?? "",
  marketMaker: MM_ENABLED ? { address: MM.address.toLowerCase(), symbol: MM.symbol, source: "binance" } : null,
};

const ledger = new Ledger();
const book = new OrderBook();
const store = openStore(DB_PATH);
console.log(
  DB_PATH === ":memory:"
    ? "[store] DB_PATH=:memory:，纯内存模式（重启即丢）"
    : `[store] SQLite 持久化：${store.path}`,
);
const auth = createAuth({ chainId: CHAIN_ID, jwtSecret: JWT_SECRET });
const chain = createChain({
  chainId: CHAIN_ID,
  rpcUrl: env.RPC_URL ?? "http://127.0.0.1:8545",
  vault: config.vault, usdc: config.usdc, wavax: config.wavax,
  signerKey: (env.BACKEND_SIGNER_PRIVATE_KEY ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as Hex,
});

const app = new Hono();
app.use("*", cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173"] }));
app.get("/", (c) => c.json({ ok: true, name: "mini-dex", mode: chain.offline ? "offline" : "chain" }));
app.route("/", auth.router);

// routes 需要 ws，ws 需要 http server，所以先占个位，server 起来后再填
let hub: ReturnType<typeof createWs> | null = null;
const routes = createRoutes({
  ledger, book, chain, bearer: auth.bearer, config,
  store,
  ws: {
    broadcast: (t, d) => hub?.broadcast(t, d),
    sendBalance: (a, d) => hub?.sendBalance(a, d),
    sendOrders: (a, d) => hub?.sendOrders(a, d),
  },
});
app.route("/", routes.app);

// 先恢复上次的余额/挂单，再做别的 —— 回放链上事件和做市注资都会改账本，顺序反了就重复计账
const saved = store.load();
for (const [address, balances] of saved.balances) ledger.restore(address, balances);
routes.restore(saved);

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[server] http://localhost:${info.port}  ws://localhost:${info.port}/ws  chainId=${CHAIN_ID}`);
}) as Server;

hub = createWs({
  server,
  verifyToken: auth.verifyToken,
  getSnapshot: () => routes.snapshot(10),
  getBalances: routes.balancesSnapshot,
  getOrders: routes.ordersSnapshot,
});
// 回放起点：优先用库里存的游标（上次扫到哪就从下一块接着扫），没有才用 DEPOSIT_FROM_BLOCK 全量重建。
// 重复扫到同一笔也不会重复入账 —— routes.onDeposit 会用 processed_events 查重。
const cursor = store.lastBlock();
const fromBlock = cursor !== null ? cursor + 1n : env.DEPOSIT_FROM_BLOCK ? BigInt(env.DEPOSIT_FROM_BLOCK) : undefined;
if (cursor !== null) console.log(`[store] 链上事件游标 last_block=${cursor}，从 ${cursor + 1n} 继续回放`);
chain.watchDeposits(routes.onDeposit, {
  fromBlock,
  onWithdraw: routes.onWithdrawBackfill,
  onProgress: (block) => store.setLastBlock(block),
});

if (MM_ENABLED) {
  // 虚拟注资：做市账户本身不走链上充值时，用这两项给它账本余额（链上模式下这是"无抵押"的教学用资金，README 有说明）。
  // 只在账户还不存在时注资 —— 否则每次重启都会再送一份，做市账户的钱会越滚越多。
  const seedUsdc = env.MM_SEED_USDC ?? "100000";
  const seedWavax = env.MM_SEED_WAVAX ?? "10000";
  if (!ledger.has(MM.address)) {
    if (Number(seedUsdc) > 0) ledger.credit(MM.address, "USDC", parseFixed(seedUsdc));
    if (Number(seedWavax) > 0) ledger.credit(MM.address, "WAVAX", parseFixed(seedWavax));
    routes.persist();
  } else {
    console.log(`[mm] 账本里已有 ${MM.address} 的余额，跳过虚拟注资`);
  }
  startMarketMaker(MM, {
    ledger,
    ordersOf: routes.ordersOf,
    placeOrder: routes.placeOrder,
    cancelOrder: routes.cancelOrder,
    broadcastBook: routes.broadcastBook,
  });
}
