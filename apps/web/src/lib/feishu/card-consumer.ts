/**
 * 飞书卡片回调 consumer —— 长连接（WSClient）收「✅确认/✖️拒绝」按钮点击。
 *
 * 关键坑（已实测固化，勿改交互方式）：
 * - card 回调必须走官方 SDK 的 WSClient + EventDispatcher('card.action.trigger')，
 *   lark-cli 的 event consume 不支持这个回调，单独的 cardActionHandler 参数也不对。
 * - 长连接是出站 WebSocket，服务器公网关闭也能收回调；飞书后台需订阅 card.action.trigger
 *   且订阅方式选「长连接」。
 * - 多副本时每副本各连一条，回调被其中一个消费；challenge 状态在 PG 共享，任意副本处理都对。
 *
 * 单例守卫：模块级 started，避免重复 start（instrumentation 只在生产 nodejs 调一次，双保险）。
 */

import * as Lark from '@larksuiteoapi/node-sdk';

import { config } from '@/lib/config';
import { getChallenge, markChallenge } from '@/lib/feishu/store';

let started = false;

/** 卡片回调载荷：只取点击人 open_id 与按钮 value，其余字段不读。 */
interface CardActionData {
  operator?: { open_id?: string };
  action?: { value?: unknown };
}

interface ActionValue {
  action: string;
  nonce: string;
}

/** 从按钮 value（unknown）里逐字段收窄出 { action, nonce }，非法结构返回 undefined。 */
function parseActionValue(value: unknown): ActionValue | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const action = obj['action'];
  const nonce = obj['nonce'];
  if (typeof action !== 'string' || typeof nonce !== 'string') return undefined;
  return { action, nonce };
}

/** 就地更新卡片：点完变「已确认/已拒绝」。type:'raw' 直接替换整张卡。 */
function updatedCard(
  template: 'green' | 'red',
  title: string,
  content: string,
): { type: 'raw'; data: unknown } {
  return {
    type: 'raw',
    data: {
      header: { template, title: { tag: 'plain_text', content: title } },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content } }],
    },
  };
}

/** 起长连接 + 注册卡片回调。已启动则直接返回（单例）。 */
export function startCardConsumer(): void {
  if (started) return;
  started = true;

  const dispatcher = new Lark.EventDispatcher({}).register({
    'card.action.trigger': async (data: CardActionData) => {
      const openId = data.operator?.open_id;
      const parsed = parseActionValue(data.action?.value);
      if (openId === undefined || parsed === undefined) {
        return { toast: { type: 'error', content: '参数缺失' } };
      }
      const challenge = await getChallenge(parsed.nonce);
      if (challenge?.status !== 'pending') {
        return { toast: { type: 'error', content: '该请求已失效' } };
      }
      // 防串号：点击人必须是挑战归属的 open_id 本人。
      if (challenge.openId !== openId) {
        return { toast: { type: 'error', content: '非本人，拒绝' } };
      }
      if (parsed.action === 'confirm') {
        await markChallenge(parsed.nonce, 'confirmed');
        return {
          toast: { type: 'success', content: '已确认 ✅' },
          card: updatedCard(
            'green',
            '✅ 已确认',
            `校验码 \`${parsed.nonce}\` 已确认，网页端可继续。`,
          ),
        };
      }
      await markChallenge(parsed.nonce, 'rejected');
      return {
        toast: { type: 'info', content: '已拒绝' },
        card: updatedCard('red', '✖️ 已拒绝', `已拒绝校验码 \`${parsed.nonce}\`。`),
      };
    },
  });

  const wsClient = new Lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    loggerLevel: Lark.LoggerLevel.error,
  });
  // start() 返回 Promise：不阻塞 register()，但要接住 rejection，避免未处理拒绝。
  void wsClient.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
    console.error('[feishu] 卡片回调长连接启动失败：', error);
  });

  console.log('[feishu] 卡片回调长连接已启动');
}
