# mini-dex —— 课程配套的迷你订单簿交易所

> 《用 Vibe Coding 做一个简易交易所 —— 以 Primit.io 为案例》的"标准答案"。
> 三个包：`contracts/`（Foundry）· `server/`（Node + TS，撮合引擎 + 账本 + 登录 + 链上监听）· `web/`（Vite + React + wagmi）。
> 课上用的 prompt 在 `prompts/`，按章节顺序粘给 AI 即可复现整个项目。

## 架构（一句话）
资金在链上 **Vault** 托管，撮合和余额在链下内存里；用户用 MetaMask **EIP-712 签名登录**；充值 = `approve` + `deposit`，后端监听 `Deposit` 事件入账；提现 = 后端签 EIP-712 授权 → 用户自己调 `Vault.withdraw`。

## 前置
- Node 22、npm；Foundry（`forge`/`anvil`）；MetaMask。
- 首次 `forge build` 会下载 solc 0.8.28（国内网络可能要几分钟）。

## 三种运行模式

### A. 离线模式（最快，只看撮合 / 登录，不连链）
```bash
cd server && npm i && cp .env.example .env && npm run dev      # VAULT_ADDRESS 留空 = 离线
cd web && npm i && cp .env.example .env && npm run dev         # http://localhost:5173
```
页面上会出现"Faucet (offline)"按钮直接给账本加钱。

### B. anvil 本地链（课前排练推荐）
```bash
# 终端 1
anvil
# 终端 2：部署（anvil 账户 #0 部署，#1 作为后端 signer）
cd contracts && forge build
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
SIGNER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
# 把打印出来的 VAULT_ADDRESS / USDC_ADDRESS / WAVAX_ADDRESS 填进 server/.env（CHAIN_ID=31337）
cd ../server && npm run dev
cd ../web && npm run dev
```
MetaMask 手动添加网络：chainId 31337、RPC `http://127.0.0.1:8545`、符号 ETH；导入账户 #0 私钥（上面那个）。

### C. Avalanche Fuji（正式录课）
```bash
# 1) 用课程专用钱包到 https://core.app/tools/testnet-faucet/ 领 AVAX
# 2) 部署
cd contracts
PRIVATE_KEY=<你的 Fuji 钱包私钥> SIGNER_ADDRESS=<后端 signer 地址> \
forge script script/Deploy.s.sol --rpc-url https://api.avax-test.network/ext/bc/C/rpc --broadcast
# 3) server/.env：CHAIN_ID=43113  RPC_URL=https://api.avax-test.network/ext/bc/C/rpc  三个地址  BACKEND_SIGNER_PRIVATE_KEY=<signer 私钥>
# 4) npm run dev（server / web），MetaMask 切到 Fuji
```
浏览器：https://testnet.snowtrace.io

## 一键联调（验证三个包接口一致）
```bash
./scripts/e2e-anvil.sh
```
自动：起 anvil → 部署 → 起 server（链上模式）→ 两个账户 mint/approve/deposit → 后端入账 → 挂单/吃单 → 提现签名 → `Vault.withdraw` 上链 → 重放被拒。最后一行应为 `E2E OK`。

## 测试
```bash
cd contracts && forge test          # 13 个用例
cd server && npm test               # 19 个用例（撮合引擎 / 定点数 / 账本）
cd web && npm run typecheck && npm run build
```

## 目录
```
contracts/  src/Vault.sol src/MockERC20.sol test/Vault.t.sol script/Deploy.s.sol abi/
server/     src/engine/orderbook.ts(+test) src/ledger.ts src/auth.ts src/chain.ts src/routes.ts src/ws.ts scripts/{smoke,e2e-anvil}.ts
web/        src/components/{Header,TickerBar,Chart,OrderBook,OrderForm,Trades,BottomPanel,MyOrders,Wallet}.tsx src/lib/{api,ws,binance,useBinance,abi,chains,useAuth}.ts
            K 线用 lightweight-charts，价格源同步 Binance AVAXUSDT（WS 失败自动退化为 REST 轮询），详见 web/README.md
prompts/    00-project-spec … 05-debug-patterns
scripts/    e2e-anvil.sh
```

## 重启不丢充值：DEPOSIT_FROM_BLOCK
账本是内存态，但 server 启动时会从 `DEPOSIT_FROM_BLOCK`（合约部署区块）回放链上 `Deposit`（入账）和 `Withdraw`（扣账）事件重建余额——这是 Primit `block_sync_state` 游标的极简版。**成交和挂单不会恢复**，只有充提。

## 课前准备脚本
```bash
cd server && USER_KEY=<账户私钥> npm run prep:fuji -- deposit   # approve+deposit 100 USDC + 5 WAVAX → 提 50 USDC，验证全链路
cd server && USER_KEY=<账户私钥> npm run prep:fuji -- check     # 只登录查余额
```
Fuji 公共 RPC 上 viem 的 gas 估算会给出离谱值（`exceeds block gas limit`），脚本里显式传了 `gas`；浏览器走 MetaMask 自己估 gas，不受影响。

## 已知简化（课上要口头说明）
- 内存态：重启后靠回放恢复充提余额，成交/挂单丢失；生产用 TimescaleDB（作业进阶 B）。
- `Vault.withdraw` 不用链上 `balances` 做硬上限（Primit 有）；作业进阶 A。
- `/withdraw` 先扣链下余额再签名，不跟踪 in-flight 签名；生产要记录 nonce 并监听 `Withdraw` 事件对账。
- 允许 self-trade（作业必做 1.3 要求拒绝）。
- `BACKEND_SIGNER_PRIVATE_KEY` 示例是 anvil 公开私钥，**绝不能用于真实资金**。
