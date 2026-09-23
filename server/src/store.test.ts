// 持久化测试：重点是「重启之后还是对的」—— 用真的 SQLite 文件，跑完关掉、重开、再验。
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { Ledger } from "./ledger.js";
import { OrderBook } from "./engine/orderbook.js";
import { createRoutes } from "./routes.js";
import { parseFixed as P } from "./fixed.js";
import type { AuthEnv } from "./auth.js";
import type { MiddlewareHandler } from "hono";

const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";
const CAROL = "0x00000000000000000000000000000000000000c3";

const tmpDirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mini-dex-test-"));
  tmpDirs.push(dir);
  return join(dir, "state.sqlite");
}

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// ---- 一个够用的 routes 组装（只测下单/撤单，不碰链） ----
const bearer: MiddlewareHandler<AuthEnv> = async (c, next) => next();
const stubChain = { offline: true } as unknown as Parameters<typeof createRoutes>[0]["chain"];
const stubWs = { broadcast() {}, sendBalance() {}, sendOrders() {} };
const config = { chainId: 31337, wsUrl: "", vault: "", usdc: "", wavax: "" };

/** 和 index.ts 的启动顺序一致：先 load + restore，再给别的用 */
function boot(store: Store) {
  const ledger = new Ledger();
  const book = new OrderBook();
  const routes = createRoutes({ ledger, book, chain: stubChain, ws: stubWs, store, bearer, config });
  const saved = store.load();
  for (const [address, balances] of saved.balances) ledger.restore(address, balances);
  routes.restore(saved);
  return { ledger, book, routes, store };
}

describe("Store 读写", () => {
  it("金额用字符串存：超过 2^63 的 bigint 也能原样读回来", () => {
    const store = openStore(":memory:");
    const huge = 2n ** 70n + 12345n; // 存成 SQLite 的 64 位整数会被静默截断
    const ledger = new Ledger();
    ledger.credit(ALICE, "WAVAX", huge);

    store.save({ balances: ledger.entries(), orders: [], trades: [] });
    expect(store.load().balances[0]![1].WAVAX.available).toBe(huge);
    store.close();
  });

  it("余额、挂单、成交一起 roundtrip", () => {
    const store = openStore(":memory:");
    store.save({
      balances: [[ALICE, { USDC: { available: P("1.5"), locked: P("2.5") }, WAVAX: { available: 0n, locked: 0n } }]],
      orders: [{ id: "o1", owner: ALICE, side: "sell", type: "limit", tif: "GTC", price: P("10"), qty: P("3"), remaining: P("2"), ts: 111, seq: 7 }],
      trades: [{ id: "t1", price: "10", qty: "1", side: "buy", ts: 222 }],
    });

    const loaded = store.load();
    expect(loaded.balances).toHaveLength(1);
    expect(loaded.balances[0]![1].USDC).toEqual({ available: P("1.5"), locked: P("2.5") });
    expect(loaded.orders[0]).toMatchObject({ id: "o1", price: P("10"), remaining: P("2"), seq: 7 });
    expect(loaded.trades[0]).toMatchObject({ id: "t1", qty: "1" });
    store.close();
  });

  it("全 0 的账户不落库（不存一堆空行）", () => {
    const store = openStore(":memory:");
    const ledger = new Ledger();
    ledger.get(ALICE); // 只是建了个空账户
    store.save({ balances: ledger.entries(), orders: [], trades: [] });
    expect(store.load().balances).toHaveLength(0);
    store.close();
  });

  it("链上事件去重：同一笔第二次 save 不会重复标记，hasEvent 认得出", () => {
    const store = openStore(":memory:");
    expect(store.hasEvent("0xdead:0")).toBe(false);
    store.save({ balances: [], orders: [], trades: [] }, "0xdead:0");
    expect(store.hasEvent("0xdead:0")).toBe(true);
    expect(store.hasEvent("0xdead:1")).toBe(false);
    store.close();
  });

  it("区块游标只前进不后退", () => {
    const store = openStore(":memory:");
    expect(store.lastBlock()).toBeNull();
    store.setLastBlock(100n);
    store.setLastBlock(90n); // 乱序/重复回调
    expect(store.lastBlock()).toBe(100n);
    store.setLastBlock(101n);
    expect(store.lastBlock()).toBe(101n);
    store.close();
  });
});

