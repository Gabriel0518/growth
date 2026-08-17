# Meta Marketing API 沙盒测试 Query 清单（App 上架过审用）

> 用途：App `975332261767844` 未上线，用沙盒账户测 Marketing API，为 App Review 演示各权限的真实调用。
> 沙盒账户 ID：`985498160530300` → 路径里写 `act_985498160530300`
> 工具：Graph API Explorer https://developers.facebook.com/tools/explorer
> API 版本：v24.0（Explorer 左侧可选）

## 前置
1. Meta App 下拉选 `975332261767844`
2. Permissions 勾：`ads_read` `ads_management` `read_insights` `business_management`
3. 点 **Generate Access Token** 重新生成（每次加权限都要重新生成）
4. 点 ⓘ 确认 token 里已包含上述权限

---

## 一、验 token 有效（基础）
```
GET /me?fields=id,name
```

## 二、验沙盒账户可读（ads_read）
```
GET /act_985498160530300?fields=id,name,account_status,currency,is_test_account,account_id
```
预期：is_test_account = true

## 三、验 Insights 报表读取（ads_read / read_insights）★核心
```
GET /act_985498160530300/insights?fields=spend,impressions,clicks,ctr,cpc,actions&date_preset=maximum&level=account
```
（沙盒无数据时返回空 data 属正常，能成功返回结构即算通）

## 四、验 campaign 读取（ads_read）
```
GET /act_985498160530300/campaigns?fields=id,name,status,objective,daily_budget
```

## 五、验广告组读取（ads_read）
```
GET /act_985498160530300/adsets?fields=id,name,status,daily_budget,optimization_goal
```

## 六、验 business 读取（business_management）
```
GET /me/businesses?fields=id,name
```

---

## 写权限演示（ads_management）—— 过审更充分时用

> ✅ **2026-07-09 已实测通过（Zhao Peng 号 token）**：沙盒账户 `985498160530300` 依然 #200 不可达，改在**真实账户 admesh `act_1548558926611600`** 建 PAUSED campaign 验证写能力。建成 id `52552015983469`（PAUSED/OUTCOME_TRAFFIC），回读确认后**立即 DELETE 清理**（`{success:true}`，状态转 DELETED，不留痕、不花钱 amount_spent=0）。

沙盒不可用时，在真实账户建 PAUSED 测试 campaign（POST）：
```
POST /act_1548558926611600/campaigns
  name=Test Campaign API Review (ads_management verify)
  objective=OUTCOME_TRAFFIC
  status=PAUSED
  special_ad_categories=[]
  is_adset_budget_sharing_enabled=false   # ⚠️ v25.0 新增必填：不用 CBO 必须显式传 true/false，否则报 #100 subcode 4834011
```
成功返回新建 campaign 的 id → 证明 ads_management 写能力在用。测完立即 `DELETE /{campaign-id}` 清理。
（PAUSED 不真实投放、不花钱）

---

## App Review 提交要点
- 每个申请的权限，都要能对应到"我们在用它做什么"的截图/录屏
- ads_read/read_insights：截图三、四条 query 成功返回
- ads_management：截图写 campaign 成功
- business_management：截图六条 + 说明用于定位公司 BM 下广告账户
- 录屏：从选 App → 生成 token → 跑 query → 返回成功，一镜到底最有说服力

## 最终目标
过审上架后 → 走 OAuth 授权公司真实广告账户 → 直连 Meta Marketing API 拉 FB 投放数据（消耗/转化/素材），替代 XMP 的 FB 部分。
