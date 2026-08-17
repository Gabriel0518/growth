/**
 * app_id / media_source 归一映射 —— 逐字对齐旧 dashboard/server.js。
 * 纯查表逻辑，无副作用。
 */

/** app_id → 产品显示名。含 Adjust 用的无 `id` 前缀数字形态。 */
export const APP_ID_MAP: Record<string, string> = {
  'com.doramatch.app': 'Dora And',
  id6746109957: 'Dora iOS',
  id6746782904: 'Romi iOS',
  'com.qiga.vio': 'Jovia And',
  'com.doni.appa': 'Doni',
  'com.romiandroid.appmatch': 'Romi And',
  id1658972379: 'GraceChat',
  id6759697686: 'Kira iOS',
  'com.meraki.kira': 'Kira And',
  'com.cavalier.nalo': 'Nalo And',
  'com.rubymatch.app': 'Ruby And',
  // Adjust uses numeric app_id without 'id' prefix
  '6746109957': 'Dora iOS',
  '6746782904': 'Romi iOS',
  '1658972379': 'GraceChat',
  '6759697686': 'Kira iOS',
  '6746466099': 'Luma',
  'com.circleconnect.dora': 'Dora iOS',
  'com.chatsbridgeconnect.romi': 'Romi iOS',
  'com.odyssey.luma': 'Luma',
  id6746466099: 'Luma',
  id6761983452: 'Mora iOS',
  '6761983452': 'Mora iOS',
};

/** 测试/未知 app_id，postback 展示时排除。 */
export const EXCLUDED_APP_IDS: ReadonlySet<string> = new Set(['id123']);

/** LTV/user-lookup 用的 app_id → 产品名（复刻旧 LTV_APP_IDS，仅 id 前缀 iOS 形态）。 */
export const LTV_APP_IDS: Record<string, string> = {
  id6746109957: 'Dora iOS',
  id6746782904: 'Romi iOS',
  id6746466099: 'Luma',
  id1658972379: 'GraceChat',
  id6759697686: 'Kira iOS',
  id6761983452: 'Mora iOS',
  'com.doramatch.app': 'Dora And',
  'com.qiga.vio': 'Jovia And',
  'com.doni.appa': 'Doni',
  'com.romiandroid.appmatch': 'Romi And',
  'com.meraki.kira': 'Kira And',
  'com.cavalier.nalo': 'Nalo And',
  'com.rubymatch.app': 'Ruby And',
};

/** 静态 media_source → 渠道映射。动态规则（含 W2A/web）见 mapMediaSource。 */
export const MEDIA_SOURCE_MAP: Record<string, string> = {
  // FB
  'Facebook Ads': 'FB',
  'Facebook+Installs': 'FB',
  'Facebook Installs': 'FB',
  'Instagram+Installs': 'FB',
  'Instagram Installs': 'FB',
  'Off-Facebook+Installs': 'FB',
  Social_facebook: 'FB',
  facebook: 'FB',
  // FB W2A (含 W2A 或 web/Web 字样)
  'Facebook+web': 'FB W2A',
  'Facebook web': 'FB W2A',
  // GG
  googleadwords_int: 'GG',
  'Google Ads ACI': 'GG',
  'Google+Ads+ACI': 'GG',
  // TT
  tiktokglobal_int: 'TT',
  'TikTok+SAN': 'TT',
  'TikTok SAN': 'TT',
  // 自然量
  organic: 'Organic',
  Organic: 'Organic',
  restricted: 'Organic',
  Unattributed: 'Organic',
  'Untrusted Devices': 'Organic',
};

/** 名字含 W2A 或 Web/web 的动态归为 FB W2A；否则原样返回，空值 Unknown。 */
export function mapMediaSource(src: string): string {
  if (!src) return 'Unknown';
  const mapped = MEDIA_SOURCE_MAP[src];
  if (mapped !== undefined) return mapped;
  const s = src.toLowerCase();
  if (s.includes('w2a') || s.includes('web')) return 'FB W2A';
  return src;
}
