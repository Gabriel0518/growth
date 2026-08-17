#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fb-android-daily-build.py —— FB 安卓账户每日新建广告（仅 Dora And，账户 act_646387524897026）

对齐 TikTok android daily-build，差异映射（屹恒 2026-07-21 定）：
  - 单账户单产品（Dora And），只建 AEO×1 + VO×1（都不带出价，FB 无出价）
  - 每条 campaign CBO 日预算 $100
  - 素材走本地 FB 素材库（config/fb-android-material-lib.json，由 fb-android-prep.py 预上传），
    库内直取，每 campaign 挂库内全部可用素材（跳过黑名单 + 灰名单拒审>=3）
  - 命名与 TT 同规范：Dora And_syh_<yymmdd>_<AEO|VO>（可重名；幂等查重避免同名重复建）
  - 默认 PAUSED（--enable 才 ACTIVE 真投放）

流程:
  1) 幂等查重：读账户现存 campaign 名，今日 AEO/VO 均已存在则跳过
  2) 从 FB 素材库挑可用素材（复用 create 脚本 pick_materials）
  3) 逐 plan 调 fb-create-android-ad.build_ad() 建广告
  4) 飞书私聊汇报

用法:
  source /etc/environment
  python3 scripts/fb-android-daily-build.py --dry-run   # 只查重+列素材，不建
  python3 scripts/fb-android-daily-build.py             # 正式：AEO×1+VO×1，各 CBO $100，PAUSED
  python3 scripts/fb-android-daily-build.py --enable    # 建成即 ACTIVE 投放（真花钱）

