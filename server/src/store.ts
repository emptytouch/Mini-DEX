// SQLite 持久化：把「重启后必须还在」的东西落库 —— 账本余额、订单簿挂单、最近成交、链上事件游标。
// 用 Node 22.5+ 内置的 node:sqlite（DatabaseSync），不引第三方依赖、不需要原生编译。
//
// 取舍：撮合和结算仍然全在内存里算，落库是「改完就全量重写一遍」。数据量是几百行级别，
// 简单可读 > 高效；生产该走增量写 + WAL + 连接池（Primit 用 TimescaleDB）。
//
// 注意：bigint 全部以十进制字符串存储 —— SQLite 的 INTEGER 是 64 位，而 8 位定点的
// WAVAX 数量（18 位小数 × 1e8）很容易越过 2^63，存成整数会静默截断。

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ASSETS, type Asset, type Balances } from "./ledger.js";
import type { Order, Side, OrderType, TimeInForce } from "./engine/orderbook.js";

// 为什么要绕这一下：Vite 5 自带一份硬编码的 Node 内置模块清单（比 node:sqlite 早），
// 而且它会先把 "node:" 前缀去掉再查表 —— 于是 `import ... from "node:sqlite"` 会被当成
// 第三方包去解析，跑测试时报 "Failed to load url sqlite"。用 createRequire 在运行时加载，
// 绕开打包器的静态分析，tsx 和 vitest 下行为一致。类型仍是静态导入的（import type 会被擦除）。
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** 存进库的成交记录（和 routes.ts 的 Trade 同构，这里独立声明避免循环依赖） */
export interface StoredTrade { id: string; price: string; qty: string; side: Side; ts: number }

export interface PersistedState {
  balances: [address: string, balances: Balances][];
  orders: Order[];
  trades: StoredTrade[];
}

