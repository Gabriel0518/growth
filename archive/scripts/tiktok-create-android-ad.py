#!/usr/bin/env python3
"""
TikTok 安卓广告标准模板生成器（Smart+ 结构，严格复刻 Jovia And_syh_260605_VO_1）
用法:
  source /etc/environment
  python3 scripts/tiktok-create-android-ad.py <config.json>

只需在 config.json 里改这 4 类变量，其余全部锁死（与源模板一致）:
  1. 命名     campaign_name / adgroup_name / ad_name
  2. 优化事件 opt_type: "AEO" 或 "VO"
  3. 出价     bid: AEO=conversion_bid_price(CPA $), VO=roas_bid(如0.3)
  4. 素材     materials: [[video_id, cover_web_uri, file_name], ...]
  + 账户/App: advertiser_id / app_id / identity(该产品的 BC_AUTH_TT identity)

安全: 全程 operation_status=DISABLE（暂停，不花钱）。跑通后你手动开投。
"""
import os, sys, json, time, urllib.request

API = "https://business-api.tiktok.com/open_api/v1.3"
TOKEN = os.environ["TIKTOK_ACCESS_TOKEN"]

# ===== 锁死的通用常量（4变量之外全部不动）=====
IDENTITY_BC_ID = "7118908157199384578"   # Presence BC（BC_AUTH_TT identity 归属）
AD_TEXTS = ["Meet girls online!", "Dating in your town", "Find the love you're looking for"]
CTA = "DOWNLOAD_NOW"
ENHANCE = ["TRANSLATE_AND_DUB", "VIDEO_QUALITY", "MUSIC_REFRESH"]  # create合法枚举

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
    IDENTITY_ID = cfg["identity_id"]         # 该产品 BC_AUTH_TT identity
    opt = cfg["opt_type"].upper()            # AEO / VO
    bid = cfg["bid"]
    cname = cfg["campaign_name"]
    aname = cfg.get("adgroup_name", cname)
    adname = cfg.get("ad_name", cname)
    mats = cfg["materials"]
    OP = cfg.get("op_status", "DISABLE").upper()  # DISABLE(默认,安全) 或 ENABLE(直接开投,真实花钱)

    # ---------- 1) Campaign（全App通用）----------
    c = post("smart_plus/campaign/create", {
        "advertiser_id": AID, "request_id": rid(),
        "campaign_name": cname,
        "objective_type": "APP_PROMOTION", "app_promotion_type": "APP_INSTALL",
        "campaign_type": "REGULAR_CAMPAIGN",
        "budget_mode": "BUDGET_MODE_DYNAMIC_DAILY_BUDGET", "budget": 50,
        "budget_optimize_on": True,
        "operation_status": OP,
    })
    if c.get("code") != 0:
        print("Campaign FAIL:", c.get("message")); return
    CID = c["data"]["campaign_id"]
    print("Campaign OK:", CID, cname)

    # ---------- 2) Ad Group（AEO/VO 区别 + 出价）----------
    now = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    ag = {
        "advertiser_id": AID, "campaign_id": CID, "request_id": rid(),
        "adgroup_name": aname,
        "promotion_type": "APP_ANDROID", "app_id": APP_ID,
        "placement_type": "PLACEMENT_TYPE_AUTOMATIC",
        "billing_event": "OCPM",
        "click_attribution_window": "SEVEN_DAYS",
        "view_attribution_window": "ONE_DAY",
        "budget_mode": "BUDGET_MODE_INFINITE",
        "schedule_type": "SCHEDULE_FROM_NOW", "schedule_start_time": now,
        "operation_status": OP,
        "targeting_spec": {
            "location_ids": ["6252001"], "gender": "GENDER_MALE",
            "age_groups": ["AGE_18_24","AGE_25_34","AGE_35_44","AGE_45_54","AGE_55_100"],
            "languages": ["en"], "operating_systems": ["ANDROID"],
        },
    }
    if opt == "AEO":
        # AEO: 自定义出价（CPA），源 AEO 组用 BID_TYPE_CUSTOM
        ag.update({"optimization_goal": "IN_APP_EVENT", "optimization_event": "ACTIVE_PAY",
                   "deep_bid_type": "AEO", "bid_type": "BID_TYPE_CUSTOM",
                   "conversion_bid_price": bid})
    elif opt == "VO":
        # VO(D0 ROAS): 关键是 vbo_window=ZERO_DAY（D0）。D7(默认/SEVEN_DAY)已被 TikTok 下线不能新建。
        # 源 VO 组实测: bid_type=NO_BID, optimization_event=ACTIVE_PAY, vbo_window=ZERO_DAY（2026-07-03 逐字核对）
        ag.update({"optimization_goal": "VALUE", "deep_bid_type": "VO_MIN_ROAS",
                   "bid_type": "BID_TYPE_NO_BID", "optimization_event": "ACTIVE_PAY",
                   "vbo_window": "ZERO_DAY", "roas_bid": bid})
    else:
        print("opt_type 必须 AEO 或 VO"); return
    a = post("smart_plus/adgroup/create", ag)
    if a.get("code") != 0:
        print("Adgroup FAIL:", a.get("message")); return
    AGID = a["data"]["adgroup_id"]
    print(f"Adgroup OK: {AGID}  [{opt} bid={bid}]")

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
        print("Ad FAIL:", ad.get("message")); return
    d = ad["data"]
    print("Ad OK:", d.get("smart_plus_ad_id"),
          "| dark_post=", d.get("ad_configuration",{}).get("dark_post_status"),
          "| 素材数=", len(d.get("creative_list",[])))
    print(f"\n✅ 完成（op_status={OP}）: campaign={CID} adgroup={AGID} ad={d.get('smart_plus_ad_id')}")

if __name__ == "__main__":
    cfg = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else json.load(sys.stdin)
    main(cfg)
