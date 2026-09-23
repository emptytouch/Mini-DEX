// 撮合引擎单元测试（vitest）。每个 case 对应一条撮合规则，先看测试再看实现更好懂。
import { describe, it, expect } from "vitest";
import { OrderBook, type Side, type OrderType } from "./orderbook.js";
import { parseFixed as F } from "../fixed.js";

let n = 0;
function order(owner: string, side: Side, type: OrderType, price: string, qty: string) {
  return { id: `o${++n}`, owner, side, type, price: type === "market" ? 0n : F(price), qty: F(qty) };
}
const limit = (owner: string, side: Side, price: string, qty: string) => order(owner, side, "limit", price, qty);
const market = (owner: string, side: Side, qty: string) => order(owner, side, "market", "0", qty);

describe("OrderBook", () => {
  it("空簿：limit 单直接挂上", () => {
    const ob = new OrderBook();
    const r = ob.submit(limit("alice", "sell", "100", "1"));
    expect(r.fills).toHaveLength(0);
    expect(r.resting?.remaining).toBe(F("1"));
    expect(ob.bestAsk()).toBe(F("100"));
    expect(ob.bestBid()).toBeNull();
  });

  it("价格交叉：按 maker 价成交", () => {
    const ob = new OrderBook();
    ob.submit(limit("alice", "sell", "100", "1"));
    const r = ob.submit(limit("bob", "buy", "105", "1")); // bob 愿出 105，但按 alice 的 100 成交
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.price).toBe(F("100"));
    expect(r.fills[0]!.qty).toBe(F("1"));
    expect(r.fills[0]!.maker).toBe("alice");
    expect(r.fills[0]!.taker).toBe("bob");
    expect(r.resting).toBeNull();
    expect(ob.bestAsk()).toBeNull();
  });

  it("部分成交：剩余部分挂单", () => {
    const ob = new OrderBook();
    ob.submit(limit("alice", "sell", "100", "1"));
    const r = ob.submit(limit("bob", "buy", "100", "3"));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.qty).toBe(F("1"));
    expect(r.resting?.remaining).toBe(F("2"));
    expect(ob.bestBid()).toBe(F("100"));
    expect(ob.snapshot(5).bids).toEqual([[F("100"), F("2")]]);
  });

  it("价格优先：更优价格先成交", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "102", "1"));
    ob.submit(limit("b", "sell", "100", "1")); // 更便宜，后挂但先成交
    const r = ob.submit(market("t", "buy", "1"));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.maker).toBe("b");
    expect(r.fills[0]!.price).toBe(F("100"));
  });

  it("时间优先：同价 FIFO", () => {
    const ob = new OrderBook();
    const first = ob.submit(limit("a", "sell", "100", "1")).resting!;
    ob.submit(limit("b", "sell", "100", "1"));
    const r = ob.submit(market("t", "buy", "1"));
    expect(r.fills[0]!.makerOrderId).toBe(first.id);
    expect(r.fills[0]!.maker).toBe("a");
  });

  it("market 买单：吃穿多个档位", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "100", "1"));
    ob.submit(limit("b", "sell", "101", "1"));
    ob.submit(limit("c", "sell", "102", "5"));
    const r = ob.submit(market("t", "buy", "2.5"));
    expect(r.fills.map((f) => [f.price, f.qty])).toEqual([
      [F("100"), F("1")],
      [F("101"), F("1")],
      [F("102"), F("0.5")],
    ]);
    expect(r.resting).toBeNull();
    expect(ob.snapshot(5).asks).toEqual([[F("102"), F("4.5")]]);
  });

  it("market 单遇到空簿：不成交也不挂单", () => {
    const ob = new OrderBook();
    const r = ob.submit(market("t", "buy", "1"));
    expect(r.fills).toHaveLength(0);
    expect(r.resting).toBeNull();
    expect(ob.snapshot(5)).toEqual({ bids: [], asks: [] });
  });

  it("market 单流动性不足：吃完就停", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "100", "1"));
    const r = ob.submit(market("t", "buy", "5"));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.qty).toBe(F("1"));
    expect(r.resting).toBeNull();
    expect(ob.bestAsk()).toBeNull();
  });

  it("撤单：从簿和快照里移除", () => {
    const ob = new OrderBook();
    const o = ob.submit(limit("a", "sell", "100", "1")).resting!;
    expect(ob.cancel(o.id, "someone-else")).toBeNull(); // 不能撤别人的
    const cancelled = ob.cancel(o.id, "a");
    expect(cancelled?.id).toBe(o.id);
    expect(ob.cancel(o.id, "a")).toBeNull();             // 重复撤返回 null
    expect(ob.bestAsk()).toBeNull();
    expect(ob.snapshot(5).asks).toEqual([]);
    expect(ob.ordersOf("a")).toEqual([]);
  });

  it("快照：同价订单数量合并，且按深度截断", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "buy", "99", "1"));
    ob.submit(limit("b", "buy", "99", "2"));
    ob.submit(limit("c", "buy", "98", "1"));
    ob.submit(limit("d", "buy", "97", "1"));
    const s = ob.snapshot(2);
    expect(s.bids).toEqual([
      [F("99"), F("3")],
      [F("98"), F("1")],
    ]);
    expect(ob.bestBid()).toBe(F("99"));
  });

  it("limit 单吃穿多档后剩余挂单", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "100", "1"));
    ob.submit(limit("b", "sell", "101", "1"));
    ob.submit(limit("c", "sell", "110", "1")); // 超出 105，不该被吃
    const r = ob.submit(limit("t", "buy", "105", "3"));
    expect(r.fills.map((f) => f.price)).toEqual([F("100"), F("101")]);
    expect(r.resting?.remaining).toBe(F("1"));
    expect(ob.bestBid()).toBe(F("105"));
    expect(ob.bestAsk()).toBe(F("110"));
  });

  it("ordersOf：只返回该用户还在簿上的单", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "buy", "90", "1"));
    ob.submit(limit("a", "sell", "110", "1"));
    ob.submit(limit("b", "sell", "120", "1"));
    expect(ob.ordersOf("a").map((o) => o.price).sort((a, b) => (a < b ? -1 : 1))).toEqual([F("90"), F("110")]);
    expect(ob.ordersOf("b")).toHaveLength(1);
  });

  // ---- task7 必做 1：补充「时间优先」显式用例（买侧同价多 maker 按提交顺序被吃）----
  it("时间优先：买侧同价多 maker 按提交顺序被吃", () => {
    const ob = new OrderBook();
    const first = ob.submit(limit("a", "sell", "100", "1")).resting!; // 先挂
    ob.submit(limit("b", "sell", "100", "1"));                         // 后挂
    ob.submit(limit("c", "sell", "100", "1"));                         // 最后挂
    const r = ob.submit(market("t", "buy", "2")); // 吃 2 个
    // 同价按时间优先：先 a 后 b；c 剩下 1 个留在簿上
    expect(r.fills.map((f) => f.maker)).toEqual(["a", "b"]);
    expect(r.fills[0]!.makerOrderId).toBe(first.id);
    expect(ob.snapshot(5).asks).toEqual([[F("100"), F("1")]]);
  });

  // ---- task7 必做 1：补充「拒绝 self-trade（自成交）」用例 ----
  it("拒绝 self-trade：同地址的挂单不会被自己成交", () => {
    const ob = new OrderBook();
    const sell = ob.submit(limit("alice", "sell", "100", "1")).resting!;
    // alice 自己下买单，想吃自己的卖单
    const r = ob.submit(limit("alice", "buy", "100", "1"));
    expect(r.fills).toHaveLength(0);                  // 自成交被拒绝：0 笔成交
    expect(r.resting).not.toBeNull();                 // 买单正常挂上
    expect(ob.bestBid()).toBe(F("100"));              // 买一 = 100
    expect(ob.get(sell.id)?.remaining).toBe(F("1"));  // 自己的卖单原封不动
    // 换成真实对手 bob 来吃，才能成交
    const r2 = ob.submit(limit("bob", "buy", "100", "1"));
    expect(r2.fills).toHaveLength(1);
    expect(r2.fills[0]!.maker).toBe("alice");
    expect(r2.fills[0]!.taker).toBe("bob");
  });

  it("拒绝 self-trade：market 单也不会吃自己的挂单", () => {
    const ob = new OrderBook();
    ob.submit(limit("alice", "sell", "100", "1"));   // 自己的卖单
    const r = ob.submit(market("alice", "buy", "1")); // 自己市价买
    expect(r.fills).toHaveLength(0);                 // 自成交被拒绝
    expect(ob.bestAsk()).toBe(F("100"));             // 卖单仍在簿上
  });

  // 回归：整档都是自己的单时必须「跳过这一档」，不能终止整轮撮合。
  // 否则只要用户在最优价有自己的挂单，他就再也吃不到后面档位别人的单。
  it("拒绝 self-trade：整档都是自己的单时跳过该档，继续吃下一档", () => {
    const ob = new OrderBook();
    ob.submit(limit("alice", "sell", "100", "1"));       // alice 自己的卖单占住卖一
    ob.submit(limit("bob", "sell", "101", "1"));         // bob 的单在卖二
    const r = ob.submit(limit("alice", "buy", "105", "1")); // 出价 105
    expect(r.fills).toHaveLength(1);                     // 应该吃到 bob
    expect(r.fills[0]!.maker).toBe("bob");
    expect(r.fills[0]!.price).toBe(F("101"));            // 按 bob 的挂单价成交
    expect(r.resting).toBeNull();                        // 买单已全部成交，不挂单
    expect(ob.bestAsk()).toBe(F("100"));                 // alice 自己的卖单仍在
  });

  it("拒绝 self-trade：同档混合时跳过自己的单，别人的单按时间优先", () => {
    const ob = new OrderBook();
    ob.submit(limit("alice", "sell", "100", "1"));      // 自己，排队最前
    const bobOrder = ob.submit(limit("bob", "sell", "100", "1")).resting!;
    const carolOrder = ob.submit(limit("carol", "sell", "100", "1")).resting!;
    const r = ob.submit(limit("alice", "buy", "100", "2"));
    expect(r.fills.map((f) => f.maker)).toEqual(["bob", "carol"]); // 跳过自己，其余按 FIFO
    expect(r.fills.map((f) => f.makerOrderId)).toEqual([bobOrder.id, carolOrder.id]);
    expect(ob.snapshot(5).asks).toEqual([[F("100"), F("1")]]); // 只剩 alice 自己那 1 个
  });

  // ---- IOC：立刻成交能成交的，剩余部分作废，绝不挂单 ----
  describe("IOC", () => {
    it("部分成交后剩余作废，不挂单", () => {
      const ob = new OrderBook();
      ob.submit(limit("a", "sell", "100", "1"));
      const r = ob.submit({ ...limit("t", "buy", "100", "3"), tif: "IOC" });
      expect(r.fills).toHaveLength(1);
      expect(r.fills[0]!.qty).toBe(F("1"));
      expect(r.resting).toBeNull();               // 剩余 2 个直接作废
      expect(ob.bestBid()).toBeNull();            // 簿上没有留下任何买单
      expect(ob.snapshot(5).bids).toEqual([]);
    });

    it("完全吃不到就整单作废（而不是挂上去等）", () => {
      const ob = new OrderBook();
      ob.submit(limit("a", "sell", "110", "1"));  // 价格对不上
      const r = ob.submit({ ...limit("t", "buy", "100", "1"), tif: "IOC" });
      expect(r.fills).toHaveLength(0);
      expect(r.resting).toBeNull();
      expect(ob.bestBid()).toBeNull();            // GTC 的话这里会挂上 100
      expect(ob.ordersOf("t")).toEqual([]);
    });

    it("market 单默认就是 IOC：吃不完的剩余直接丢弃", () => {
      const ob = new OrderBook();
      ob.submit(limit("a", "sell", "100", "1"));
      const r = ob.submit(market("t", "buy", "5"));
      expect(r.fills).toHaveLength(1);
      expect(r.resting).toBeNull();
      expect(ob.snapshot(5).bids).toEqual([]);
    });
  });

  // ---- FOK：要么立刻全额成交，要么整单作废，不允许部分成交 ----
  describe("FOK", () => {
    it("流动性足够时全额成交", () => {
      const ob = new OrderBook();
      ob.submit(limit("a", "sell", "100", "1"));
      ob.submit(limit("b", "sell", "101", "2"));
      const r = ob.submit({ ...limit("t", "buy", "101", "3"), tif: "FOK" });
      expect(r.fills.map((f) => [f.price, f.qty])).toEqual([
        [F("100"), F("1")],
        [F("101"), F("2")],
      ]);
      expect(r.resting).toBeNull();
      expect(ob.bestAsk()).toBeNull();
    });

    it("流动性不足时整单作废，且簿上不留痕迹", () => {
      const ob = new OrderBook();
      ob.submit(limit("a", "sell", "100", "1"));
      ob.submit(limit("b", "sell", "101", "1"));
      const r = ob.submit({ ...limit("t", "buy", "101", "3"), tif: "FOK" }); // 只有 2 可吃
      expect(r.fills).toHaveLength(0);            // 一笔都不成交
      expect(r.resting).toBeNull();
      // 关键：maker 的单必须原封不动（干跑不能有副作用）
      expect(ob.snapshot(5).asks).toEqual([
        [F("100"), F("1")],
        [F("101"), F("1")],
      ]);
    });

    it("价格够不着的那部分不算进可成交量", () => {
      const ob = new OrderBook();
      ob.submit(limit("a", "sell", "100", "1"));
      ob.submit(limit("b", "sell", "120", "5"));  // 超出限价 105
      const r = ob.submit({ ...limit("t", "buy", "105", "3"), tif: "FOK" });
      expect(r.fills).toHaveLength(0);            // 只能吃到 1，凑不满 3 -> 作废
      expect(ob.snapshot(5).asks).toEqual([
        [F("100"), F("1")],
        [F("120"), F("5")],
      ]);
    });

    it("FOK 也不会吃自己的挂单", () => {
      const ob = new OrderBook();
      ob.submit(limit("alice", "sell", "100", "3"));
      const r = ob.submit({ ...limit("alice", "buy", "100", "3"), tif: "FOK" });
      expect(r.fills).toHaveLength(0);            // 自己的 3 个不算流动性
      expect(r.resting).toBeNull();
      expect(ob.bestAsk()).toBe(F("100"));
    });
  });
});
