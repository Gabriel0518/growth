# BUG修复：收入来源图修正收入与面板不匹配

## 现状
- 用户在个人面板看投手「苏屹恒(syh)」的**修正总收入** ≈ $10,639
- 但收入来源图(operator=syh, days=60)显示的区间总修正收入 ≈ $7,862
- 面板原始总收入 $7,879,图表修正后 $7,887 → 修正系数几乎都是 1,没有真正起作用
- 期望:图表的修正收入应该与面板的修正总收入一致

## 根因推测
`/api/revenue-by-install` 里调用 `computeCorrectionFactorsSync(date, db)` 获取修正系数。
但今天(6/26)的雅典娜数据可能不完整,导致该函数对部分产品返回系数=1(fallback)。
而个人面板(`/api/postback/personal`)的修正收入计算走的是**另一条路径**:
- 用 `getCorrectionFactorForDay()` → 内部有 `correctionFactorsCache` 和 `computeCorrectionForProduct()`
- 可能用了不同日期的系数(昨天而非今天),或者有缓存预热

## 需要做的
1. **诊断**:对比 `computeCorrectionFactorsSync('2026-06-26', db)` 返回的系数 vs 个人面板实际用的系数。找出哪个产品的系数不一致。
2. **修复**:让 revenue-by-install 使用**与个人面板完全一致的修正系数来源**。最简单的做法:复用个人面板已有的修正系数计算逻辑(如 `getCorrectionFactorForDay` 或 `/api/correction-factors` 的返回),而不是自己单独调 `computeCorrectionFactorsSync`。
3. **验证**:修完后,operator=syh 的图表修正总收入应该与面板修正总收入 ≈ 一致(允许小数点差异)。

## 关键代码位置
- `computeCorrectionFactorsSync()` 约 455 行 —— 当前 revenue-by-install 调用的
- `getCorrectionFactorForDay()` 约 3440 行 —— 个人面板用的(有缓存)
- `computeCorrectionForProduct()` 约 3440+ 行 —— 个人面板的备选计算
- `/api/correction-factors` 约 564 行 —— 前端用的修正系数 API
- `/api/postback/personal` —— 个人面板主 API,修正收入计算在这里

## 注意
- 修正系数是**按产品×渠道**的,安卓单一系数,iOS 有 fb/other 两档
- 用户明确说"修正系数全部用今天的"——即查询日期(date参数)当天的系数
- 如果今天数据不完整,fallback 到昨天是合理的(与面板行为一致)
- Romi iOS B口径(FB=AD/TT=AF/GG排除)保持不变
- 不要重启服务、不要 commit,改完 node --check + 告诉我结果
