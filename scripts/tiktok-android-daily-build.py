#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tiktok-android-daily-build.py —— 安卓账户每日新建广告（Doni And + Dora And + Jovia And）
账户: 7559144904526708753 (省广_Dora_Doni_Jovia_And_syh_Agentic)

流程（复刻 iOS daily-build，改动: ①素材榜用 FB 通道 ②走安卓建广告脚本 ③本账户三产品）:
  1) 读 dashboard 素材面板 creative-*.json，最近3天聚合(product::name 累加 newUserRevenue)，
     筛 FB 通道，全局(不分产品)按 newUserRevenue 降序 → 全局榜
  2) 同名寻址：产品段换成目标(Doni/Dora/Jovia)，优先 TT 素材库复用，否则 XMP 精确搜 file_url 上传，
     凑满 need 条/产品；黑名单命中直接跳过顺延
  3) 上传到 TT (UPLOAD_BY_URL) + 取封面
  4) 调 tiktok-create-android-ad.py 建广告
  5) 飞书汇报

用法:
  python3 tiktok-android-daily-build.py --dry-run       # 只跑榜单+寻址，不上传不建广告
  python3 tiktok-android-daily-build.py --test          # 每产品建 1 条 VO_1、DISABLE(暂停验证)、素材10条
  python3 tiktok-android-daily-build.py                 # 正式: 每产品 AEO×2 + VO×2，ENABLE $50/天

跳过机制(同 iOS): scripts/.skip_build_date_android == 今天 则跳过；
  产品级暂停: config/tiktok-build-paused-products.json 的 paused 数组(产品 key: "Doni And"/"Dora And"/"Jovia And")。
