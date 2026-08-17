#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fb-create-android-ad.py —— FB 安卓广告标准模板生成器（3A/CBO 结构，复刻 Dora And_syh 系列）

只服务广告账户 act_646387524897026（省广_Dora_And_3_syh_Agentic）。
结构：1 Campaign(CBO) → 1 AdSet(Advantage+受众) → N 条 Ad（每 Ad 挂 1 素材）。默认 10 素材。

四层固定值（全部从该账户真实老广告 1:1 扒出，见 docs/meta-create-android-ad.md）：
  Campaign: objective=OUTCOME_APP_PROMOTION / CBO(预算在此层) / bid=LOWEST_COST_WITHOUT_CAP / special_ad_categories=[]
  AdSet:    AEO→OFFSITE_CONVERSIONS / VO→VALUE；promoted app_id=774714691621452 + Google Play + PURCHASE；
            美国/18-65/安卓/未安装/advantage_audience=1；点击7天归因；billing=IMPRESSIONS；destination=APP
  Creative: Page 717745171433271(Dora meet friends) + IG 17841477175558188 + CTA INSTALL_MOBILE_APP；文案固定照抄
  素材来源: 本地 FB 素材库（config/fb-android-material-lib.json，由 fb-android-prep.py 预上传）

每次只定 4 类变量（其余锁死）：
  1. opt_type: "AEO" 或 "VO"（都不带出价）
  2. daily_budget: CBO 日预算（美元，脚本 *100 转分）
  3. name: 命名（与 TT 同规范，可重名，如 Dora And_syh_260721_AEO）
  4. countries: 默认 ["US"]

黑灰名单（与 TikTok 独立）：建广告时跳过 黑名单 + 灰名单拒审>=3；1~2 次照用。

安全：默认 status=PAUSED（不投放）。加 --enable 才直接投放（真实花钱）。

用法:
  source /etc/environment
  python3 scripts/fb-create-android-ad.py --opt AEO --budget 50 --name 'Dora And_syh_260721_AEO'
  python3 scripts/fb-create-android-ad.py --opt VO  --budget 100 --name '...' --countries US,CA --enable
  python3 scripts/fb-create-android-ad.py <config.json>   # 或用 json 配置
