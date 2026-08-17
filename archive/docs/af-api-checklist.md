# AppsFlyer API 接入清单

目标：评估是否可用 AF 官方 API / Export 替代当前 Playwright 登录抓取。

## 一、先确认权限
请在 AppsFlyer 后台确认以下能力是否已开通（名称可能因套餐/版本略有不同）：

- Pull API / Master API / Reporting API
- Raw Data Export / Pivot / Aggregate Report API
- Data Locker（如果公司走数据落仓方案）
- 按媒体渠道（media source）和 app 维度导出报表的权限
- 收入相关字段（actual revenue / predicted revenue / ltv revenue）是否可经 API 获取

建议直接问管理员：

> 我们是否有 AppsFlyer 的报表 API 权限？是否能按 date + app + media_source 拉 installs、actual revenue、ltv revenue 这几个字段？

## 二、需要拿到的鉴权信息
如果可行，需要准备：

- API token / access token / v2 token
- 对应账号/租户的 API 访问说明
- 是否有 app 级别 token 或全局 token
- 如果按 app 单独拉数，需要每个 app 的 app_id / app_token

## 三、需要验证的字段口径
当前 dashboard 依赖以下字段：

### 1. 总面板（AF 汇总）
- date
- app / product
- installs
- revenue actual
- revenue ltv

### 2. 个人面板（媒体渠道 × 产品）
- date
- media_source
- app / product
- installs
- revenue actual
- revenue ltv

需要重点确认：
- API 里的 revenue actual 是否与当前 UI 口径一致
- API 里的 revenue ltv 是否与当前 UI 口径一致
- 时间区间是否支持和当前 dashboard 一致的按日查询
- 是否支持直接按 media_source + app 聚合

## 四、建议做的最小 PoC
一旦拿到权限，先别全量替换，先做一个最小验证：

### PoC-A：总面板
拉取某一天：
- 8 个 app
- installs
- actual revenue
- ltv revenue

然后与当前网页抓取结果对比。

### PoC-B：个人面板
拉取某一天：
- media_source = googleadwords_int / Facebook Ads / tiktokglobal_int
- app
- installs
- actual revenue
- ltv revenue

再与现有个人面板对比。

## 五、判断是否可以替代 Playwright 的标准
只要满足以下几点，就建议替换：

- 能稳定拉到数据
- 字段口径和现有页面基本一致
- 支持按 app / media_source 聚合
- 不需要复杂人工登录
- 速率限制可接受

## 六、如果只能拿到原始事件流
如果 AF 只支持 event/raw export，而不直接给聚合报表：

- 也能做，但工程量会明显上升
- 需要自己落库
- 需要自己聚合 installs / revenue / ltv
- 需要自己对齐 UI 口径

这种情况下，优先级低于“直接可拉聚合报表 API”。

## 七、推荐决策顺序
1. 先确认 API 权限是否有
2. 再确认是否能拿到 app + media_source + revenue + installs
3. 先做 PoC
4. PoC 对齐后，再逐步替换当前 Playwright 抓取

## 八、当前短期方案
在 API 可行性确认前，当前已对 Playwright 抓取做止血增强：
- 登录页改成更稳的 domcontentloaded + 显式等待输入框
- 增加自动重试
- 失败自动保存截图和 HTML 到 output/af-debug/

这样可以先提升现有抓取成功率，同时保留后续切 API 的空间。
