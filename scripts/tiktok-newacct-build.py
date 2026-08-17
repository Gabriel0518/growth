#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tiktok-newacct-build.py —— 新增3个安卓账户每日建广告（Nalo And / Kira And / Romi And）

背景（屹恒 2026-07-20）：新加4个广告账户，第4个未授权暂不接。前3个都是安卓产品，
套用现有安卓建广告模板（FB素材榜 + 同名寻址 + APP_ANDROID + AEO/VO），仅改：账户/token/app_id/identity/产品段。
每账户独立 token（171账户分4token），故不能复用 android-daily-build 的单token单账户。

与 tiktok-android-daily-build.py 逻辑一致，差异：
  · 逐账户循环，每账户用自己的 token（config/tiktok-newacct-accounts.json 的 token_env）
  · 每账户1个产品（product::seg）
  · 建广告时把 token 注入到 tiktok-create-android-ad 模块（每账户 reload）

流程/计划完全沿用安卓：AEO×2($18/$21) + VO×2(0.3/0.35)，$50/天 ENABLE。
0素材守卫、幂等查重、黑名单过滤、--lib-only 纯库内、--dry-run、--test 全部对齐。

用法:
  python3 tiktok-newacct-build.py --dry-run       # 只寻址不建
  python3 tiktok-newacct-build.py --test          # 每账户建1条 VO_1 DISABLE 验证
  python3 tiktok-newacct-build.py --lib-only      # 纯库内直取（晚上23:40用，配合中午预热）
  python3 tiktok-newacct-build.py                 # 正式：每账户 AEO×2+VO×2 ENABLE $50/天