"""
import os, sys, json, time, urllib.request, urllib.parse

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GRAPH = "https://graph.facebook.com/v25.0"

# ===== 账户 & 全部锁死常量 =====
ACT = "act_646387524897026"
SEG = "Dora"
NEED = 10

FB_APP_ID = "774714691621452"                 # 该账户固定 FB App 资产（换账户才改）
STORE_URL = "http://play.google.com/store/apps/details?id=com.doramatch.app"
PAGE_ID = "717745171433271"                    # Dora meet friends
IG_USER_ID = "17841477175558188"
CTA_TYPE = "INSTALL_MOBILE_APP"

# 文案（该账户统一，照抄老广告）
TITLES = ["Singles nearby\U0001FAE6", "Ready to date?\U0001F49E"]
BODIES = ["Dating in your town\U0001F49E", "Find the love you're looking for",
          "Meet girls online!\U0001F447\U0001F3FB"]

# 创意增强开关（沿用老广告 OPT_IN 组合）
# 注：standard_enhancements 已被 Meta 废弃，新建 creative 传它会报 subcode 3858504，故移除。
CREATIVE_FEATURES_OPT_IN = ["enhance_cta", "inline_comment",
                            "text_optimizations", "video_auto_crop"]

LIB_FP = os.path.join(WS, "config", "fb-android-material-lib.json")
BLACKLIST_FP = os.path.join(WS, "config", "fb-material-blacklist.json")
GREYLIST_FP = os.path.join(WS, "config", "fb-material-greylist.json")
SEG_LIST = ['Dora', 'Romi', 'Doni', 'Luma', 'Jovia', 'GraceChat', 'Kira', 'Nalo']


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


def norm_key(name):
    base = name
    for ext in (".mp4", ".mov"):
        if base.lower().endswith(ext):
            base = base[:-4]
            break
    return "_".join(s for s in base.split("_") if s not in SEG_LIST).lower()


def load_blacklist():
    try:
        return {norm_key(m) for m in json.load(open(BLACKLIST_FP)).get("materials", []) if m}
    except Exception:
        return set()


def load_greylist_counts():
    try:
        raw = json.load(open(GREYLIST_FP)).get("counts", {})
        return {norm_key(k): int(v) for k, v in raw.items()}
    except Exception:
        return {}


def load_lib():
    try:
        return json.load(open(LIB_FP))
    except Exception:
        return {}


def fb_post(path, params):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(f"{GRAPH}/{path}", data=data)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=120).read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def fb_delete(node):
    req = urllib.request.Request(f"{GRAPH}/{node}?access_token=" + urllib.parse.quote(TOKEN), method="DELETE")
    try:
        return json.loads(urllib.request.urlopen(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def parse_args():
    """命令行 或 json 文件。返回 cfg dict。"""
    for a in sys.argv[1:]:
        if a.endswith(".json") and os.path.exists(a):
            return json.load(open(a))
    cfg = {"opt_type": None, "daily_budget": None, "name": None,
           "countries": ["US"], "enable": "--enable" in sys.argv}
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == "--opt" and i + 1 < len(args):
            cfg["opt_type"] = args[i + 1].upper()
        elif a == "--budget" and i + 1 < len(args):
            cfg["daily_budget"] = float(args[i + 1])
        elif a == "--name" and i + 1 < len(args):
            cfg["name"] = args[i + 1]
        elif a == "--countries" and i + 1 < len(args):
            cfg["countries"] = [c.strip().upper() for c in args[i + 1].split(",") if c.strip()]
    return cfg


def pick_materials():
    """从本地 FB 库选可用素材（跳过黑名单 + 灰名单>=3），最多 NEED 条。"""
    lib = load_lib()
    bl = load_blacklist()
    grey = load_greylist_counts()
    picked, skipped = [], 0
    for k, v in lib.items():
        if len(picked) >= NEED:
            break
        if not v.get("video_id"):
            continue
        if k in bl or grey.get(k, 0) >= 3:
            skipped += 1
            continue
        picked.append(v)
    return picked, skipped, len(lib)


def build_creative(fn, vid, thumb):
    """建一个 creative（换素材时复用）。返回 (creative_id, resp)。"""
    feats = {f: {"enroll_status": "OPT_IN"} for f in CREATIVE_FEATURES_OPT_IN}
    story = {
        "page_id": PAGE_ID,
        "instagram_user_id": IG_USER_ID,
        "video_data": {
            "video_id": vid,
            "image_url": thumb or "",
            "call_to_action": {"type": CTA_TYPE, "value": {"link": STORE_URL}},
        },
    }
    afs = {
        "titles": [{"text": t} for t in TITLES],
        "bodies": [{"text": b} for b in BODIES],
        "optimization_type": "DEGREES_OF_FREEDOM",
    }
    dof = {"creative_features_spec": feats}
    cr = fb_post(f"{ACT}/adcreatives", {
        "name": fn,
        "object_story_spec": json.dumps(story),
        "asset_feed_spec": json.dumps(afs),
        "degrees_of_freedom_spec": json.dumps(dof),
        "access_token": TOKEN,
    })
    return cr.get("id"), cr


def build_ad(cfg, mats=None, verbose=True):
    """可编程入口（供 daily-build 调用）。
    cfg: {opt_type, daily_budget, name, countries?, enable?}
    mats: 素材列表 [{video_id,file_name,thumb}, ...]；为 None 时从库自动挑。
    返回 dict: {ok, campaign_id, adset_id, ads:[(adid,fn)], msg}
    """
    def log(*a):
        if verbose: print(*a)
    opt = (cfg.get("opt_type") or "").upper()
    budget = cfg.get("daily_budget")
    name = cfg.get("name")
    countries = cfg.get("countries") or ["US"]
    enable = cfg.get("enable", False)
    if opt not in ("AEO", "VO") or not budget or not name:
        return {"ok": False, "msg": "必填 opt/budget/name"}
    status = "ACTIVE" if enable else "PAUSED"

    if mats is None:
        mats, skipped, libn = pick_materials()
    if not mats:
        return {"ok": False, "msg": "无可用素材"}

    log(f"🚀 FB 建广告  {name} | {opt} | CBO ${budget} | {','.join(countries)} | status={status} | 素材 {len(mats)}")

    # ---------- 1) Campaign（CBO）----------
    c = fb_post(f"{ACT}/campaigns", {
        "name": name,
        "objective": "OUTCOME_APP_PROMOTION",
        "special_ad_categories": "[]",
        "buying_type": "AUCTION",
        "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
        "daily_budget": str(int(round(budget * 100))),   # CBO 预算在 campaign 层
        "status": status,
        "access_token": TOKEN,
    })
    CID = c.get("id")
    if not CID:
        return {"ok": False, "msg": "Campaign FAIL: " + json.dumps(c.get("error", c), ensure_ascii=False)[:160]}
    log("Campaign OK:", CID)

    # ---------- 2) Ad Set（Advantage+受众，不放预算）----------
    opt_goal = "OFFSITE_CONVERSIONS" if opt == "AEO" else "VALUE"
    targeting = {
        "age_min": 18, "age_max": 65,
        "app_install_state": "not_installed",
        "geo_locations": {"countries": countries, "location_types": ["home", "recent"]},
        "user_device": ["Android_Smartphone", "Android_Tablet"],
        "user_os": ["Android_ver_2.0_and_above"],
        "targeting_automation": {"advantage_audience": 1},
    }
    promoted = {"application_id": FB_APP_ID, "object_store_url": STORE_URL,
                "custom_event_type": "PURCHASE"}
    aset = fb_post(f"{ACT}/adsets", {
        "name": name,
        "campaign_id": CID,
        "optimization_goal": opt_goal,
        "billing_event": "IMPRESSIONS",
        "destination_type": "APP",
        "promoted_object": json.dumps(promoted),
        "attribution_spec": json.dumps([{"event_type": "CLICK_THROUGH", "window_days": 7}]),
        "targeting": json.dumps(targeting),
        "status": status,
        "access_token": TOKEN,
    })
    ASID = aset.get("id")
    if not ASID:
        fb_delete(CID)
        return {"ok": False, "msg": "AdSet FAIL: " + json.dumps(aset.get("error", aset), ensure_ascii=False)[:160] + f"（已删孤儿 campaign {CID}）"}
    log("AdSet OK:", ASID, f"[{opt}/{opt_goal}]")

    # ---------- 3+4) 每条素材：建 Creative → 建 Ad ----------
    ok_ads = []
    for m in mats:
        vid = m["video_id"]; fn = m["file_name"]; thumb = m.get("thumb") or ""
        crid, cr = build_creative(fn, vid, thumb)
        if not crid:
            log(f"  ⚠️ creative FAIL [{fn}]:", json.dumps(cr.get("error", cr), ensure_ascii=False)[:140])
            continue
        ad = fb_post(f"{ACT}/ads", {
            "name": fn,
            "adset_id": ASID,
            "creative": json.dumps({"creative_id": crid}),
            "status": status,
            "access_token": TOKEN,
        })
        adid = ad.get("id")
        if not adid:
            log(f"  ⚠️ ad FAIL [{fn}]:", json.dumps(ad.get("error", ad), ensure_ascii=False)[:140])
            continue
        ok_ads.append((adid, fn))
        log(f"  ✅ Ad {adid}  {fn}")

    if not ok_ads:
        fb_delete(CID)
        return {"ok": False, "msg": "全部素材建 Ad 失败，已删孤儿 campaign"}

    return {"ok": True, "campaign_id": CID, "adset_id": ASID, "ads": ok_ads,
            "msg": f"campaign={CID} adset={ASID} ads={len(ok_ads)}/{len(mats)}"}


def main():
    if not TOKEN:
        print("❌ 缺 FB token（--token 或 FB_LONG_TOKEN/FB_TOKEN）")
        sys.exit(1)
    cfg = parse_args()
    if (cfg.get("opt_type") or "").upper() not in ("AEO", "VO") or not cfg.get("daily_budget") or not cfg.get("name"):
        print("❌ 必填：--opt AEO|VO  --budget <美元>  --name <命名>")
        sys.exit(1)
    r = build_ad(cfg, verbose=True)
    if not r.get("ok"):
        print("\n❌ 失败:", r.get("msg"))
        return
    print(f"\n✅ 完成: {r['msg']}")
    print(f"   在广告管理器搜「{cfg.get('name')}」查看。默认 PAUSED，确认无误后手动开量或用 --enable。")


if __name__ == "__main__":
    main()
