/**
 * Facebook Token 管理。
 * 从环境变量 FB_LONG_TOKEN 读取 System User Token（永久有效，不过期）。
 * 启动时校验有效性，无效时抛错阻断启动。
 */

/** 从环境变量读取长期 token。未设置时抛错。 */
export function loadToken(): string {
  const token = process.env['FB_LONG_TOKEN'] ?? process.env['FB_TOKEN'];
  if (!token || token.length === 0) {
    throw new Error('FB_LONG_TOKEN 未设置，请设置环境变量后重试');
  }
  return token;
}

/** 调 GET /me 校验 token 是否有效。 */
export async function validateToken(
  token: string,
): Promise<{ userId: string; userName: string }> {
  const url = `https://graph.facebook.com/v25.0/me?fields=id,name&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();

    throw new Error(`FB Token 校验失败 (HTTP ${String(res.status)}): ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as { id: string; name: string };
  if (!data.id) throw new Error('FB Token 校验返回无 id，可能已过期');
  return { userId: data.id, userName: data.name };
}

export interface AdAccountInfo {
  id: string;
  name: string;
  account_status: number;
}

/** 用给定的 token 查所有可访问的广告账户列表。 */
export async function queryAdAccounts(token: string): Promise<AdAccountInfo[]> {
  const url = `https://graph.facebook.com/v25.0/me/adaccounts?fields=id,name,account_status&limit=200&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FB 查询广告账户失败 (HTTP ${String(res.status)}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    data?: { id: string; name: string; account_status: number }[];
  };
  const accounts = (data.data ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    account_status: a.account_status,
  }));
  console.log(`[FB] queryAdAccounts: ${String(accounts.length)} 个账户`);
  return accounts;
}

/**
 * 通过广告账户反查 BM 信息。
 * System User 的 me/businesses 通常返回空（System User 在 BM 中没有用户角色），
 * 但通过它能操作的广告账户，可以查到所属 BM。
 */
export async function queryBusinessManager(
  token: string,
): Promise<{ bmId: string; bmName: string } | null> {
  // 1. 先查 token 能访问的广告账户（带 business 字段）
  const accountsUrl = `https://graph.facebook.com/v25.0/me/adaccounts?fields=id,name,business{id,name}&limit=5&access_token=${encodeURIComponent(token)}`;
  const acctRes = await fetch(accountsUrl);
  if (!acctRes.ok) {
    const body = await acctRes.text();
    console.error(
      `[FB] queryBusinessManager 查广告账户失败 HTTP ${String(acctRes.status)}: ${body.slice(0, 300)}`,
    );
    throw new Error(`FB 查询 BM 失败 (HTTP ${String(acctRes.status)})`);
  }
  const acctData = (await acctRes.json()) as {
    data?: { id: string; name: string; business?: { id: string; name: string } }[];
  };

  console.log(
    `[FB] queryBusinessManager: token 可访问 ${String(acctData.data?.length ?? 0)} 个广告账户`,
  );

  // 2. 从第一个有 business 的账户提取 BM
  for (const acct of acctData.data ?? []) {
    if (acct.business) {
      console.log(
        `[FB] queryBusinessManager: 从广告账户 ${acct.id}(${acct.name}) → BM ${acct.business.id}(${acct.business.name})`,
      );
      return { bmId: acct.business.id, bmName: acct.business.name };
    }
  }

  // 3. 尝试 me/businesses 兜底（User Token 场景）
  const bmUrl = `https://graph.facebook.com/v25.0/me/businesses?fields=id,name&access_token=${encodeURIComponent(token)}`;
  const bmRes = await fetch(bmUrl);
  if (bmRes.ok) {
    const bmData = (await bmRes.json()) as { data?: { id: string; name: string }[] };
    const first = bmData.data?.[0];
    if (first) {
      console.log(
        `[FB] queryBusinessManager: me/businesses 兜底 → BM ${first.id}(${first.name})`,
      );
      return { bmId: first.id, bmName: first.name };
    }
  }

  console.warn('[FB] queryBusinessManager: 未能确定 BM（token 无广告账户且不在任何 BM 中）');
  return null;
}