describe("重启恢复", () => {
  it("挂单 + 余额活过重启，且恢复后撤单能正确解冻", () => {
    const path = tmpDbPath();

    // ---- 第一次运行：下一张限价买单，然后"进程结束" ----
    const s1 = boot(openStore(path));
    s1.ledger.credit(ALICE, "USDC", P("1000"));
    s1.routes.placeOrder(ALICE, { side: "buy", type: "limit", price: P("10"), qty: P("5") });
    expect(s1.ledger.get(ALICE).USDC).toEqual({ available: P("950"), locked: P("50") });
    s1.store.close();

    // ---- 第二次运行：同一个库文件，重新组装 ----
    const store2 = openStore(path);
    const s2 = boot(store2);
    const orders = s2.book.ordersOf(ALICE);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ side: "buy", price: P("10"), qty: P("5"), remaining: P("5") });
    expect(s2.ledger.get(ALICE).USDC).toEqual({ available: P("950"), locked: P("50") });

    // 冻结额是恢复时按挂单算出来的 —— 撤单成功就证明算对了
    expect(s2.routes.cancelOrder(ALICE, orders[0]!.id)).toBeTruthy();
    expect(s2.ledger.get(ALICE).USDC).toEqual({ available: P("1000"), locked: 0n });
    store2.close();
  });

  it("恢复后同价挂单的先后次序不变（时间优先没丢）", () => {
    const path = tmpDbPath();

    const s1 = boot(openStore(path));
    s1.ledger.credit(ALICE, "WAVAX", P("10"));
    s1.ledger.credit(BOB, "WAVAX", P("10"));
    s1.routes.placeOrder(ALICE, { side: "sell", type: "limit", price: P("10"), qty: P("1") }); // 先挂
    s1.routes.placeOrder(BOB, { side: "sell", type: "limit", price: P("10"), qty: P("1") });   // 同价后挂
    s1.store.close();

    const store2 = openStore(path);
    const s2 = boot(store2);
    s2.ledger.credit(CAROL, "USDC", P("100")); // 换个第三方来吃单，避开自成交防护
    s2.routes.placeOrder(CAROL, { side: "buy", type: "market", price: 0n, qty: P("1") });

    // 同价先挂的先成交：ALICE 的单被吃了，BOB 的还挂着
    expect(s2.book.ordersOf(ALICE)).toHaveLength(0);
    expect(s2.book.ordersOf(BOB)).toHaveLength(1);
    store2.close();
  });

  it("最近成交也活过重启", () => {
    const path = tmpDbPath();

    const s1 = boot(openStore(path));
    s1.ledger.credit(ALICE, "WAVAX", P("10"));
    s1.ledger.credit(BOB, "USDC", P("100"));
    s1.routes.placeOrder(ALICE, { side: "sell", type: "limit", price: P("10"), qty: P("1") });
    s1.routes.placeOrder(BOB, { side: "buy", type: "market", price: 0n, qty: P("1") });
    s1.store.close();

    const store2 = openStore(path);
    boot(store2);
    expect(store2.load().trades).toHaveLength(1);
    expect(store2.load().trades[0]).toMatchObject({ price: "10", qty: "1" });
    store2.close();
  });

  it("重启后新挂单的排队次序排在老单后面", () => {
    const path = tmpDbPath();

    const s1 = boot(openStore(path));
    s1.ledger.credit(ALICE, "WAVAX", P("10"));
    const first = s1.routes.placeOrder(ALICE, { side: "sell", type: "limit", price: P("10"), qty: P("1") }).order;
    s1.store.close();

    const store2 = openStore(path);
    const s2 = boot(store2);
    const second = s2.routes.placeOrder(ALICE, { side: "sell", type: "limit", price: P("10"), qty: P("1") }).order;

    // seq 计数器必须从恢复的最大值继续，否则新单会插到老单前面
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(s2.book.ordersOf(ALICE).map((o) => o.id)).toEqual([first.id, second.id]);
    store2.close();
  });
});

