/**
 * Partnership ADS 基础组件层。
 *
 * 设计源：Figma 文件 OqpGtNg1QQgihDHd2YvZ2S，页面 `Agentic UG · Design System`，
 * 组件区在 x=6000 y=4200。颜色一律走 globals.css 里的 pa- 令牌，不写裸值
 * （品牌 logo 色是唯一例外，见 platform-icon.tsx）。
 *
 * 本层刻意**不含** Dialog / Drawer / Toast / DataTable —— 那几个是「模式」不是
 * 基础组件，且强依赖尚未确定的路由与状态方案，等产品页面落地时一起定。
 */
export { Avatar, type AvatarSize } from './avatar';
export { BrandLockup, BrandMark } from './brand-mark';
export { Button, buttonClasses, type ButtonSize, type ButtonVariant } from './button';
export { Checkbox } from './checkbox';
export { cn } from './cn';
export { DataTrust, type TrustState } from './data-trust';
export { Dropdown, type DropdownOption } from './dropdown';
export { MetricCard } from './metric-card';
export { PlatformIcon, type Platform } from './platform-icon';
export { Radio } from './radio';
export { SearchField } from './search-field';
export { Segment, type SegmentItem } from './segment';
export { STATUS_TONE, StatusPill, type PillTone } from './status-pill';
export { Tabs, type TabItem } from './tab';
export { type NavIcon, type NavItem, Sidebar } from './sidebar';
