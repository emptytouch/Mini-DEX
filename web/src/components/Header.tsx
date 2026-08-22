// 顶栏：连接钱包 / 切链 / 签名登录 / 登出，右侧状态小圆点按颜色区分四种状态。
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import type { Config } from "../lib/api";
import { chainName, chains } from "../lib/chains";
import { shortAddress } from "../lib/format";
import type { useAuth } from "../lib/useAuth";

type Auth = ReturnType<typeof useAuth>;
type Status = "disconnected" | "wrongChain" | "connected" | "signedIn";

const STATUS_LABEL: Record<Status, string> = {
  disconnected: "未连接",
  wrongChain: "链错误",
  connected: "已连接未登录",
  signedIn: "已登录",
};

export function Header({ config, auth }: { config: Config | undefined; auth: Auth }) {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const expectedChainId = config?.chainId;
  const wrongChain = isConnected && !!expectedChainId && chainId !== expectedChainId;
  const targetChain = chains.find((c) => c.id === expectedChainId);

  const status: Status = !isConnected
    ? "disconnected"
    : wrongChain
      ? "wrongChain"
      : auth.token
        ? "signedIn"
        : "connected";

  return (
    <header className="header">
      <div className="brand">
        <span className="logo">◆</span> MiniDex
        <nav className="nav">
          <span className="nav-item on">现货</span>
          <span className="nav-item">合约</span>
          <span className="nav-item">理财</span>
        </nav>
      </div>

      <div className="header-right">
        {expectedChainId && <span className="pill net">{chainName(expectedChainId)}</span>}

        {!isConnected && (
          <button
            className="btn primary"
            disabled={connecting}
            onClick={() => connect({ connector: connectors[0] })}
          >
            {connecting ? "连接中…" : "Connect MetaMask"}
          </button>
        )}

        {isConnected && address && (
          <span className="pill addr" title={address}>
            {shortAddress(address)}
          </span>
        )}

        {wrongChain && targetChain && (
          <button
            className="btn warn"
            disabled={switching}
            onClick={() => switchChain({ chainId: targetChain.id })}
          >
            {switching ? "切换中…" : `Switch to ${targetChain.name}`}
          </button>
        )}
        {wrongChain && !targetChain && (
          <span className="pill err">后端要求的链 {expectedChainId} 前端未配置</span>
        )}

        {isConnected && !wrongChain && !auth.token && (
          <button className="btn primary" disabled={auth.busy} onClick={auth.signIn}>
            {auth.busy ? "签名中…" : "Sign in"}
          </button>
        )}

        {auth.token && (
          <button className="btn" onClick={auth.signOut}>
            Sign out
          </button>
        )}

        {isConnected && (
          <button className="btn ghost" onClick={() => disconnect()}>
            断开
          </button>
        )}

        <span className={`pill status ${status}`}>
          <i className="dot" /> {STATUS_LABEL[status]}
        </span>
      </div>

      {auth.error && <div className="msg err header-msg">登录失败：{auth.error}</div>}
    </header>
  );
}
