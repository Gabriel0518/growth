'use client';

/**
 * sitin.ai 客户门户（/demo）主组件 —— 全部内容来自真实合创(partnership)投放数据。
 *
 * 数据来源见 lib/demo/partnership.ts：消耗/曝光/点击/播放/互动/安装走 FB 官方 API，
 * 收入走库，创作者名单走 FB branded content 授权。前端只负责渲染与筛选，不做业务口径计算
 * ——口径一旦分散在两处必然漂移。
 *
 * 登录走服务端 httpOnly cookie（lib/demo/auth.ts），本文件不接触任何口令；语言/主题/展示名
 * /头像这类纯展示偏好仍留在 localStorage（见 demo-data.ts）。
 * 「创建 campaign」本轮不做：门户当前是只读的经营看板。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  AVATAR_GRADIENTS,
  apiLogin,
  apiLogout,
  apiOverview,
  apiSession,
  fmtCompact,
  fmtInt,
  fmtPct,
  fmtRatio,
  fmtTime,
  fmtUSD,
  gradientOf,
  initials,
  lastNDays,
  loadProfile,
  saveProfile,
  todayStr,
} from './demo-data';
import type {
  DateRange,
  DemoCampaignStat,
  DemoCreatorStat,
  DemoMaterialStat,
  DemoProductSlotCell,
  DemoTrendPoint,
  Lang,
  OverviewResponse,
  PortalUser,
  Profile,
  Theme,
  UserAvatar,
} from './demo-data';
import styles from './demo.module.css';

/** CSS Module 类名拼接：括号访问 + 兜底空串（应对严格索引签名配置），支持条件类。 */
function cx(...keys: (string | false | null | undefined)[]): string {
  return keys
    .filter((k): k is string => typeof k === 'string')
    .map((k) => styles[k] ?? '')
    .join(' ');
}

// ───────────────────────────── 国际化 ─────────────────────────────

const LangContext = createContext<Lang>('zh');

