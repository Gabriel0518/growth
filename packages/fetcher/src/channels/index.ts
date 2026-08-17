/**
 * Channel Adapter 工厂 —— 按渠道标识获取对应 adapter 实例。
 * Demo 阶段只支持 Facebook；后续扩展 TikTok / Google。
 */

import type { Channel, ChannelAdapter } from './types.js';

let _createFb: ((token: string) => ChannelAdapter) | undefined;

/**
 * 用给定 token 创建 FB Adapter（不缓存，每次新建）。
 * 适用范围：前端传入 accountId → token-service 查到 token → 调此函数。
 */
export async function createFbAdapter(token: string): Promise<ChannelAdapter> {
  if (!_createFb) {
    const { FacebookAdapter } = await import('./facebook/adapter.js');
    _createFb = (t: string) => new FacebookAdapter(t);
  }
  return _createFb(token);
}

/**
 * 从环境变量 FB_LONG_TOKEN 读取 token 并创建 FB Adapter（遗留兼容）。
 */
export async function getFbAdapter(): Promise<ChannelAdapter> {
  const { loadToken } = await import('./facebook/token.js');
  return createFbAdapter(loadToken());
}

/** 按渠道标识获取 adapter（目前只支持 fb，后续扩展 switch）。 */
export async function getAdapter(channel: Channel): Promise<ChannelAdapter> {
  switch (channel) {
    case 'fb': {
      return getFbAdapter();
    }
    default: {
      throw new Error(`不支持的渠道: ${channel}`);
    }
  }
}

export { type ChannelAdapter } from './types.js';
