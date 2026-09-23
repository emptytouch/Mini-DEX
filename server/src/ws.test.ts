// 私有 orders 频道测试：认证通过才推、且只推给订单所有者自己的那条连接。
// 起一个真的 http server + 真的 ws 连接（不是 mock），因为要验的正是"谁能收到"。
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createWs, type WsHub } from "./ws.js";

const addr = (i: number) => "0x" + i.toString(16).padStart(40, "0");
const ALICE = addr(1); // 0x00…01
const BOB = addr(2);

const TOKENS: Record<string, string> = { "alice-token": ALICE, "bob-token": BOB };

/** 把一条连接收到的消息排成队列，next(type) 取第一条匹配的（没有就等，2 秒超时） */
function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs: any[] = [];
  const waiters: { type?: string; resolve: (m: any) => void }[] = [];

  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    // 有人在等就直接交给它（不进队列，否则 msgs 里会留下已消费的副本，
    // "不该收到消息" 的断言就没法用 msgs 判断了）
    const i = waiters.findIndex((w) => !w.type || w.type === m.type);
    if (i >= 0) { waiters.splice(i, 1)[0].resolve(m); return; }
    msgs.push(m);
  });

  const next = (type?: string): Promise<any> => {
    const i = msgs.findIndex((m) => !type || m.type === type);
    if (i >= 0) return Promise.resolve(msgs.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`超时：没等到 ${type ?? "任意"} 消息`)), 2000);
      waiters.push({ type, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  };

  const auth = async (token: string) => {
    // 同一条连接可能认证第二次（换地址），所以只在还没连上时才等 open
    if (ws.readyState !== WebSocket.OPEN) await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "auth", token }));
    return next("auth");
  };

  return { ws, next, auth, msgs };
}

const idle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

let server: Server | undefined;
let hub: WsHub;
const opened: WebSocket[] = [];
// 测试里拿 getOrders/getBalances 收到的地址，用来断言"推的是本人数据"
const seenOrders: string[] = [];

async function boot() {
  server = createServer();
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  hub = createWs({
    server,
    verifyToken: async (t) => TOKENS[t] ?? null,
    getSnapshot: () => ({ bids: [], asks: [] }),
    getBalances: (a) => ({ USDC: { available: "100", locked: "0" }, WAVAX: { available: "1", locked: "0" }, who: a }),
    getOrders: (a) => {
      seenOrders.push(a);
      return [{ id: `order-of-${a}`, owner: a, side: "sell", price: "10", qty: "1", remaining: "1" }];
    },
  });
  return port;
}

afterEach(async () => {
  for (const ws of opened) ws.close();
  opened.length = 0;
  seenOrders.length = 0;
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

function open(port: number) {
  const c = connect(port);
  opened.push(c.ws);
  return c;
}

describe("WS 私有 orders 频道", () => {
  it("认证通过后，把本人的余额和挂单快照补发给这条连接", async () => {
    const port = await boot();
    const alice = open(port);

    await alice.next("orderbook"); // 一进来先给公共订单簿
    const ack = await alice.auth("alice-token");
    expect(ack).toMatchObject({ ok: true, address: ALICE });

    const balance = await alice.next("balance");
    expect(balance.address).toBe(ALICE);
    expect(balance.data.USDC.available).toBe("100");

    const orders = await alice.next("orders");
    expect(orders.address).toBe(ALICE);
    expect(orders.data).toHaveLength(1);
    expect(orders.data[0].owner).toBe(ALICE);
    expect(seenOrders).toEqual([ALICE]); // 只查了本人的数据
  });

  it("sendOrders 只推给该地址自己的连接：别人的连接、未登录的连接都收不到", async () => {
    const port = await boot();
    const alice = open(port);
    const bob = open(port);
    const anon = open(port);

    await alice.auth("alice-token");
    await bob.auth("bob-token");
    await alice.next("orderbook");
    await bob.next("orderbook");
    await anon.next("orderbook");
    await alice.next("balance");
    await alice.next("orders");
    await bob.next("balance");
    await bob.next("orders");
    await idle(); // 该收的都收完了，此刻三条队列都应该是空的

    hub.sendOrders(ALICE, [{ id: "new", owner: ALICE, remaining: "0.5" }]);
    hub.sendBalance(ALICE, { USDC: { available: "42", locked: "0" } });

    const pushed = await alice.next("orders");
    expect(pushed.address).toBe(ALICE);
    expect(pushed.data[0].id).toBe("new");
    const bal = await alice.next("balance");
    expect(bal.data.USDC.available).toBe("42");

    // 关键断言：Bob 和匿名连接一条私有消息都不该有
    await idle();
    expect(bob.msgs).toEqual([]);
    expect(anon.msgs).toEqual([]);
  });

  it("大小写不同的地址算同一个人（链上地址比较不区分大小写）", async () => {
    const port = await boot();
    const alice = open(port);
    await alice.auth("alice-token");
    await alice.next("balance");
    await alice.next("orders");

    const checksummed = "0x" + ALICE.slice(2).toUpperCase();
    hub.sendOrders(checksummed, [{ id: "upper", owner: ALICE }]);

    const pushed = await alice.next("orders");
    expect(pushed.data[0].id).toBe("upper");
    expect(pushed.address).toBe(ALICE); // 推送里统一是小写
  });

  it("改 token 重新认证会换绑地址：旧地址的推送不再送达", async () => {
    const port = await boot();
    const conn = open(port);
    await conn.next("orderbook");
    await conn.auth("alice-token");
    await conn.next("balance");
    await conn.next("orders");
    await conn.auth("bob-token"); // 同一条连接改成 Bob
    await conn.next("balance");   // 换绑后服务端会重推一份 Bob 的余额 + 挂单快照
    expect((await conn.next("orders")).data[0].owner).toBe(BOB);

    hub.sendOrders(ALICE, [{ id: "for-alice" }]);
    hub.sendOrders(BOB, [{ id: "for-bob" }]);

    const pushed = await conn.next("orders");
    expect(pushed.data[0].id).toBe("for-bob");
    await idle();
    expect(conn.msgs).toEqual([]); // alice 的那条没进来
  });

  it("公共频道不受影响：orderbook / trade 还是发给所有人", async () => {
    const port = await boot();
    const alice = open(port);
    const anon = open(port);
    await alice.next("orderbook");
    await anon.next("orderbook");

    hub.broadcast("trade", { id: "t1", price: "10", qty: "1" });

    expect((await alice.next("trade")).data.id).toBe("t1");
    expect((await anon.next("trade")).data.id).toBe("t1");
  });

  it("token 无效时不发私有快照，只回 auth ok:false", async () => {
    const port = await boot();
    const conn = open(port);
    await conn.next("orderbook");

    const ack = await conn.auth("bogus");
    expect(ack.ok).toBe(false);

    await idle();
    expect(conn.msgs).toEqual([]);
    expect(seenOrders).toEqual([]);
  });
});
