// 撮合引擎（纯内存、零依赖）。
// 规则：价格优先、时间优先（同价 FIFO）；成交价 = maker（挂单方）的价格；默认开启自成交防护。
// 有效期支持 GTC / IOC / FOK（见 TimeInForce）；market 单默认按 IOC 处理。
// 数据结构：每边一个 Map<价格, Level> + 一个有序价格数组（bids 降序 / asks 升序）。
// 初学者能读懂 > 极致性能；生产引擎（如 Primit 的 Rust 引擎）会用更高效的结构。

export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";

/**
 * 有效期（time in force）：
 *  - GTC（Good-Till-Cancel）：默认。没吃完的部分挂在簿上等对手方。
 *  - IOC（Immediate-Or-Cancel）：立刻吃能吃的，剩余部分直接作废，不挂单。
 *  - FOK（Fill-Or-Kill）：要么立刻全额成交，要么整单作废 —— 不允许部分成交。
 * market 单天然没有「挂单」一说，所以默认就是 IOC。
 */
export type TimeInForce = "GTC" | "IOC" | "FOK";

export interface Order {
  id: string;
  owner: string;       // 钱包地址（小写）
  side: Side;
  type: OrderType;
  tif: TimeInForce;    // 有效期，见上
  price: bigint;       // 8 位定点；market 单为 0n
  qty: bigint;         // 原始数量
  remaining: bigint;   // 还没成交的数量
  ts: number;          // 提交时间（毫秒）
  seq: number;         // 提交序号，用于时间优先
}

export interface Fill {
  takerOrderId: string;
  makerOrderId: string;
  taker: string;
  maker: string;
  price: bigint;       // = maker 的挂单价
  qty: bigint;
  side: Side;          // taker 的方向
  ts: number;
}

/** 一个价格档位：同价的挂单按先来后到排队 */
interface Level {
  price: bigint;
  orders: Order[];     // FIFO
}

export class OrderBook {
  private bids = new Map<bigint, Level>();
  private asks = new Map<bigint, Level>();
  private bidPrices: bigint[] = []; // 降序：最高买价在前
  private askPrices: bigint[] = []; // 升序：最低卖价在前
  private byId = new Map<string, Order>();
  private seq = 0;
  private preventSelfTrade: boolean;

  /** 默认开启自成交防护；传 false 可退化为允许自成交（旧行为，仅测试/对比用） */
  constructor(preventSelfTrade = true) {
    this.preventSelfTrade = preventSelfTrade;
  }

  /** 提交订单：先吃对手盘，剩下的按有效期处理（GTC 挂单 / IOC、FOK 丢弃） */
  submit(
    input: Omit<Order, "remaining" | "seq" | "ts" | "tif"> & { tif?: TimeInForce } & Partial<Pick<Order, "ts">>,
  ): { fills: Fill[]; resting: Order | null } {
    const tif = input.tif ?? (input.type === "market" ? "IOC" : "GTC");
    const order: Order = { ...input, tif, remaining: input.qty, seq: ++this.seq, ts: input.ts ?? Date.now() };

    // FOK：先「干跑」一遍确认能全额成交，再真正撮合；否则整单作废（不成交、不挂单）。
    // 干跑不做任何修改，所以不会出现「先成交一半再回滚」的中间态。
    if (tif === "FOK" && this.fillableQty(order) < order.qty) {
      return { fills: [], resting: null };
    }

    const fills = this.match(order);

    // 只有 GTC 的 limit 单会把剩余量挂到簿上；IOC / FOK 吃完即弃
    if (tif === "GTC" && order.type === "limit" && order.remaining > 0n) {
      this.rest(order);
      return { fills, resting: order };
    }
    return { fills, resting: null };
  }

  /** 撤单：只能撤自己的；返回被撤的订单（找不到返回 null） */
  cancel(id: string, owner: string): Order | null {
    const order = this.byId.get(id);
    if (!order || order.owner !== owner) return null;
    const { book, prices } = this.sideOf(order.side);
    const level = book.get(order.price)!;
    level.orders = level.orders.filter((o) => o.id !== id);
    if (level.orders.length === 0) {
      book.delete(order.price);
      prices.splice(prices.indexOf(order.price), 1);
    }
    this.byId.delete(id);
    return order;
  }

  /** 按价格聚合的深度快照：[[price, qty], ...] */
  snapshot(depth = 10): { bids: [bigint, bigint][]; asks: [bigint, bigint][] } {
    const agg = (prices: bigint[], book: Map<bigint, Level>): [bigint, bigint][] =>
      prices.slice(0, depth).map((p) => {
        const total = book.get(p)!.orders.reduce((s, o) => s + o.remaining, 0n);
        return [p, total];
      });
    return { bids: agg(this.bidPrices, this.bids), asks: agg(this.askPrices, this.asks) };
  }

  bestBid(): bigint | null { return this.bidPrices[0] ?? null; }
  bestAsk(): bigint | null { return this.askPrices[0] ?? null; }

  /** 按 id 查还在簿上的挂单（已成交/已撤的查不到） */
  get(id: string): Order | undefined {
    return this.byId.get(id);
  }