/** 返回一个双语取词函数：lang=en 取第二参，否则取第一参（中文）。 */
function useT(): (zh: string, en: string) => string {
  const lang = useContext(LangContext);
  return (zh: string, en: string) => (lang === 'en' ? en : zh);
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

// ───────────────────────────── 基础组件 ─────────────────────────────

/** 创作者头像：没有真实图片，用名字派生固定渐变 + 首字母。 */
function Avatar({ name, cls }: { name: string; cls: string }): React.ReactElement {
  const g = gradientOf(name);
  return (
    <div className={cls} style={{ background: `linear-gradient(135deg, ${g[0]}, ${g[1]})` }}>
      {initials(name)}
    </div>
  );
}

/** 登录用户头像：渐变+字母 或 上传图片（背景图铺满，无需 img 标签）。 */
function UserAvatarView({ avatar, cls }: { avatar: UserAvatar; cls: string }): React.ReactElement {
  if (avatar.kind === 'image' && typeof avatar.image === 'string') {
    return (
      <span
        className={cls}
        style={{
          backgroundImage: `url(${avatar.image})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      />
    );
  }
  return (
    <span
      className={cls}
      style={{
        background: `linear-gradient(135deg, ${avatar.gradient[0]}, ${avatar.gradient[1]})`,
      }}
    >
      {avatar.letters}
    </span>
  );
}

function Brand({ big }: { big?: boolean }): React.ReactElement {
  return (
    <span className={cx('brand')} style={big === true ? { fontSize: '22px' } : undefined}>
      <span className={cx('brandMark')}>S</span>
      <span className={cx('brandText')}>
        sitin<span className={cx('brandDot')}>.ai</span>
      </span>
    </span>
  );
}

/** 分段开关。 */
function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { v: T; label: string }[];
  onChange: (v: T) => void;
}): React.ReactElement {
  return (
    <div className={cx('seg')}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          className={cx('segBtn', value === o.v && 'segBtnOn')}
          onClick={() => {
            onChange(o.v);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function NavIcon({ name }: { name: string }): React.ReactElement {
  const common = {
    className: cx('navIcon'),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (name === 'dashboard') {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="7" height="9" />
        <rect x="14" y="3" width="7" height="5" />
        <rect x="14" y="12" width="7" height="9" />
        <rect x="3" y="16" width="7" height="5" />
      </svg>
    );
  }
  if (name === 'creators') {
    return (
      <svg {...common}>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11" />
      </svg>
    );
  }
  if (name === 'products') {
    return (
      <svg {...common}>
        <path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
        <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="m10 15 5.2-3L10 9z" />
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
    </svg>
  );
}

// ───────────────────────────── 登录 ─────────────────────────────

function AuthScreen({ onAuth }: { onAuth: (u: PortalUser) => void }): React.ReactElement {
  const t = useT();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setError('');
    setBusy(true);
    const result = await apiLogin(username, password);
    setBusy(false);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    onAuth(result.user);
  }

  return (
    <div className={cx('authWrap')}>
      <div className={cx('authCard')}>
        <div className={cx('authBrand')}>
          <Brand big />
        </div>
        <div className={cx('authTagline')}>AI Creator Growth Engine</div>
        <div className={cx('authTitle')}>{t('登录客户控制台', 'Sign in to your console')}</div>
        <div className={cx('authHint')}>
          {t('进入你的合创投放控制台', 'Access your co-creation campaign console')}
        </div>

        {error !== '' && <div className={cx('authError')}>{error}</div>}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className={cx('field')}>
            <label className={cx('label')} htmlFor="si-user">
              {t('用户名', 'Username')}
            </label>
            <input
              id="si-user"
              className={cx('input')}
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
              }}
              placeholder="username"
              autoComplete="username"
            />
          </div>
          <div className={cx('field')}>
            <label className={cx('label')} htmlFor="si-pass">
              {t('密码', 'Password')}
            </label>
            <input
              id="si-pass"
              className={cx('input')}
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>
          <button type="submit" className={cx('btn')} style={{ marginTop: '6px' }} disabled={busy}>
            {busy ? t('验证中…', 'Signing in…') : t('登录 →', 'Sign in →')}
          </button>
        </form>
      </div>
    </div>
  );
}

// ───────────────────────────── 图表 ─────────────────────────────

/**
 * 鼠标 x（clientX）→ 最近的数据点下标。图表现在等比缩放（去掉了 preserveAspectRatio="none"，
 * 见任务 2），rect.width 即渲染宽度，据此把屏幕坐标反解回 viewBox 的 sx 并四舍五入到最近点。
 */
function nearestIndex(
  clientX: number,
  rect: DOMRect,
  w: number,
  padL: number,
  padR: number,
  n: number,
): number {
  if (n <= 1 || rect.width === 0) return 0;
  const vx = ((clientX - rect.left) / rect.width) * w;
  const iw = w - padL - padR;
  const i = Math.round(((vx - padL) / iw) * (n - 1));
  return Math.max(0, Math.min(n - 1, i));
}

/** 悬浮 tooltip：按数据点 x 的百分比定位，靠右侧的点向左展开避免溢出。 */
function ChartTip({
  x,
  w,
  day,
  rows,
}: {
  x: number;
  w: number;
  day: string;
  rows: readonly { color: string; label: string; value: string }[];
}): React.ReactElement {
  const leftPct = (x / w) * 100;
  const flip = leftPct > 62;
  return (
    <div
      className={cx('chartTip', flip && 'chartTipFlip')}
      style={{ left: `${leftPct.toFixed(2)}%` }}
    >
      <div className={cx('chartTipDay')}>{day}</div>
      {rows.map((r) => (
        <div key={r.label} className={cx('chartTipRow')}>
          <span className={cx('chartTipDot')} style={{ background: r.color }} />
          <span className={cx('chartTipLbl')}>{r.label}</span>
          <span className={cx('chartTipVal')}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** 收入 vs 消耗双线图（同为美元，可共用一根 y 轴）。悬浮显示当日收入/消耗。 */
function MoneyChart({ trend }: { trend: DemoTrendPoint[] }): React.ReactElement {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const w = 760;
  const h = 250;
  const padL = 52;
  const padR = 18;
  const padT = 18;
  const padB = 26;
  const maxV = Math.max(1, ...trend.map((d) => Math.max(d.revenue, d.spend))) * 1.15;
  const iw = w - padL - padR;
  const ih = h - padT - padB;
  const sx = (i: number): number => padL + (trend.length <= 1 ? 0 : (i / (trend.length - 1)) * iw);
  const sy = (v: number): number => padT + ih - (v / maxV) * ih;

  const pts = trend.map((d, i) => ({ x: sx(i), yr: sy(d.revenue), ys: sy(d.spend), d }));
  const first = pts[0];
  const last = pts.at(-1);
  if (first === undefined || last === undefined) {
    return <div className={cx('empty')}>{t('暂无趋势数据', 'No trend data')}</div>;
  }

  const linePath = (key: 'yr' | 'ys'): string =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p[key].toFixed(1)}`).join(' ');
  const areaPath = `${linePath('yr')} L ${last.x.toFixed(1)} ${(padT + ih).toFixed(1)} L ${first.x.toFixed(1)} ${(padT + ih).toFixed(1)} Z`;
  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxV);
  const hv = hover === null ? undefined : pts[hover];

  return (
    <div className={cx('chartWrap')}>
      <div className={cx('chartInner')}>
        <svg
          ref={svgRef}
          className={cx('chartSvg')}
          viewBox={`0 0 ${String(w)} ${String(h)}`}
          role="img"
          aria-label={t('收入与消耗趋势', 'Revenue and spend trend')}
          onMouseMove={(e) => {
            const rect = svgRef.current?.getBoundingClientRect();
            if (rect) setHover(nearestIndex(e.clientX, rect, w, padL, padR, trend.length));
          }}
          onMouseLeave={() => {
            setHover(null);
          }}
        >
          <defs>
            <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
            </linearGradient>
          </defs>
          {gridVals.map((v) => (
            <g key={v}>
              <line
                x1={padL}
                y1={sy(v)}
                x2={w - padR}
                y2={sy(v)}
                stroke="rgba(120,150,220,0.12)"
                strokeWidth="1"
              />
              <text x={padL - 8} y={sy(v) + 3} textAnchor="end" fontSize="9.5" fill="#5a628a">
                ${fmtCompact(v)}
              </text>
            </g>
          ))}
          {trend.map((d, i) => (
            <text key={d.day} x={sx(i)} y={h - 8} textAnchor="middle" fontSize="9" fill="#5a628a">
              {i % 2 === 0 ? d.day.slice(5) : ''}
            </text>
          ))}
          <path d={areaPath} fill="url(#revFill)" />
          <path
            d={linePath('ys')}
            fill="none"
            stroke="#ff3d81"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ filter: 'drop-shadow(0 0 5px rgba(255,61,129,0.6))' }}
          />
          <path
            className={cx('drawLine')}
            d={linePath('yr')}
            fill="none"
            stroke="#22d3ee"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ filter: 'drop-shadow(0 0 6px rgba(34,211,238,0.7))' }}
          />
          {hv !== undefined && (
            <>
              <line
                x1={hv.x}
                y1={padT}
                x2={hv.x}
                y2={padT + ih}
                stroke="rgba(180,200,255,0.35)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <circle
                cx={hv.x}
                cy={hv.yr}
                r="4"
                fill="#22d3ee"
                stroke="#0b0e1a"
                strokeWidth="1.5"
              />
              <circle
                cx={hv.x}
                cy={hv.ys}
                r="3.5"
                fill="#ff3d81"
                stroke="#0b0e1a"
                strokeWidth="1.5"
              />
            </>
          )}
          {hv === undefined && (
            <>
              <circle
                cx={last.x}
                cy={last.yr}
                r="4.5"
                fill="#22d3ee"
                style={{ filter: 'drop-shadow(0 0 6px #22d3ee)' }}
              />
              <circle
                cx={last.x}
                cy={last.ys}
                r="3.5"
                fill="#ff3d81"
                style={{ filter: 'drop-shadow(0 0 5px #ff3d81)' }}
              />
            </>
          )}
        </svg>
        {hv !== undefined && (
          <ChartTip
            x={hv.x}
            w={w}
            day={hv.d.day}
            rows={[
              { color: '#22d3ee', label: t('收入', 'Revenue'), value: fmtUSD(hv.d.revenue) },
              { color: '#ff3d81', label: t('消耗', 'Spend'), value: fmtUSD(hv.d.spend) },
            ]}
          />
        )}
      </div>
      <div className={cx('legend')}>
        <span className={cx('legendItem')}>
          <span className={cx('swatch')} style={{ background: '#22d3ee' }} /> {t('收入', 'Revenue')}
        </span>
        <span className={cx('legendItem')}>
          <span className={cx('swatch')} style={{ background: '#ff3d81' }} /> {t('消耗', 'Spend')}
        </span>
      </div>
    </div>
  );
}

/**
 * 曝光量柱 + 点击量线的双轴图。两者量级差一个数量级以上，共轴会把点击压成一条贴地直线，
 * 所以各用各的轴。
 */
