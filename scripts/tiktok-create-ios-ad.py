#!/usr/bin/env python3
"""
TikTok iOS 广告标准模板生成器（Smart+ / IOS14_CAMPAIGN 专属系列）
严格复刻 Romi iOS_syh_260611_VO（真实读出字段）。

用法:
  set -a; source /etc/environment; set +a
  python3 scripts/tiktok-create-ios-ad.py <config.json>

vs 安卓模板的 iOS 专属差异（屹恒三点 + 系统字段）:
  ★ campaign: campaign_type=IOS14_CAMPAIGN（iOS14专属系列）
             is_advanced_dedicated_campaign=True
             disable_skan_campaign=True（★取消SKAN归因）
             campaign_app_profile_page_state=OFF（★取消应用内介绍页）
  ★ adgroup: promotion_type=APP_IOS / operating_systems=["IOS"]
             ios14_targeting=IOS14_PLUS / min_ios_version=14.0
             adgroup_app_profile_page_state=OFF（★应用内介绍页）
  ad 层与安卓一致（identity / dark_post / 文案 / 增强策略）

config.json 字段:
  advertiser_id, app_id, identity_id, opt_type(AEO/VO), bid,
  campaign_name, [adgroup_name], [ad_name], [budget],
  op_status(默认DISABLE), materials[[video_id,cover_web_uri,file_name]...]
"""
import os, sys, json, time, urllib.request

API = "https://business-api.tiktok.com/open_api/v1.3"
TOKEN = os.environ["TIKTOK_ACCESS_TOKEN"]

IDENTITY_BC_ID = "7118908157199384578"
AD_TEXTS = ["Meet girls online!", "Dating in your town.", "Find the love you're looking for."]
CTA = "DOWNLOAD_NOW"
ENHANCE = ["TRANSLATE_AND_DUB", "VIDEO_QUALITY", "MUSIC_REFRESH"]

# ── 素材黑名单兜底过滤（不区分产品段；无论从 daily-build 还是手动 SOP 调用都拦一道）──
_WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SEG_LIST = ['Dora','Romi','Doni','Luma','Jovia','GraceChat','Kira','Nalo','Mora']
def _bl_norm(name):
    if not name: return ""
    base = name[:-4] if str(name).lower().endswith(".mp4") else name
    return "_".join(s for s in str(base).split("_") if s not in _SEG_LIST).lower()
def _load_blacklist():
    try:
        data = json.load(open(os.path.join(_WS, "config", "tiktok-material-blacklist.json")))
        return {_bl_norm(m) for m in data.get("materials", []) if m}
    except Exception:
        return set()
def _filter_blacklist(mats):
    """从 materials 过滤掉黑名单素材（按文件名第3列判断）。"""
    bl = _load_blacklist()
    if not bl: return mats, []
    kept, dropped = [], []
    for m in mats:
        fn = m[2] if isinstance(m, (list,tuple)) and len(m)>=3 else ""
        (dropped if _bl_norm(fn) in bl else kept).append(m)
    return kept, dropped

