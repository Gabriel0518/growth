# 因子分析 v3 重跑任务（2026-07-06）

数据已积累接近两个月（DB 现有 records_202605/202606/202607 三张月表，install_time 覆盖到 2026-07-06）。
完整重跑四大因子分析。**方法论、脚本结构、口径全部沿用现有 v2，不要重新发明**。参考 `docs/factor-analysis.md`。

## 核心变更（屹恒本次唯一的方法论调整）
消耗响应因子里，"大幅增加预算"的主口径阈值从 **+50% 降到 +30%**（首次分析样本少，现在样本充足，30% 更能代表"大幅加量"且样本量够）。
- 脚本 `factor_analysis_v2.py` 的 surge 分析本就同时跑 [0.3, 0.5, 1.0] 三个阈值，无需改代码逻辑；
- 但**报告结论与 docs 的"大幅加量"叙述要以 30% 阈值为主口径**（50%/100% 作为补充参照保留在表里）。

## 已由龙虾完成的前置工作
1. `analysis/extract_revenue_v2.py` 已改成三表 UNION ALL（05+06+07），AF 和 AD 两段都改好了，已过语法检查。
2. XMP 历史消耗正在后台增量拉取（`analysis/fetch-xmp-history.js 2026-05-28 2026-07-06`，日志 `analysis/xmp-fetch-reanalysis.log`）。**开工前先确认它已跑完**（tail 日志看到 "Done!"），否则 XMP 数据不全。

## 你（CC）要做的步骤
1. **确认 XMP 拉取完成**：`tail analysis/xmp-fetch-reanalysis.log`，看到 Done 再继续。
2. **提取收入**：`python3 analysis/extract_revenue_v2.py`（三表 UNION，会慢，几十秒~几分钟正常）。产出 `revenue_by_campaign_day.csv` + `revenue_ad_by_campaign_day.csv`。
3. **重建 product_daily_summary.csv**：现有文件只到 06-04，需要覆盖到 07-06。数据源是 `dashboard/data/YYYY-MM-DD.json`，每个文件取**最后一个 snapshot**，读 `athena[]`（product/totalRevenue/newUserRevenue）和 `xmp[]`（product/cost），按产品聚合成一行 `date,product,athena_total_revenue,athena_new_user_revenue,xmp_cost`。写一个小脚本 `analysis/build_product_daily.py` 生成，覆盖 2026-03-30 ~ 2026-07-06 所有有数据的日期。产品名沿用 dashboard 里的口径（不用再映射）。
4. **合并宽表**：`python3 analysis/prepare_data.py`（生成 `campaign_wide_table.csv`）。
5. **更新可靠区间**：`factor_analysis_v2.py` 顶部 `CAMP_START`/`CAMP_END`。
   - 原理：`records_YYYYMM` 只存 event_time 落在该月的事件，所以某 install_date 要有完整 D1(24h内付费)窗口，其购买事件必须被月表捕获。现在有 05/06/07 三月事件表，**install_date 从 2026-05-10 到约 2026-07-05 都应有可靠 D1**（07-06 当天窗口未满 24h，剔除）。
   - **务必用数据自检确认真实可靠下界/上界**：跑 `prepare_data.py` 后看匹配率、看每天 matched 行数和 new_user_revenue 是否在两端异常掉零（掉零的日期要剔出可靠区间）。给出你实际采用的 CAMP_START/CAMP_END 及依据。目标覆盖 ≥ 45 天（对比首次仅 18 天）。
6. **重跑分析**：`python3 analysis/factor_analysis_v2.py`，产出 `analysis/factor_analysis_report.txt`。
7. **质量检查**（对照 docs 6.3 清单）：匹配率 >20%、可靠区间 ≥45 天、无新 app_id/media_source 漏映射、周末样本数、surge 各平台样本数 >50。
8. **写结论**：把四大因子的新结论（数值 + 与首次分析的对比：日历/动量/波动率/消耗响应四个因子这次结论有没有变、加量阈值 30% 下 FB/GG/TT 各自当天与 3 日后 ROAS 变化）整理成一段清晰中文小结，输出到 `analysis/REANALYSIS_SUMMARY.md`，供龙虾转达屹恒。

## 注意
- app_id/product/platform 映射见 `prepare_data.py`，如遇 DB 里新出现的 app_id 或 source 未映射，补进映射表并在小结里说明。
- 别动 dashboard 线上服务和 `AI投放决策.md`（结论确定后由龙虾和屹恒确认再更新那份 + docs）。
- 全程只读 DB，不写 DB。
- 每步跑完报一下关键数字（行数/匹配率/区间），方便龙虾盯。
