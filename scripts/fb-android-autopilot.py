#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fb-android-autopilot.py —— FB 安卓广告自动运维（仅 Dora And，账户 act_646387524897026）

对齐 TikTok android autopilot（阶梯规则/阈值/eLTV/修正系数逻辑完全一致），差异映射（屹恒 2026-07-21 定）：
  1) 拒审处理（FB 特有：能读真实审核状态 effective_status=DISAPPROVED + ad_review_feedback）
     发现某 ad DISAPPROVED：
       - 该素材归一化名 → 灰名单 counts +1
       - 满 5 次 → 进黑名单 + 删除该 ad（全删，含在投）
       - 1~4 次 → 【替换同一个 ad 的素材】：从库挑一个干净素材(counts<3 且非黑名单，
                 优先该 adset 未用过的) → 建新 creative → POST /{ad_id} 把 ad 的 creative 换成新的
                 （ad_id 不变、名字随新素材、仍在原 adset/campaign。屹恒 2026-07-21 明确：换素材不删ad不补建）
  2) 读个人面板(syh→Dora And→FB→campaign)算当天 eLTVROAS
  3) cost>20 才动，按阶梯调预算(POST /{campaign_id} daily_budget 分×100)或关停(status=PAUSED)
     eLTVROAS: =0关停; <0.6降20%; 0.6~0.9降10%; 0.9~1.1不变; 1.1~1.3增10%;
               1.3~1.6增20%; 1.6~2增30%; >2增40%；降后<39 关停
  4) 全部动作 + 拒审汇总，发飞书私聊给屹恒

用法:
  python3 scripts/fb-android-autopilot.py           # 真实执行（换素材/调预算/关停/发飞书）
  python3 scripts/fb-android-autopilot.py --dry-run  # 只算不改、不发
  python3 scripts/fb-android-autopilot.py --retry-budget  # 次日 00:10：重试昨天没降成的降预算
