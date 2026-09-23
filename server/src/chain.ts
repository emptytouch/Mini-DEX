// 链上对接：
//  1. 监听 Vault 的 Deposit 事件 -> 换算成 8 位定点 -> 记入账本（"充值到账"）。
//  2. 用后端私钥签 EIP-712 Withdraw 授权，前端拿着签名去调 Vault.withdraw。
// VAULT_ADDRESS 为空时进入"离线模式"：不连链，用 /dev/faucet 直接发测试余额。
// 注意：signer 私钥 = 金库钥匙（提现不受链上余额约束），生产要 HSM/多签 + 限额。
import { createPublicClient, http, parseAbi, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Asset } from "./ledger.js";
import { weiToFixed, fixedToWei } from "./fixed.js";

/** 一笔链上事件的"身份证"：回放重叠时靠它去重（存进 store 的 processed_events） */
export interface ChainEvent {
  key: string;
  block: bigint;
  /** 只有 Withdraw 事件有：后端签发授权时生成的 nonce。
   *  回放时靠它认出"这笔提现是本站实时扣过账的"，避免重复扣款。 */
  nonce?: bigint;
}
export type ChainEventHandler = (user: string, asset: Asset, amount: bigint, ev?: ChainEvent) => void;

export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  vault: string;   // 空 = 离线模式
  usdc: string;
  wavax: string;
  signerKey: Hex;
}

export const TOKEN_DECIMALS: Record<Asset, number> = { USDC: 6, WAVAX: 18 };

