// 我的挂单：优先用私有 WS 频道推来的 orders（下单/成交/撤单时服务端主动推，无延迟）。
// pushed 为 null 表示还没收到过推送（例如 WS 刚断），这时才退回 GET /orders 轮询兜底。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Order } from "../lib/api";
import { errorMessage, fmtNum, fmtTime } from "../lib/format";

export function MyOrders({ token, pushed }: { token: string | null; pushed?: Order[] | null }) {
  const queryClient = useQueryClient();
  const live = pushed ?? null;

  const orders = useQuery({
    queryKey: ["orders", token],
    queryFn: () => api.orders(token!),
    enabled: !!token,
    refetchInterval: live ? false : 3000, // 有推送就不轮询了
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelOrder(token!, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["balances"] });
    },
  });

  const list = live ?? orders.data ?? [];

  return (
    <div className="card">
      {!token && <p className="muted">登录后显示。</p>}
      {token && list.length === 0 && <p className="muted">没有挂单。</p>}
      {list.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>方向</th>
              <th>价格</th>
              <th>剩余/数量</th>
              <th>时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.id}>
                <td className={o.side}>{o.side === "buy" ? "买" : "卖"}</td>
                <td>{fmtNum(o.price, 4)}</td>
                <td>
                  {fmtNum(o.remaining, 4)} / {fmtNum(o.qty, 4)}
                </td>
                <td className="muted">{fmtTime(o.ts)}</td>
                <td>
                  <button className="btn ghost small" disabled={cancel.isPending} onClick={() => cancel.mutate(o.id)}>
                    撤单
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cancel.error && <div className="msg err">{errorMessage(cancel.error)}</div>}
    </div>
  );
}
