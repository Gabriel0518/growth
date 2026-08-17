#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tiktok-newacct-autopilot.py —— 新增3个安卓账户自动运维（Nalo And / Kira And / Romi And）

复刻 tiktok-android-autopilot.py 的全部逻辑（拒审上报 + eLTVROAS 阶梯调预算/关停 + 灰名单清理），
差异：逐账户循环，每账户用自己的 token / AID / 产品名 / identity_bc_id（灰名单回写素材要带）。

阶梯规则/阈值/eLTV/修正系数/远端取数/降预算重试队列全部与安卓一致。
面板产品名：Nalo And / Kira And / Romi And（dashboard 个人面板 syh→产品→TT→campaign）。

用法:
  python3 tiktok-newacct-autopilot.py            # 真实执行
  python3 tiktok-newacct-autopilot.py --dry-run  # 只算不改不发
  python3 tiktok-newacct-autopilot.py --retry-budget  # 次日00:10降预算补偿
"""
import os, sys, json, time, urllib.request, urllib.parse, subprocess, datetime, http.cookiejar

DRY = "--dry-run" in sys.argv
RETRY = "--retry-budget" in sys.argv
WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ACCT_FP = os.path.join(WS, "config", "tiktok-newacct-accounts.json")

TT_API = "https://business-api.tiktok.com/open_api/v1.3"
DASH = "http://127.0.0.1:8081"
ADMIN_USER, ADMIN_PASS = "admin", "d3dkJdSXvkuuYZoqg_5O4Q"
OPERATOR = "syh"
YIHENG_OPENID = "ou_b2467dac5ff1d686fb48ccf1fbaa0c0d"
LARK = os.path.expanduser("~/.npm-global/bin/lark-cli")

TT_REJECT = {"AD_STATUS_AUDIT_DENY", "AD_STATUS_REVIEW_PARTIALLY_APPROVED",
             "ADGROUP_STATUS_AUDIT_DENY", "ADGROUP_STATUS_REVIEW_PARTIALLY_APPROVED"}
COST_THRESHOLD = 20.0
MIN_BUDGET = 39.0
RETRY_FILE = os.path.join(WS, "output", "tt-budget-retry-newacct.json")

TK = ""  # 每账户切换

def load_tokens():
    t={}
    for l in open("/etc/environment"):
        l=l.strip()
        for k in ["TIKTOK_ACCESS_TOKEN_4","TIKTOK_ACCESS_TOKEN_3","TIKTOK_ACCESS_TOKEN_2","TIKTOK_ACCESS_TOKEN"]:
            if l.startswith(k+"="): t[k]=l.split("=",1)[1].strip().strip('"'); break
    return t
TOKENS = load_tokens()
def load_accounts(): return json.load(open(ACCT_FP)).get("accounts", [])

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

# ── dashboard 登录 cookie ──
_cj = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cj), urllib.request.HTTPRedirectHandler())
def dash_login():
    data = urllib.parse.urlencode({"username": ADMIN_USER, "password": ADMIN_PASS}).encode()
    last=None
    for _ in range(4):
        req = urllib.request.Request(f"{DASH}/login", data=data)
        try: _opener.open(req, timeout=30); return True
        except urllib.error.HTTPError: return True
        except Exception as e: last=e; time.sleep(10)
    raise RuntimeError(f"dashboard 登录超时: {last}")
def dash_get(path):
    last=None
    for _ in range(3):
        try:
            req = urllib.request.Request(f"{DASH}{path}")
            return json.loads(_opener.open(req, timeout=90).read())
        except Exception as e: last=e; time.sleep(8)
    raise last

# ── 远端取数（eLTV + 修正系数必须走远端，失败 fallback 本机）──
RICHANG_BASE = "https://ug-data-callback.sitinai.com"
RICHANG_SESSION_FP = os.path.join(WS, "config", "richang-session.json")
RICHANG_UA = "Mozilla/5.0 (X11; Linux x86_64) richang-autopilot"
_richang_warn = []
def _richang_cookie():
    try:
        s = json.load(open(RICHANG_SESSION_FP)); cv=s.get("dashboard_session",""); exp=s.get("exp_ms",0)
        if not cv: return None,"session 文件无 cookie"
        if exp and exp < time.time()*1000: return None,"session cookie 已过期"
        return cv, None
    except Exception as e: return None, f"读 session 失败: {e}"
def richang_get(path):
    cv, err = _richang_cookie()
    if err: raise RuntimeError(err)
    req = urllib.request.Request(f"{RICHANG_BASE}{path}",
        headers={"Cookie": f"dashboard_session={cv}", "User-Agent": RICHANG_UA})
    for attempt in range(3):
        try: return json.loads(urllib.request.urlopen(req, timeout=40).read())
        except urllib.error.HTTPError as e:
            if e.code==401: raise RuntimeError("远端 401（cookie 失效）")
            if e.code==429:
                try: wait=json.loads(e.read()).get("retryAfterSeconds",3)
                except Exception: wait=3
                time.sleep(min(wait,10)); continue
            raise RuntimeError(f"远端 HTTP {e.code}")
        except Exception as e:
            if attempt==2: raise RuntimeError(f"远端请求失败: {e}")
            time.sleep(3)
    raise RuntimeError("远端多次重试仍失败")
def fetch_eltv(d):
    try:
        r=richang_get(f"/api/ext/eltv?date={d}"); data=r.get("data",{})
        if r.get("cached") and data: return data,"远端"
        raise RuntimeError(f"cached={r.get('cached')} 空")
    except Exception as e:
        _richang_warn.append(f"eLTV 远端失败→本机：{e}")
        return dash_get(f"/api/eltv-multipliers?date={d}").get("multipliers",{}),"本机(fallback)"
def fetch_corr(d, dy):
    try:
        r=richang_get(f"/api/ext/correction-factors?date={dy}"); data=r.get("data",{})
        if r.get("cached") and data: return data,"远端"
        raise RuntimeError(f"cached={r.get('cached')} 空")
    except Exception as e:
        _richang_warn.append(f"修正系数 远端失败→本机：{e}")
        return dash_get(f"/api/correction-factors?date={d}").get("factors",{}),"本机(fallback)"

def feishu(text):
    if DRY: print("\n===== [DRY] 将发飞书 =====\n"+text+"\n========================="); return
    env=dict(os.environ); env["PATH"]=os.path.expanduser("~/.npm-global/bin")+":"+env.get("PATH","")
    try:
        out=subprocess.run([LARK,"im","+messages-send","--as","bot","--user-id",YIHENG_OPENID,"--text",text],
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,universal_newlines=True,timeout=60,env=env)
        print("✅ 飞书已发" if '"message_id"' in (out.stdout+out.stderr) else "⚠️ 飞书失败:"+(out.stdout+out.stderr)[:200])
    except Exception as e: print("⚠️ 飞书异常:",e)

def today_bj(): return (datetime.datetime.utcnow()+datetime.timedelta(hours=8)).strftime("%Y-%m-%d")
def yesterday_bj(): return (datetime.datetime.utcnow()+datetime.timedelta(hours=8)-datetime.timedelta(days=1)).strftime("%Y-%m-%d")

def get_eltv_mult(elt, product, channel="TT"):
    m=elt.get(product)
    if not m: return None
    if channel in m and m[channel].get("d180"): return m[channel]["d180"]
    for ch in ("FB","GG","TT"):
        if m.get(ch,{}).get("d180"): return m[ch]["d180"]
    return m.get("d180")
def get_corr_factor(cf, product, channel="TT"):
    f=cf.get(product)
    if f is None: return 1.0
    if isinstance(f,(int,float)): return f
    if channel=="FB": return f.get("fb",1) or 1
    return f.get("other",1) or 1

def budget_action(er):
    if er==0: return ("stop",None)
    if er<0.6: return ("adjust",0.80)
    if er<0.9: return ("adjust",0.90)
    if er<1.1: return ("keep",1.0)
    if er<1.3: return ("adjust",1.10)
    if er<1.6: return ("adjust",1.20)
    if er<2.0: return ("adjust",1.30)
    return ("adjust",1.40)

# ── 降预算重试队列（跨账户共用一个文件，条目带 aid+token_env）──
def _load_retry():
    try: return json.load(open(RETRY_FILE))
    except Exception: return []
def _save_retry(items):
    try:
        with open(RETRY_FILE,"w") as f: json.dump(items,f,ensure_ascii=False,indent=1)
    except Exception as e: print("⚠️ 写重试队列失败:",e)
def _queue_retry(aid, token_env, cid, cname, tb, er):
    items=_load_retry(); items=[x for x in items if x.get("campaign_id")!=cid]
    items.append({"advertiser_id":aid,"token_env":token_env,"campaign_id":cid,"campaign_name":cname,
                  "target_budget":tb,"eltvRoas":round(er,2),
                  "queued_at":datetime.datetime.now().strftime("%Y-%m-%d %H:%M")})
    _save_retry(items)

def run_budget_retry():
    global TK
    items=_load_retry()
    lines=[f"🌙 TikTok 新增账户 降预算补偿（00:10）"]
    if not items:
        lines.append("  队列为空。"); feishu("\n".join(lines)); print("\n".join(lines)); return
    still=[]
    for it in items:
        aid=it["advertiser_id"]; TK=TOKENS.get(it.get("token_env",""),"")
        cid=it["campaign_id"]; cname=it.get("campaign_name",cid); tb=it["target_budget"]
        if DRY: lines.append(f"  [DRY] 将重试 {cname} → ${tb:.0f}"); still.append(it); continue
        r=tt_post("smart_plus/campaign/update",{"advertiser_id":aid,"campaign_id":cid,"budget":tb})
        if r.get("code")==0:
            lines.append(f"  ✅ {cname} 降到 ${tb:.0f} 成功")
        else:
            lines.append(f"  ❌ {cname} 重试仍失败 code={r.get('code')}（保留队列）"); still.append(it)
        time.sleep(0.5)
    _save_retry(still); feishu("\n".join(lines)); print("\n".join(lines))

# ── 灰名单清理（逐账户，带该账户 identity_bc_id）──
_SEG=['Dora','Romi','Doni','Luma','Jovia','GraceChat','Kira','Nalo','Mora']
def _norm(name):
    if not name: return ""
    base=name[:-4] if str(name).lower().endswith(".mp4") else name
    return "_".join(s for s in str(base).split("_") if s not in _SEG).lower()
def _load_graylist():
    try: return {_norm(m) for m in json.load(open(os.path.join(WS,"config","tiktok-material-graylist.json"))).get("materials",[]) if m}
    except Exception: return set()
def graylist_cleanup(aid, bc_default):
    GL=_load_graylist()
    if not GL: return ["\n🧹 灰名单：空，跳过"]
    hits=[]; total=0; page=1
    while True:
        r=tt_get("smart_plus/ad/get",{"advertiser_id":aid,"page":page,"page_size":50,
            "fields":json.dumps(["smart_plus_ad_id","ad_name","campaign_id","adgroup_id",
                                 "operation_status","secondary_status","creative_list"])})
        if r.get("code")!=0: return [f"\n🧹 灰名单：扫描失败 {r.get('message')}"]
        d=r.get("data",{}); lst=d.get("list",[])
        for ad in lst:
            total+=1
            # 触发状态：部分过审 + 审核中（屹恒 2026-07-22：审核中且命中灰名单也剔素材，重新触发审核）
            if ad.get("secondary_status") not in ("AD_STATUS_REVIEW_PARTIALLY_APPROVED","AD_STATUS_AUDIT"): continue
            cl=ad.get("creative_list",[]) or []
            matched=[fn for fn in [((cr.get("creative_info",{}) or {}).get("video_info",{}) or {}).get("file_name","") for cr in cl] if _norm(fn) in GL]
            if matched: hits.append({"ad_id":ad.get("smart_plus_ad_id"),"camp":ad.get("campaign_id"),"name":ad.get("ad_name")})
        pi=d.get("page_info",{})
        if page>=pi.get("total_page",1) or not lst: break
        page+=1; time.sleep(0.3)
    if not hits: return [f"\n🧹 灰名单：扫 {total} 条，无部分过审命中"]
    out=[f"\n🧹 灰名单：{len(hits)} 条部分过审命中，处理中："]
    for h in hits:
        ad_id=h["ad_id"]; camp=h["camp"]; name=h["name"]
        r=tt_get("smart_plus/ad/get",{"advertiser_id":aid,"filtering":json.dumps({"campaign_ids":[camp]}),
            "fields":json.dumps(["smart_plus_ad_id","ad_name","adgroup_id","creative_list"])})
        if r.get("code")!=0: out.append(f"  ❌ {name}: ad/get失败"); continue
        target=None
        for ad in r.get("data",{}).get("list",[]):
            if str(ad.get("smart_plus_ad_id"))==str(ad_id): target=ad; break
        if not target: out.append(f"  ❌ {name}: 未匹配 ad_id"); continue
        cl=target.get("creative_list",[]) or []; new_cl=[]; removed=[]
        for cr in cl:
            ci=cr.get("creative_info",{}) or {}; vi=ci.get("video_info",{}) or {}; fn=vi.get("file_name","")
            if _norm(fn) in GL: removed.append(fn); continue
            imgs=ci.get("image_info",[]) or []
            new_cl.append({"creative_info":{
                "ad_format":ci.get("ad_format","SINGLE_VIDEO"),
                "identity_id":ci.get("identity_id"),
                "identity_type":ci.get("identity_type","BC_AUTH_TT"),
                "identity_authorized_bc_id":ci.get("identity_authorized_bc_id") or bc_default,
                "video_info":{"video_id":vi.get("video_id"),"file_name":vi.get("file_name")},
                "image_info":[{"web_uri":(im.get("web_uri") if isinstance(im,dict) else im)} for im in imgs],
            }})
        if not removed: out.append(f"  ⏭️ {name}: 实际未含灰名单"); continue
        if not new_cl: out.append(f"  ⚠️ {name}: 移除后为空，跳过"); continue
        if DRY: out.append(f"  [DRY] {name}: {len(cl)}→{len(new_cl)}, 移除 {removed}"); continue
        u=tt_post("smart_plus/ad/update",{"advertiser_id":aid,"smart_plus_ad_id":ad_id,"creative_list":new_cl})
        out.append(f"  ✅ {name}: {len(cl)}→{len(new_cl)}, 移除 {removed}" if u.get("code")==0 else f"  ❌ {name}: 更新失败 {u.get('message')}")
        time.sleep(0.6)
    return out

def run_account(acc, elt, cf, pbp, lines):
    """对单个账户跑：拒审上报 + 调预算/关停 + 灰名单清理。"""
    global TK
    pname=acc["product"]; aid=acc["advertiser_id"]; cname_pref=acc["cname"]
    TK=TOKENS.get(acc["token_env"],"")
    bc=acc.get("identity_bc_id","")
    lines.append(f"\n──── {pname} ({aid}) ────")
    if not TK: lines.append("  ⚠️ token 缺失，跳过"); return

    # 本账户 syh ENABLE campaign
    r=tt_get("campaign/get",{"advertiser_id":aid,
        "fields":json.dumps(["campaign_id","campaign_name","operation_status","budget"]),"page_size":100})
    all_camps=r.get("data",{}).get("list",[])
    my_camps=[c for c in all_camps if "syh_" in c["campaign_name"]
              and c.get("operation_status")=="ENABLE"
              and c["campaign_name"].startswith(cname_pref+"_")]

    # 拒审上报
    rej=[]
    for c in my_camps:
        ar=tt_get("smart_plus/ad/get",{"advertiser_id":aid,
            "filtering":json.dumps({"campaign_ids":[c["campaign_id"]]}),"page_size":20})
        for a in ar.get("data",{}).get("list",[]):
            if a.get("secondary_status","") in TT_REJECT:
                rej.append(f"  • {c['campaign_name']} → {a.get('secondary_status')}")
        time.sleep(0.2)
    lines.append(f"  ⚠️ 拒审 {len(rej)} 条：" if rej else "  ✅ 无拒审")
    lines += rej

    # 算 eLTVROAS（面板 syh→本产品→TT→campaign）
    emult=get_eltv_mult(elt,pname,"TT"); cfac=get_corr_factor(cf,pname,"TT")
    camp_metrics={}
    for op in pbp.get("operators",[]):
        if op["operator"]!=OPERATOR: continue
        for p in op.get("products",[]):
            if p["product"]!=pname: continue
            for ch in p.get("channels",[]):
                if ch["channel"]!="TT": continue
                for camp in ch.get("campaigns",[]):
                    cost=camp.get("cost",0) or 0
                    cnr=camp.get("correctedNewUserRevenue")
                    if cnr is None: cnr=(camp.get("newUserRevenue",0) or 0)*cfac
                    er=(cnr/cost*emult) if (cost>0 and emult) else 0
                    camp_metrics[camp["campaign"]]={"cost":cost,"eltvRoas":er}

    name2camp={c["campaign_name"]:c for c in my_camps}
    if not camp_metrics:
        lines.append("  （面板暂无本产品 TT campaign 数据，今天可能还没消耗）")
    for cname, m in sorted(camp_metrics.items()):
        cost,er=m["cost"],m["eltvRoas"]; cobj=name2camp.get(cname)
        if not cobj: continue
        cid=cobj["campaign_id"]; cur_bud=cobj.get("budget",0)
        if cobj.get("operation_status")!="ENABLE": continue
        if cost<=COST_THRESHOLD:
            lines.append(f"  • {cname}: cost=${cost:.1f}≤20 不动 (eLTVROAS={er:.2f})"); continue
        act,factor=budget_action(er)
        if act=="stop":
            if not DRY: tt_post("campaign/status/update",{"advertiser_id":aid,"campaign_ids":[cid],"operation_status":"DISABLE"})
            lines.append(f"  🛑 {cname}: eLTVROAS=0 → 关停 (cost=${cost:.1f})")
        elif act=="keep":
            lines.append(f"  • {cname}: eLTVROAS={er:.2f} 不变 (cost=${cost:.1f} bud=${cur_bud:.0f})")
        else:
            new_bud=round(cur_bud*factor,2)
            if factor<1 and new_bud<MIN_BUDGET:
                if not DRY: tt_post("campaign/status/update",{"advertiser_id":aid,"campaign_ids":[cid],"operation_status":"DISABLE"})
                lines.append(f"  🛑 {cname}: eLTVROAS={er:.2f} 降后=${new_bud:.0f}<39 → 关停 (cost=${cost:.1f})")
            else:
                arrow="↑" if factor>1 else "↓"; pct=int(round(abs(factor-1)*100))
                if DRY:
                    lines.append(f"  {arrow} {cname}: eLTVROAS={er:.2f} → {arrow}{pct}% ${cur_bud:.0f}→${new_bud:.0f} (cost=${cost:.1f})")
                else:
                    rr=tt_post("smart_plus/campaign/update",{"advertiser_id":aid,"campaign_id":cid,"budget":new_bud})
                    if rr.get("code")==0:
                        lines.append(f"  {arrow} {cname}: eLTVROAS={er:.2f} → {arrow}{pct}% ${cur_bud:.0f}→${new_bud:.0f} (cost=${cost:.1f})")
                    elif factor<1:
                        _queue_retry(aid,acc["token_env"],cid,cname,new_bud,er)
                        lines.append(f"  ⏳ {cname}: 降预算失败(疑撞105% 已花${cost:.1f}) → 目标${new_bud:.0f} 记补偿队列")
                    else:
                        lines.append(f"  ⚠️ {cname}: 增预算失败 code={rr.get('code')}")
        time.sleep(0.5)

    # 灰名单清理
    lines += graylist_cleanup(aid, bc)

def main():
    if RETRY:
        run_budget_retry(); return
    ts=datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines=[f"🤖 TikTok 新增账户自动运维 {ts}"+("（DRY-RUN）" if DRY else "")]
    accounts=load_accounts()
    d=today_bj(); dy=yesterday_bj()
    try:
        dash_login()
        elt,elt_src=fetch_eltv(d); cf,cf_src=fetch_corr(d,dy)
        pbp=dash_get(f"/api/postback/personal?startDate={d}&endDate={d}")
    except Exception as e:
        lines.append(f"❌ 读面板/取数失败: {e}（跳过调预算，仍尝试逐账户拒审+灰名单）")
        feishu("\n".join(lines)); print("\n".join(lines))
        # 面板失败时仍可做拒审+灰名单（不依赖面板）
        elt,cf,pbp={},{},{"operators":[]}
    else:
        lines.append(f"📡 数据源：eLTV={elt_src} / 修正系数={cf_src} / 消耗+收入=本机postback")
        if _richang_warn:
            lines.append("⚠️ 远端取数异常（已兜底本机）："); lines+=["   • "+w for w in _richang_warn]
    for acc in accounts:
        try:
            run_account(acc, elt, cf, pbp, lines)
        except Exception as e:
            lines.append(f"\n❌ {acc.get('product')} 运维异常: {e}")
    feishu("\n".join(lines)); print("\n".join(lines))

if __name__=="__main__":
    try: main()
    except Exception as e:
        import traceback; err=traceback.format_exc()[-800:]; print(err)
        feishu(f"🛑 tiktok-newacct-autopilot 异常\n{err[-400:]}"); sys.exit(1)