// 直接写人类可读 ABI，不依赖 contracts 包（和 spec §3.3 的事件签名一致）
const VAULT_ABI = parseAbi([
  "event Deposit(address indexed user, address indexed token, uint256 amount)",
  "event Withdraw(address indexed user, address indexed token, uint256 amount, uint256 nonce)",
  "function withdrawLimit(address token) view returns (uint256)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const WITHDRAW_TYPES = {
  Withdraw: [
    { name: "user", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function createChain(cfg: ChainConfig) {
  const offline = !cfg.vault;
  const signer = privateKeyToAccount(cfg.signerKey);
  // 只读客户端按需创建，watchDeposits / checkWithdrawable 共用
  let readClient: ReturnType<typeof createPublicClient> | null = null;
  const getReadClient = () => (readClient ??= createPublicClient({ transport: http(cfg.rpcUrl) }));
  let limitUnsupported = false; // 旧版 Vault 没有 withdrawLimit，见 checkWithdrawable

  const tokenAddress = (asset: Asset) => (asset === "USDC" ? cfg.usdc : cfg.wavax);
  function assetOf(token: string): Asset | null {
    const t = token.toLowerCase();
    if (t === cfg.usdc.toLowerCase()) return "USDC";
    if (t === cfg.wavax.toLowerCase()) return "WAVAX";
    return null;
  }

  /**
   * 启动回放：从 fromBlock 扫到最新块，把历史 Deposit 记入账本、历史 Withdraw 扣掉。
   * fromBlock 平时是库里的游标 + 1；第一次启动（或清库后）才从 DEPOSIT_FROM_BLOCK 全量扫。
   * 这是 Primit block_sync_state 游标的极简版：库里没记过这笔充值，链下账本就没有这笔钱。
   * 公共 RPC 对 eth_getLogs 有区块跨度限制（Avalanche 是 2048），所以分块查。
   */
  async function backfill(
    client: ReturnType<typeof createPublicClient>,
    fromBlock: bigint,
    onDeposit: ChainEventHandler,
    onWithdraw: ChainEventHandler,
  ): Promise<bigint> {
    const latest = await client.getBlockNumber();
    const STEP = 2000n;
    let deposits = 0, withdraws = 0;
    for (let start = fromBlock; start <= latest; start += STEP) {
      const end = start + STEP - 1n < latest ? start + STEP - 1n : latest;
      const logs = await client.getContractEvents({ address: getAddress(cfg.vault), abi: VAULT_ABI, fromBlock: start, toBlock: end });
      for (const log of logs) {
        const { user, token, amount, nonce } = log.args as {
          user?: string; token?: string; amount?: bigint; nonce?: bigint;
        };
        if (!user || !token || amount === undefined) continue;
        const asset = assetOf(token);
        if (!asset) continue;
        const fixed = weiToFixed(amount, TOKEN_DECIMALS[asset]);
        const ev = eventKeyOf(log);
        if (log.eventName === "Deposit") { onDeposit(user, asset, fixed, ev); deposits++; }
        else {
          // 把 nonce 带上：调用方要用它判断这笔提现是不是已经实时扣过账了
          onWithdraw(user, asset, fixed, ev && nonce !== undefined ? { ...ev, nonce } : ev);
          withdraws++;
        }
      }
    }
    console.log(`[chain] 回放 ${fromBlock} → ${latest}：Deposit ${deposits} 笔，Withdraw ${withdraws} 笔`);
    return latest;
  }

  /** txHash:logIndex —— 链上事件的唯一坐标；block 用来推进回放游标 */
  function eventKeyOf(log: {
    transactionHash?: string | null;
    logIndex?: number | null;
    blockNumber?: bigint | null;
  }): ChainEvent | undefined {
    if (!log.transactionHash || log.logIndex === undefined || log.logIndex === null) return undefined;
    return { key: `${log.transactionHash}:${log.logIndex}`, block: log.blockNumber ?? 0n };
  }

  /** 开始监听 Deposit 事件；每笔到账回调 onDeposit(user, asset, 8 位定点金额)。
   *  fromBlock 有值时先回放历史事件（Deposit 入账、Withdraw 扣账）再开始实时监听。 */
  function watchDeposits(
    onDeposit: ChainEventHandler,
    opts: { fromBlock?: bigint; onWithdraw?: ChainEventHandler; onProgress?: (block: bigint) => void } = {},
  ): () => void {
    if (offline) {
      console.log("[chain] 离线模式：VAULT_ADDRESS 为空，不监听链上事件，开放 POST /dev/faucet");
      return () => {};
    }
    console.log(`[chain] 链上模式：chainId=${cfg.chainId} vault=${cfg.vault} rpc=${cfg.rpcUrl}`);
    console.log(`[chain] 后端签名地址 signer=${signer.address}（必须和 Vault.signer 一致）`);
    const client = getReadClient();
    let stop: (() => void) | null = null;
    let stopped = false;
    const startWatch = (fromBlock?: bigint) => {
      if (stopped) return;
      stop = client.watchContractEvent({
        address: getAddress(cfg.vault),
        abi: VAULT_ABI,
        eventName: "Deposit",
        fromBlock,
        onLogs: (logs) => {
          let maxBlock: bigint | null = null;
          for (const log of logs) {
            const { user, token, amount } = log.args;
            if (!user || !token || amount === undefined) continue;
            const asset = assetOf(token);
            if (!asset) { console.warn(`[chain] 未知代币 ${token}，忽略`); continue; }
            const fixed = weiToFixed(amount, TOKEN_DECIMALS[asset]);
            console.log(`[chain] Deposit ${user} ${asset} ${amount} wei (tx ${log.transactionHash})`);
            const ev = eventKeyOf(log);
            onDeposit(user, asset, fixed, ev);
            if (ev && (maxBlock === null || ev.block > maxBlock)) maxBlock = ev.block;
          }
          // 整批处理完才推进游标
          if (maxBlock !== null) opts.onProgress?.(maxBlock);
        },
        onError: (e) => console.error("[chain] 事件监听出错:", e.message),
      });
    };
    if (opts.fromBlock !== undefined) {
      backfill(client, opts.fromBlock, onDeposit, opts.onWithdraw ?? (() => {}))
        .then((latest) => {
          opts.onProgress?.(latest); // 扫到哪就记到哪，重启不用从头再扫
          startWatch(latest + 1n);
        })
        .catch((e) => { console.error("[chain] 回放失败，改为只监听新事件:", e.message); startWatch(); });
    } else {
      startWatch();
    }
    return () => { stopped = true; stop?.(); };
  }

  /**
   * 提现前的链上预检：对应 Vault.withdraw 里的两道硬上限（单笔限额 + 金库偿付能力）。
   * 不预检的话，服务端会先把链下余额扣掉、链上却 revert，用户两头落空
   * （详见 docs/SECURITY-REVIEW.md 的问题 3 / 4）。
   * 离线模式没有 Vault，直接放行。
   */
  async function checkWithdrawable(asset: Asset, amount: bigint): Promise<void> {
    if (offline) return;
    const token = getAddress(tokenAddress(asset));
    const vaultAddr = getAddress(cfg.vault);
    const amountWei = fixedToWei(amount, TOKEN_DECIMALS[asset]);
    const client = getReadClient();

    const held = await client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [vaultAddr] });

    // 旧版 Vault 没有 withdrawLimit（本轮才加），调用会 revert。
    // 这时降级为「不限」并只警告一次，避免新后端配旧合约时所有提现都失败。
    let limit = 0n;
    if (!limitUnsupported) {
      try {
        limit = await client.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "withdrawLimit", args: [token] });
      } catch {
        limitUnsupported = true;
        console.warn("[chain] 该 Vault 不支持 withdrawLimit（旧版合约），跳过单笔限额预检；金库偿付能力仍会检查。重新部署即可启用。");
      }
    }
    if (limit > 0n && amountWei > limit) {
      throw new Error(`提现超过链上单笔限额：${amountWei} > ${limit}（${asset} 最小单位）`);
    }
    if (held < amountWei) {
      throw new Error(`金库链上余额不足：${amountWei} > ${held}（${asset} 最小单位）`);
    }
  }

  /** 签 Withdraw 授权。amount 是 8 位定点，这里换算成代币 wei 再签 */
  async function signWithdraw(p: { user: string; asset: Asset; amount: bigint; nonce: bigint; deadline: bigint }) {
    const token = getAddress(tokenAddress(p.asset));
    const amountWei = fixedToWei(p.amount, TOKEN_DECIMALS[p.asset]);
    const signature = await signer.signTypedData({
      domain: { name: "MiniDexVault", version: "1", chainId: cfg.chainId, verifyingContract: getAddress(cfg.vault) },
      types: WITHDRAW_TYPES,
      primaryType: "Withdraw",
      message: { user: getAddress(p.user), token, amount: amountWei, nonce: p.nonce, deadline: p.deadline },
    });
    return { token, amountWei, signature };
  }

  return { offline, signerAddress: signer.address, tokenAddress, watchDeposits, signWithdraw, checkWithdrawable };
}
export type Chain = ReturnType<typeof createChain>;