function ReachChart({ trend }: { trend: DemoTrendPoint[] }): React.ReactElement {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const w = 760;
  const h = 230;
  const padL = 52;
  const padR = 52;
  const padT = 16;
  const padB = 26;
  const iw = w - padL - padR;
  const ih = h - padT - padB;
  const maxImp = Math.max(1, ...trend.map((d) => d.impressions)) * 1.15;
  const maxClk = Math.max(1, ...trend.map((d) => d.clicks)) * 1.2;
  const n = Math.max(1, trend.length);
  const bw = (iw / n) * 0.62;
  const cx0 = (i: number): number => padL + (iw / n) * (i + 0.5);
  const syImp = (v: number): number => padT + ih - (v / maxImp) * ih;
  const syClk = (v: number): number => padT + ih - (v / maxClk) * ih;

  const clickPath = trend
    .map((d, i) => `${i === 0 ? 'M' : 'L'} ${cx0(i).toFixed(1)} ${syClk(d.clicks).toFixed(1)}`)
    .join(' ');

  // 柱状按格子等分定位（非端到端），命中用 floor 落到所在格。
  const hitIndex = (clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const vx = ((clientX - rect.left) / rect.width) * w;
    const i = Math.floor((vx - padL) / (iw / n));
    return Math.max(0, Math.min(n - 1, i));
  };
  const hd = hover === null ? undefined : trend[hover];

  return (
    <div className={cx('chartWrap')}>
      <div className={cx('chartInner')}>
        <svg
          ref={svgRef}
          className={cx('chartSvg')}
          viewBox={`0 0 ${String(w)} ${String(h)}`}
          role="img"
          aria-label={t('曝光量与点击量趋势', 'Impressions and clicks trend')}
          onMouseMove={(e) => {
            setHover(hitIndex(e.clientX));
          }}
          onMouseLeave={() => {
            setHover(null);
          }}
        >
          <defs>
            <linearGradient id="impBar" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#a855f7" stopOpacity="0.85" />
              <stop offset="100%" stopColor="#a855f7" stopOpacity="0.18" />
            </linearGradient>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line
                x1={padL}
                y1={syImp(f * maxImp)}
                x2={w - padR}
                y2={syImp(f * maxImp)}
                stroke="rgba(120,150,220,0.1)"
                strokeWidth="1"
              />
              <text
                x={padL - 8}
                y={syImp(f * maxImp) + 3}
                textAnchor="end"
                fontSize="9.5"
                fill="#5a628a"
              >
                {fmtCompact(f * maxImp)}
              </text>
              <text
                x={w - padR + 8}
                y={syClk(f * maxClk) + 3}
                textAnchor="start"
                fontSize="9.5"
                fill="#5a628a"
              >
                {fmtCompact(f * maxClk)}
              </text>
            </g>
          ))}
          {trend.map((d, i) => (
            <rect
              key={d.day}
              x={cx0(i) - bw / 2}
              y={syImp(d.impressions)}
              width={bw}
              height={Math.max(0, padT + ih - syImp(d.impressions))}
              fill="url(#impBar)"
              opacity={hover === null || hover === i ? 1 : 0.4}
              rx="2"
            />
          ))}
          <path
            d={clickPath}
            fill="none"
            stroke="#fbbf24"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ filter: 'drop-shadow(0 0 5px rgba(251,191,36,0.6))' }}
          />
          {trend.map((d, i) => (
            <text key={d.day} x={cx0(i)} y={h - 8} textAnchor="middle" fontSize="9" fill="#5a628a">
              {i % 2 === 0 ? d.day.slice(5) : ''}
            </text>
          ))}
          {hd !== undefined && hover !== null && (
            <>
              <line
                x1={cx0(hover)}
                y1={padT}
                x2={cx0(hover)}
                y2={padT + ih}
                stroke="rgba(180,200,255,0.35)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <circle
                cx={cx0(hover)}
                cy={syClk(hd.clicks)}
                r="3.5"
                fill="#fbbf24"
                stroke="#0b0e1a"
                strokeWidth="1.5"
              />
            </>
          )}
        </svg>
        {hd !== undefined && hover !== null && (
          <ChartTip
            x={cx0(hover)}
            w={w}
            day={hd.day}
            rows={[
              {
                color: '#a855f7',
                label: t('曝光量', 'Impressions'),
                value: fmtInt(hd.impressions),
              },
              { color: '#fbbf24', label: t('点击量', 'Clicks'), value: fmtInt(hd.clicks) },
            ]}
          />
        )}
      </div>
      <div className={cx('legend')}>
        <span className={cx('legendItem')}>
          <span className={cx('swatch')} style={{ background: '#a855f7' }} />{' '}
          {t('曝光量（左轴）', 'Impressions (left)')}
        </span>
        <span className={cx('legendItem')}>
          <span className={cx('swatch')} style={{ background: '#fbbf24' }} />{' '}
          {t('点击量（右轴）', 'Clicks (right)')}
        </span>
      </div>
    </div>
  );
}

// ───────────────────────────── KPI ─────────────────────────────

function Kpi({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: string;
}): React.ReactElement {
  return (
    <div className={cx('kpi', 'riseIn')}>
      <div className={cx('kpiLabel')}>{label}</div>
      <div className={cx('kpiValue')} style={accent === undefined ? undefined : { color: accent }}>
        {value}
      </div>
      <div className={cx('kpiDelta')}>{sub}</div>
    </div>
  );
}

/** 表格里的占比条：一眼看出谁在这批里占大头。 */
function Bar({ ratio, color }: { ratio: number; color: string }): React.ReactElement {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <span className={cx('barTrack')}>
      <span className={cx('barFill')} style={{ width: `${pct.toFixed(1)}%`, background: color }} />
    </span>
  );
}

// ───────────────────────────── 视图：数据看板 ─────────────────────────────