export interface Store {
  readonly path: string;
  load(): PersistedState;
  /** eventKey 有值时，把"这笔事件已处理"和状态写进同一个事务（回放幂等的关键） */
  save(state: PersistedState, eventKey?: string): void;
  /** 这笔链上事件是不是已经记过账了 */
  hasEvent(key: string): boolean;
  /** 记下"这个提现 nonce 的链下余额已经扣过"（提现是先扣链下再上链，回放不能再扣一次） */
  markWithdrawn(nonce: bigint): void;
  /** 这个提现 nonce 是不是本站实时签发并已扣过账的 */
  isWithdrawn(nonce: bigint): boolean;
  /** 已处理到的链上区块号（充值/提现回放的游标）；从没存过返回 null */
  lastBlock(): bigint | null;
  setLastBlock(block: bigint): void;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS balances (
  address   TEXT NOT NULL,
  asset     TEXT NOT NULL,
  available TEXT NOT NULL,
  locked    TEXT NOT NULL,
  PRIMARY KEY (address, asset)
);
CREATE TABLE IF NOT EXISTS orders (
  id        TEXT PRIMARY KEY,
  owner     TEXT NOT NULL,
  side      TEXT NOT NULL,
  type      TEXT NOT NULL,
  tif       TEXT NOT NULL,
  price     TEXT NOT NULL,
  qty       TEXT NOT NULL,
  remaining TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  seq       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trades (
  id    TEXT PRIMARY KEY,
  price TEXT NOT NULL,
  qty   TEXT NOT NULL,
  side  TEXT NOT NULL,
  ts    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- 处理过的链上事件（txHash:logIndex）。有它，回放重叠也不会把同一笔充值记两次。
CREATE TABLE IF NOT EXISTS processed_events (key TEXT PRIMARY KEY, ts INTEGER NOT NULL);
-- 后端实时签发并已经扣过链下余额的提现 nonce。
-- 提现是"先扣链下余额，再让用户自己去调 Vault.withdraw 上链"，签发那一刻后端拿不到 tx hash，
-- 没法用 processed_events 标记。少了这张表，重启回放会把同一笔提现再扣一次 —— 用户的钱扣两遍。
CREATE TABLE IF NOT EXISTS debited_nonces (nonce TEXT PRIMARY KEY, ts INTEGER NOT NULL);
`;

/** path 传 ":memory:" 就是纯内存库（测试用）；文件名则会在需要时建好目录 */
export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL"); // 掉电时少丢一点
  db.exec(SCHEMA);

  return {
    path,

    load(): PersistedState {
      const balances = new Map<string, Balances>();
      for (const row of db.prepare("SELECT address, asset, available, locked FROM balances").all() as any[]) {
        const asset = row.asset as Asset;
        if (!ASSETS.includes(asset)) continue;
        let b = balances.get(row.address);
        if (!b) {
          b = { USDC: { available: 0n, locked: 0n }, WAVAX: { available: 0n, locked: 0n } };
          balances.set(row.address, b);
        }
        b[asset] = { available: BigInt(row.available), locked: BigInt(row.locked) };
      }

      const orders = (db.prepare("SELECT * FROM orders ORDER BY seq ASC").all() as any[]).map(
        (r): Order => ({
          id: r.id, owner: r.owner, side: r.side as Side, type: r.type as OrderType, tif: r.tif as TimeInForce,
          price: BigInt(r.price), qty: BigInt(r.qty), remaining: BigInt(r.remaining),
          ts: Number(r.ts), seq: Number(r.seq),
        }),
      );

      const trades = (db.prepare("SELECT * FROM trades ORDER BY ts ASC").all() as any[]).map(
        (r): StoredTrade => ({ id: r.id, price: r.price, qty: r.qty, side: r.side as Side, ts: Number(r.ts) }),
      );

      return { balances: [...balances], orders, trades };
    },

    hasEvent(key: string): boolean {
      return db.prepare("SELECT 1 FROM processed_events WHERE key = ?").get(key) !== undefined;
    },

    markWithdrawn(nonce: bigint) {
      db.prepare("INSERT OR IGNORE INTO debited_nonces (nonce, ts) VALUES (?, ?)").run(nonce.toString(), Date.now());
    },

    isWithdrawn(nonce: bigint): boolean {
      return db.prepare("SELECT 1 FROM debited_nonces WHERE nonce = ?").get(nonce.toString()) !== undefined;
    },

    save(state: PersistedState, eventKey?: string) {
      db.exec("BEGIN");
      try {
        db.exec("DELETE FROM balances");
        db.exec("DELETE FROM orders");
        db.exec("DELETE FROM trades");

        const insBal = db.prepare("INSERT INTO balances (address, asset, available, locked) VALUES (?, ?, ?, ?)");
        for (const [address, b] of state.balances) {
          for (const asset of ASSETS) {
            const { available, locked } = b[asset];
            if (available === 0n && locked === 0n) continue; // 全 0 的账户不用存
            insBal.run(address, asset, available.toString(), locked.toString());
          }
        }

        const insOrder = db.prepare(
          "INSERT INTO orders (id, owner, side, type, tif, price, qty, remaining, ts, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const o of state.orders) {
          insOrder.run(o.id, o.owner, o.side, o.type, o.tif, o.price.toString(), o.qty.toString(), o.remaining.toString(), o.ts, o.seq);
        }

        const insTrade = db.prepare("INSERT INTO trades (id, price, qty, side, ts) VALUES (?, ?, ?, ?, ?)");
        for (const t of state.trades) insTrade.run(t.id, t.price, t.qty, t.side, t.ts);

        // 和余额在同一个事务里：要么"钱到账且标记已处理"，要么两样都没发生
        if (eventKey) {
          db.prepare("INSERT OR IGNORE INTO processed_events (key, ts) VALUES (?, ?)").run(eventKey, Date.now());
        }

        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },

    lastBlock(): bigint | null {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'last_block'").get() as { value: string } | undefined;
      return row ? BigInt(row.value) : null;
    },

    setLastBlock(block: bigint) {
      // 只前进不后退：乱序/重复的回调不能把游标拽回去
      const cur = this.lastBlock();
      if (cur !== null && block <= cur) return;
      db.prepare("INSERT INTO meta (key, value) VALUES ('last_block', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(block.toString());
    },

    close() {
      db.close();
    },
  };
}