def post(ep, body):
    req = urllib.request.Request(f"{API}/{ep}/", data=json.dumps(body).encode(),
            headers={"Access-Token": TOKEN, "Content-Type": "application/json"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())

def rid():
    time.sleep(0.05)
    return str(int(time.time()*1000000))

def main(cfg):
    AID = cfg["advertiser_id"]
    APP_ID = cfg["app_id"]
    IDENTITY_ID = cfg["identity_id"]
    opt = cfg["opt_type"].upper()
    bid = cfg["bid"]
    cname = cfg["campaign_name"]
    aname = cfg.get("adgroup_name", cname)
    adname = cfg.get("ad_name", cname)
    budget = cfg.get("budget", 50)
    mats = cfg["materials"]
    mats, _bl_dropped = _filter_blacklist(mats)
    if _bl_dropped:
        print(f"[黑名单] 过滤掉 {len(_bl_dropped)} 个素材: {[m[2] for m in _bl_dropped]}")
    OP = cfg.get("op_status", "DISABLE").upper()

    # ---------- 1) Campaign（★IOS14 专属系列 + 取消SKAN + 取消介绍页）----------
    c = post("smart_plus/campaign/create", {
        "advertiser_id": AID, "request_id": rid(),
        "campaign_name": cname,
        "objective_type": "APP_PROMOTION", "app_promotion_type": "APP_INSTALL",
        "campaign_type": "IOS14_CAMPAIGN",              # ★ iOS14 专属广告系列
        "app_id": APP_ID,                                # ★ iOS14 dedicated campaign 必须在 campaign 层传 app_id（安卓只在 adgroup 层）
        "is_advanced_dedicated_campaign": cfg.get("is_advanced_dedicated_campaign", True),          # ★ iOS14 专属配套（可被 cfg 覆盖：Mora 新账户用 False）
        "disable_skan_campaign": cfg.get("disable_skan_campaign", True),                   # ★ 取消 SKAN 归因（可被 cfg 覆盖）
        "campaign_app_profile_page_state": cfg.get("campaign_app_profile_page_state", "OFF"),        # ★ 取消应用内介绍页
        "budget_mode": "BUDGET_MODE_DYNAMIC_DAILY_BUDGET", "budget": budget,
        "budget_optimize_on": True,
        "operation_status": OP,
    })
    if c.get("code") != 0:
        print("Campaign FAIL:", c.get("code"), c.get("message"))
        return {"ok": False, "stage": "campaign", "code": c.get("code"), "message": c.get("message")}
    CID = c["data"]["campaign_id"]
    print("Campaign OK:", CID, cname, "[IOS14_CAMPAIGN, SKAN off, profile page off]")

    # ---------- 2) Ad Group（iOS 定向 + AEO/VO 出价）----------
    now = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    ag = {
        "advertiser_id": AID, "campaign_id": CID, "request_id": rid(),
        "adgroup_name": aname,
        "promotion_type": "APP_IOS", "app_id": APP_ID,   # ★ iOS
        "placement_type": cfg.get("placement_type", "PLACEMENT_TYPE_AUTOMATIC"),
        # NORMAL 版位必须显式传 placements（AUTOMATIC 不传）；Mora 对齐手动建的 ["PLACEMENT_TIKTOK"]
        **({"placements": cfg["placements"]} if cfg.get("placements") else {}),
        "billing_event": "OCPM",
        "click_attribution_window": "SEVEN_DAYS",
        "view_attribution_window": "ONE_DAY",
        "budget_mode": "BUDGET_MODE_INFINITE",
        "schedule_type": "SCHEDULE_FROM_NOW", "schedule_start_time": now,
        "operation_status": OP,
        "adgroup_app_profile_page_state": "OFF",         # ★ 取消应用内介绍页（adgroup 层）
        "targeting_spec": {
            "location_ids": ["6252001"], "gender": "GENDER_MALE",
            "age_groups": ["AGE_18_24","AGE_25_34","AGE_35_44","AGE_45_54","AGE_55_100"],
            "languages": ["en"],
            "operating_systems": ["IOS"],                # ★ iOS
            "ios14_targeting": "IOS14_PLUS",             # ★ iOS14+
            "min_ios_version": "14.0",                   # ★ 最低系统版本
        },
    }
    if opt == "AEO":
        ag.update({"optimization_goal": "IN_APP_EVENT", "optimization_event": "ACTIVE_PAY",
                   "deep_bid_type": "AEO"})
        # 非专属系列(is_advanced_dedicated_campaign=False，如 Mora 新账户) 不支持 Cost Cap，
        # 必须 NO_BID + 跳过学习期（对齐屹恒手动建的 Mora 广告）；
        # 专属系列(现有 Romi iOS/Luma/GraceChat) 继续用 Cost Cap(BID_TYPE_CUSTOM + conversion_bid_price)。
        if cfg.get("is_advanced_dedicated_campaign", True):
            ag.update({"bid_type": "BID_TYPE_CUSTOM", "conversion_bid_price": bid})
        else:
            ag.update({"bid_type": "BID_TYPE_NO_BID", "skip_learning_phase": True})
    elif opt == "VO":
        ag.update({"optimization_goal": "VALUE", "deep_bid_type": "VO_MIN_ROAS",
                   "bid_type": "BID_TYPE_NO_BID", "optimization_event": "ACTIVE_PAY",
                   "vbo_window": "ZERO_DAY", "roas_bid": bid})
    else:
        print("opt_type 必须 AEO 或 VO"); return
    a = post("smart_plus/adgroup/create", ag)
    if a.get("code") != 0:
        print("Adgroup FAIL:", a.get("code"), a.get("message"))
        # 删掉刚建的空壳 campaign（如 VO 优化目标不支持时），避免残留
        try: post("campaign/status/update", {"advertiser_id": AID, "campaign_ids": [CID], "operation_status": "DELETE"})
        except Exception: pass
        return {"ok": False, "stage": "adgroup", "code": a.get("code"), "message": a.get("message"), "deleted_campaign": CID}
    AGID = a["data"]["adgroup_id"]
    print(f"Adgroup OK: {AGID}  [iOS {opt} bid={bid}]")

    # ---------- 3) Ad（1广告多素材 + dark_post ON）----------
    creative_list = [{
        "creative_info": {
            "ad_format": "SINGLE_VIDEO",
            "identity_id": IDENTITY_ID, "identity_type": "BC_AUTH_TT",
            "identity_authorized_bc_id": IDENTITY_BC_ID,
            "video_info": {"video_id": v, "file_name": n},
            "image_info": [{"web_uri": cov}],
        }} for (v, cov, n) in mats]
    ad = post("smart_plus/ad/create", {
        "advertiser_id": AID, "adgroup_id": AGID, "request_id": rid(),
        "ad_name": adname,
        "ad_text_list": [{"ad_text": t} for t in AD_TEXTS],
        "call_to_action_list": [{"call_to_action": CTA}],
        "ad_configuration": {"dark_post_status": "ON",
                             "creative_auto_enhancement_strategy_list": ENHANCE},
        "creative_list": creative_list,
        "operation_status": OP,
    })
    if ad.get("code") != 0:
        print("Ad FAIL:", ad.get("code"), ad.get("message"))
        return {"ok": False, "stage": "ad", "code": ad.get("code"), "message": ad.get("message")}
    d = ad["data"]
    print("Ad OK:", d.get("smart_plus_ad_id"),
          "| dark_post=", d.get("ad_configuration",{}).get("dark_post_status"),
          "| 素材数=", len(d.get("creative_list",[])))
    print(f"\n✅ 完成（op_status={OP}）: campaign={CID} adgroup={AGID} ad={d.get('smart_plus_ad_id')}")
    return {"ok": True, "campaign_id": CID, "adgroup_id": AGID, "ad_id": d.get("smart_plus_ad_id")}

if __name__ == "__main__":
    cfg = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else json.load(sys.stdin)
    main(cfg)
