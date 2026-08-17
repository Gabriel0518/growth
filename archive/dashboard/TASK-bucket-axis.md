# 任务：收入来源图横轴改为分段聚合 + install窗口扩展到99天+更早桶

## 背景
当前收入来源图的横轴是逐日 install 日期(days=99,99个点),折线太密且信息过载。屹恒要求改成**分段聚合**展示。

## 横轴分段定义（11个桶）

| 序号 | 横轴标签 | install 范围（D=查询日） |
|------|---------|------|
| 1 | 当天 | D |
| 2 | D-1~D-3 | 过去3天 |
| 3 | D-4~D-7 | 4-7天前 |
| 4 | D-8~D-14 | 8-14天前 |
| 5 | D-15~D-28 | 15-28天前 |
| 6 | D-29~D-42 | 29-42天前 |
| 7 | D-43~D-56 | 43-56天前 |
| 8 | D-57~D-70 | 57-70天前 |
| 9 | D-71~D-84 | 71-84天前 |
| 10 | D-85~D-98 | 85-98天前 |
| 11 | 更早 | install < D-98 |

## 后端改动（/api/revenue-by-install handler）

1. **days 默认值改为 99**（已改好 ✅）
2. **增加「更早」桶**：install_time 落在 axis 窗口之前的付费也计入，不再丢弃。在 `byDay` 之外加一个 `earlierRev` 变量，当 `day != null && day not in byDay && day < axis[0]` 时累加到 `earlierRev`。
3. **返回数据**：series 仍然是逐日数据（保持API通用性），但在响应里额外加一个 `earlierRevenue` 字段（数值,修正后的更早桶收入）。前端据此构造第11个桶。

```js
// 在 byDay 定义后加:
let earlierRevenue = 0;  // install 早于 axis 窗口的修正收入

// 在 AF/AD 累加处，把原来的:
if (day != null && day in byDay) byDay[day] += ...
// 改为:
if (day != null) {
  if (day in byDay) byDay[day] += ...;
  else if (day < axis[0]) earlierRevenue += ...;
}
```

4. 响应 JSON 加 `"earlierRevenue": Math.round(earlierRevenue * 100) / 100`

## 前端改动（app.js 的 renderRbiChart 函数）

1. **分段聚合**：把后端返回的逐日 `series` + `earlierRevenue` 按上面的11个桶定义聚合成新的数据点。
2. **横轴标签**：用上面表格的标签（"当天"、"过去3天"、"4-7天前"等），不再用日期。
3. **折线图配置**：
   - X 轴 = 11 个桶标签（从左"更早"到右"当天"，**左远右近**，与原逻辑一致：左边=老用户，右边=新用户）
   - Y 轴 = 各桶修正收入总和
   - Chart.js line 类型，与现有样式保持一致
4. **区间总金额**：所有桶求和（含更早桶），显示在弹层里。
5. **副标题**：改为 `${date} 当日修正付费 × 按安装时段`

## 注意
- 不要动后端的 event_time=当天筛选逻辑、修正系数、Romi iOS 全量口径——这些已经改对了
- 不要重启服务、不要 commit
- 改完 node --check 两个文件