跳过: scripts/.skip_build_date_newacct==今天 则跳过；产品级暂停复用 config/tiktok-build-paused-products.json。
黑/灰名单与iOS/安卓共用。
"""
import os, sys, json, time, hashlib, urllib.request, urllib.parse, subprocess, datetime, importlib.util

DRY = "--dry-run" in sys.argv
TEST = "--test" in sys.argv
LIB_ONLY = "--lib-only" in sys.argv
WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ACCT_FP = os.path.join(WS, "config", "tiktok-newacct-accounts.json")
DATE_TAG = None

PLANS = [("AEO",1,18),("AEO",2,21),("VO",1,0.3),("VO",2,0.35)]
PLANS_TEST = [("VO",1,0.3)]

SEG_LIST = ['Dora','Romi','Doni','Luma','Jovia','GraceChat','Kira','Nalo','Mora']
CREATIVE_DIR = os.path.join(WS, "dashboard", "data")
BLACKLIST_FP = os.path.join(WS, "config", "tiktok-material-blacklist.json")
PAUSED_FP = os.path.join(WS, "config", "tiktok-build-paused-products.json")

XMP_HOST="xmp-open.mobvista.com"; XMP_CID="d607c5992ba7c40f19d9834da9b425e6"; XMP_SEC="5520f711776d92ab13e8683c72e0fd30"
TT_API="https://business-api.tiktok.com/open_api/v1.3"
YIHENG="ou_b2467dac5ff1d686fb48ccf1fbaa0c0d"; LARK=os.path.expanduser("~/.npm-global/bin/lark-cli")

# 当前账户 token（每账户循环时切换）
TK = ""

def load_tokens():
    t={}
    for l in open("/etc/environment"):
        l=l.strip()
        for k in ["TIKTOK_ACCESS_TOKEN_4","TIKTOK_ACCESS_TOKEN_3","TIKTOK_ACCESS_TOKEN_2","TIKTOK_ACCESS_TOKEN"]:
            if l.startswith(k+"="): t[k]=l.split("=",1)[1].strip().strip('"'); break
    return t
TOKENS = load_tokens()

def load_accounts():
    d = json.load(open(ACCT_FP))
    return d.get("accounts", [])

def load_paused():
    try:
        d = json.load(open(PAUSED_FP)); return {p for p in d.get("paused", []) if p}
    except Exception as e:
        print(f"⚠️ 暂停开关加载失败({e})，本次不暂停"); return set()

def _norm_key(name):
    if not name: return ""
    base = name[:-4] if name.lower().endswith(".mp4") else name
    return "_".join(s for s in base.split("_") if s not in SEG_LIST).lower()

def load_blacklist():
    try:
        data = json.load(open(BLACKLIST_FP)); return {_norm_key(m) for m in data.get("materials", []) if m}
    except Exception as e:
        print(f"⚠️ 黑名单加载失败({e})"); return set()

def is_blacklisted(name, bl):
    return _norm_key(name) in bl if bl else False

def today_bj(): return (datetime.datetime.utcnow()+datetime.timedelta(hours=8)).strftime("%Y-%m-%d")
def prev(ds,n): return (datetime.datetime.strptime(ds,"%Y-%m-%d")-datetime.timedelta(days=n)).strftime("%Y-%m-%d")

def feishu(text):
    if DRY: print("\n[DRY 飞书]\n"+text); return
    env=dict(os.environ); env["PATH"]=os.path.expanduser("~/.npm-global/bin")+":"+env.get("PATH","")
    try:
        out=subprocess.run([LARK,"im","+messages-send","--as","bot","--user-id",YIHENG,"--text",text],
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,universal_newlines=True,timeout=60,env=env)
        print("✅ 飞书已发" if '"message_id"' in (out.stdout+out.stderr) else "⚠️ 飞书失败:"+(out.stdout+out.stderr)[:200])
    except Exception as e: print("⚠️ 飞书异常:",e)

# ── XMP ──
def xmp_post(path, body):
    ts=int(time.time()); sign=hashlib.md5((XMP_SEC+str(ts)).encode()).hexdigest()
    body=dict(body,client_id=XMP_CID,timestamp=ts,sign=sign); p=json.dumps(body).encode()
    req=urllib.request.Request(f"https://{XMP_HOST}{path}",data=p,
        headers={"Content-Type":"application/json","Content-Length":len(p)})
    for _ in range(3):
        try: return json.loads(urllib.request.urlopen(req,timeout=30).read())
        except urllib.error.HTTPError as e:
            try: return json.loads(e.read())
            except: pass
        except Exception: time.sleep(2)
    return {"code":-1}
def xmp_search(name):
    r=xmp_post("/v1/media/material/list",{"material_name":[name],"page":1,"page_size":5})
    if r.get("code")!=0: return None
    data=r.get("data",{}); rows=data.get("data",[]) if isinstance(data,dict) else []
    return rows[0] if rows else None

# ── TT（用当前账户 TK）──
def tt_post(ep,body):
    req=urllib.request.Request(f"{TT_API}/{ep}/",data=json.dumps(body).encode(),
        headers={"Access-Token":TK,"Content-Type":"application/json"})
    try: return json.loads(urllib.request.urlopen(req,timeout=120).read())
    except urllib.error.HTTPError as e: return json.loads(e.read())
def tt_get(ep,params):
    url=f"{TT_API}/{ep}/?"+urllib.parse.urlencode(params)
    req=urllib.request.Request(url,headers={"Access-Token":TK})
    try: return json.loads(urllib.request.urlopen(req,timeout=60).read())
    except urllib.error.HTTPError as e: return json.loads(e.read())

# ── 全局榜（FB 通道，与安卓一致）──
def build_rank():
    d=today_bj(); dates=[prev(d,i) for i in (3,2,1)]
    agg={}
    for ds in dates:
        fp=os.path.join(CREATIVE_DIR,f"creative-{ds}.json")
        if not os.path.exists(fp): continue
        try: data=json.load(open(fp))
        except Exception: continue
        for c in data.get("creatives",[]):
            if c.get("channel")!="FB": continue
            k=(c.get("product",""),c.get("name",""))
            if k not in agg: agg[k]={"name":c.get("name",""),"newUserRevenue":0}
            agg[k]["newUserRevenue"]+=(c.get("newUserRevenue",0) or 0)
    return sorted(agg.values(),key=lambda x:x["newUserRevenue"],reverse=True), dates

def swap(name,target):
    base=name[:-4] if name.lower().endswith(".mp4") else name
    segs=base.split("_")
    for i,s in enumerate(segs):
        if s in SEG_LIST:
            if s!=target: segs[i]=target
            return "_".join(segs)+".mp4"
    return None

def tt_lib_index(aid):
    idx={}; page=1
    while True:
        r=tt_get("file/video/ad/search",{"advertiser_id":aid,"page":page,"page_size":100})
        if r.get("code")!=0: break
        data=r.get("data",{}); lst=data.get("list",[])
        for v in lst:
            fn=v.get("file_name"); vid=v.get("video_id")
            if fn and vid and fn not in idx: idx[fn]=vid
        pi=data.get("page_info",{})
        if page>=pi.get("total_page",1) or not lst: break
        page+=1; time.sleep(0.2)
    return idx

def _cover_ok(c):
    w,h=c.get("width"),c.get("height")
    if not w or not h: return True
    return abs((h/w)-1.7778)<0.03

def suggest_cover(aid, vid, tries=6, gap=4):
    for _ in range(tries):
        cr=tt_get("file/video/suggestcover",{"advertiser_id":aid,"video_id":vid})
        lst=cr.get("data",{}).get("list",[])
        if lst:
            for c in lst:
                if c.get("id") and _cover_ok(c): return c["id"]
            if all((c.get("width") and c.get("height")) for c in lst): return None
        time.sleep(gap)
    return None

def existing_campaign_names(aid):
    names=set(); page=1
    while True:
        r=tt_get("campaign/get",{"advertiser_id":aid,"page":page,"page_size":100,
            "fields":json.dumps(["campaign_name","secondary_status"])})
        if r.get("code")!=0: return None
        data=r.get("data",{}); lst=data.get("list",[])
        for c in lst:
            if c.get("secondary_status")=="CAMPAIGN_STATUS_DELETE": continue
            nm=c.get("campaign_name")
            if nm: names.add(nm)
        pi=data.get("page_info",{})
        if page>=pi.get("total_page",1) or not lst: break
        page+=1; time.sleep(0.2)
    return names

def resolve(aid, rank, target, need=10, lib=None, bl=None, lib_only=None):
    if lib is None: lib=tt_lib_index(aid)
    if bl is None: bl=load_blacklist()
    if lib_only is None: lib_only=LIB_ONLY
    picked=[]; seen=set(); skipped=[]
    for r in rank:
        if len(picked)>=need: break
        if is_blacklisted(r["name"], bl): skipped.append(r["name"]); continue
        nn=swap(r["name"],target)
        if not nn or nn in seen: continue
        seen.add(nn)
        vid=lib.get(nn)
        if vid:
            cover=suggest_cover(aid, vid, tries=3, gap=2)
            if cover: picked.append([vid,cover,nn]); continue
        if lib_only: continue
        row=xmp_search(nn); time.sleep(0.35)
        if not (row and row.get("file_url")): continue
        r2=tt_post("file/video/ad/upload",{"advertiser_id":aid,"upload_type":"UPLOAD_BY_URL","video_url":row["file_url"],"file_name":nn})
        if r2.get("code")!=0: continue
        data=r2.get("data"); uvid=data[0]["video_id"] if isinstance(data,list) else data.get("video_id")
        time.sleep(3)
        cover=suggest_cover(aid, uvid, tries=12, gap=5)
        if cover: picked.append([uvid,cover,nn])
    if skipped: print(f"  [黑名单] 跳过 {len(skipped)} 个: {skipped}")
    return picked

def load_create_module(token):
    """加载 tiktok-create-android-ad 模块，并把该模块的 TOKEN 替换为当前账户 token。"""
    spec=importlib.util.spec_from_file_location("andad_dyn",os.path.join(WS,"scripts","tiktok-create-android-ad.py"))
    m=importlib.util.module_from_spec(spec)
    os.environ["TIKTOK_ACCESS_TOKEN"]=token   # 模块 import 时读 os.environ["TIKTOK_ACCESS_TOKEN"]
    spec.loader.exec_module(m)
    m.TOKEN=token                              # 双保险：显式覆盖
    return m

def main():
    global TK, DATE_TAG
    d=today_bj(); dt=datetime.datetime.strptime(d,"%Y-%m-%d"); DATE_TAG=dt.strftime("%y%m%d")
    plans = PLANS_TEST if TEST else PLANS
    op_status = "DISABLE" if TEST else "ENABLE"
    need = 10

    skip_fp=os.path.join(WS,"scripts",".skip_build_date_newacct")
    if not TEST and os.path.exists(skip_fp) and open(skip_fp).read().strip()==d:
        print(f"跳过新建（标记 {d}）")
        if not DRY:
            os.remove(skip_fp); feishu(f"🌙 {d} 新增账户建广告：按你要求今天跳过。标记已清除。")
        return

    accounts=load_accounts()
    rank,dates=build_rank()
    bl=load_blacklist()
    paused=load_paused()
    tag = "（DRY）" if DRY else ("（TEST DISABLE）" if TEST else "")
    if LIB_ONLY: tag += "（纯库内）"
    lines=[f"🌙 TikTok 新增账户建广告 {d}{tag}",
           f"账户数: {len(accounts)}（Nalo/Kira/Romi And）",
           f"素材榜窗口(FB): {dates[0]}~{dates[-1]}（3天），全局{len(rank)}条",
           f"素材黑名单: {len(bl)} 条"]
    if paused: lines.append(f"⛔️ 暂停: {sorted(paused)}")

    total_built=0; skipped_dup=0; zero_mat=[]

    for acc in accounts:
        pname=acc["product"]; aid=acc["advertiser_id"]; seg=acc["seg"]; cname_pref=acc["cname"]
        TK=TOKENS.get(acc["token_env"],"")
        if not TK:
            lines.append(f"\n{pname}: ⚠️ token {acc['token_env']} 缺失，跳过"); continue
        if pname in paused:
            lines.append(f"\n{pname}: ⛔️ 已暂停"); continue

        lib=tt_lib_index(aid)
        if DRY:
            mats=resolve(aid,rank,seg,need,lib=lib,bl=bl)
            hits=sum(1 for m in mats if m[2] in lib)
            lines.append(f"\n{pname} ({aid}): TT库{len(lib)}个，备好 {len(mats)} 条（库内直取 {hits}）")
            for m in mats: lines.append(f"      - {m[2]}")
            continue

        andad=load_create_module(TK)
        exist=existing_campaign_names(aid)
        if exist is None:
            lines.append(f"\n{pname}: ⚠️ 查重失败，不做幂等"); exist=set()
        plan_names=[f"{cname_pref}_syh_{DATE_TAG}_{opt}_{seq}" for opt,seq,_ in plans]
        if exist and all(n in exist for n in plan_names):
            lines.append(f"\n{pname}: 今日 campaign 均已存在，跳过（幂等）"); skipped_dup+=len(plans); continue

        tt=resolve(aid,rank,seg,need,lib=lib,bl=bl)
        lines.append(f"\n{pname} ({aid}): TT库{len(lib)}个，备好素材 {len(tt)} 条")
        if not tt:
            lines.append(f"  ⚠️ 0 素材，跳过该产品，不建空壳"); zero_mat.append(pname); continue
        for opt,seq,bid in plans:
            cname=f"{cname_pref}_syh_{DATE_TAG}_{opt}_{seq}"
            if cname in exist:
                lines.append(f"  ⏭️ {cname} 已存在，跳过"); skipped_dup+=1; continue
            cfg={"advertiser_id":aid,"app_id":acc["app_id"],"identity_id":acc["identity"],
                 "identity_bc_id":acc.get("identity_bc_id"),
                 "opt_type":opt,"bid":bid,"campaign_name":cname,"op_status":op_status,"materials":tt}
            try:
                andad.main(cfg); total_built+=1; exist.add(cname)
                lines.append(f"  ✅ {cname} bid={bid} 素材{len(tt)} [{op_status}]")
            except Exception as e:
                lines.append(f"  ❌ {cname} 建失败: {e}")
            time.sleep(2)

    if DRY:
        print("\n".join(lines)); feishu("\n".join(lines)); return
    lines.append(f"\n共建成 {total_built} 条 [{op_status}]"+(f"（幂等跳过 {skipped_dup}）" if skipped_dup else ""))
    if zero_mat:
        lines.append(f"⚠️ 0 素材跳过（未建，避免空壳）: {zero_mat}")
    print("\n".join(lines)); feishu("\n".join(lines))

if __name__=="__main__":
    try:
        main()
    except Exception as e:
        import traceback; err=traceback.format_exc()[-800:]; print(err)
        feishu(f"🛑 tiktok-newacct-build 异常中止\n{err[-400:]}"); sys.exit(1)
