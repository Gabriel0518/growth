'use client';

import { MaterialPanel } from './material-panel';

import { CREATIVE_PRODUCTS } from '@/lib/client/aigc';

/** 素材面板 creative：自带时间窗/修正开关，产品集含 Dora（老命名素材）。 */
export function CreativePanel(): React.ReactElement {
  return (
    <MaterialPanel
      apiPath="/api/creative/data"
      products={CREATIVE_PRODUCTS}
      rankPrefix="素材排名"
      statusLabel="素材数据"
      csvSuffix="素材"
    />
  );
}