function DashboardView({ data }: { data: OverviewResponse }): React.ReactElement {
  const t = useT();
  const s = data.summary;
  const topCreators = data.creators.slice(0, 6);
  const maxSpend = Math.max(1, ...topCreators.map((c) => c.spend));

  return (
    <>
      <div className={cx('grid', 'kpiRow')} style={{ marginBottom: '16px' }}>
        <Kpi
          label={t('总曝光量', 'Total Impressions')}
          value={fmtCompact(s.impressions)}
          sub={t(`${fmtInt(s.impressions)} 次展示`, `${fmtInt(s.impressions)} impressions`)}
          accent="#a855f7"
        />
        <Kpi
          label={t('总点击量', 'Total Clicks')}
          value={fmtCompact(s.clicks)}
          sub={t(`点击率 ${fmtPct(s.ctr)}`, `CTR ${fmtPct(s.ctr)}`)}
          accent="#fbbf24"
        />
        <Kpi
          label={t('视频播放量', 'Video Views')}
          value={fmtCompact(s.videoViews)}
          sub={t(
            `互动 ${fmtCompact(s.engagements)} 次`,
            `${fmtCompact(s.engagements)} engagements`,
          )}
          accent="#34d399"
        />
        <Kpi
          label={t('安装量', 'Installs')}
          value={fmtCompact(s.installs)}
          sub={`CPI ${s.cpi === null ? '-' : fmtUSD(s.cpi, 2)}`}
          accent="#22d3ee"
        />
      </div>

      <div className={cx('grid', 'kpiRow')} style={{ marginBottom: '16px' }}>
        <Kpi
          label={t('广告消耗', 'Ad Spend')}
          value={fmtUSD(s.spend)}
          sub={`CPM ${fmtUSD(s.cpm ?? 0, 2)}`}
        />
        <Kpi
          label={t('产生收入', 'Revenue')}
          value={fmtUSD(s.revenue)}
          sub={t(`付费 ${fmtInt(s.purchases)} 笔`, `${fmtInt(s.purchases)} purchases`)}
        />
        <Kpi
          label="ROAS"
          value={fmtRatio(s.roas)}
          sub={t('当期收入 / 消耗', 'Revenue / spend')}
          accent={s.roas !== null && s.roas >= 1 ? '#34d399' : '#ff3d81'}
        />
        <Kpi
          label="eLTV ROAS"
          value={fmtRatio(s.eltvRoas)}
          sub={t('长周期回报预测', 'Long-term projection')}
          accent={s.eltvRoas !== null && s.eltvRoas >= 1 ? '#34d399' : '#fbbf24'}
        />
      </div>

      <div className={cx('card')}>
        <div className={cx('cardHead')}>
          <div className={cx('cardTitle')}>{t('收入 / 消耗趋势', 'Revenue / Spend Trend')}</div>
          <span className={cx('cardTag')}>
            {data.range.start} → {data.range.end}
          </span>
        </div>
        <MoneyChart trend={data.trend} />
      </div>

      <div className={cx('card')}>
        <div className={cx('cardHead')}>
          <div className={cx('cardTitle')}>
            {t('曝光量 / 点击量趋势', 'Impressions / Clicks Trend')}
          </div>
          <span className={cx('cardTag')}>
            {t('创作者内容的触达规模', 'Reach of creator content')}
          </span>
        </div>
        <ReachChart trend={data.trend} />
      </div>

      <div className={cx('card')}>
        <div className={cx('cardHead')}>
          <div className={cx('cardTitle')}>{t('头部创作者', 'Top Creators')}</div>
          <span className={cx('cardTag')}>
            {t(
              `${String(s.activeCreators)} / ${String(s.creators)} 位在投`,
              `${String(s.activeCreators)} / ${String(s.creators)} active`,
            )}
          </span>
        </div>
        <div className={cx('grid', 'creatorGrid')}>
          {topCreators.map((c) => (
            <div key={c.creator} className={cx('creatorCard')}>
              <div className={cx('creatorTop')}>
                <Avatar name={c.creator} cls={cx('avatar')} />
                <div style={{ minWidth: 0 }}>
                  <div className={cx('creatorName')}>{c.creator}</div>
                  <div className={cx('creatorHandle')}>@{c.creator}</div>
                </div>
              </div>
              <div className={cx('creatorStats')}>
                <div className={cx('stat')}>
                  <div className={cx('statNum')}>{fmtCompact(c.impressions)}</div>
                  <div className={cx('statLbl')}>{t('曝光', 'Impr.')}</div>
                </div>
                <div className={cx('stat')}>
                  <div className={cx('statNum')}>{fmtCompact(c.clicks)}</div>
                  <div className={cx('statLbl')}>{t('点击', 'Clicks')}</div>
                </div>
                <div className={cx('stat')}>
                  <div className={cx('statNum')}>{fmtUSD(c.revenue)}</div>
                  <div className={cx('statLbl')}>{t('收入', 'Revenue')}</div>
                </div>
              </div>
              <Bar ratio={c.spend / maxSpend} color="#22d3ee" />
              <div className={cx('creatorFoot')}>
                <span className={cx('tags')}>
                  {c.products.slice(0, 2).map((p) => (
                    <span key={p} className={cx('chip')}>
                      {p}
                    </span>
                  ))}
                </span>
                <span className={cx('rate')}>
                  <span className={cx('rateLbl')}>ROAS</span>
                  {c.spend > 0 ? fmtRatio(c.revenue / c.spend) : '-'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ───────────────────────────── 视图：创作者 ─────────────────────────────

function CreatorsView({ data }: { data: OverviewResponse }): React.ReactElement {
  const t = useT();
  const [onlyActive, setOnlyActive] = useState(false);
  const rows = useMemo(
    () => (onlyActive ? data.creators.filter((c) => c.activeAdsets > 0) : data.creators),
    [data.creators, onlyActive],
  );
  const maxSpend = Math.max(1, ...data.creators.map((c) => c.spend));
  const notInvested = data.pool.filter((p) => !p.invested);

  return (
    <>
      <div className={cx('card')}>
        <div className={cx('cardHead')}>
          <div className={cx('cardTitle')}>{t('创作者排行榜', 'Creator Leaderboard')}</div>
          <div className={cx('toolbar')}>
            <button
              type="button"
              className={cx('filterBtn', !onlyActive && 'filterBtnOn')}
              onClick={() => {
                setOnlyActive(false);
              }}
            >
              {t('全部', 'All')} {data.creators.length}
            </button>
            <button
              type="button"
              className={cx('filterBtn', onlyActive && 'filterBtnOn')}
              onClick={() => {
                setOnlyActive(true);
              }}
            >
              {t('在投', 'Active')} {data.summary.activeCreators}
            </button>
          </div>
        </div>
        <div className={cx('tableWrap')}>
          <table className={cx('table')}>
            <thead>
              <tr>
                <th>{t('创作者', 'Creator')}</th>
                <th className={cx('num')}>{t('曝光量', 'Impressions')}</th>
                <th className={cx('num')}>{t('点击量', 'Clicks')}</th>
                <th className={cx('num')}>{t('播放量', 'Views')}</th>
                <th className={cx('num')}>{t('安装量', 'Installs')}</th>
                <th className={cx('num')}>{t('消耗', 'Spend')}</th>
                <th className={cx('num')}>{t('收入', 'Revenue')}</th>
                <th className={cx('num')}>ROAS</th>
                <th className={cx('num')}>{t('广告组', 'Ad Sets')}</th>
                <th>{t('产品', 'Products')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c, i) => (
                <CreatorRow key={c.creator} rank={i + 1} c={c} maxSpend={maxSpend} />
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <div className={cx('empty')}>{t('当前筛选下没有创作者', 'No creators match')}</div>
        )}
      </div>

      <div className={cx('card')}>
        <div className={cx('cardHead')}>
          <div className={cx('cardTitle')}>{t('已授权创作者池', 'Approved Creator Pool')}</div>
          <span className={cx('cardTag')}>
            {t(
              `共 ${String(data.pool.length)} 位已通过品牌合作授权 · ${String(notInvested.length)} 位尚未投放`,
              `${String(data.pool.length)} branded-content approved · ${String(notInvested.length)} not yet live`,
            )}
          </span>
        </div>
        <div className={cx('grid', 'creatorGrid')}>
          {data.pool.map((p) => (
            <div key={`${p.brand}-${p.creator}`} className={cx('creatorCard')}>
              <div className={cx('creatorTop')}>
                <Avatar name={p.creator} cls={cx('avatar')} />
                <div style={{ minWidth: 0 }}>
                  <div className={cx('creatorName')}>{p.creator}</div>
                  <div className={cx('creatorHandle')}>{p.brand}</div>
                </div>
              </div>
              <div className={cx('creatorFoot')}>
                <span className={cx('badge', p.invested ? 'bLive' : 'bDraft')}>
                  {p.invested ? t('投放中', 'Live') : t('待启用', 'Idle')}
                </span>
                <span className={cx('rate')}>
                  <span className={cx('rateLbl')}>{t('消耗', 'Spend')}</span>
                  {fmtUSD(p.spend)}
                </span>
              </div>
            </div>
          ))}
        </div>
        {data.pool.length === 0 && (
          <div className={cx('empty')}>
            {t('暂未取到授权创作者名单', 'Approved creator list unavailable')}
          </div>
        )}
      </div>
    </>
  );
}

function CreatorRow({
  rank,
  c,
  maxSpend,
}: {
  rank: number;
  c: DemoCreatorStat;
  maxSpend: number;
}): React.ReactElement {
  const t = useT();
  return (
    <tr>
      <td>
        <div className={cx('cellCreator')}>
          <span className={cx('rankNo')}>{rank}</span>
          <Avatar name={c.creator} cls={cx('avatarSm')} />
          <div style={{ minWidth: 0 }}>
            <div className={cx('creatorName')}>{c.creator}</div>
            <Bar ratio={c.spend / maxSpend} color="#22d3ee" />
          </div>
          {c.approved ? (
            <span className={cx('badge', 'bLive')}>{t('已授权', 'Approved')}</span>
          ) : (
            // 2026-08-11 之前的老命名，广告组名不是创作者 IG 号（如「SS VO」「素人2 AEO」）。
            // 数据真实、有消耗有收入，剔掉会让明细对不上汇总，所以保留但明确标出来，
            // 免得客户把内部代号当成某位创作者。
            <span className={cx('badge', 'bDraft')}>{t('历史组', 'Legacy')}</span>
          )}
        </div>
      </td>
      <td className={cx('num', 'mono')}>{fmtCompact(c.impressions)}</td>
      <td className={cx('num', 'mono')}>{fmtCompact(c.clicks)}</td>
      <td className={cx('num', 'mono')}>{fmtCompact(c.videoViews)}</td>
      <td className={cx('num', 'mono')}>{fmtInt(c.installs)}</td>
      <td className={cx('num', 'mono')}>{fmtUSD(c.spend)}</td>
      <td className={cx('num', 'mono')}>{fmtUSD(c.revenue)}</td>
      <td className={cx('num', 'mono')}>{c.spend > 0 ? fmtRatio(c.revenue / c.spend) : '-'}</td>
      <td className={cx('num', 'mono')}>
        {c.activeAdsets}/{c.adsets}
      </td>
      <td>
        <span className={cx('tags')}>
          {c.products.map((p) => (
            <span key={p} className={cx('chip')}>
              {p}
            </span>
          ))}
        </span>
      </td>
    </tr>
  );
}

// ───────────────────────────── 视图：产品 × 档位 ─────────────────────────────

/** 门户口径只分两档：AEO=应用事件优化，VO=价值优化（含历史 VO_1/VO_2/VO_Post 全部并入）。 */
function slotLabel(slot: string, t: (zh: string, en: string) => string): string {
  if (slot === 'AEO') return t('AEO · 事件优化', 'AEO · App Events');
  if (slot === 'VO') return t('VO · 价值优化', 'VO · Value');
  return t('其他', 'Other');
}

function ProductsView({ data }: { data: OverviewResponse }): React.ReactElement {
  const t = useT();
  const cellOf = useMemo(() => {
    const map = new Map<string, DemoProductSlotCell>();
    for (const c of data.productSlots) map.set(`${c.product}__${c.slot}`, c);
    return map;
  }, [data.productSlots]);

  const maxCellSpend = Math.max(1, ...data.productSlots.map((c) => c.spend));
  const [selected, setSelected] = useState<string | null>(null);
  const campaignRows = useMemo(
    () =>
      selected === null ? data.campaigns : data.campaigns.filter((c) => c.product === selected),
    [data.campaigns, selected],
  );

  return (
    <>
      <div className={cx('card')}>
        <div className={cx('cardHead')}>
          <div className={cx('cardTitle')}>{t('产品 × 投放档位', 'Product × Slot')}</div>
          <span className={cx('cardTag')}>
            {t(
              `${String(data.products.length)} 个产品 · ${String(data.summary.campaigns)} 条推广系列`,
              `${String(data.products.length)} products · ${String(data.summary.campaigns)} campaigns`,
            )}
          </span>
        </div>
        <div className={cx('tableWrap')}>
          <table className={cx('table', 'matrix')}>
            <thead>
              <tr>
                <th>{t('产品', 'Product')}</th>
                {data.slots.map((s) => (
                  <th key={s} className={cx('num')}>
                    {slotLabel(s, t)}
                  </th>
                ))}
                <th className={cx('num')}>{t('曝光量', 'Impressions')}</th>
                <th className={cx('num')}>{t('点击量', 'Clicks')}</th>
                <th className={cx('num')}>{t('安装量', 'Installs')}</th>
                <th className={cx('num')}>{t('合计消耗', 'Total Spend')}</th>
                <th className={cx('num')}>{t('合计收入', 'Total Revenue')}</th>
                <th className={cx('num')}>ROAS</th>
              </tr>
            </thead>
            <tbody>
              {data.products.map((product) => {
                const cells = data.slots.map((s) => cellOf.get(`${product}__${s}`));
                const spend = cells.reduce((sum, c) => sum + (c?.spend ?? 0), 0);
                const revenue = cells.reduce((sum, c) => sum + (c?.revenue ?? 0), 0);
                const impressions = cells.reduce((sum, c) => sum + (c?.impressions ?? 0), 0);
                const clicks = cells.reduce((sum, c) => sum + (c?.clicks ?? 0), 0);
                const installs = cells.reduce((sum, c) => sum + (c?.installs ?? 0), 0);
                const roas = spend > 0 ? revenue / spend : null;
                return (
                  <tr
                    key={product}
                    className={cx(selected === product && 'rowOn')}
                    onClick={() => {
                      setSelected(selected === product ? null : product);
                    }}
                  >
                    <td>
                      <span className={cx('prodName')}>{product}</span>
                    </td>
                    {cells.map((c, i) => (
                      <td key={data.slots[i] ?? String(i)} className={cx('num')}>
                        {c === undefined ? (
                          <span className={cx('muted')}>—</span>
                        ) : (
                          <div className={cx('matrixCell')}>
                            <span className={cx('mono')}>{fmtUSD(c.spend)}</span>
                            <span className={cx('cellSub')}>
                              {t(
                                `${String(c.creators)} 位创作者 · ${fmtCompact(c.impressions)} 曝光`,
                                `${String(c.creators)} creators · ${fmtCompact(c.impressions)} impr.`,
                              )}
                            </span>
                            <Bar ratio={c.spend / maxCellSpend} color="#a855f7" />
                          </div>
                        )}
                      </td>
                    ))}
                    <td className={cx('num', 'mono')}>{fmtCompact(impressions)}</td>
                    <td className={cx('num', 'mono')}>{fmtCompact(clicks)}</td>
                    <td className={cx('num', 'mono')}>{fmtInt(installs)}</td>
                    <td className={cx('num', 'mono')}>{fmtUSD(spend)}</td>
                    <td className={cx('num', 'mono')}>{fmtUSD(revenue)}</td>
                    <td
                      className={cx('num', 'mono')}
                      style={{ color: roas !== null && roas >= 1 ? 'var(--green)' : undefined }}
                    >
                      {fmtRatio(roas)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className={cx('hint')}>
          {t(
            '点击产品行可筛选下方推广系列；再次点击取消筛选。',
            'Click a product row to filter campaigns below; click again to clear.',
          )}
        </div>
      </div>

      <div className={cx('card')}>
        <div className={cx('cardHead')}>
          <div className={cx('cardTitle')}>{t('推广系列明细', 'Campaign Detail')}</div>
          <span className={cx('cardTag')}>
            {selected === null
              ? t('全部产品', 'All products')
              : `${t('已筛选', 'Filtered')}：${selected}`}{' '}
            · {campaignRows.length}
          </span>
        </div>
        <div className={cx('tableWrap')}>
          <table className={cx('table')}>
            <thead>
              <tr>
                <th>{t('推广系列', 'Campaign')}</th>
                <th>{t('状态', 'Status')}</th>
                <th className={cx('num')}>{t('曝光量', 'Impressions')}</th>
                <th className={cx('num')}>{t('点击量', 'Clicks')}</th>
                <th className={cx('num')}>{t('安装量', 'Installs')}</th>
                <th className={cx('num')}>{t('消耗', 'Spend')}</th>
                <th className={cx('num')}>{t('收入', 'Revenue')}</th>
                <th className={cx('num')}>ROAS</th>
                <th className={cx('num')}>{t('创作者', 'Creators')}</th>
              </tr>
            </thead>
            <tbody>
              {campaignRows.map((c) => (
                <CampaignRow key={c.campaign} c={c} />
              ))}
            </tbody>
          </table>
        </div>
        {campaignRows.length === 0 && (
          <div className={cx('empty')}>{t('没有匹配的推广系列', 'No campaigns match')}</div>
        )}
      </div>
    </>
  );
}

function CampaignRow({ c }: { c: DemoCampaignStat }): React.ReactElement {
  const t = useT();
  const live = c.status === 'ACTIVE';
  return (
    <tr>
      <td>
        <div className={cx('campName')}>{c.campaign}</div>
        <div className={cx('cellSub')}>
          {c.product} · {slotLabel(c.slot, t)} ·{' '}
          {t(`${String(c.adsets)} 个广告组`, `${String(c.adsets)} ad sets`)}
        </div>
      </td>
      <td>
        <span className={cx('badge', live ? 'bLive' : 'bEnded')}>
          {live ? t('投放中', 'Live') : t('已暂停', 'Paused')}
        </span>
      </td>
      <td className={cx('num', 'mono')}>{fmtCompact(c.impressions)}</td>
      <td className={cx('num', 'mono')}>{fmtCompact(c.clicks)}</td>
      <td className={cx('num', 'mono')}>{fmtInt(c.installs)}</td>
      <td className={cx('num', 'mono')}>{fmtUSD(c.spend)}</td>
      <td className={cx('num', 'mono')}>{fmtUSD(c.revenue)}</td>
      <td className={cx('num', 'mono')}>{c.spend > 0 ? fmtRatio(c.revenue / c.spend) : '-'}</td>
      <td className={cx('num', 'mono')}>{c.creators}</td>
    </tr>
  );
}

// ───────────────────────────── 视图：素材 ─────────────────────────────

/** 素材表一次最多渲染这么多行：全量有上千条，铺开会把页面拖慢，也没人看得完。 */
const MATERIAL_LIMIT = 60;

function MaterialsView({ data }: { data: OverviewResponse }): React.ReactElement {
  const t = useT();
  const [keyword, setKeyword] = useState('');
  const rows = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const filtered =
      kw === ''
        ? data.materials
        : data.materials.filter(
            (m) =>
              m.ad.toLowerCase().includes(kw) ||
              m.creator.toLowerCase().includes(kw) ||
              m.product.toLowerCase().includes(kw),
          );
    return filtered.slice(0, MATERIAL_LIMIT);
  }, [data.materials, keyword]);

  const maxSpend = Math.max(1, ...rows.map((m) => m.spend));

  return (
    <div className={cx('card')}>
      <div className={cx('cardHead')}>
        <div className={cx('cardTitle')}>{t('素材表现', 'Creative Performance')}</div>
        <div className={cx('toolbar')}>
          <input
            className={cx('input', 'inputSm')}
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
            }}
            placeholder={t('搜索素材 / 创作者 / 产品', 'Search creative / creator / product')}
          />
          <span className={cx('cardTag')}>
            {t(
              `共 ${String(data.materials.length)} 条，显示前 ${String(rows.length)}`,
              `${String(data.materials.length)} total, showing ${String(rows.length)}`,
            )}
          </span>
        </div>
      </div>
      <div className={cx('tableWrap')}>
        <table className={cx('table')}>
          <thead>
            <tr>
              <th>{t('素材', 'Creative')}</th>
              <th>{t('创作者', 'Creator')}</th>
              <th>{t('产品', 'Product')}</th>
              <th className={cx('num')}>{t('曝光量', 'Impressions')}</th>
              <th className={cx('num')}>{t('点击量', 'Clicks')}</th>
              <th className={cx('num')}>{t('播放量', 'Views')}</th>
              <th className={cx('num')}>{t('点击率', 'CTR')}</th>
              <th className={cx('num')}>{t('消耗', 'Spend')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <MaterialRow key={`${m.campaign}-${m.adset}-${m.ad}`} m={m} maxSpend={maxSpend} />
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <div className={cx('empty')}>{t('没有匹配的素材', 'No creatives match')}</div>
      )}
      <div className={cx('hint')}>
        {t(
          '素材维度只有投放侧指标：收入回传能归到创作者（广告组），但归不到具体某条素材，故此表不列收入。',
          'Creative-level rows show delivery metrics only: revenue postbacks resolve to a creator (ad set) but not to an individual creative.',
        )}
      </div>
    </div>
  );
}

function MaterialRow({
  m,
  maxSpend,
}: {
  m: DemoMaterialStat;
  maxSpend: number;
}): React.ReactElement {
  return (
    <tr>
      <td>
        <div className={cx('campName')}>{m.ad}</div>
        <Bar ratio={m.spend / maxSpend} color="#34d399" />
      </td>
      <td>
        <div className={cx('cellCreator')}>
          <Avatar name={m.creator} cls={cx('avatarSm')} />
          <span>{m.creator}</span>
        </div>
      </td>
      <td>
        <span className={cx('chip')}>{m.product}</span>
      </td>
      <td className={cx('num', 'mono')}>{fmtCompact(m.impressions)}</td>
      <td className={cx('num', 'mono')}>{fmtCompact(m.clicks)}</td>
      <td className={cx('num', 'mono')}>{fmtCompact(m.videoViews)}</td>
      <td className={cx('num', 'mono')}>
        {m.impressions > 0 ? fmtPct(m.clicks / m.impressions) : '-'}
      </td>
      <td className={cx('num', 'mono')}>{fmtUSD(m.spend)}</td>
    </tr>
  );
}

// ───────────────────────────── 视图：账户设置 ─────────────────────────────

function fileToSquareDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('error', () => {
      reject(new Error('read failed'));
    });
    reader.addEventListener('load', () => {
      const img = new Image();
      img.addEventListener('error', () => {
        reject(new Error('bad image'));
      });
      img.addEventListener('load', () => {
        const size = 128;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('no canvas'));
          return;
        }
        const min = Math.min(img.width, img.height);
        const dx = (img.width - min) / 2;
        const dy = (img.height - min) / 2;
        ctx.drawImage(img, dx, dy, min, min, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      });
      img.src = typeof reader.result === 'string' ? reader.result : '';
    });
    reader.readAsDataURL(file);
  });
}

function SettingsView({
  profile,
  username,
  onUpdateProfile,
}: {
  profile: Profile;
  username: string;
  onUpdateProfile: (p: Profile) => void;
}): React.ReactElement {
  const t = useT();
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [avatar, setAvatar] = useState<UserAvatar>(profile.avatar);
  const [letters, setLetters] = useState(profile.avatar.letters);
  const [savedMsg, setSavedMsg] = useState('');

  function pickGradient(gradient: readonly [string, string]): void {
    setAvatar({ kind: 'gradient', letters: letters || initials(displayName) || 'U', gradient });
  }

  function onLettersChange(value: string): void {
    const up = value.slice(0, 2).toUpperCase();
    setLetters(up);
    if (avatar.kind === 'gradient') setAvatar({ ...avatar, letters: up || 'U' });
  }

  function onUpload(file: File | undefined): void {
    if (!file) return;
    void fileToSquareDataUrl(file)
      .then((image) => {
        setAvatar({ kind: 'image', letters, gradient: avatar.gradient, image });
      })
      .catch(() => {
        /* 忽略：非图片/读取失败 */
      });
  }

  function saveProfileEdits(): void {
    onUpdateProfile({
      ...profile,
      displayName: displayName.trim() || profile.displayName,
      avatar,
    });
    setSavedMsg(t('已保存', 'Saved'));
  }

  return (
    <div className={cx('settings')}>
      {/* 偏好：语言 + 主题 */}
      <div className={cx('settingGroup')}>
        <div className={cx('groupTitle')}>{t('偏好', 'Preferences')}</div>
        <div className={cx('settingRow')}>
          <div className={cx('settingMain')}>
            <div className={cx('settingName')}>{t('语言', 'Language')}</div>
            <div className={cx('settingDesc')}>{t('界面显示语言', 'Interface language')}</div>
          </div>
          <Seg<Lang>
            value={profile.lang}
            options={[
              { v: 'zh', label: '中文' },
              { v: 'en', label: 'English' },
            ]}
            onChange={(lang) => {
              onUpdateProfile({ ...profile, lang });
            }}
          />
        </div>
        <div className={cx('settingRow')}>
          <div className={cx('settingMain')}>
            <div className={cx('settingName')}>{t('外观', 'Appearance')}</div>
            <div className={cx('settingDesc')}>{t('深色 / 浅色模式', 'Dark / light mode')}</div>
          </div>
          <Seg<Theme>
            value={profile.theme}
            options={[
              { v: 'dark', label: t('深色', 'Dark') },
              { v: 'light', label: t('浅色', 'Light') },
            ]}
            onChange={(theme) => {
              onUpdateProfile({ ...profile, theme });
            }}
          />
        </div>
      </div>

      {/* 资料：展示名 + 头像 */}
      <div className={cx('settingGroup')}>
        <div className={cx('groupTitle')}>{t('个人资料', 'Profile')}</div>
        <div className={cx('settingRow')}>
          <div className={cx('settingMain')}>
            <div className={cx('settingName')}>{t('展示用户名', 'Display Name')}</div>
            <div className={cx('settingDesc')}>
              {t('展示在门户里的名称（非登录用户名）', 'Shown in the portal (not your login name)')}
            </div>
          </div>
          <input
            className={cx('input')}
            style={{ maxWidth: '220px' }}
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
            }}
          />
        </div>

        <div className={cx('settingRow')} style={{ display: 'block' }}>
          <div className={cx('settingName')} style={{ marginBottom: '12px' }}>
            {t('头像', 'Avatar')}
          </div>
          <div className={cx('avatarEditRow')}>
            <UserAvatarView avatar={avatar} cls={cx('avatarBig')} />
            <div className={cx('avatarControls')}>
              <div>
                <div className={cx('miniLabel')}>{t('渐变色', 'Gradient')}</div>
                <div className={cx('gradientGrid')}>
                  {AVATAR_GRADIENTS.map((g) => (
                    <button
                      key={`${g[0]}${g[1]}`}
                      type="button"
                      className={cx(
                        'gradientOpt',
                        avatar.kind === 'gradient' &&
                          avatar.gradient[0] === g[0] &&
                          avatar.gradient[1] === g[1] &&
                          'gradientOptOn',
                      )}
                      style={{ background: `linear-gradient(135deg, ${g[0]}, ${g[1]})` }}
                      onClick={() => {
                        pickGradient(g);
                      }}
                      aria-label={t('选择渐变', 'Choose gradient')}
                    />
                  ))}
                </div>
              </div>
              <div
                style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-end' }}
              >
                <div>
                  <div className={cx('miniLabel')}>{t('字母', 'Letters')}</div>
                  <input
                    className={cx('input', 'lettersInput')}
                    value={letters}
                    maxLength={2}
                    onChange={(e) => {
                      onLettersChange(e.target.value);
                    }}
                  />
                </div>
                <div>
                  <div className={cx('miniLabel')}>
                    {t('或上传 1:1 图片', 'Or upload 1:1 image')}
                  </div>
                  <label className={cx('uploadBtn')}>
                    {t('上传图片', 'Upload')}
                    <input
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        onUpload(e.target.files?.[0]);
                      }}
                    />
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className={cx('settingRow')} style={{ display: 'block' }}>
          <div className={cx('saveRow')}>
            <button
              type="button"
              className={cx('btnSm')}
              onClick={() => {
                saveProfileEdits();
              }}
            >
              {t('保存资料', 'Save Profile')}
            </button>
            {savedMsg !== '' && <span className={cx('savedMsg')}>✓ {savedMsg}</span>}
          </div>
        </div>
      </div>

      {/* 安全：口令已移到服务端，前端改不了——这里只能如实说明，不放假的改密码表单 */}
      <div className={cx('settingGroup')}>
        <div className={cx('groupTitle')}>{t('安全', 'Security')}</div>
        <div className={cx('settingRow')}>
          <div className={cx('settingMain')}>
            <div className={cx('settingName')}>{t('登录账号', 'Login Account')}</div>
            <div className={cx('settingDesc')}>
              {t(
                `当前登录名 ${username}。门户挂的是真实经营数据，登录凭据已改为服务端校验、不再存放于浏览器，因此无法在此自助修改；如需更换请联系管理员。`,
                `Signed in as ${username}. This portal serves live business data, so credentials are verified server-side and no longer kept in the browser — contact your administrator to change them.`,
              )}
            </div>
          </div>
          <span className={cx('badge', 'bLive')}>{t('服务端校验', 'Server-side')}</span>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── 外壳 ─────────────────────────────