  /** 某个用户所有还在簿上的挂单 */
  ordersOf(owner: string): Order[] {
    return [...this.byId.values()].filter((o) => o.owner === owner);
  }

  /** 全部挂单（按时间优先顺序），落库用 */
  allOrders(): Order[] {
    return [...this.byId.values()].sort((a, b) => a.seq - b.seq);
  }

  /**
   * 从库里恢复挂单（启动时用）。必须按 seq 升序喂进来 —— rest() 是 push 到档位末尾，
   * 按提交顺序恢复才能保住同价单的 FIFO 排队次序。
   * seq 计数器同时抬到最大值，否则重启后新单的 seq 会和旧单撞车。
   */
  restore(orders: Order[]): void {
    for (const o of [...orders].sort((a, b) => a.seq - b.seq)) {
      this.rest(o);
      if (o.seq > this.seq) this.seq = o.seq;
    }
  }

  // ---------- 内部实现 ----------

  /**
   * 干跑：不修改订单簿，算出这张单此刻最多能成交多少。FOK 用它做预检。
   * 判定规则必须和 match() 完全一致（价格交叉 + 自成交跳过），否则预检会算错。
   */
  private fillableQty(taker: Order): bigint {
    const opposite = this.sideOf(taker.side === "buy" ? "sell" : "buy");
    const want = taker.remaining;
    let left = want;

    for (let pi = 0; pi < opposite.prices.length && left > 0n; pi++) {
      const price = opposite.prices[pi]!;
      if (taker.type === "limit" && !this.crosses(taker.side, taker.price, price)) break;
      for (const o of opposite.book.get(price)!.orders) {
        if (this.preventSelfTrade && o.owner === taker.owner) continue;
        left -= o.remaining < left ? o.remaining : left;
        if (left === 0n) break;
      }
    }
    return want - left;
  }

  /** 撮合：买单看 asks（从低到高），卖单看 bids（从高到低） */
  private match(taker: Order): Fill[] {
    const fills: Fill[] = [];
    const opposite = this.sideOf(taker.side === "buy" ? "sell" : "buy");

    // 用下标 pi 遍历档位而不是永远看 prices[0]：整档都是自己的单时要能跳到下一档
    //（如果直接 break，用户在任一档位有自己的挂单就再也买不到别人的货）。
    let pi = 0;
    while (taker.remaining > 0n && pi < opposite.prices.length) {
      const bestPrice = opposite.prices[pi]!;
      // limit 单只在价格能对上时成交；market 单不看价
      if (taker.type === "limit" && !this.crosses(taker.side, taker.price, bestPrice)) break;

      const level = opposite.book.get(bestPrice)!;
      // 自成交防护（self-trade prevention）：跳过同地址的挂单，取这一档里第一个"别人"的单。
      // 排在它前面的同地址挂单保持原位（不动它们的排队次序）。
      let k = 0;
      while (k < level.orders.length && this.preventSelfTrade && level.orders[k]!.owner === taker.owner) k++;
      if (k === level.orders.length) { pi++; continue; } // 整档都是自己的单 -> 跳过这一档

      const maker = level.orders[k]!;
      const qty = taker.remaining < maker.remaining ? taker.remaining : maker.remaining;
      taker.remaining -= qty;
      maker.remaining -= qty;
      fills.push({
        takerOrderId: taker.id, makerOrderId: maker.id,
        taker: taker.owner, maker: maker.owner,
        price: maker.price, qty, side: taker.side, ts: taker.ts,
      });
      // qty = min(双方剩余)，所以每轮必然有一方被耗尽 -> 不会死循环
      if (maker.remaining === 0n) {
        level.orders.splice(k, 1);
        this.byId.delete(maker.id);
      }
      if (level.orders.length === 0) {
        opposite.book.delete(bestPrice);
        opposite.prices.splice(pi, 1); // 数组前移，pi 原地指向下一档
      }
    }
    return fills;
  }

  /** 买单价 >= 卖一 / 卖单价 <= 买一 才能成交 */
  private crosses(side: Side, takerPrice: bigint, makerPrice: bigint): boolean {
    return side === "buy" ? takerPrice >= makerPrice : takerPrice <= makerPrice;
  }

  /** 把剩余部分挂到簿上，保持价格数组有序 */
  private rest(order: Order): void {
    const { book, prices } = this.sideOf(order.side);
    let level = book.get(order.price);
    if (!level) {
      level = { price: order.price, orders: [] };
      book.set(order.price, level);
      // 插入到正确位置：bids 降序 / asks 升序
      const better = (a: bigint, b: bigint) => (order.side === "buy" ? a > b : a < b);
      let i = 0;
      while (i < prices.length && better(prices[i]!, order.price)) i++;
      prices.splice(i, 0, order.price);
    }
    level.orders.push(order);
    this.byId.set(order.id, order);
  }

  private sideOf(side: Side): { book: Map<bigint, Level>; prices: bigint[] } {
    return side === "buy" ? { book: this.bids, prices: this.bidPrices } : { book: this.asks, prices: this.askPrices };
  }
}