黑名单/灰名单: 与 iOS 共用 config/tiktok-material-blacklist.json / graylist.json。
"""
import os, sys, json, time, hashlib, urllib.request, urllib.parse, subprocess, datetime, importlib.util

DRY = "--dry-run" in sys.argv
TEST = "--test" in sys.argv
LIB_ONLY = "--lib-only" in sys.argv   # 纯库内模式：只走 TT 素材库直取，砍掉 XMP 上传兜底
WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

AID = "7559144904526708753"
DATE_TAG = None

PRODUCTS = {
    "Doni And":  {"app_id":"7571754591199281159","identity":"6a413d04-8ef6-5910-b382-8f2dca3057cb","seg":"Doni","cname":"Doni And"},
    "Dora And":  {"app_id":"7553503763386908689","identity":"bdb607d7-56cc-59b6-803f-c60f7bd85635","seg":"Dora","cname":"Dora And"},
    "Jovia And": {"app_id":"7585065113720225808","identity":"d5c65e1b-ca66-55f9-be50-3d40a879e7c6","seg":"Jovia","cname":"Jovia And"},
}
# 正式计划: VO 0.3/0.35 各一条 + AEO 18/21 各一条（屹恒 2026-07-20 定）
PLANS = [("AEO",1,18),("AEO",2,21),("VO",1,0.3),("VO",2,0.35)]
# 测试计划: 每产品 1 条 VO_1
PLANS_TEST = [("VO",1,0.3)]

SEG_LIST = ['Dora','Romi','Doni','Luma','Jovia','GraceChat','Kira','Nalo','Mora']
CREATIVE_DIR = os.path.join(WS, "dashboard", "data")
BLACKLIST_FP = os.path.join(WS, "config", "tiktok-material-blacklist.json")
PAUSED_FP = os.path.join(WS, "config", "tiktok-build-paused-products.json")

def load_paused():
    try:
        d = json.load(open(PAUSED_FP))
        return {p for p in d.get("paused", []) if p}
    except Exception as e:
        print(f"⚠️ 暂停开关加载失败({e})，本次不暂停任何产品")
        return set()

def _norm_key(name):
    if not name: return ""
    base = name[:-4] if name.lower().endswith(".mp4") else name
    segs = [s for s in base.split("_") if s not in SEG_LIST]
    return "_".join(segs).lower()

def load_blacklist():
    try:
        data = json.load(open(BLACKLIST_FP))
        return {_norm_key(m) for m in data.get("materials", []) if m}
    except Exception as e:
        print(f"⚠️ 黑名单加载失败({e})，本次不启用黑名单")
        return set()

def is_blacklisted(name, bl):
    return _norm_key(name) in bl if bl else False

XMP_HOST="xmp-open.mobvista.com"; XMP_CID="d607c5992ba7c40f19d9834da9b425e6"; XMP_SEC="5520f711776d92ab13e8683c72e0fd30"
TT_API="https://business-api.tiktok.com/open_api/v1.3"
YIHENG="ou_b2467dac5ff1d686fb48ccf1fbaa0c0d"; LARK=os.path.expanduser("~/.npm-global/bin/lark-cli")

def tk():
    for l in open("/etc/environment"):
        l=l.strip()
        if l.startswith("TIKTOK_ACCESS_TOKEN="): return l.split("=",1)[1].strip().strip('"')
    return os.environ.get("TIKTOK_ACCESS_TOKEN","")
TK=tk()

def today_bj(): return (datetime.datetime.utcnow()+datetime.timedelta(hours=8)).strftime("%Y-%m-%d")
def prev(ds,n):
    d=datetime.datetime.strptime(ds,"%Y-%m-%d")-datetime.timedelta(days=n); return d.strftime("%Y-%m-%d")

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

# ── TT ──
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

# ── 1. 全局榜（FB 通道）──
def build_rank():
    d=today_bj(); dates=[prev(d,i) for i in (3,2,1)]
    agg={}
    for ds in dates:
        fp=os.path.join(CREATIVE_DIR,f"creative-{ds}.json")
        if not os.path.exists(fp): continue
        data=json.load(open(fp))
        for c in data.get("creatives",[]):
            if c.get("channel")!="FB": continue     # ★ 安卓用 FB 榜
            k=(c.get("product",""),c.get("name",""))
            if k not in agg: agg[k]={"name":c.get("name",""),"newUserRevenue":0}
            agg[k]["newUserRevenue"]+=(c.get("newUserRevenue",0) or 0)
    rows=sorted(agg.values(),key=lambda x:x["newUserRevenue"],reverse=True)
    return rows, dates

# ── 2. 同名寻址 ──
def swap(name,target):
    base=name[:-4] if name.lower().endswith(".mp4") else name
    segs=base.split("_")
    for i,s in enumerate(segs):
        if s in SEG_LIST:
            if s!=target: segs[i]=target
            return "_".join(segs)+".mp4"
    return None

def tt_lib_index():
    idx={}; page=1
    while True:
        r=tt_get("file/video/ad/search",{"advertiser_id":AID,"page":page,"page_size":100})
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
    """仅接受 9:16(约1.778) 竖版封面。TT Smart+ 拒收非标比例(如 AIGC 1080x1790=1.657)，
    会报 'Unsupported image size'。宽高缺失时保守放行(交给 TT 校验)。"""
    w,h=c.get("width"),c.get("height")
    if not w or not h: return True
    return abs((h/w)-1.7778)<0.03

def suggest_cover(vid, tries=6, gap=4):
    """取一个 9:16 合规封面 web_uri；候选全非标则返回 None(调用方顺延该素材)。"""
    for _ in range(tries):
        cr=tt_get("file/video/suggestcover",{"advertiser_id":AID,"video_id":vid})
        lst=cr.get("data",{}).get("list",[])
        if lst:
            for c in lst:
                if c.get("id") and _cover_ok(c): return c["id"]
            # 有候选但全部非标比例 → 该素材封面不可用，别顺延等待，直接判失败
            if all((c.get("width") and c.get("height")) for c in lst):
                return None
        time.sleep(gap)
    return None

def existing_campaign_names():
    names=set(); page=1
    while True:
        r=tt_get("campaign/get",{"advertiser_id":AID,"page":page,"page_size":100,
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

def resolve(rank,target,need=10,lib=None,bl=None,lib_only=None):
    """优先 ① TT 素材库同名直取 → ② XMP 同名寻址+上传。
    lib_only=True（纯库内模式）：只走 ① 库内直取，库内缺的顺延，不走 XMP 上传兜底。"""
    if lib is None: lib=tt_lib_index()
    if bl is None: bl=load_blacklist()
    if lib_only is None: lib_only=LIB_ONLY
    picked=[]; seen=set(); skipped=[]
    for r in rank:
        if len(picked)>=need: break
        if is_blacklisted(r["name"], bl):
            skipped.append(r["name"]); continue
        nn=swap(r["name"],target)
        if not nn or nn in seen: continue
        seen.add(nn)
        vid=lib.get(nn)
        if vid:
            cover=suggest_cover(vid, tries=3, gap=2)
            if cover:
                picked.append([vid,cover,nn]); continue
        if lib_only:
            continue  # 纯库内模式：不走 XMP 上传兜底，顺延下一候选
        row=xmp_search(nn); time.sleep(0.35)
        if not (row and row.get("file_url")): continue
        r2=tt_post("file/video/ad/upload",{"advertiser_id":AID,"upload_type":"UPLOAD_BY_URL","video_url":row["file_url"],"file_name":nn})
        if r2.get("code")!=0: continue
        data=r2.get("data"); uvid=data[0]["video_id"] if isinstance(data,list) else data.get("video_id")
        time.sleep(3)
        cover=suggest_cover(uvid, tries=12, gap=5)
        if cover: picked.append([uvid,cover,nn])
    if skipped: print(f"  [黑名单] 跳过 {len(skipped)} 个素材: {skipped}")
    return picked

def main():
    d=today_bj()
    dt=datetime.datetime.strptime(d,"%Y-%m-%d"); global DATE_TAG
    DATE_TAG=dt.strftime("%y%m%d")
    plans = PLANS_TEST if TEST else PLANS
    op_status = "DISABLE" if TEST else "ENABLE"
    need = 10

    # skip 标记
    skip_fp=os.path.join(WS,"scripts",".skip_build_date_android")
    if not TEST and os.path.exists(skip_fp) and open(skip_fp).read().strip()==d:
        print(f"跳过新建（标记 {d}）")
        if not DRY:
            os.remove(skip_fp)
            feishu(f"🌙 {d} 安卓新建广告任务：按你要求今天跳过。标记已清除。")
        return

    rank,dates=build_rank()
    bl=load_blacklist()
    paused=load_paused()
    tag = "（DRY）" if DRY else ("（TEST暂停验证）" if TEST else "")
    if LIB_ONLY: tag += "（纯库内）"
    lines=[f"🌙 TikTok 安卓新建广告 {d}{tag}",
           f"账户: 省广_Dora_Doni_Jovia_And_syh_Agentic ({AID})",
           f"素材榜窗口(FB): {dates[0]}~{dates[-1]}（3天），全局{len(rank)}条",
           f"素材黑名单: {len(bl)} 条规则"]
    if paused: lines.append(f"⛔️ 暂停: {sorted(paused)}（本次跳过）")

    if DRY:
        lib=tt_lib_index()
        lines.append(f"TT素材库索引: {len(lib)} 个视频")
        for pname,p in PRODUCTS.items():
            if pname in paused:
                lines.append(f"  {pname}: ⛔️ 已暂停，跳过"); continue
            mats=resolve(rank,p["seg"],need,lib=lib,bl=bl)
            hits=sum(1 for m in mats if m[2] in lib)
            lines.append(f"  {pname}: 备好 {len(mats)} 条（库内直取 {hits}）")
            for m in mats: lines.append(f"      - {m[2]}")
        print("\n".join(lines)); feishu("\n".join(lines)); return

    # 加载安卓建广告模块
    spec=importlib.util.spec_from_file_location("andad",os.path.join(WS,"scripts","tiktok-create-android-ad.py"))
    andad=importlib.util.module_from_spec(spec); spec.loader.exec_module(andad)

    total_built=0; skipped_dup=0; zero_mat=[]
    lib=tt_lib_index()
    lines.append(f"TT素材库索引: {len(lib)} 个视频")
    exist=existing_campaign_names()
    if exist is None:
        lines.append("⚠️ 查重失败，本次不做幂等判重"); exist=set()
    else:
        lines.append(f"幂等查重: 账户现存 {len(exist)} 个 campaign 名")

    for pname,p in PRODUCTS.items():
        if pname in paused:
            lines.append(f"\n{pname}: ⛔️ 已暂停"); continue
        plan_names=[f"{p['cname']}_syh_{DATE_TAG}_{opt}_{seq}" for opt,seq,_ in plans]
        if all(n in exist for n in plan_names):
            lines.append(f"\n{pname}: 今日 campaign 均已存在，跳过（幂等）")
            skipped_dup+=len(plans); continue
        tt=resolve(rank,p["seg"],need,lib=lib,bl=bl)
        lines.append(f"\n{pname}: 备好素材 {len(tt)} 条")
        # ── 0 素材守卫：绝不建空壳 campaign/adgroup（07-18 空壳根治）──
        if not tt:
            lines.append(f"  ⚠️ 0 素材，跳过该产品，不建空壳")
            zero_mat.append(pname); continue
        for opt,seq,bid in plans:
            cname=f"{p['cname']}_syh_{DATE_TAG}_{opt}_{seq}"
            if cname in exist:
                lines.append(f"  ⏭️ {cname} 已存在，跳过"); skipped_dup+=1; continue
            cfg={"advertiser_id":AID,"app_id":p["app_id"],"identity_id":p["identity"],
                 "opt_type":opt,"bid":bid,"campaign_name":cname,"op_status":op_status,"materials":tt}
            try:
                andad.main(cfg); total_built+=1; exist.add(cname)
                lines.append(f"  ✅ {cname} bid={bid} 素材{len(tt)} [{op_status}]")
            except Exception as e:
                lines.append(f"  ❌ {cname} 建失败: {e}")
            time.sleep(2)
    lines.append(f"\n共建成 {total_built} 条 [{op_status}]"+(f"（幂等跳过 {skipped_dup}）" if skipped_dup else ""))
    if zero_mat:
        lines.append(f"⚠️ 0 素材跳过的产品（未建，避免空壳）: {zero_mat}")
    print("\n".join(lines)); feishu("\n".join(lines))

if __name__=="__main__": main()