"""
import os, sys, json, time, urllib.request, urllib.parse, subprocess, datetime
import http.cookiejar

DRY = "--dry-run" in sys.argv
WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── 常量 ──────────────────────────────────────────────────────────
GRAPH = "https://graph.facebook.com/v25.0"
ACT = "act_646387524897026"          # 省广_Dora_And_3_syh_Agentic
OPERATOR = "syh"
PRODUCT = "Dora And"                  # 面板产品名
CAMP_PREFIX = "Dora And_syh_"        # 本账户 syh 建的安卓广告前缀
CHANNEL = "FB"

# 建广告固定资产（换素材建 creative 用，与 create 脚本一致）
FB_APP_ID = "774714691621452"
STORE_URL = "http://play.google.com/store/apps/details?id=com.doramatch.app"
PAGE_ID = "717745171433271"
IG_USER_ID = "17841477175558188"
CTA_TYPE = "INSTALL_MOBILE_APP"
TITLES = ["Singles nearby\U0001FAE6", "Ready to date?\U0001F49E"]
BODIES = ["Dating in your town\U0001F49E", "Find the love you're looking for",
          "Meet girls online!\U0001F447\U0001F3FB"]
CREATIVE_FEATURES_OPT_IN = ["enhance_cta", "inline_comment",
                            "text_optimizations", "video_auto_crop"]

DASH = "http://127.0.0.1:8081"
ADMIN_USER, ADMIN_PASS = "admin", "d3dkJdSXvkuuYZoqg_5O4Q"
YIHENG_OPENID = "ou_b2467dac5ff1d686fb48ccf1fbaa0c0d"
LARK = os.path.expanduser("~/.npm-global/bin/lark-cli")

COST_THRESHOLD = 20.0    # 消耗大于此才调整（与 TT 一致）
MIN_BUDGET = 39.0        # 降预算后低于此则关停（与 TT 一致）
GREY_STOP = 3            # 灰名单满此不再用于新建
GREY_BLACK = 5           # 灰名单满此进黑名单全删

RETRY_FILE = os.path.join(WS, "output", "fb-budget-retry-android.json")
LIB_FP = os.path.join(WS, "config", "fb-android-material-lib.json")
BLACKLIST_FP = os.path.join(WS, "config", "fb-material-blacklist.json")
GREYLIST_FP = os.path.join(WS, "config", "fb-material-greylist.json")
SEG_LIST = ['Dora', 'Romi', 'Doni', 'Luma', 'Jovia', 'GraceChat', 'Kira', 'Nalo']


def get_token():
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


# ── 名单归一化 & 读写 ─────────────────────────────────────────────
def norm_key(name):
    if not name:
        return ""
    base = name
    for ext in (".mp4", ".mov"):
        if base.lower().endswith(ext):
            base = base[:-4]
            break
    return "_".join(s for s in base.split("_") if s not in SEG_LIST).lower()


def load_json(fp, default):
    try:
        return json.load(open(fp))
    except Exception:
        return default


def save_json(fp, obj):
    if DRY:
        return
    tmp = fp + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, fp)


def load_lib():
    return load_json(LIB_FP, {})


# ── FB API ────────────────────────────────────────────────────────
def fb_get(path, params):
    params = dict(params, access_token=TOKEN)
    url = f"{GRAPH}/{path}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except Exception:
            return {"error": {"message": str(e)}}


def fb_post(path, params):
    params = dict(params, access_token=TOKEN)
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(f"{GRAPH}/{path}", data=data)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=120).read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except Exception:
            return {"error": {"message": str(e)}}


def fb_delete(node):
    url = f"{GRAPH}/{node}?access_token=" + urllib.parse.quote(TOKEN)
    req = urllib.request.Request(url, method="DELETE")
    try:
        return json.loads(urllib.request.urlopen(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except Exception:
            return {"error": {"message": str(e)}}


def build_creative(fn, vid, thumb):
    """建一个 creative（换素材用）。返回 creative_id 或 None。"""
    feats = {f: {"enroll_status": "OPT_IN"} for f in CREATIVE_FEATURES_OPT_IN}
    story = {"page_id": PAGE_ID, "instagram_user_id": IG_USER_ID,
             "video_data": {"video_id": vid, "image_url": thumb or "",
                            "call_to_action": {"type": CTA_TYPE, "value": {"link": STORE_URL}}}}
    afs = {"titles": [{"text": t} for t in TITLES],
           "bodies": [{"text": b} for b in BODIES],
           "optimization_type": "DEGREES_OF_FREEDOM"}
    dof = {"creative_features_spec": feats}
    cr = fb_post(f"{ACT}/adcreatives", {
        "name": fn,
        "object_story_spec": json.dumps(story),
        "asset_feed_spec": json.dumps(afs),
        "degrees_of_freedom_spec": json.dumps(dof)})
    return cr.get("id"), cr


# ── dashboard 登录 cookie ─────────────────────────────────────────
_cj = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cj),
                                      urllib.request.HTTPRedirectHandler())


def dash_login():
    data = urllib.parse.urlencode({"username": ADMIN_USER, "password": ADMIN_PASS}).encode()
    last = None
    for _ in range(4):
        req = urllib.request.Request(f"{DASH}/login", data=data)
        try:
            _opener.open(req, timeout=30); return True
        except urllib.error.HTTPError:
            return True
        except Exception as e:
            last = e; time.sleep(10)
    raise RuntimeError(f"dashboard 登录超时: {last}")


def dash_get(path):
    last = None
    for _ in range(3):
        try:
            req = urllib.request.Request(f"{DASH}{path}")
            return json.loads(_opener.open(req, timeout=90).read())
        except Exception as e:
            last = e; time.sleep(8)
    raise last


# ── 远端取数（eLTV + 修正系数走远端优先，与 TT 一致）──────────────
RICHANG_BASE = "https://ug-data-callback.sitinai.com"
RICHANG_SESSION_FP = os.path.join(WS, "config", "richang-session.json")
RICHANG_UA = "Mozilla/5.0 (X11; Linux x86_64) richang-autopilot"
_richang_warn = []


def _richang_cookie():
    try:
        s = json.load(open(RICHANG_SESSION_FP))
        cv = s.get("dashboard_session", "")
        exp = s.get("exp_ms", 0)
        if not cv:
            return None, "session 文件无 cookie"
        if exp and exp < time.time() * 1000:
            return None, "session cookie 已过期"
        return cv, None
    except Exception as e:
        return None, f"读 session 文件失败: {e}"


def richang_get(path):
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
                raise RuntimeError("远端 401（cookie 失效）")
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
    env = dict(os.environ)
    env["PATH"] = os.path.expanduser("~/.npm-global/bin") + ":" + env.get("PATH", "")
    try:
        out = subprocess.run([LARK, "im", "+messages-send", "--as", "bot",
                              "--user-id", YIHENG_OPENID, "--text", text],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             universal_newlines=True, timeout=60, env=env)
        if '"message_id"' in (out.stdout + out.stderr):
            print("✅ 飞书已发送")
        else:
            print("⚠️ 飞书发送可能失败:", (out.stdout + out.stderr)[:300])
    except Exception as e:
        print("⚠️ 飞书异常:", e)


# ── 日期 & eLTV/系数取值 ──────────────────────────────────────────
def today_bj():
    return (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).strftime("%Y-%m-%d")


def yesterday_bj():
    return (datetime.datetime.utcnow() + datetime.timedelta(hours=8) - datetime.timedelta(days=1)).strftime("%Y-%m-%d")


def get_eltv_mult(elt, product, channel="FB"):
    m = elt.get(product)
    if not m:
        return None
    if channel in m and m[channel].get("d180"):
        return m[channel]["d180"]
    for ch in ("FB", "GG", "TT"):
        if m.get(ch, {}).get("d180"):
            return m[ch]["d180"]
    return m.get("d180")


def get_corr_factor(cf, product, channel="FB"):
    f = cf.get(product)
    if f is None:
        return 1.0
    if isinstance(f, (int, float)):
        return f          # 安卓单系数
    if channel == "FB":
        return f.get("fb", 1) or 1
    return f.get("other", 1) or 1


# ── 阶梯规则（与 TT 完全一致）──────────────────────────────────────
def budget_action(eltv_roas):
    if eltv_roas == 0:            return ("stop", None)
    if eltv_roas < 0.6:          return ("adjust", 0.80)
    if eltv_roas < 0.9:          return ("adjust", 0.90)
    if eltv_roas < 1.1:          return ("keep", 1.0)
    if eltv_roas < 1.3:          return ("adjust", 1.10)
    if eltv_roas < 1.6:          return ("adjust", 1.20)
    if eltv_roas < 2.0:          return ("adjust", 1.30)
    return ("adjust", 1.40)


# ── 降预算失败重试队列 ─────────────────────────────────────────────
def _load_retry():
    return load_json(RETRY_FILE, [])


def _save_retry(items):
    save_json(RETRY_FILE, items)


def _queue_retry(cid, cname, target_bud_cents, er):
    items = _load_retry()
    items = [x for x in items if x.get("campaign_id") != cid]
    items.append({"campaign_id": cid, "campaign_name": cname,
                  "target_budget_cents": target_bud_cents, "eltvRoas": round(er, 2),
                  "queued_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M")})
    _save_retry(items)


def run_budget_retry():
    items = _load_retry()
    lines = ["🌙 FB 安卓 降预算补偿（00:10）"]
    if not items:
        lines.append("  队列为空，无需补偿。"); feishu("\n".join(lines)); print("\n".join(lines)); return
    still = []
    for it in items:
        cid = it["campaign_id"]; cname = it.get("campaign_name", cid); tb = it["target_budget_cents"]
        if DRY:
            lines.append(f"  [DRY] 将重试 {cname} → ${tb/100:.0f}"); still.append(it); continue
        r = fb_post(cid, {"daily_budget": str(int(tb))})
        if r.get("success") or r.get("id"):
            lines.append(f"  ✅ {cname} 降到 ${tb/100:.0f} 成功")
        else:
            lines.append(f"  ❌ {cname} 重试仍失败: {json.dumps(r.get('error', r), ensure_ascii=False)[:80]}（保留队列）")
            still.append(it)
        time.sleep(0.5)
    _save_retry(still)
    feishu("\n".join(lines)); print("\n".join(lines))


# ── 拒审换素材 ────────────────────────────────────────────────────
def pick_clean_material(lib, grey, blacklist, used_norm_keys):
    """从库挑一个干净素材（counts<GREY_STOP 且非黑名单，优先本 adset 未用过的）。
    返回 (norm_key, mat_dict) 或 (None, None)。"""
    fallback = None
    for k, v in lib.items():
        if not v.get("video_id"):
            continue
        if k in blacklist or grey.get(k, 0) >= GREY_STOP:
            continue
        if k not in used_norm_keys:
            return k, v
        if fallback is None:
            fallback = (k, v)
    return fallback if fallback else (None, None)


def handle_rejections(lines):
    """扫账户所有我们建的 ENABLE campaign 下的 ad，处理 DISAPPROVED。
    返回 my_camps（campaign 列表，供调预算复用）。"""
    grey_raw = load_json(GREYLIST_FP, {"counts": {}})
    grey = {norm_key(k): int(v) for k, v in grey_raw.get("counts", {}).items()}
    # 保留原始 key 大小写以便回写（用归一化后作为 canonical key）
    grey_counts = dict(grey)
    black_raw = load_json(BLACKLIST_FP, {"materials": []})
    black_mats = list(black_raw.get("materials", []))
    blacklist = {norm_key(m) for m in black_mats if m}
    lib = load_lib()

    # 1) 列本账户所有 campaign（含 effective_status / daily_budget）
    my_camps = []
    after = None
    for _ in range(20):
        params = {"fields": "id,name,daily_budget,effective_status,configured_status", "limit": 200}
        if after:
            params["after"] = after
        r = fb_get(f"{ACT}/campaigns", params)
        if "error" in r:
            lines.append(f"⚠️ 列 campaign 失败: {json.dumps(r['error'], ensure_ascii=False)[:100]}")
            break
        for c in r.get("data", []):
            nm = c.get("name", "")
            if nm.startswith(CAMP_PREFIX) and c.get("effective_status") == "ACTIVE":
                my_camps.append(c)
        paging = r.get("paging", {})
        after = paging.get("cursors", {}).get("after")
        if not r.get("data") or "next" not in paging:
            break

    # 2) 读每个 campaign 下的 ad + effective_status + creative video
    reject_actions = []
    changed_grey = False
    for c in my_camps:
        cid = c["id"]; cname = c["name"]
        ar = fb_get(f"{cid}/ads", {
            "fields": "id,name,effective_status,adset_id,"
                      "creative{id,video_id,object_story_spec}",
            "limit": 100})
        ads = ar.get("data", [])
        # 收集该 adset 已用素材归一化名（避免换成同款）
        for a in ads:
            if a.get("effective_status") != "DISAPPROVED":
                continue
            fn = a.get("name", "")
            k = norm_key(fn)
            # 灰名单 +1
            grey_counts[k] = grey_counts.get(k, 0) + 1
            cnt = grey_counts[k]
            changed_grey = True
            adid = a["id"]; asid = a.get("adset_id")

            if cnt >= GREY_BLACK:
                # 满 5 → 进黑名单 + 删该 ad
                if fn and fn not in black_mats:
                    black_mats.append(fn)
                    blacklist.add(k)
                if DRY:
                    reject_actions.append(f"  🚫 {cname} / {fn}: 拒审第{cnt}次 → 满{GREY_BLACK}进黑名单+删ad [{adid}]（DRY）")
                else:
                    d = fb_delete(adid)
                    ok = d.get("success") or (isinstance(d, dict) and not d.get("error"))
                    reject_actions.append(f"  🚫 {cname} / {fn}: 拒审第{cnt}次 → 进黑名单+删ad {'✅' if ok else '❌'+json.dumps(d.get('error',{}),ensure_ascii=False)[:60]}")
                continue

            # 1~4 次 → 换同一 ad 的素材（换 creative 保留 ad_id）
            # 该 adset 已用素材归一化名（含当前拒审素材，避免换回同款）
            used = set()
            for aa in ads:
                if aa.get("adset_id") == asid:
                    used.add(norm_key(aa.get("name", "")))
            nk, mat = pick_clean_material(lib, grey_counts, blacklist, used)
            if not mat:
                reject_actions.append(f"  ⚠️ {cname} / {fn}: 拒审第{cnt}次 → 库中无干净素材可换，暂保留（不删）")
                continue
            newfn = mat["file_name"]
            if DRY:
                reject_actions.append(f"  🔁 {cname} / {fn}: 拒审第{cnt}次 → 换素材[{newfn}] 保留ad[{adid}]（DRY）")
                continue
            crid, cr = build_creative(newfn, mat["video_id"], mat.get("thumb"))
            if not crid:
                reject_actions.append(f"  ❌ {cname} / {fn}: 换素材建creative失败 {json.dumps(cr.get('error',{}),ensure_ascii=False)[:60]}")
                continue
            # 换 creative + 同步 ad 名为新素材名
            u = fb_post(adid, {"creative": json.dumps({"creative_id": crid}), "name": newfn})
            if u.get("success") or u.get("id"):
                reject_actions.append(f"  🔁 {cname}: {fn} 拒审第{cnt}次 → 换成 {newfn}（ad[{adid}]保留）✅")
            else:
                reject_actions.append(f"  ❌ {cname} / {fn}: 换creative失败 {json.dumps(u.get('error',{}),ensure_ascii=False)[:60]}")
            time.sleep(0.5)
        time.sleep(0.3)

    # 回写灰/黑名单
    if changed_grey and not DRY:
        grey_raw["counts"] = grey_counts
        grey_raw["_updated"] = today_bj()
        save_json(GREYLIST_FP, grey_raw)
        black_raw["materials"] = black_mats
        black_raw["_updated"] = today_bj()
        save_json(BLACKLIST_FP, black_raw)

    if reject_actions:
        lines.append(f"\n⚠️ 拒审处理 {len(reject_actions)} 条：")
        lines += reject_actions
    else:
        lines.append("\n✅ 无拒审广告")
    return my_camps


# ── 主流程 ────────────────────────────────────────────────────────
def main():
    if not TOKEN:
        print("❌ 缺 FB token"); sys.exit(1)
    if "--retry-budget" in sys.argv:
        run_budget_retry(); return

    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [f"🤖 FB 安卓自动运维 {ts}" + ("（DRY-RUN）" if DRY else ""),
             f"账户: 省广_Dora_And_3_syh_Agentic（{ACT}）"]

    # ===== 1. 拒审处理（换素材/删/黑灰名单）=====
    my_camps = handle_rejections(lines)

    # ===== 2. 读面板算 eLTVROAS =====
    d = today_bj(); dy = yesterday_bj()
    dash_login()
    elt, elt_src = fetch_eltv(d)
    cf, cf_src = fetch_corr(d, dy)
    try:
        pbp = dash_get(f"/api/postback/personal?startDate={d}&endDate={d}")
    except Exception as e:
        lines.append(f"\n❌ 读面板失败: {e}（跳过调预算）")
        feishu("\n".join(lines)); return

    lines.append(f"\n📡 数据源：eLTV={elt_src} / 修正系数={cf_src} / 消耗+收入=本机postback")
    if _richang_warn:
        lines.append("⚠️ 远端取数异常（已自动兜底本机）：")
        lines += ["   • " + w for w in _richang_warn]

    emult = get_eltv_mult(elt, PRODUCT, CHANNEL)
    cfac = get_corr_factor(cf, PRODUCT, CHANNEL)

    # 定位 syh → Dora And → FB → campaign
    camp_metrics = {}
    for op in pbp.get("operators", []):
        if op.get("operator") != OPERATOR:
            continue
        for p in op.get("products", []):
            if p.get("product") != PRODUCT:
                continue
            for ch in p.get("channels", []):
                if ch.get("channel") != CHANNEL:
                    continue
                for camp in ch.get("campaigns", []):
                    cost = camp.get("cost", 0) or 0
                    cnr = camp.get("correctedNewUserRevenue")
                    if cnr is None:
                        cnr = (camp.get("newUserRevenue", 0) or 0) * cfac
                    eltv_roas = (cnr / cost * emult) if (cost > 0 and emult) else 0
                    camp_metrics[camp["campaign"]] = {"cost": cost, "eltvRoas": eltv_roas}

    # ===== 3. 调预算/关停 =====
    lines.append("\n📊 调预算/关停：")
    # campaign_name → {id, daily_budget(分)}（FB 权威预算）
    name2camp = {c["name"]: c for c in my_camps}
    for cname, m in sorted(camp_metrics.items()):
        cost, er = m["cost"], m["eltvRoas"]
        cobj = name2camp.get(cname)
        if not cobj:
            continue  # 面板有但不在本账户 ACTIVE campaign（已停/历史）
        cid = cobj["id"]
        cur_cents = int(cobj.get("daily_budget", 0) or 0)
        cur_bud = cur_cents / 100.0
        if cost <= COST_THRESHOLD:
            lines.append(f"  • {cname}: cost=${cost:.1f} ≤20 不动 (eLTVROAS={er:.2f})")
            continue
        act, factor = budget_action(er)
        if act == "stop":
            if not DRY:
                fb_post(cid, {"status": "PAUSED"})
            lines.append(f"  🛑 {cname}: eLTVROAS=0 → 关停 (cost=${cost:.1f})")
        elif act == "keep":
            lines.append(f"  • {cname}: eLTVROAS={er:.2f} 0.9~1.1 不变 (cost=${cost:.1f} bud=${cur_bud:.0f})")
        else:
            new_cents = int(round(cur_cents * factor))
            new_bud = new_cents / 100.0
            if factor < 1 and new_bud < MIN_BUDGET:
                if not DRY:
                    fb_post(cid, {"status": "PAUSED"})
                lines.append(f"  🛑 {cname}: eLTVROAS={er:.2f} 降后=${new_bud:.0f}<39 → 关停 (cost=${cost:.1f})")
            else:
                arrow = "↑" if factor > 1 else "↓"
                pct = int(round(abs(factor - 1) * 100))
                if DRY:
                    lines.append(f"  {arrow} {cname}: eLTVROAS={er:.2f} → {arrow}{pct}% ${cur_bud:.0f}→${new_bud:.0f} (cost=${cost:.1f})")
                else:
                    r = fb_post(cid, {"daily_budget": str(new_cents)})
                    if r.get("success") or r.get("id"):
                        lines.append(f"  {arrow} {cname}: eLTVROAS={er:.2f} → {arrow}{pct}% ${cur_bud:.0f}→${new_bud:.0f} (cost=${cost:.1f})")
                    elif factor < 1:
                        _queue_retry(cid, cname, new_cents, er)
                        lines.append(f"  ⏳ {cname}: eLTVROAS={er:.2f} 降预算失败({json.dumps(r.get('error',{}),ensure_ascii=False)[:50]}) → 目标${new_bud:.0f} 记入次日00:10补偿队列")
                    else:
                        lines.append(f"  ⚠️ {cname}: eLTVROAS={er:.2f} 增预算失败 {json.dumps(r.get('error',{}),ensure_ascii=False)[:60]}")
        time.sleep(0.5)

    if not camp_metrics:
        lines.append("  （面板暂无 syh 的 Dora And FB campaign 数据，可能今天还没消耗）")

    feishu("\n".join(lines))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
