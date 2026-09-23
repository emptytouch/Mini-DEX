// 做市验证：把本所订单簿的前 N 档和 Binance 的盘口并排打出来。
// 用法：node scripts/mm-compare.mjs        （后端要跑着且 MARKET_MAKER=1）
//
// 注意 Binance 的 REST 主机：api.binance.com 在部分网络（含国内）连不通，
// data-api.binance.vision 是公开只读镜像，后端 marketmaker.ts 的 REST_HOSTS 里也把它排第一。
//
// 两个坑，都踩过：
//  1) 价格不能按字符串比。本所返回 "11.23"（去掉尾随 0），Binance 返回 "11.23000000"，
//     价格一模一样但字符串不等——按字符串比会永远 ❌。这里统一转 Number 再比。
//  2) 本所是「镜像」不是「转发」：做市每 MM_INTERVAL_MS 才刷一次，
//     而脚本问的是 Binance 的实时盘口。行情在这 1~2 秒里动过，前几档就会整体错开
//     （错开量 = 这段行情的波动，两侧同向、约一两个 tick）。行情单边快走时误差必然存在，
//     只有在行情短暂走平的瞬间才会逐档完全相等——所以下面要反复抓，去碰那个瞬间。
const API = process.env.API ?? "http://localhost:8787";
const SYMBOL = process.env.MM_SYMBOL ?? "AVAXUSDT";
const LEVELS = Number(process.env.MM_LEVELS ?? 3);
const MAX_ATTEMPTS = Number(process.env.MM_ATTEMPTS ?? 25);
const POLL_MS = 120; // 盯着本所盘口的变化，越早发现「刚刷过」越好

const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
};

const bookUrl = `${API}/orderbook?depth=${LEVELS}`;
const depthUrl = `https://data-api.binance.vision/api/v3/depth?symbol=${SYMBOL}&limit=${LEVELS}`;

const cfg = await get(`${API}/config`);
console.log(`后端 ${API}  mode=${cfg.mode}  marketMaker=${cfg.marketMaker ? cfg.marketMaker.address : "未开启"}`);
if (!cfg.marketMaker) {
  console.error("做市没开：把 server/.env 里 MARKET_MAKER=1 打开再重启后端。");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 数值相等即可：本所 "11.23" 和 Binance "11.23000000" 是同一个价
const samePrice = (a, b) => a != null && b != null && Number(a) === Number(b);
const bookKey = (b) => JSON.stringify(b.bids) + JSON.stringify(b.asks);

function buildRows(book, depth) {
  const rows = [];
  let matched = 0;
  for (let i = 0; i < LEVELS; i++) {
    const lb = book.bids[i]?.[0];
    const bnb = depth.bids[i]?.[0];
    const la = book.asks[i]?.[0];
    const bna = depth.asks[i]?.[0];
    const ok = samePrice(lb, bnb) && samePrice(la, bna);
    if (ok) matched++;
    rows.push({
      档位: i + 1,
      "本所买 / Binance买": `${lb ?? "—"} / ${bnb ?? "—"}`,
      "本所卖 / Binance卖": `${la ?? "—"} / ${bna ?? "—"}`,
      一致: ok ? "✅" : "❌",
    });
  }
  return { rows, matched };
}

// 两次抓取之间各档价格差了多少 —— 用来判断"是镜像错了"还是"行情动了"
function maxDrift(book, depth) {
  let max = 0;
  for (let i = 0; i < LEVELS; i++) {
    for (const [x, y] of [
      [book.bids[i]?.[0], depth.bids[i]?.[0]],
      [book.asks[i]?.[0], depth.asks[i]?.[0]],
    ]) {
      if (x == null || y == null) continue;
      max = Math.max(max, Math.abs(Number(x) - Number(y)));
    }
  }
  return max;
}

// 等本所盘口变化 —— 变化就说明做市刚 tick 过一次，那一刻它拿的是最新鲜的 Binance 快照。
// 立刻抓 Binance 去比，两者时间差最小。返回 null 表示等超时（行情没动，盘口没变）。
async function waitForTick(prevKey, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    try {
      const now = await get(bookUrl);
      if (bookKey(now) !== prevKey) return now;
    } catch {
      /* 后端抖一下不算事，接着等 */
    }
  }
  return null;
}

// 刷新间隔的两倍 + 1 秒兜底
const TICK_TIMEOUT = Number(process.env.MM_INTERVAL_MS ?? 2000) * 2 + 1000;

let best = null; // 「最接近」的一次，全都没对上时用它解释偏差来源
let book = await get(bookUrl);

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const depth = await get(depthUrl);
  const { rows, matched } = buildRows(book, depth);
  const drift = maxDrift(book, depth);
  console.log(`第 ${attempt} 次抓取：${matched}/${LEVELS} 档一致，最大价差 ${drift.toFixed(4)}`);

  if (!best || matched > best.matched || (matched === best.matched && drift < best.drift)) {
    best = { rows, matched, drift, attempt };
  }
  if (matched === LEVELS) {
    console.log(`\n交易对 ${SYMBOL}  取前 ${LEVELS} 档（价格单位 USDC）\n`);
    console.table(rows);
    console.log(`逐档价格完全一致 ✅（第 ${attempt} 次抓取，对齐在做市刚刷新之后的瞬间）`);
    console.log(`\n说明：本所价格去掉了尾随 0（11.23），Binance 是 8 位小数（11.23000000），是同一个价。`);
    console.log(`本所盘口是"每隔 ${process.env.MM_INTERVAL_MS ?? 2000}ms 镜像一次"的快照，不是实时转发，`);
    console.log(`所以要在行情走平的瞬间比才逐档相等——行情单边快走时差一两个 tick 属于快照时差。`);
    await printQty(book);
    process.exit(0);
  }
  if (attempt === MAX_ATTEMPTS) break;

  // 第一次之后都等"刚 tick 过"再比
  const fresh = await waitForTick(bookKey(book), TICK_TIMEOUT);
  if (fresh) book = fresh;
  else book = await get(bookUrl); // 超时：行情没动，盘口没变 —— 正好是走平的时候，直接再比一次
}

// 走到这里说明行情一直在单边走，没碰上走平的瞬间
console.log(`\n交易对 ${SYMBOL}  取前 ${LEVELS} 档（价格单位 USDC）——最接近的一次（第 ${best.attempt} 次）\n`);
console.table(best.rows);
console.log(`没抓到完全对齐的一刻 ❌（最好 ${best.matched}/${LEVELS} 档，最大价差 ${best.drift.toFixed(4)}）`);
console.log(`\n偏差来源：本所盘口是"上一次镜像时的 Binance"，脚本抓的是"此刻的 Binance"。`);
console.log(`行情单边走时这 1~2 秒的价差必然体现在档位上——两侧同向、幅度约一两个 tick 就是时差，`);
console.log(`不是镜像错了（镜像错了会表现为档位顺序乱、价差异常大、或买卖方向对不上）。`);
console.log(`行情走平的时候再跑一次，或把 MM_INTERVAL_MS 调小（如 500）让快照更新鲜。`);
await printQty(book);
process.exit(1);

async function printQty(b) {
  // 数量是缩放过和按余额裁剪过的，只做个提示，不参与一致性判断
  console.log(`\n本所各档挂单量（已按 MM_SCALE 缩放 + 按做市账户余额封顶）：`);
  console.log(`  买量 ${b.bids.map(([, q]) => q).join(" / ")}`);
  console.log(`  卖量 ${b.asks.map(([, q]) => q).join(" / ")}`);
}