type View = 'dashboard' | 'creators' | 'products' | 'materials' | 'settings';

const NAV: readonly { key: View; icon: string }[] = [
  { key: 'dashboard', icon: 'dashboard' },
  { key: 'creators', icon: 'creators' },
  { key: 'products', icon: 'products' },
  { key: 'materials', icon: 'materials' },
];

/** 顶栏日期区间筛选：自由选择起止日期。改动即全局重新聚合。 */
function DateFilter({
  range,
  onChange,
}: {
  range: DateRange;
  onChange: (r: DateRange) => void;
}): React.ReactElement {
  const t = useT();
  const today = todayStr();
  const isValidDate = (value: string): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return false;
    const [year, month, day] = value.split('-').map(Number);
    return (
      date.getFullYear() === year && date.getMonth() === (month ?? 0) - 1 && date.getDate() === day
    );
  };
  return (
    <div className={cx('dateFilter')}>
      <input
        type="date"
        className={cx('dateInput')}
        value={range.start}
        max={today}
        onChange={(e) => {
          const start = e.target.value;
          if (isValidDate(start)) {
            const safeStart = start > today ? today : start;
            const safeEnd = range.end > today ? today : range.end;
            onChange({ start: safeStart, end: safeStart > safeEnd ? safeStart : safeEnd });
          }
        }}
        onBlur={(e) => {
          if (!isValidDate(e.currentTarget.value)) e.currentTarget.value = range.start;
        }}
        aria-label={t('起始日期', 'Start date')}
      />
      <span className={cx('dateArrow')} aria-hidden="true">
        →
      </span>
      <input
        type="date"
        className={cx('dateInput')}
        value={range.end}
        max={today}
        onChange={(e) => {
          const end = e.target.value;
          if (isValidDate(end)) {
            const safeEnd = end > today ? today : end;
            const safeStart = range.start > today ? today : range.start;
            onChange({ start: safeEnd < safeStart ? safeEnd : safeStart, end: safeEnd });
          }
        }}
        onBlur={(e) => {
          if (!isValidDate(e.currentTarget.value)) e.currentTarget.value = range.end;
        }}
        aria-label={t('结束日期', 'End date')}
      />
    </div>
  );
}

