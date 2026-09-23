// WebSocket 广播：和 HTTP 共用同一个端口，路径 /ws。
// 公共频道（全员）：orderbook / trade。
// 私有频道（只推给发过 {type:"auth", token} 且地址匹配的连接）：balance / orders。
// 新连接一进来先发一份订单簿快照；认证通过后再补一份该地址的余额和挂单快照，
// 这样前端重连后不用额外 GET 就能自愈。
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

export interface WsHub {
  broadcast(type: "orderbook" | "trade", data: unknown): void;
  sendBalance(address: string, data: unknown): void;
  /** 私有 orders 频道：把该地址当前的挂单列表推给它自己的连接（别人一条都收不到） */
  sendOrders(address: string, data: unknown): void;
}

export function createWs(opts: {
  server: Server;
  verifyToken: (token: string) => Promise<string | null>;
  getSnapshot: () => unknown;
  /** 认证通过时取该地址的余额快照（格式和 GET /balances 一致） */
  getBalances: (address: string) => unknown;
  /** 认证通过时取该地址的挂单快照（格式和 GET /orders 一致） */
  getOrders: (address: string) => unknown;
}): WsHub {
  const wss = new WebSocketServer({ server: opts.server, path: "/ws" });
  const authed = new Map<WebSocket, string>(); // socket -> 小写地址

  wss.on("connection", (ws) => {
    send(ws, { type: "orderbook", data: opts.getSnapshot() });

    ws.on("message", async (raw) => {
      let msg: { type?: string; token?: string };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "auth" && typeof msg.token === "string") {
        const address = await opts.verifyToken(msg.token);
        if (address) authed.set(ws, address);
        send(ws, { type: "auth", ok: !!address, address });
        // 认证成功：补发这个地址的余额 + 挂单快照（只发给这一条连接）
        if (address) {
          send(ws, { type: "balance", address, data: opts.getBalances(address) });
          send(ws, { type: "orders", address, data: opts.getOrders(address) });
        }
      }
    });
    ws.on("close", () => authed.delete(ws));
  });

  function send(ws: WebSocket, msg: unknown) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  /** 只发给这个地址已认证的连接 —— 私有频道的地基 */
  function sendTo(address: string, type: "balance" | "orders", data: unknown) {
    const key = address.toLowerCase();
    for (const [ws, addr] of authed) {
      if (addr === key) send(ws, { type, address: key, data });
    }
  }

  return {
    broadcast(type, data) {
      for (const ws of wss.clients) send(ws, { type, data });
    },
    sendBalance(address, data) {
      sendTo(address, "balance", data);
    },
    sendOrders(address, data) {
      sendTo(address, "orders", data);
    },
  };
}