// 回归：提现是「先扣链下余额，再让用户自己去调 Vault.withdraw 上链」，
// 签发那一刻后端拿不到 tx hash，processed_events 认不出这笔提现。
// 于是重启回放会把同一笔提现再扣一次 —— 真机上实测漏了 40 USDC。
describe("重启回放提现：不能重复扣款", () => {
  const TOKEN_ADDR = "0x00000000000000000000000000000000000000aa";

  // 提现要走真实 HTTP 路径，所以这里不能用 boot() 里的 offline 桩
  const liveChainStub = {
    offline: false,
    checkWithdrawable: async () => {},
    signWithdraw: async () => ({ token: TOKEN_ADDR, amountWei: 0n, signature: "0x" }),
  } as unknown as Parameters<typeof createRoutes>[0]["chain"];

  /** 让 c.get("address") 直接返回指定地址，跳过真 JWT */
  const bearerAs = (address: string): MiddlewareHandler<AuthEnv> =>
    async (c, next) => { c.set("address", address); await next(); };

  function bootAs(store: Store, address: string) {
    const ledger = new Ledger();
    const book = new OrderBook();
    const routes = createRoutes({ ledger, book, chain: liveChainStub, ws: stubWs, store, bearer: bearerAs(address), config });
    const saved = store.load();
    for (const [addr, balances] of saved.balances) ledger.restore(addr, balances);
    routes.restore(saved);
    return { ledger, book, routes };
  }

  /** 走真的 POST /withdraw，返回后端签发的 nonce */
  async function withdraw(routes: ReturnType<typeof bootAs>["routes"], amount: string) {
    const res = await routes.app.request("/withdraw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "USDC", amount }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { nonce: string };
  }

  it("实时提现扣过的钱，重启回放不会再扣一次", async () => {
    const path = tmpDbPath();

    const s1 = openStore(path);
    const a = bootAs(s1, ALICE);
    a.ledger.credit(ALICE, "USDC", P("100"));
    const { nonce } = await withdraw(a.routes, "40");
    expect(a.ledger.get(ALICE).USDC.available).toBe(P("60"));
    s1.close();

    // 重启，回放链上那笔 Withdraw 事件
    const s2 = openStore(path);
    const b = bootAs(s2, ALICE);
    expect(b.ledger.get(ALICE).USDC.available).toBe(P("60"));

    const ev = { key: "0xdead:1", block: 1n, nonce: BigInt(nonce) };
    b.routes.onWithdrawBackfill(ALICE, "USDC", P("40"), ev);

    expect(b.ledger.get(ALICE).USDC.available).toBe(P("60")); // 还是 60，没被扣第二遍
    expect(s2.hasEvent(ev.key)).toBe(true);                   // 但要补上"已处理"标记
    s2.close();
  });

  it("不是本站签发的提现（nonce 没见过），回放照常扣账", () => {
    const store = openStore(":memory:");
    const { ledger, routes } = bootAs(store, ALICE);
    ledger.credit(ALICE, "USDC", P("100"));

    // 比如手动导入的历史账户：这笔提现后端没签过，链下余额也没扣过，就得扣
    routes.onWithdrawBackfill(ALICE, "USDC", P("30"), { key: "0xbeef:1", block: 1n, nonce: 999n });

    expect(ledger.get(ALICE).USDC.available).toBe(P("70"));
    store.close();
  });

  it("同一笔 Withdraw 事件回放两次也只扣一次", () => {
    const store = openStore(":memory:");
    const { ledger, routes } = bootAs(store, ALICE);
    ledger.credit(ALICE, "USDC", P("100"));

    const ev = { key: "0xbeef:2", block: 1n, nonce: 888n }; // 不认识的 nonce，走扣账分支
    routes.onWithdrawBackfill(ALICE, "USDC", P("30"), ev);
    routes.onWithdrawBackfill(ALICE, "USDC", P("30"), ev);

    expect(ledger.get(ALICE).USDC.available).toBe(P("70"));
    store.close();
  });
});
