// 登录模块测试：重点是 nonce 存储的内存边界（安全审查发现的问题）。
import { describe, it, expect, vi, afterEach } from "vitest";
import { createAuth } from "./auth.js";

const addr = (i: number) => "0x" + i.toString(16).padStart(40, "0");
const DUMMY_SIG = ("0x" + "00".repeat(65)) as `0x${string}`;

/** 走一遍 /auth/login，只关心它卡在哪一步：
 *  "nonce 不存在或已使用" = nonce 已被清理掉；"签名校验失败" = nonce 还在（只是签名是假的） */
async function loginError(app: ReturnType<typeof createAuth>["router"], address: string, nonce: string) {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, nonce, signature: DUMMY_SIG }),
  });
  return ((await res.json()) as { error: string }).error;
}

async function getNonce(app: ReturnType<typeof createAuth>["router"], address: string) {
  const res = await app.request(`/auth/nonce?address=${address}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { nonce: string }).nonce;
}

afterEach(() => vi.useRealTimers());

describe("auth nonce 存储", () => {
  it("未登录的地址不会让 nonce 无限堆积：超出上限时淘汰最老的", async () => {
    const { router } = createAuth({ chainId: 31337, jwtSecret: "t", maxNonces: 10 });

    const first = addr(1);
    const firstNonce = await getNonce(router, first);

    // 用 24 个不同地址连续要 nonce（模拟未认证的批量请求）
    for (let i = 2; i <= 25; i++) await getNonce(router, addr(i));

    // 最老的那个应该被淘汰了 -> 卡在 nonce 检查
    expect(await loginError(router, first, firstNonce)).toBe("nonce 不存在或已使用");

    // 最新的那个还在 -> 能通过 nonce 检查，只是签名是假的
    const last = addr(25);
    const lastNonce = await getNonce(router, last);
    expect(await loginError(router, last, lastNonce)).toBe("签名校验失败");
  });

  it("过期的 nonce 会被清理", async () => {
    vi.useFakeTimers();
    const { router } = createAuth({ chainId: 31337, jwtSecret: "t", maxNonces: 1000 });

    const a = addr(7);
    const nonce = await getNonce(router, a);

    vi.advanceTimersByTime(6 * 60 * 1000); // 越过 5 分钟 TTL
    await getNonce(router, addr(8));       // 这次请求会顺带触发清理

    expect(await loginError(router, a, nonce)).toBe("nonce 不存在或已使用");
  });

  it("同一个地址重复要 nonce 只占一份", async () => {
    const { router } = createAuth({ chainId: 31337, jwtSecret: "t", maxNonces: 2 });
    const a = addr(3);
    const old = await getNonce(router, a);
    const fresh = await getNonce(router, a);
    expect(fresh).not.toBe(old);
    // 前一个被覆盖了，只有最新的有效
    expect(await loginError(router, a, old)).toBe("nonce 不存在或已使用");
    expect(await loginError(router, a, fresh)).toBe("签名校验失败");
  });
});
