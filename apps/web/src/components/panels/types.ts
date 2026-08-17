export interface PanelProps {
  startDate: string;
  endDate: string;
  /** 供面板回报「最后更新」文案给顶栏。 */
  onLastUpdate: (text: string) => void;
}