跳过机制: scripts/.skip_build_date_fb_android == 今天 则跳过。
"""
import os, sys, json, time, urllib.request, urllib.parse, subprocess, datetime, importlib.util

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRY = "--dry-run" in sys.argv
ENABLE = "--enable" in sys.argv

GRAPH = "https://graph.facebook.com/v25.0"
ACT = "act_646387524897026"          # 省广_Dora_And_3_syh_Agentic（唯一账户）
PRODUCT = "Dora And"

# 每日建广告计划（FB AEO/VO 都不带出价，只定条数 + 预算；屹恒 2026-07-21 定：各 1 条，各 $100）
PLANS = [("AEO", 100.0), ("VO", 100.0)]

YIHENG = "ou_b2467dac5ff1d686fb48ccf1fbaa0c0d"
LARK = os.path.expanduser("~/.npm-global/bin/lark-cli")


def get_token():
    for i, a in enumerate(sys.argv):
        if a == "--token" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    t = os.environ.get("FB_LONG_TOKEN") or os.environ.get("FB_TOKEN")
    if not t:
        try:
            for l in open("/etc/environment"):
                l = l.strip()
                for k in ("FB_LONG_TOKEN", "FB_TOKEN"):
                    if l.startswith(k + "="):
                        return l.split("=", 1)[1].strip().strip('"')
        except Exception:
            pass
    return t


TOKEN = get_token()


def today_bj():
    return (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).strftime("%Y-%m-%d")


def feishu(text):
    if DRY:
        print("\n[DRY 飞书]\n" + text)
        return
    env = dict(os.environ)
    env["PATH"] = os.path.expanduser("~/.npm-global/bin") + ":" + env.get("PATH", "")
    try:
        out = subprocess.run([LARK, "im", "+messages-send", "--as", "bot",
                              "--user-id", YIHENG, "--text", text],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             universal_newlines=True, timeout=60, env=env)
        print("✅ 飞书已发" if '"message_id"' in (out.stdout + out.stderr)
              else "⚠️ 飞书失败:" + (out.stdout + out.stderr)[:200])
    except Exception as e:
        print("⚠️ 飞书异常:", e)


def fb_get(path, params):
    url = f"{GRAPH}/{path}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def existing_campaign_names(create_mod):
    """读账户现存（非 DELETED）campaign 名集合，用于幂等查重。失败返回 None。"""
    names = set()
    after = None
    for _ in range(20):
        params = {"fields": "name,configured_status,effective_status", "limit": 200,
                  "access_token": TOKEN}
        if after:
            params["after"] = after
        r = fb_get(f"{ACT}/campaigns", params)
        if "error" in r:
            return None
        for c in r.get("data", []):
            # DELETED / ARCHIVED 不算占用（可重建）；其余都算现存
            if c.get("configured_status") in ("DELETED", "ARCHIVED"):
                continue
            nm = c.get("name")
            if nm:
                names.add(nm)
        paging = r.get("paging", {})
        after = paging.get("cursors", {}).get("after")
        if not r.get("data") or "next" not in paging:
            break
    return names


def main():
    if not TOKEN:
        print("❌ 缺 FB token（--token 或 FB_LONG_TOKEN/FB_TOKEN）")
        sys.exit(1)

    # 加载 create 模块（复用 pick_materials + build_ad）
    spec = importlib.util.spec_from_file_location(
        "fbcreate", os.path.join(WS, "scripts", "fb-create-android-ad.py"))
    fbc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fbc)

    d = today_bj()
    date_tag = datetime.datetime.strptime(d, "%Y-%m-%d").strftime("%y%m%d")
    status_label = "ACTIVE" if ENABLE else "PAUSED"
    tag = "（DRY）" if DRY else ("（ENABLE 真投放）" if ENABLE else "（PAUSED）")

    # skip 标记
    skip_fp = os.path.join(WS, "scripts", ".skip_build_date_fb_android")
    if os.path.exists(skip_fp) and open(skip_fp).read().strip() == d:
        print(f"跳过新建（标记 {d}）")
        if not DRY:
            os.remove(skip_fp)
            feishu(f"🌙 {d} FB安卓新建广告：按你要求今天跳过。标记已清除。")
        return

    mats, skipped, libn = fbc.pick_materials()
    lines = [f"🌙 FB 安卓新建广告 {d}{tag}",
             f"账户: 省广_Dora_And_3_syh_Agentic（{ACT}）",
             f"素材库: {libn} 条，可用 {len(mats)} 条（跳过黑灰 {skipped}）"]

    if not mats:
        lines.append("⚠️ 0 可用素材，跳过建广告（不建空壳）。先跑 fb-android-prep.py")
        print("\n".join(lines)); feishu("\n".join(lines)); return

    # 幂等查重
    exist = existing_campaign_names(fbc)
    if exist is None:
        lines.append("⚠️ 查重失败，本次不做幂等判重"); exist = set()
    else:
        lines.append(f"幂等查重: 账户现存 {len(exist)} 个 campaign 名")

    plan_names = [f"{PRODUCT}_syh_{date_tag}_{opt}" for opt, _ in PLANS]

    if DRY:
        lines.append("\n[DRY] 将建：")
        for (opt, bud), nm in zip(PLANS, plan_names):
            dup = "（已存在，跳过）" if nm in exist else ""
            lines.append(f"  • {nm} | {opt} | CBO ${bud:.0f} | 素材 {len(mats)} 条 {dup}")
        print("\n".join(lines)); feishu("\n".join(lines)); return

    built = 0; skipped_dup = 0
    lines.append("\n建广告：")
    for (opt, bud), cname in zip(PLANS, plan_names):
        if cname in exist:
            lines.append(f"  ⏭️ {cname} 已存在，跳过（幂等）"); skipped_dup += 1; continue
        cfg = {"opt_type": opt, "daily_budget": bud, "name": cname,
               "countries": ["US"], "enable": ENABLE}
        try:
            r = fbc.build_ad(cfg, mats=mats, verbose=True)
            if r.get("ok"):
                built += 1; exist.add(cname)
                lines.append(f"  ✅ {cname} [{opt}/${bud:.0f}] {len(r['ads'])} 条ad [{status_label}]  camp={r['campaign_id']}")
            else:
                lines.append(f"  ❌ {cname} 建失败: {r.get('msg')}")
        except Exception as e:
            lines.append(f"  ❌ {cname} 异常: {e}")
        time.sleep(2)

    lines.append(f"\n共建成 {built} 条 [{status_label}]" + (f"（幂等跳过 {skipped_dup}）" if skipped_dup else ""))
    print("\n".join(lines)); feishu("\n".join(lines))


if __name__ == "__main__":
    main()
