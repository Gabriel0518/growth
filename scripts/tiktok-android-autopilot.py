#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tiktok-android-autopilot.py —— Doni And + Dora And + Jovia And 安卓广告自动运维（拒审上报 + eLTVROAS 阶梯调预算/关停）

用法:
  python3 tiktok-android-autopilot.py           # 真实执行（改预算/关停/发飞书）
  python3 tiktok-android-autopilot.py --dry-run  # 只算不改、不发（打印将要做的动作）

逻辑（复刻 iOS autopilot，仅改：账户/产品/campaign前缀。阶梯规则/阈值/eLTV/修正系数逻辑完全一致）:
  1) 读账户所有 campaign 的 ad，ad 层 secondary_status 若拒审/部分通过 → 只飞书上报，不删不停
  2) 读个人面板(syh→Doni/Dora And/Jovia And→TT→campaign)算当天 eLTVROAS
  3) cost>20 才动，按阶梯调预算(smart_plus/campaign/update)或关停(campaign/status/update)
     eLTVROAS: =0关停; <0.6降20%; 0.6~0.9降10%; 0.9~1.1不变; 1.1~1.3增10%;
               1.3~1.6增20%; 1.6~2增30%; >2增40%
     任意降预算后 <39 → 关停该 campaign
  4) 全部动作 + 拒审汇总，发飞书私聊给屹恒
