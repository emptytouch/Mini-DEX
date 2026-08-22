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

const env = process.env;
const PORT = Number(env.PORT ?? 8787);
const CHAIN_ID = Number(env.CHAIN_ID ?? 31337);
const JWT_SECRET = env.JWT_SECRET ?? "dev-secret-change-me";
const config = {
  chainId: CHAIN_ID,
  wsUrl: `ws://localhost:${PORT}/ws`,
  vault: env.VAULT_ADDRESS ?? "",
  usdc: env.USDC_ADDRESS ?? "",
  wavax: env.WAVAX_ADDRESS ?? "",
};

const ledger = new Ledger();
const book = new OrderBook();
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
  ws: {
    broadcast: (t, d) => hub?.broadcast(t, d),
    sendBalance: (a, d) => hub?.sendBalance(a, d),
  },
});
app.route("/", routes.app);

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[server] http://localhost:${info.port}  ws://localhost:${info.port}/ws  chainId=${CHAIN_ID}`);
}) as Server;

hub = createWs({ server, verifyToken: auth.verifyToken, getSnapshot: () => routes.snapshot(10) });
// DEPOSIT_FROM_BLOCK 有值时，启动先从该区块回放 Deposit/Withdraw 重建余额（内存账本重启即丢）
const fromBlock = env.DEPOSIT_FROM_BLOCK ? BigInt(env.DEPOSIT_FROM_BLOCK) : undefined;
chain.watchDeposits(routes.onDeposit, { fromBlock, onWithdraw: routes.onWithdrawBackfill });