function Shell({
  user,
  profile,
  onUpdateProfile,
  onLogout,
}: {
  user: PortalUser;
  profile: Profile;
  onUpdateProfile: (p: Profile) => void;
  onLogout: () => void;
}): React.ReactElement {
  const t = useT();
  const [view, setView] = useState<View>('dashboard');
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [clock, setClock] = useState('');
  // 全局日期区间：默认近 14 天，改动后所有看板一起按新区间重新聚合。
  const [range, setRange] = useState<DateRange>(() => lastNDays(14));

  const load = useCallback(async (r: DateRange, force = false): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      setData(await apiOverview(force, r));
    } catch (error_) {
      setError((error_ as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [load, range]);

  useEffect(() => {
    const tick = (): void => {
      const d = new Date();
      setClock(`${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`);
    };
    tick();
    const id = globalThis.setInterval(tick, 1000);
    return () => {
      globalThis.clearInterval(id);
    };
  }, []);

  const navLabel = (key: View): string => {
    if (key === 'dashboard') return t('数据看板', 'Dashboard');
    if (key === 'creators') return t('创作者', 'Creators');
    if (key === 'products') return t('产品与档位', 'Products');
    if (key === 'materials') return t('素材表现', 'Creatives');
    return t('账户设置', 'Settings');
  };
  const meta: Record<View, { title: string; sub: string }> = {
    dashboard: { title: t('数据看板', 'Dashboard'), sub: 'GROWTH OVERVIEW' },
    creators: { title: t('创作者', 'Creators'), sub: 'CREATOR PERFORMANCE' },
    products: { title: t('产品与档位', 'Products'), sub: 'PRODUCT × SLOT MATRIX' },
    materials: { title: t('素材表现', 'Creatives'), sub: 'CREATIVE PERFORMANCE' },
    settings: { title: t('账户设置', 'Account Settings'), sub: 'ACCOUNT SETTINGS' },
  };
  const cur = meta[view];

  return (
    <div className={cx('shell')}>
      <aside className={cx('sidebar')}>
        <div className={cx('sideBrand')}>
          <Brand />
        </div>
        {NAV.map((n) => (
          <button
            key={n.key}
            type="button"
            className={cx('navItem', view === n.key && 'navItemActive')}
            onClick={() => {
              setView(n.key);
            }}
          >
            <NavIcon name={n.icon} />
            {navLabel(n.key)}
          </button>
        ))}
        <div className={cx('navSpacer')} />
        <button
          type="button"
          className={cx('userChip', view === 'settings' && 'userChipActive')}
          onClick={() => {
            setView('settings');
          }}
        >
          <UserAvatarView avatar={profile.avatar} cls={cx('userAvatar')} />
          <div style={{ minWidth: 0 }}>
            <div className={cx('userName')}>{profile.displayName}</div>
            <div className={cx('userCompany')}>@{user.username}</div>
          </div>
        </button>
        <button
          type="button"
          className={cx('navItem')}
          onClick={onLogout}
          style={{ marginTop: '4px' }}
        >
          {t('退出登录', 'Log out')}
        </button>
      </aside>

      <div className={cx('main')}>
        <header className={cx('topbar')}>
          <div>
            <div className={cx('pageTitle')}>{cur.title}</div>
            <div className={cx('pageSub')}>{cur.sub}</div>
          </div>
          <div className={cx('topRight')}>
            {view !== 'settings' && (
              <DateFilter
                range={range}
                onChange={(r) => {
                  setRange(r);
                }}
              />
            )}
            {data !== null && (
              <span className={cx('cardTag')}>
                {t('数据更新于', 'Updated')} {fmtTime(data.cachedAt)}
              </span>
            )}
            <button
              type="button"
              className={cx('btnGhost', 'btnSm')}
              onClick={() => {
                void load(range, true);
              }}
              disabled={loading}
            >
              {loading ? t('刷新中…', 'Refreshing…') : t('立即刷新', 'Refresh')}
            </button>
            <span className={cx('statusPill')}>
              <span className={cx('dot')} /> system online
            </span>
            <span className={cx('clock')}>{clock}</span>
          </div>
        </header>

        <main className={cx('content')}>
          {view === 'settings' ? (
            <SettingsView
              profile={profile}
              username={user.username}
              onUpdateProfile={onUpdateProfile}
            />
          ) : (
            <>
              {error !== '' && <div className={cx('authError')}>{error}</div>}
              {data === null && loading && (
                <div className={cx('empty')}>
                  {t('正在加载真实投放数据…', 'Loading live campaign data…')}
                </div>
              )}
              {data !== null && (
                <>
                  {data.warnings.length > 0 && (
                    <div className={cx('warnBar')}>
                      {data.warnings.map((w) => (
                        <div key={w}>⚠ {w}</div>
                      ))}
                    </div>
                  )}
                  {view === 'dashboard' && <DashboardView data={data} />}
                  {view === 'creators' && <CreatorsView data={data} />}
                  {view === 'products' && <ProductsView data={data} />}
                  {view === 'materials' && <MaterialsView data={data} />}
                  <div className={cx('footNote')}>
                    {t(
                      `数据口径：消耗 / 曝光 / 点击 / 播放 / 安装来自 Facebook 官方广告接口；收入以归因回传为基础，经每日修正系数与长周期口径系数建模估算（回传受 SKAN/S2S 限制系统性低报，故非当期实收金额）。均为 ${data.range.start} 至 ${data.range.end} 的投放数据，每小时更新。eLTV ROAS 为按长周期口径折算的回报预测（在建模新用户收入的 D180 模型值基础上乘以 ${String(data.eltvDisplayFactor)} 的长周期系数），非当期实收。`,
                      `Methodology: spend / impressions / clicks / views / installs come from the official Facebook Ads API; revenue is modeled from attribution postbacks using daily correction and long-horizon factors (postbacks systematically under-report due to SKAN/S2S limits, so figures are modeled rather than realized cash). All figures cover ${data.range.start} to ${data.range.end} and refresh hourly. eLTV ROAS is a long-horizon projection (the D180 model value on modeled new-user revenue multiplied by a ${String(data.eltvDisplayFactor)} long-term factor), not realized revenue.`,
                    )}
                    {data.unattributedRevenue > 0 &&
                      t(
                        ` 另有 ${fmtUSD(data.unattributedRevenue)} 收入因 iOS 隐私归因限制无法定位到具体创作者，已计入总收入但未摊入创作者明细。`,
                        ` An additional ${fmtUSD(data.unattributedRevenue)} in revenue cannot be traced to a specific creator due to iOS privacy attribution limits; it is included in totals but not allocated in the per-creator breakdown.`,
                      )}
                  </div>
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// ───────────────────────────── 根组件 ─────────────────────────────

export function SitinPortal(): React.ReactElement {
  const [user, setUser] = useState<PortalUser | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void apiSession().then((u) => {
      setUser(u);
      if (u) setProfile(loadProfile(u.username, u.company));
      setReady(true);
    });
  }, []);

  function handleAuth(u: PortalUser): void {
    setUser(u);
    setProfile(loadProfile(u.username, u.company));
  }

  function updateProfile(p: Profile): void {
    if (!user) return;
    setProfile(p);
    saveProfile(user.username, p);
  }

  function logout(): void {
    void apiLogout().then(() => {
      setUser(null);
      setProfile(null);
    });
  }

  const lang: Lang = profile?.lang ?? 'zh';
  const theme: Theme = profile?.theme ?? 'dark';

  if (!ready) return <div className={cx('root')} />;

  return (
    <LangContext.Provider value={lang}>
      <div className={cx('root', theme === 'light' && 'light')}>
        {user && profile ? (
          <Shell user={user} profile={profile} onUpdateProfile={updateProfile} onLogout={logout} />
        ) : (
          <AuthScreen onAuth={handleAuth} />
        )}
      </div>
    </LangContext.Provider>
  );
}