"""
import os, sys, json, time, urllib.request, urllib.parse, subprocess, datetime

DRY = "--dry-run" in sys.argv

# ── 常量 ──────────────────────────────────────────────────────────
AID = "7559144904526708753"          # 省广_Dora_Doni_Jovia_And_syh_Agentic
OPERATOR = "syh"
PRODUCTS = ["Doni", "Dora And", "Jovia And"]      # 面板产品名（Doni 面板 key 是 "Doni" 不是 "Doni And"）
# campaign_name 产品前缀（用于过滤本账户 syh 建的安卓广告）
CAMP_PREFIXES = ("Doni And_", "Dora And_", "Jovia And_")
TT_API = "https://business-api.tiktok.com/open_api/v1.3"
DASH = "http://127.0.0.1:8081"
ADMIN_USER, ADMIN_PASS = "admin", "d3dkJdSXvkuuYZoqg_5O4Q"
YIHENG_OPENID = "ou_b2467dac5ff1d686fb48ccf1fbaa0c0d"
LARK = os.path.expanduser("~/.npm-global/bin/lark-cli")

TT_REJECT = {"AD_STATUS_AUDIT_DENY", "AD_STATUS_REVIEW_PARTIALLY_APPROVED",
             "ADGROUP_STATUS_AUDIT_DENY", "ADGROUP_STATUS_REVIEW_PARTIALLY_APPROVED"}

COST_THRESHOLD = 20.0    # 消耗大于此才调整（屹恒 2026-07-11: 40→30→20）
MIN_BUDGET = 39.0        # 降预算后低于此则关停（屹恒 2026-07-11 由35改39）
# 降预算失败（撞 TikTok「新预算≥已花费×105%」下限）时记待重试，次日 00:10 --retry-budget 重试。屹恒 2026-07-20 定。
WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RETRY_FILE = os.path.join(WS, "output", "tt-budget-retry-android.json")

# 只运维「当前在投的 syh iOS 广告」——动态发现：本账户内 operation_status=ENABLE
# 且 campaign_name 含 'syh_' 的 IOS14 campaign。历史/已停的一律不碰。
# （不写死 campaign_id，因为每天 23:40 会新建，白名单会过期）

def token():
    # /etc/environment 无 export，直接解析
    for line in open("/etc/environment"):
        line = line.strip()
        if line.startswith("TIKTOK_ACCESS_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"')
    return os.environ.get("TIKTOK_ACCESS_TOKEN", "")
TK = token()

# ── TT API ────────────────────────────────────────────────────────
def tt_get(ep, params):
    url = f"{TT_API}/{ep}/?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Access-Token": TK})
    try: return json.loads(urllib.request.urlopen(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        try: return json.loads(e.read())
        except: return {"code": -1, "message": str(e)}

def tt_post(ep, body):
    req = urllib.request.Request(f"{TT_API}/{ep}/", data=json.dumps(body).encode(),
        headers={"Access-Token": TK, "Content-Type": "application/json"})
    try: return json.loads(urllib.request.urlopen(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        try: return json.loads(e.read())
        except: return {"code": -1, "message": str(e)}

# ── dashboard 登录 cookie ─────────────────────────────────────────
import http.cookiejar
_cj = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cj),
                                      urllib.request.HTTPRedirectHandler())
def dash_login():
    data = urllib.parse.urlencode({"username": ADMIN_USER, "password": ADMIN_PASS}).encode()
    last = None
    for _ in range(4):  # dashboard 整点前可能拥堵，重试
        req = urllib.request.Request(f"{DASH}/login", data=data)
        try:
            _opener.open(req, timeout=30); return True
        except urllib.error.HTTPError:
            return True  # 302 正常（登录成功重定向）
        except Exception as e:
            last = e; time.sleep(10)
    raise RuntimeError(f"dashboard 登录超时（4次重试）: {last}")
def dash_get(path):
    last = None
    for _ in range(3):
        try:
            req = urllib.request.Request(f"{DASH}{path}")
            return json.loads(_opener.open(req, timeout=90).read())
        except Exception as e:
            last = e; time.sleep(8)
    raise last

# ── 远端取数（richang-daily-data / ug-data-callback）─────────────────
# 屹恒 2026-07-17 定：eLTV 倍数 + 修正系数「必须走远端」（远端最近发版更新过，本机没更新）；
# 消耗/收入仍走本机 postback。远端任一环失败（无cookie/401/403/超时/cached:false）→ fallback 本机。
RICHANG_BASE = "https://ug-data-callback.sitinai.com"
RICHANG_SESSION_FP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "richang-session.json")
RICHANG_UA = "Mozilla/5.0 (X11; Linux x86_64) richang-autopilot"
_richang_warn = []   # 收集远端异常，最后并入飞书汇报

def _richang_cookie():
    try:
        s = json.load(open(RICHANG_SESSION_FP))
        cv = s.get("dashboard_session", "")
        exp = s.get("exp_ms", 0)
        if not cv:
            return None, "session 文件无 cookie"
        if exp and exp < time.time() * 1000:
            return None, "session cookie 已过期（需重新飞书授权）"
        return cv, None
    except Exception as e:
        return None, f"读 session 文件失败: {e}"

def richang_get(path):
    """打远端只读接口。成功返回 dict；失败 raise（调用方兜底本机）。"""
    cv, err = _richang_cookie()
    if err:
        raise RuntimeError(err)
    req = urllib.request.Request(f"{RICHANG_BASE}{path}",
        headers={"Cookie": f"dashboard_session={cv}", "User-Agent": RICHANG_UA})
    for attempt in range(3):
        try:
            return json.loads(urllib.request.urlopen(req, timeout=40).read())
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise RuntimeError("远端 401（cookie 失效，需重新授权）")
            if e.code == 429:
                try:
                    wait = json.loads(e.read()).get("retryAfterSeconds", 3)
                except Exception:
                    wait = 3
                time.sleep(min(wait, 10)); continue
            raise RuntimeError(f"远端 HTTP {e.code}")
        except Exception as e:
            if attempt == 2:
                raise RuntimeError(f"远端请求失败: {e}")
            time.sleep(3)
    raise RuntimeError("远端多次重试仍失败")

def fetch_eltv(d):
    """eLTV 倍数：远端优先（date=当天），失败/空 → fallback 本机。返回 (multipliers, 来源标记)。"""
    try:
        r = richang_get(f"/api/ext/eltv?date={d}")
        data = r.get("data", {})
        if r.get("cached") and data:
            return data, "远端"
        raise RuntimeError(f"远端 eltv cached={r.get('cached')} 空数据")
    except Exception as e:
        _richang_warn.append(f"eLTV 远端取失败→本机兜底：{e}")
        return dash_get(f"/api/eltv-multipliers?date={d}").get("multipliers", {}), "本机(fallback)"

def fetch_corr(d, dy):
    """修正系数：远端优先。远端按日期分桶、只有定稿日（≤昨天），故取 date=昨天（本机 date=今天 内部也映射到昨天口径，等价）。
    失败/空 → fallback 本机 date=今天。返回 (factors, 来源标记)。"""
    try:
        r = richang_get(f"/api/ext/correction-factors?date={dy}")
        data = r.get("data", {})
        if r.get("cached") and data:
            return data, "远端"
        raise RuntimeError(f"远端 cf cached={r.get('cached')} 空数据")
    except Exception as e:
        _richang_warn.append(f"修正系数 远端取失败→本机兜底：{e}")
        return dash_get(f"/api/correction-factors?date={d}").get("factors", {}), "本机(fallback)"

# ── 飞书 ──────────────────────────────────────────────────────────
def feishu(text):
    if DRY:
        print("\n===== [DRY] 将发飞书 =====\n" + text + "\n=========================")
        return
    env = dict(os.environ); env["PATH"] = os.path.expanduser("~/.npm-global/bin") + ":" + env.get("PATH", "")
    try:
        out = subprocess.run([LARK, "im", "+messages-send", "--as", "bot",
            "--user-id", YIHENG_OPENID, "--text", text],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=60, env=env)
        if '"message_id"' in (out.stdout + out.stderr):
            print("✅ 飞书已发送")
        else:
            print("⚠️ 飞书发送可能失败:", (out.stdout + out.stderr)[:300])
    except Exception as e:
        print("⚠️ 飞书异常:", e)

# ── eLTV / 修正系数 / 面板 ────────────────────────────────────────
def today_bj():
    return (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).strftime("%Y-%m-%d")

def yesterday_bj():
    return (datetime.datetime.utcnow() + datetime.timedelta(hours=8) - datetime.timedelta(days=1)).strftime("%Y-%m-%d")

def get_eltv_mult(elt, product, channel="TT"):
    m = elt.get(product)
    if not m: return None
    if channel in m and m[channel].get("d180"): return m[channel]["d180"]
    for ch in ("FB", "GG", "TT"):
        if m.get(ch, {}).get("d180"): return m[ch]["d180"]
    return m.get("d180")

def get_corr_factor(cf, product, channel="TT"):
    f = cf.get(product)
    if f is None: return 1.0
    if isinstance(f, (int, float)): return f          # 安卓单系数
    if channel == "FB": return f.get("fb", 1) or 1    # iOS
    return f.get("other", 1) or 1

# ── 阶梯规则 ──────────────────────────────────────────────────────
def budget_action(eltv_roas):
    """返回 (action, factor)：action ∈ {stop, adjust, keep}；factor=预算乘数"""
    if eltv_roas == 0:            return ("stop", None)
    if eltv_roas < 0.6:          return ("adjust", 0.80)
    if eltv_roas < 0.9:          return ("adjust", 0.90)
    if eltv_roas < 1.1:          return ("keep", 1.0)
    if eltv_roas < 1.3:          return ("adjust", 1.10)
    if eltv_roas < 1.6:          return ("adjust", 1.20)
    if eltv_roas < 2.0:          return ("adjust", 1.30)
    return ("adjust", 1.40)

# ── 降预算失败重试队列（撞 105% 下限时记待重试，次日 00:10 cost 归零后重试）──
def _load_retry():
    try: return json.load(open(RETRY_FILE))
    except Exception: return []

def _save_retry(items):
    try:
        with open(RETRY_FILE, "w") as f: json.dump(items, f, ensure_ascii=False, indent=1)
    except Exception as e: print("⚠️ 写重试队列失败:", e)

def _queue_retry(cid, cname, target_bud, er):
    """降预算当场失败 → 记进队列（同 campaign 去重，保留最新目标）。"""
    items = _load_retry()
    items = [x for x in items if x.get("campaign_id") != cid]
    items.append({"campaign_id": cid, "campaign_name": cname,
                  "target_budget": target_bud, "eltvRoas": round(er, 2),
                  "queued_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M")})
    _save_retry(items)

def run_budget_retry():
    """--retry-budget 模式（次日 00:10 crontab 调用）：重提交昨天撞下限没降成的降预算。
    此时当天 cost 已归零，new_bud≥cost×1.05 必然成立，能顺利降到目标值。"""
    items = _load_retry()
    lines = [f"🌙 TikTok 安卓 降预算补偿（00:10）"]
    if not items:
        lines.append("  队列为空，无需补偿。"); feishu("\n".join(lines)); print("\n".join(lines)); return
    still = []
    for it in items:
        cid = it["campaign_id"]; cname = it.get("campaign_name", cid); tb = it["target_budget"]
        if DRY:
            lines.append(f"  [DRY] 将重试 {cname} → ${tb:.0f}"); still.append(it); continue
        r = tt_post("smart_plus/campaign/update", {"advertiser_id": AID, "campaign_id": cid, "budget": tb})
        if r.get("code") == 0:
            lines.append(f"  ✅ {cname} 降到 ${tb:.0f} 成功（昨日撞105%下限，今日补偿）")
        else:
            lines.append(f"  ❌ {cname} 重试仍失败 code={r.get('code')} {str(r.get('message'))[:60]}（保留队列）")
            still.append(it)
        time.sleep(0.5)
    _save_retry(still)
    feishu("\n".join(lines)); print("\n".join(lines))


# ── 灰名单清理（scan + remove 内联，屹恒 2026-07-20 接进 autopilot，跟在调预算后）──
# 只清理【部分过审】(AD_STATUS_REVIEW_PARTIALLY_APPROVED) 广告里的灰名单素材，保留其余素材。
# 完全过审/审核中即使命中也不动。移除后若素材归零则跳过（不建空广告）。
def graylist_cleanup():
    _BC = "7118908157199384578"
    _SEG = ['Dora', 'Romi', 'Doni', 'Luma', 'Jovia', 'GraceChat', 'Kira', 'Nalo']
    def _norm(name):
        if not name: return ""
        base = name[:-4] if str(name).lower().endswith(".mp4") else name
        return "_".join(s for s in str(base).split("_") if s not in _SEG).lower()
    _cfg = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "config", "tiktok-material-graylist.json")
    try:
        GL = {_norm(m) for m in json.load(open(_cfg)).get("materials", []) if m}
    except Exception as e:
        return [f"\n🧹 灰名单清理：读配置失败 {e}（跳过）"]
    if not GL:
        return ["\n🧹 灰名单清理：灰名单为空，跳过"]

    # 1) 扫全账户，挑出【部分过审】且命中灰名单的广告
    hits = []; total = 0; page = 1
    while True:
        r = tt_get("smart_plus/ad/get", {"advertiser_id": AID, "page": page, "page_size": 50,
            "fields": json.dumps(["smart_plus_ad_id", "ad_name", "campaign_id", "adgroup_id",
                                  "operation_status", "secondary_status", "creative_list"])})
        if r.get("code") != 0:
            return [f"\n🧹 灰名单清理：扫描失败 {r.get('message')}（跳过）"]
        d = r.get("data", {}); lst = d.get("list", [])
        for ad in lst:
            total += 1
            # 触发状态：部分过审 + 审核中（屹恒 2026-07-22：审核中且命中灰名单也剔素材，重新触发审核）
            if ad.get("secondary_status") not in ("AD_STATUS_REVIEW_PARTIALLY_APPROVED", "AD_STATUS_AUDIT"):
                continue
            cl = ad.get("creative_list", []) or []
            matched = [((cr.get("creative_info", {}) or {}).get("video_info", {}) or {}).get("file_name", "")
                       for cr in cl]
            matched = [fn for fn in matched if _norm(fn) in GL]
            if matched:
                hits.append({"ad_id": ad.get("smart_plus_ad_id"), "camp": ad.get("campaign_id"),
                             "name": ad.get("ad_name"), "matched": matched})
        pi = d.get("page_info", {}); tp = pi.get("total_page", 1)
        if page >= tp or not lst: break
        page += 1; time.sleep(0.3)

    if not hits:
        return [f"\n🧹 灰名单清理：扫描 {total} 条广告，无【部分过审】命中灰名单，无需清理"]

    # 2) 逐条移除灰名单素材（保留其余），写回
    out = [f"\n🧹 灰名单清理：{len(hits)} 条【部分过审】广告命中，处理中："]
    for h in hits:
        ad_id = h["ad_id"]; camp = h["camp"]; name = h["name"]
        r = tt_get("smart_plus/ad/get", {"advertiser_id": AID,
            "filtering": json.dumps({"campaign_ids": [camp]}),
            "fields": json.dumps(["smart_plus_ad_id", "ad_name", "adgroup_id", "creative_list"])})
        if r.get("code") != 0:
            out.append(f"  ❌ {name}: ad/get失败 {r.get('message')}"); continue
        target = None
        for ad in r.get("data", {}).get("list", []):
            if str(ad.get("smart_plus_ad_id")) == str(ad_id): target = ad; break
        if not target:
            out.append(f"  ❌ {name}: 未匹配到 ad_id={ad_id}"); continue
        cl = target.get("creative_list", []) or []
        new_cl = []; removed = []
        for cr in cl:
            ci = cr.get("creative_info", {}) or {}
            vi = ci.get("video_info", {}) or {}
            fn = vi.get("file_name", "")
            if _norm(fn) in GL:
                removed.append(fn); continue
            imgs = ci.get("image_info", []) or []
            new_cl.append({"creative_info": {
                "ad_format": ci.get("ad_format", "SINGLE_VIDEO"),
                "identity_id": ci.get("identity_id"),
                "identity_type": ci.get("identity_type", "BC_AUTH_TT"),
                "identity_authorized_bc_id": ci.get("identity_authorized_bc_id") or _BC,
                "video_info": {"video_id": vi.get("video_id"), "file_name": vi.get("file_name")},
                "image_info": [{"web_uri": (im.get("web_uri") if isinstance(im, dict) else im)} for im in imgs],
            }})
        if not removed:
            out.append(f"  ⏭️ {name}: 实际未含灰名单素材（可能已处理）"); continue
        if not new_cl:
            out.append(f"  ⚠️ {name}: 移除后素材为空，跳过（不建空广告）"); continue
        if DRY:
            out.append(f"  [DRY] {name}: {len(cl)}→{len(new_cl)} 素材, 移除 {removed}"); continue
        u = tt_post("smart_plus/ad/update", {"advertiser_id": AID,
            "smart_plus_ad_id": ad_id, "creative_list": new_cl})
        if u.get("code") == 0:
            out.append(f"  ✅ {name}: {len(cl)}→{len(new_cl)} 素材, 移除 {removed}")
        else:
            out.append(f"  ❌ {name}: 更新失败 {u.get('message')}")
        time.sleep(0.6)
    return out

# ── 主流程 ────────────────────────────────────────────────────────
def main():
    if "--retry-budget" in sys.argv:
        run_budget_retry(); return
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [f"🤖 TikTok 安卓自动运维 {ts}" + ("（DRY-RUN）" if DRY else "")]

    # ===== 1. 读所有 campaign + ad 拒审 =====
    # 先列本账户所有 campaign（只处理 syh 建的 iOS，用 campaign_name 前缀过滤 Romi iOS_ / Luma_）
    r = tt_get("campaign/get", {"advertiser_id": AID,
        "fields": json.dumps(["campaign_id", "campaign_name", "operation_status", "budget"]),
        "page_size": 100})
    all_camps = r.get("data", {}).get("list", [])
    # 只管我们建的、当前 ENABLE 的（名字含 syh_ 且 iOS 产品前缀）
    my_camps = [c for c in all_camps
                if "syh_" in c["campaign_name"]
                and c.get("operation_status") == "ENABLE"
                and c["campaign_name"].startswith(CAMP_PREFIXES)]

    # 读 ad 拒审
    reject_report = []
    for c in my_camps:
        ar = tt_get("smart_plus/ad/get", {"advertiser_id": AID,
            "filtering": json.dumps({"campaign_ids": [c["campaign_id"]]}), "page_size": 20})
        for a in ar.get("data", {}).get("list", []):
            st = a.get("secondary_status", "")
            if st in TT_REJECT:
                reject_report.append(f"  • {c['campaign_name']} → {st}")
        time.sleep(0.2)

    if reject_report:
        lines.append(f"\n⚠️ 拒审广告 {len(reject_report)} 条（需你手动处理素材）：")
        lines += reject_report
    else:
        lines.append("\n✅ 无拒审广告")

    # ===== 2. 读面板算 eLTVROAS =====
    d = today_bj()
    dy = yesterday_bj()
    dash_login()
    # eLTV 倍数 + 修正系数「必须走远端」（远端发版更新过，本机未更），失败自动 fallback 本机
    # 修正系数远端按日期分桶、只有定稿日，取 date=昨天（等价本机 date=今天内部映射的昨日口径）
    elt, elt_src = fetch_eltv(d)
    cf, cf_src = fetch_corr(d, dy)
    try:
        pbp = dash_get(f"/api/postback/personal?startDate={d}&endDate={d}")
    except Exception as e:
        lines.append(f"\n❌ 读面板失败: {e}（跳过调预算）")
        feishu("\n".join(lines)); return
    # 数据源标记（远端/本机 fallback）写进汇报
    lines.append(f"\n📡 数据源：eLTV={elt_src} / 修正系数={cf_src} / 消耗+收入=本机postback")
    if _richang_warn:
        lines.append("⚠️ 远端取数异常（已自动兜底本机）：")
        lines += ["   • " + w for w in _richang_warn]

    # 定位 syh → 各产品 → TT → campaign
    camp_metrics = {}   # campaign_name -> {cost, eltvRoas}
    for op in pbp.get("operators", []):
        if op["operator"] != OPERATOR: continue
        for p in op.get("products", []):
            if p["product"] not in PRODUCTS: continue
            emult = get_eltv_mult(elt, p["product"], "TT")
            cfac = get_corr_factor(cf, p["product"], "TT")
            for ch in p.get("channels", []):
                if ch["channel"] != "TT": continue
                for camp in ch.get("campaigns", []):
                    cost = camp.get("cost", 0) or 0
                    # 当天单日：correctedNewUserRevenue 优先，否则 newUserRevenue×cfac
                    cnr = camp.get("correctedNewUserRevenue")
                    if cnr is None:
                        cnr = (camp.get("newUserRevenue", 0) or 0) * cfac
                    eltv_roas = (cnr / cost * emult) if (cost > 0 and emult) else 0
                    camp_metrics[camp["campaign"]] = {"cost": cost, "eltvRoas": eltv_roas}

    # ===== 3. 调预算/关停 =====
    lines.append("\n📊 调预算/关停：")
    actioned = False
    # 建 campaign_name → campaign_id/budget 映射（用 TT 权威预算）
    name2camp = {c["campaign_name"]: c for c in my_camps}
    for cname, m in sorted(camp_metrics.items()):
        cost, er = m["cost"], m["eltvRoas"]
        cobj = name2camp.get(cname)
        if not cobj:
            continue  # 面板有但不在本账户 my_camps（理论不会）
        cid = cobj["campaign_id"]; cur_bud = cobj.get("budget", 0)
        opstat = cobj.get("operation_status", "")
        if opstat != "ENABLE":
            continue  # 已关停的跳过
        if cost <= COST_THRESHOLD:
            lines.append(f"  • {cname}: cost=${cost:.1f} ≤20 不动 (eLTVROAS={er:.2f})")
            continue
        act, factor = budget_action(er)
        if act == "stop":
            actioned = True
            if not DRY:
                tt_post("campaign/status/update", {"advertiser_id": AID,
                    "campaign_ids": [cid], "operation_status": "DISABLE"})
            lines.append(f"  🛑 {cname}: eLTVROAS=0 → 关停 (cost=${cost:.1f})")
        elif act == "keep":
            lines.append(f"  • {cname}: eLTVROAS={er:.2f} 0.9~1.1 不变 (cost=${cost:.1f} bud=${cur_bud:.0f})")
        else:
            new_bud = round(cur_bud * factor, 2)
            if factor < 1 and new_bud < MIN_BUDGET:
                actioned = True
                if not DRY:
                    tt_post("campaign/status/update", {"advertiser_id": AID,
                        "campaign_ids": [cid], "operation_status": "DISABLE"})
                lines.append(f"  🛑 {cname}: eLTVROAS={er:.2f} 降后=${new_bud:.0f}<39 → 关停 (cost=${cost:.1f})")
            else:
                actioned = True
                arrow = "↑" if factor > 1 else "↓"
                pct = int(round(abs(factor - 1) * 100))
                if DRY:
                    lines.append(f"  {arrow} {cname}: eLTVROAS={er:.2f} → {arrow}{pct}% ${cur_bud:.0f}→${new_bud:.0f} (cost=${cost:.1f})")
                else:
                    r = tt_post("smart_plus/campaign/update", {"advertiser_id": AID,
                        "campaign_id": cid, "budget": new_bud})
                    if r.get("code") == 0:
                        lines.append(f"  {arrow} {cname}: eLTVROAS={er:.2f} → {arrow}{pct}% ${cur_bud:.0f}→${new_bud:.0f} (cost=${cost:.1f})")
                    elif factor < 1:
                        # 降预算失败：极可能撞 TikTok「新预算≥已花费×105%」下限 → 记队列，次日 00:10 cost 归零后补偿
                        _queue_retry(cid, cname, new_bud, er)
                        lines.append(f"  ⏳ {cname}: eLTVROAS={er:.2f} 降预算失败(code={r.get('code')} 疑撞105%下限 已花${cost:.1f}) → 目标${new_bud:.0f} 记入次日00:10补偿队列")
                    else:
                        lines.append(f"  ⚠️ {cname}: eLTVROAS={er:.2f} 增预算失败 code={r.get('code')} {str(r.get('message'))[:60]}")
        time.sleep(0.5)

    if not camp_metrics:
        lines.append("  （面板暂无 syh 的 Doni/Dora And/Jovia And TT campaign 数据，可能今天还没消耗）")

    # 灰名单清理（跟在调预算后）
    lines += graylist_cleanup()

    feishu("\n".join(lines))
    print("\n".join(lines))

if __name__ == "__main__":
    main()
