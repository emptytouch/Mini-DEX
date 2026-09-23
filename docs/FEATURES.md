# 功能完善说明 —— 本仓库在上游 Mini-DEX 之上做了什么

本仓库 fork 自课程仓库 `tubexchat/Mini-DEX`。上游是**教学起点**，功能是完整的但刻意留了几处简化。
本仓库在它之上补齐了 Task 7 的 3 个必做项和 6 个进阶项，另外修掉了 3 个真实缺陷（其中 1 个是实测对账时发现的资金损失 bug）。

> **根目录 `README.md` 描述的是 fork 之前的功能**（架构图、快速开始、API 速查仍然全部有效）。
> 凡是本文列出的改动，以本文为准；README 里那张「已知简化」表的现状见 [§六](#六上游-readme已知简化表的现状)。

---

## 一、总览

| # | 功能 | 类型 | 主要文件 | 测试 | 详细说明 |
|:--:|---|:--:|---|---:|:--:|
| 1 | 撮合引擎：时间优先 + 自成交防护 → 修复为**跳过整档**而非终止撮合 | 必做 / 安全修复 | `server/src/engine/orderbook.ts` | 24 | [§2.1](#21-撮合引擎时间优先--自成交防护--ioc--fok) |
| 2 | IOC / FOK 有效期 | 进阶 | 同上 | 同上 | [§2.1](#21-撮合引擎时间优先--自成交防护--ioc--fok) |
| 3 | 做市模块：镜像 Binance 盘口 | 进阶 | `server/src/marketmaker.ts` | 9 | [§2.2](#22-做市模块marketmakerts) |
| 4 | SQLite 持久化，重启不丢挂单与成交 | 进阶 | `server/src/store.ts` | 12 | [§2.3](#23-sqlite-持久化storets) |
| 5 | WebSocket 私有 `orders` 频道 | 进阶 | `server/src/ws.ts` | 6 | [§2.4](#24-websocket-私有-orders-频道wsts) |
| 6 | 提现链上硬上限（单笔限额 + 金库偿付能力） | 进阶 | `contracts/src/Vault.sol`、`server/src/chain.ts` | 22 | [§2.5](#25-提现链上硬上限vaultsol--chaints) |
| 7 | 重启回放重复扣款 —— 用 nonce 认领已扣账的提现 | 安全修复 | `server/src/store.ts`、`server/src/routes.ts` | 3 | [§2.6](#26-重启回放重复扣款storets--routests实测发现) |
| 8 | `auth.ts` nonce 表无界增长 | 安全修复 | `server/src/auth.ts` | 3 | [§2.7](#27-authnonce-表无界增长authts) |

**测试合计：后端 61 个（7 个文件全部通过）、合约 22 个（全部通过）。** 复现命令见 [§四](#四测试与验证).

---

## 二、逐项说明

### 2.1 撮合引擎：时间优先 + 自成交防护 + IOC / FOK

**文件**：`server/src/engine/orderbook.ts`（231 行）· **测试**：`server/src/engine/orderbook.test.ts`（24 个）

上游已有价格优先，本仓库补齐了三块：

**① 时间优先（同价 FIFO）**
每个价格档位 `Level.orders` 是一个数组，新单 `push` 到末尾；撮合永远从下标 `0` 开始取。
订单带一个自增 `seq`（`Order.seq`），既用于排队，也用于**重启后恢复次序**：

```ts
restore(orders: Order[]): void {
  for (const o of [...orders].sort((a, b) => a.seq - b.seq)) {
    this.rest(o);
    if (o.seq > this.seq) this.seq = o.seq;   // 计数器抬到最大值，否则重启后新单会和旧单撞车
  }
}
```

**② 自成交防护（self-trade prevention）**
构造函数第二个参数 `preventSelfTrade` 默认 `true`。撮合时在档位内用 `k` 找到第一个**不是自己**的挂单：

```ts
let k = 0;
while (k < level.orders.length && this.preventSelfTrade && level.orders[k]!.owner === taker.owner) k++;
if (k === level.orders.length) { pi++; continue; }   // 整档都是自己的单 -> 跳过这一档
```

被跳过的自持挂单**保持原排队位置**（不移到队尾），避免改变它们的价格-时间优先次序。

> ⚠️ **这里原本有个 bug**：上游的实现遇到「整档都是自己的单」时直接 `break` 终止整轮撮合，
> 结果只要用户在最优价挂过单，他就再也吃不到后面档位别人的单 —— 一个安全控制被实现成了拒绝服务。
> 明细与复现见 [SECURITY-REVIEW.md 问题 1](./SECURITY-REVIEW.md#1-自成交防护实现缺陷高)，回归测试：
> `拒绝 self-trade：整档都是自己的单时跳过该档，继续吃下一档`。

**③ IOC / FOK**

```ts
export type TimeInForce = "GTC" | "IOC" | "FOK";
```

| 值 | 语义 | 剩余部分 |
|---|---|---|
| `GTC` | Good-Till-Cancel，默认 | 挂在簿上 |
| `IOC` | Immediate-Or-Cancel | 直接作废，不挂单 |
| `FOK` | Fill-Or-Kill | **要么全额成交，要么整单作废** |

`market` 单天然没有「挂单」一说，默认按 `IOC` 处理。
FOK 用一次**无副作用的干跑**（`fillableQty()`）做预检，判定规则和真正的 `match()` 保持一致：

```ts
if (tif === "FOK" && this.fillableQty(order) < order.qty) {
  return { fills: [], resting: null };   // 不成交、不挂单，也不会出现「成交一半再回滚」的中间态
}
```

**接口**：`POST /orders` 接受 `tif` 字段，取值 `GTC` / `IOC` / `FOK`，非法值返回 400。

---

### 2.2 做市模块（`marketmaker.ts`）

**文件**：`server/src/marketmaker.ts`（186 行）· **测试**：`server/src/marketmaker.test.ts`（9 个）

把 Binance 的盘口**镜像**到本所订单簿，让订单簿有真实流动性、用户下单能真的成交。
（完整说明见提交 `e1b8d49`。）

每个 tick 的流程：**拉 Binance 深度 → 缩放到本所规模 → 与做市账户现有挂单做增量对比 → 按可用余额裁剪 → 挂单 → 广播一次订单簿**

| 函数 | 作用 |
|---|---|
| `fetchDepth()` | 依次尝试 `data-api.binance.vision` → `api.binance.com` → `api1.binance.com`（部分地区前两个返回 451） |
| `scaleDepth()` | 取前 N 档，数量 × `scale` 后夹在 `[minQty, maxQty]`，价格/数量保留 4 位小数 |
| `planQuotes()` | 增量计划：不在目标里 → 撤；部分成交偏差超过 `tolerance`（默认 20%）→ 撤并重挂；同价重复只留一张 |
| `capByBalance()` | 按可用余额裁剪：买单从最优价往外累计 USDC 成本，卖单累计 WAVAX；挂不起的截断，太小的丢弃 |

做市账户就是账本里的一个普通地址。离线模式靠 `MM_SEED_*` 虚拟注资；链上模式可以给它真实 `deposit`。

> ⚠️ **虚拟注资的后果**：`MM_SEED_*` 没有链上抵押。用户和做市账户成交后赚到的币，在链上是没有背书的，
> 提现时 `Vault` 支付的是**其他用户真实充进来**的币。链上模式请把 `MM_SEED_*` 置 0 并让做市账户真实充值。
> 见 [SECURITY-REVIEW.md 问题 4](./SECURITY-REVIEW.md#4-链下余额无链上背书高)。

**开关**：`server/.env` 里 `MARKET_MAKER=1`，`MM_LEVELS`（默认 3）控制每侧档位数。

**诊断脚本**：`server/scripts/mm-compare.mjs` —— 对比本所订单簿与 Binance 实时盘口。
注意本所簿是**每 `MM_INTERVAL_MS` 镜像一次的快照**（默认 2000ms），不是实时中继，
所以脚本会先轮询等做市账户跳一次价，再拉 Binance 对比，避免拿两个不同时刻的快照硬比。
用法与真实输出见 [RUNBOOK.md §12](./RUNBOOK.md)。

---

### 2.3 SQLite 持久化（`store.ts`）

**文件**：`server/src/store.ts`（189 行）· **测试**：`server/src/store.test.ts`（12 个）

把「重启后必须还在」的东西落库：**账本余额、订单簿挂单、最近成交、链上事件游标**。
上游是纯内存态，重启即丢失。

用 Node 22.5+ 内置的 `node:sqlite`（`DatabaseSync`），**不引第三方依赖、不需要原生编译**。

**为什么绕一层 `createRequire`**：

```ts
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
```

Vite 5 自带一份早于 `node:sqlite` 的硬编码内置模块清单，且会先剥掉 `node:` 前缀再查表 ——
于是 `import ... from "node:sqlite"` 会被当成第三方包解析，跑测试时报 `Failed to load url sqlite`。
`createRequire` 在运行时加载，绕开打包器的静态分析，`tsx` 和 `vitest` 下行为一致。

**表结构**（`SCHEMA`）：

| 表 | 存什么 |
|---|---|
| `balances` | 地址 × 资产 → `available` / `locked` |
| `orders` | 全部挂单（含 `seq`，恢复 FIFO 用） |
| `trades` | 最近成交（环形缓冲 200 条） |
| `meta` | `last_block` —— 链上事件回放游标，**只前进不后退** |
| `processed_events` | `txHash:logIndex`，链上事件去重 |
| `debited_nonces` | 已实时扣过账的提现 nonce，见 [§2.6](#26-重启回放重复扣款storets--routests实测发现) |

**两个关键设计**：

1. **`bigint` 一律以十进制字符串存储**。SQLite 的 `INTEGER` 是 64 位，而 8 位定点的 WAVAX 数量（18 位小数 × 1e8）很容易越过 2^63，存成整数会**静默截断**。有专门的测试守这条：
   `金额用字符串存：超过 2^63 的 bigint 也能原样读回来`。
2. **「状态 + 已处理标记」写在同一事务里**（`save(state, eventKey)`）。要么「钱到账且标记已处理」，要么两样都没发生 —— 回放重叠不会重复入账。

```ts
save(state: PersistedState, eventKey?: string) {
  db.exec("BEGIN");
  // ... 重写 balances / orders / trades ...
  if (eventKey) db.prepare("INSERT OR IGNORE INTO processed_events (key, ts) VALUES (?, ?)").run(eventKey, Date.now());
  db.exec("COMMIT");   // 出错则 ROLLBACK
}
```

**取舍**：撮合和结算仍然全在内存里算，落库是「改完就全量重写一遍」。数据量是几百行级别，简单可读 > 高效；
生产该走增量写 + `WAL` + 连接池。（已开 `PRAGMA journal_mode = WAL`。）

**开关**：`server/.env` 里 `DB_PATH`（默认 `server/data/state.sqlite`）。不设则退回纯内存模式。

---

### 2.4 WebSocket 私有 `orders` 频道（`ws.ts`）

**文件**：`server/src/ws.ts`（71 行）· **测试**：`server/src/ws.test.ts`（6 个）

上游只有全员广播的公共频道。本仓库加了**按地址定向投递**。

| 频道 | 谁能收到 |
|---|---|
| `orderbook` / `trade` | 所有人（公共） |
| `balance` | 发过 `{type:"auth", token}` 且**地址匹配**的连接 |
| `orders` | 同上（本仓库新增） |

**关键实现**：`authed` 是一张 `Map<WebSocket, address>`，投递时按地址过滤，别人的连接一条都收不到：

```ts
function sendTo(address: string, type: "balance" | "orders", data: unknown) {
  const key = address.toLowerCase();
  for (const [ws, addr] of authed) {
    if (addr === key) send(ws, { type, address: key, data });
  }
}
```

**自愈**：新连接一进来先发一份订单簿快照；认证通过后再**补发该地址的余额 + 挂单快照**，
前端重连后不用额外发 HTTP 请求就能恢复状态。

**推送时机**：下单、撤单、成交后，`routes.ts` 会对**所有受影响的地址**（taker + 每个 maker）推 `balance` 和 `orders`。

**前端**：`web/src/lib/ws.ts`、`web/src/components/MyOrders.tsx` 已对接。

---

### 2.5 提现链上硬上限（`Vault.sol` + `chain.ts`）

**文件**：`contracts/src/Vault.sol` · `server/src/chain.ts` · **测试**：`contracts/test/Vault.t.sol`（22 个）

上游 `Vault.withdraw` 只校验签名，**signer 私钥 = 金库钥匙**，签多少就能取多少。
本仓库加了两道 token 无关的兜底：

```solidity
/// @notice 单笔提现上限（token => 上限，代币最小单位）；**0 表示不限**。
mapping(address => uint256) public withdrawLimit;
```

```solidity
// ---- 链上硬上限（放在签名校验之后：无效签名不该能探到这些状态）----
// ① 单笔限额：0 表示不限。限制的是「后端一次能签多大」，不限制用户累计能提多少。
uint256 limit = withdrawLimit[token];
require(limit == 0 || amount <= limit, "Vault: exceeds token limit");
// ② 偿付能力：无论后端签了什么，金库都不会转出超过自己实际持有的币。
//    这是最后一道闸门——即使 signer 私钥泄露，能拿走的也只有金库里真实存在的资产。
require(IERC20(token).balanceOf(address(this)) >= amount, "Vault: insufficient vault liquidity");
```

配套：`setWithdrawLimit(token, limit)`（`onlyOwner`）+ `WithdrawLimitSet` 事件 + 查看函数 `withdrawLimit(token)`。

**为什么不按链上 `balances` 逐用户封顶**：成交发生在链下，用户**靠交易赚到的币在链上没有充值记录**。
逐用户封顶会让他提不出来。所以链上 `balances` 只是「充了多少 / 取了多少」的参考账本，
真正的余额在链下账本里 —— 这正是只做「单笔限额 + 金库偿付」的原因（合约注释里也写了）。

**后端前置预检**：`chain.ts` 的 `checkWithdrawable()` 把这两道限制提到**扣账之前**。顺序不能反 ——
先扣链下余额再发现链上提不出来，用户两头落空：

```ts
try {
  await chain.checkWithdrawable(asset, amount);   // 先查链上硬上限
  ledger.debit(owner, asset, amount);             // 通过了才扣链下余额
} catch (e) { return c.json({ error: e.message }, 400); }
```

预检对旧版 Vault（没有 `withdrawLimit` 函数）会自动降级为「不限」并只警告一次，避免新后端配旧合约时所有提现都失败。

**运维脚本**：`scripts/set-withdraw-limit.sh`。

> 注：[SECURITY-REVIEW.md 问题 4](./SECURITY-REVIEW.md#4-链下余额无链上背书高) 的**根因**（做市虚拟注资无链上抵押）
> 仍在，报告里仍列为「未修复」。本次实现的是「提现不会超过金库真实持币」这道闸门，
> 以及让「扣账后 revert」这条路径不再触发。

---

### 2.6 重启回放重复扣款（`store.ts` + `routes.ts`）——**实测发现**

**文件**：`server/src/store.ts`、`server/src/routes.ts` · **测试**：`server/src/store.test.ts` 的
`describe("重启回放提现：不能重复扣款")`（3 个）· **完整分析**：[SECURITY-REVIEW.md 问题 7](./SECURITY-REVIEW.md#7-重启回放重复扣款高-实测发现已修复)

**这是本次唯一一个真实的资金损失 bug，是在 Fuji 真机跑完后对账时发现的，不是代码走查猜出来的。**

**问题**：提现是「先扣链下余额，再让用户自己去调 `Vault.withdraw` 上链」。
签发那一刻后端**拿不到 tx hash**，没法用 `processed_events` 标记这笔提现。
于是每次后端重启，回放历史 `Withdraw` 事件时会把**同一笔提现再扣一次** —— 用户的钱扣两遍。

**怎么发现的**：做完端到端演示后做零和校验，账本总额应该等于 `vault 链上余额 + 做市虚拟注资`，
结果 USDC 恰好少 40，WAVAX 完全对得上。追下去发现 `0x14bc8b70…:1`（40 USDC）在 `processed_events` 里，
而 `0x1801b319e5…`（450 USDC）不在（游标已经越过它）—— 一笔被扣了两次、一笔被扣了一次，差值正好 40。

**修复**：新增一张表，按 nonce 认领「本站实时签发并已扣过账」的提现。

```sql
-- 后端实时签发并已经扣过链下余额的提现 nonce。
-- 提现是"先扣链下余额，再让用户自己去调 Vault.withdraw 上链"，签发那一刻后端拿不到 tx hash，
-- 没法用 processed_events 标记。少了这张表，重启回放会把同一笔提现再扣一次 —— 用户的钱扣两遍。
CREATE TABLE IF NOT EXISTS debited_nonces (nonce TEXT PRIMARY KEY, ts INTEGER NOT NULL);
```

`/withdraw` 在扣账成功后立刻记 nonce（**必须和 `debit` 挨着，中间别插可能抛错的东西**，否则会出现「扣了但没记」）：

```ts
try {
  await chain.checkWithdrawable(asset, amount);
  ledger.debit(owner, asset, amount);
} catch (e) { return c.json({ error: e.message }, 400); }

d.store?.markWithdrawn(nonce);   // 扣账成功才记
```

回放路径据此分流 —— 认得出就只补个「已处理」标记，不重复扣钱：

```ts
function onWithdrawBackfill(user, asset, amount, ev?) {
  if (ev && d.store?.hasEvent(ev.key)) return;
  // 这笔提现如果是本站实时签发的，钱在 /withdraw 里已经扣过了 —— 这里只能补个"已处理"标记。
  if (ev?.nonce !== undefined && d.store?.isWithdrawn(ev.nonce)) {
    persist(ev.key);
    return;
  }
  try { ledger.debit(user, asset, amount); persist(ev?.key); }
  catch (e) { console.warn(`[ledger] 回放 Withdraw 扣账失败 ...`); }   // 失败就不标记，下次启动还能重试
}
```

为此 `chain.ts` 的 `ChainEvent` 加了 `nonce?: bigint` 字段，`backfill()` 解析 `Withdraw` 事件时带上它。
（实时 watcher 只监听 `Deposit`；提现仅在 `backfill` 中到达。）

**回归测试**（3 个，第一个走真实的 `POST /withdraw` 端到端）：

| 用例 | 断言 |
|---|---|
| `实时提现扣过的钱，重启回放不会再扣一次` | 提 40 后余额 60 → 重启回放 → **仍是 60**，且补上了 `processed_events` 标记 |
| `不是本站签发的提现（nonce 没见过），回放照常扣账` | 手动导入的历史账户，该扣还得扣 |
| `同一笔 Withdraw 事件回放两次也只扣一次` | 幂等 |

已验证测试确实能捕获该缺陷：把 guard 改回 `if (false)` 后报 `expected 2000000000n to be 6000000000n`。

> ⚠️ **部署提示**：这个修复在 `store.ts` / `routes.ts` 里，**重启后端才会生效**。
> 修复前启动的进程仍在跑旧逻辑。

---

### 2.7 `/auth/nonce` 表无界增长（`auth.ts`）

**文件**：`server/src/auth.ts`（120 行）· **测试**：`server/src/auth.test.ts`（3 个）

**问题**：`nonces` 是 `Map<address, {nonce, expires}>`，但**只有「同一个地址再次发起登录」时才会清理条目**。
一个地址只要取了 nonce 却从不登录，它的条目就永远留在内存里 —— 未认证的攻击者可以用不同地址刷爆内存。

**修复**：加定期清扫，删除所有已过期条目。
明细见 [SECURITY-REVIEW.md 问题 2](./SECURITY-REVIEW.md#2-authnonce-的-nonce-表无界增长中)。

---

## 三、改动清单（文件级）

相对上游的完整 diff：**22 个文件修改（+1635 / −906 行）+ 11 个新增文件**。

### 新增

| 文件 | 说明 |
|---|---|
| `server/src/store.ts` | SQLite 持久化 |
| `server/src/store.test.ts` | 12 个持久化 / 重启恢复 / 提现回放测试 |
| `server/src/ws.test.ts` | 6 个 WS 私有频道测试 |
| `server/src/auth.test.ts` | 3 个 nonce 清理测试 |
| `server/scripts/mm-compare.mjs` | 本所盘口 vs Binance 实时对比诊断 |
| `server/scripts/fuji-demo.mjs` | Fuji 链上数据核对（零和校验） |
| `scripts/deploy-fuji.sh` | 一键部署到 Fuji 并回填 `server/.env` |
| `scripts/set-withdraw-limit.sh` | 设置链上单笔提现限额 |
| `docs/FEATURES.md` | 本文 |
| `docs/DELIVERABLES.md` | 交付说明（逐条对照作业要求） |
| `docs/RUNBOOK.md` | 操作手册（照着敲命令 → 截图） |
| `docs/SECURITY-REVIEW.md` | 安全审查报告（7 个问题，3 个已修复） |

### 修改

| 文件 | 改了什么 |
|---|---|
| `contracts/src/Vault.sol` | `withdrawLimit` + `setWithdrawLimit` + `WithdrawLimitSet` + 两道链上硬上限 |
| `contracts/test/Vault.t.sol` | +100 行，13 → 22 个测试 |
| `contracts/abi/*.json` | 重新生成 |
| `server/src/engine/orderbook.ts` | 自成交防护修复、`TimeInForce`、`fillableQty()`、`restore()` |
| `server/src/engine/orderbook.test.ts` | +147 行，覆盖时间优先 / 自成交 / IOC / FOK |
| `server/src/chain.ts` | `checkWithdrawable()`、`ChainEvent.nonce`、回放带 nonce、旧合约降级 |
| `server/src/routes.ts` | `tif` 参数、nonce 生成与标记、`onWithdrawBackfill` 防重扣、`pushOrders` |
| `server/src/ws.ts` | 私有 `orders` 频道 + 认证后补发快照 |
| `server/src/auth.ts` | nonce 定期清扫 |
| `server/src/ledger.ts` | `entries()` / `has()` / `restore()`（落库与恢复用） |
| `server/src/index.ts` | 组装 store、启动顺序（先 restore 再监听链）、做市开关、`DB_PATH` |
| `server/.env.example` | 新增 `DB_PATH`、`MARKET_MAKER`、`MM_*` |
| `web/src/lib/ws.ts`、`MyOrders.tsx` | 对接私有 `orders` 频道 |
| `web/src/components/OrderForm.tsx` | IOC / FOK 选择 |
| `.gitignore` | 忽略 `server/data/`、`contracts/.env` 等 |

**未改动的文件**：根 `README.md`、`prompts/`、`web/src/lib/binance.ts` 等行情源。

---

## 四、测试与验证

```bash
# 后端：61 个测试，7 个文件
cd server && npm test

# 合约：22 个测试
cd contracts && forge test

# 前端类型检查
cd web && npm test && npm run typecheck
```

| 套件 | 文件 | 用例数 |
|---|---:|:--:|
| 后端 | `server/src/engine/orderbook.test.ts` | 24 |
| 后端 | `server/src/store.test.ts` | 12 |
| 后端 | `server/src/marketmaker.test.ts` | 9 |
| 后端 | `server/src/ws.test.ts` | 6 |
| 后端 | `server/src/fixed.test.ts` | 4 |
| 后端 | `server/src/auth.test.ts` | 3 |
| 后端 | `server/src/ledger.test.ts` | 3 |
| **后端合计** | **7 个文件** | **61** |
| 合约 | `contracts/test/Vault.t.sol` | 22 |

端到端联调与 Fuji 真机验证的完整步骤见 [RUNBOOK.md](./RUNBOOK.md)；
链上数据核对表（3 个地址、deposit / withdraw 的 tx hash、零和校验）见 [DELIVERABLES.md](./DELIVERABLES.md)。

---

## 五、运维脚本

| 脚本 | 用途 |
|---|---|
| `scripts/deploy-fuji.sh` | 部署 `MockERC20` × 2 + `Vault` 到 Fuji，打印可直接粘贴进 `server/.env` 的地址 |
| `scripts/set-withdraw-limit.sh` | 调 `Vault.setWithdrawLimit` 设单笔提现上限 |
| `server/scripts/mm-compare.mjs` | 对比本所订单簿与 Binance 实时盘口，验证做市是否跟得上 |
| `server/scripts/fuji-demo.mjs` | 从 Fuji RPC 拉全部 Vault 事件，和账本做零和校验 |
| `scripts/e2e-anvil.sh` | 上游自带的一键端到端联调（本地 anvil） |

> ⚠️ `scripts/e2e-anvil.sh` 含破坏性的 `pkill` / `rm -rf`，会清掉本地链状态，**不要在有数据的机器上随手跑**。

---

## 六、上游 README「已知简化」表的现状

根目录 `README.md` 那张表列了 4 条简化点。本仓库的工作让其中 **2 条完全解决、2 条解决了主要部分**：

| 上游写的简化点 | 现状 | 对应改动 |
|---|---|---|
| 账本内存态，重启靠事件回放恢复充提，**成交 / 挂单丢失** | ❌ **已不成立** —— 余额、挂单、最近成交全部落 SQLite | [§2.3](#23-sqlite-持久化storets) |
| `Vault.withdraw` 不用链上 `balances` 做硬上限 | ⚠️ **部分**：加了 `withdrawLimit` + 金库偿付两道硬上限，但**确实没按 `balances` 逐用户封顶** —— 这是有意为之，因为成交在链下 | [§2.5](#25-提现链上硬上限vaultsol--chaints) |
| `/withdraw` 先扣余额再签名，**不跟踪 in-flight** | ⚠️ **部分**：`debited_nonces` 已按 nonce 跟踪「扣过账」，但**超时未落链的自动退款仍未实现** | [§2.6](#26-重启回放重复扣款storets--routests实测发现) |
| **允许自成交**（self-trade） | ❌ **已不成立** —— 默认开启自成交防护 | [§2.1](#21-撮合引擎时间优先--自成交防护--ioc--fok) |

根 README 里还有两处会误导人的表述，**本次已一并改正**：

- FAQ 里的「server 重启后挂单和成交不见了 → 设计如此」→ 改为提示检查 `DB_PATH`（README 第 436 行）。
- 目录结构里的「13 个合约测试」→ 改为 22 个（README 第 175 行）。
- 顶部新增了一段带链接的说明，指向本文和另外三份文档（README 第 48 行）。

---

## 七、相关文档

| 文档 | 看它做什么 |
|---|---|
| [DELIVERABLES.md](./DELIVERABLES.md) | 逐条对照作业要求的交付说明：地址、tx hash、余额、区块号全是实测值 |
| [RUNBOOK.md](./RUNBOOK.md) | 从零跑通的完整命令序列 + 每一步要截的图 + FAQ |
| [SECURITY-REVIEW.md](./SECURITY-REVIEW.md) | 7 个安全问题的分析、复现与状态（3 个已修复） |
| 根 [README.md](../README.md) | 上游架构、快速开始、API 速查（**未被本次改动修改**） |
| [server/README.md](../server/README.md) | 后端接口与配置项 |
