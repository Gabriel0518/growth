#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tiktok-ios-daily-build.py —— 每天新建 12 条 iOS 广告（Romi iOS + Luma + GraceChat 各 AEO×2 + VO×2）

流程（固化今天手动跑通的）:
  1) 读 dashboard 素材面板 creative-*.json，最近3天聚合(product::name 累加 newUserRevenue)，
     筛 TT，全局(不分产品)按 newUserRevenue 降序 → 全局榜
  2) 同名寻址：产品段换成目标(Romi iOS→Romi / Luma→Luma)，XMP 精确搜 file_url，凑满 10 条/产品
  3) 上传到 TT (UPLOAD_BY_URL) + 取封面
  4) 调 tiktok-create-ios-ad.py 建 12 条广告，ENABLE $50/天
  5) 飞书汇报

用法:
  python3 tiktok-ios-daily-build.py            # 真实新建
  python3 tiktok-ios-daily-build.py --dry-run  # 只跑榜单+寻址，不上传不建广告

跳过机制:
  - scripts/.skip_build_date 内容==今天(北京)日期 则跳过当天全部新建（用完删标记）。
  - 产品级暂停: config/tiktok-build-paused-products.json 的 paused 数组里的产品(PRODUCTS的key,
    如 "GraceChat"/"Romi iOS"/"Luma") 会被整体跳过、其余产品照常。恢复=把产品名从 paused 删掉。
"""
import os, sys, json, time, hashlib, urllib.request, urllib.parse, subprocess, datetime, importlib.util, glob

DRY = "--dry-run" in sys.argv
LIB_ONLY = "--lib-only" in sys.argv   # 纯库内模式：只走 TT 素材库直取，砍掉 XMP 上传兜底
WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

AID = "7553499098226819079"
DATE_TAG = None  # 260711 格式，运行时算
PRODUCTS = {
    "Romi iOS":  {"app_id":"7571769319290388487","identity":"7824e983-df3a-59fc-9dda-565cdd4d0772","seg":"Romi","cname":"Romi iOS"},
    "Luma":      {"app_id":"7569538856162426887","identity":"6d417d69-a543-5e2b-92f0-e623be5cca83","seg":"Luma","cname":"Luma"},
    # GraceChat（2026-07-17 加入）：iOS app_id 已验证可建；identity 用 Presence BC（gracechatand202601 企业号），账户内无独立 GraceChat 身份
    "GraceChat": {"app_id":"7179805841489395714","identity":"391b1ec0-4c19-5900-ba92-4c5d8dcf97ee","seg":"GraceChat","cname":"GraceChat"},
}
PLANS = [("AEO",1,15),("AEO",2,18),("VO",1,0.5),("VO",2,0.6)]
SEG_LIST = ['Dora','Romi','Doni','Luma','Jovia','GraceChat','Kira','Nalo','Mora']
CREATIVE_DIR = os.path.join(WS, "dashboard", "data")
BLACKLIST_FP = os.path.join(WS, "config", "tiktok-material-blacklist.json")
PAUSED_FP = os.path.join(WS, "config", "tiktok-build-paused-products.json")

def load_paused():
    """返回被暂停的产品名集合（对应 PRODUCTS 的 key）。文件缺失/损坏则空集合（不阻断建广告）。"""
    try:
        d = json.load(open(PAUSED_FP))
        return {p for p in d.get("paused", []) if p}
    except Exception as e:
        print(f"⚠️ 暂停开关加载失败({e})，本次不暂停任何产品")
        return set()

# ── 素材黑名单（不区分产品段，命中直接跳过顺延）──
def _norm_key(name):
    """素材名归一化匹配键：去 .mp4、抹掉产品段（不区分产品）、小写。
    例: 0224_YM_Romi_tooold_4 / 0224_YM_Doni_tooold_4 → 0224_ym_tooold_4"""
    if not name: return ""
    base = name[:-4] if name.lower().endswith(".mp4") else name
    segs = [s for s in base.split("_") if s not in SEG_LIST]
    return "_".join(segs).lower()

def load_blacklist():
    """返回黑名单归一化键集合。文件缺失/损坏则空集合（不阻断建广告）。"""
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

# ── 1. 全局榜 ──
def build_rank():
    d=today_bj(); dates=[prev(d,i) for i in (3,2,1)]
    agg={}  # (product,name) -> {newUserRevenue, name}
    for ds in dates:
        fp=os.path.join(CREATIVE_DIR,f"creative-{ds}.json")
        if not os.path.exists(fp): continue
        data=json.load(open(fp))
        for c in data.get("creatives",[]):
            if c.get("channel")!="TT": continue
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
# ── TT 创意素材库索引（file_name → video_id）──
# 优先级高于 XMP：库内已有同名素材直接复用 video_id，免上传/免等转码。
def tt_lib_index():
    idx={}  # file_name -> video_id（同名取最新一条，库按 modify_time 降序返回）
    page=1
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
    """取一个 9:16 合规封面 web_uri。库内已转码素材秒回；新上传需等转码，延长等待。
    候选全非标比例则返回 None(调用方顺延该素材)——修复此前盲取 list[0] 报 Unsupported image size。"""
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
    """拉本账户所有未删除 campaign 的名字集合，用于建前查重（幂等）。
    失败返回 None（视为无法判重，调用方保守放行，避免误跳过）。"""
    names=set(); page=1
    while True:
        r=tt_get("campaign/get",{"advertiser_id":AID,"page":page,"page_size":100,
            "fields":json.dumps(["campaign_name","secondary_status"])})
        if r.get("code")!=0: return None
        data=r.get("data",{}); lst=data.get("list",[])
        for c in lst:
            # 已删除的不算存在（删了可以重建）
            if c.get("secondary_status")=="CAMPAIGN_STATUS_DELETE": continue
            nm=c.get("campaign_name")
            if nm: names.add(nm)
        pi=data.get("page_info",{})
        if page>=pi.get("total_page",1) or not lst: break
        page+=1; time.sleep(0.2)
    return names

def resolve(rank,target,need=10,lib=None,bl=None,lib_only=None):
    """返回已备好直接建广告的素材 [[video_id,cover_web_uri,file_name],...]。
    优先级：① TT 创意素材库同名（免上传免转码） → ② XMP 同名寻址 + 上传。
    lib_only=True（纯库内模式）：只走 ① 库内直取，库内缺的素材顺延到下一候选，不走 XMP 上传兜底。
    bl=黑名单归一化键集合：命中的素材直接跳过、顺延到下一个（不区分产品段）。"""
    if lib is None: lib=tt_lib_index()
    if bl is None: bl=load_blacklist()
    if lib_only is None: lib_only=LIB_ONLY
    picked=[]; seen=set(); skipped=[]
    for r in rank:
        if len(picked)>=need: break
        # 黑名单命中：用原始素材名判断（不区分产品段），跳过顺延
        if is_blacklisted(r["name"], bl):
            skipped.append(r["name"]); continue
        nn=swap(r["name"],target)
        if not nn or nn in seen: continue
        seen.add(nn)
        # ① 优先查 TT 素材库
        vid=lib.get(nn)
        if vid:
            cover=suggest_cover(vid, tries=3, gap=2)  # 库内秒回，少量重试即可
            if cover:
                picked.append([vid,cover,nn]); continue
            # 库内居然取不到封面（极少见），降级走 XMP 上传（纯库内模式则顺延）
        if lib_only:
            continue  # 纯库内模式：不走 XMP 上传兜底，顺延下一候选
        # ② XMP 同名寻址 + 上传
        row=xmp_search(nn); time.sleep(0.35)
        if not (row and row.get("file_url")): continue
        r2=tt_post("file/video/ad/upload",{"advertiser_id":AID,"upload_type":"UPLOAD_BY_URL","video_url":row["file_url"],"file_name":nn})
        if r2.get("code")!=0: continue
        data=r2.get("data"); uvid=data[0]["video_id"] if isinstance(data,list) else data.get("video_id")
        time.sleep(3)  # 等转码起步
        cover=suggest_cover(uvid, tries=12, gap=5)  # 新上传延长等待：最多 ~60s
        if cover: picked.append([uvid,cover,nn])
    if skipped: print(f"  [黑名单] 跳过 {len(skipped)} 个素材: {skipped}")
    return picked

def main():
    d=today_bj()
    dt=datetime.datetime.strptime(d,"%Y-%m-%d"); global DATE_TAG
    DATE_TAG=dt.strftime("%y%m%d")
    # skip 标记
    skip_fp=os.path.join(WS,"scripts",".skip_build_date")
    if os.path.exists(skip_fp) and open(skip_fp).read().strip()==d:
        print(f"跳过新建（标记 {d}）")
        if not DRY:
            os.remove(skip_fp)
            feishu(f"🌙 {d} 23:40 新建广告任务：按你要求今晚跳过（已手动建过）。标记已清除，明天起正常新建。")
        else:
            print("[DRY] 真实运行会删标记并跳过；dry 不删")
        return

    rank,dates=build_rank()
    bl=load_blacklist()
    paused=load_paused()
    lines=[f"🌙 TikTok iOS 新建广告 {d} 23:40"+("（DRY）" if DRY else "")+("（纯库内）" if LIB_ONLY else ""),
           f"素材榜窗口: {dates[0]}~{dates[-1]}（3天），全局{len(rank)}条",
           f"素材黑名单: {len(bl)} 条规则"]
    if paused: lines.append(f"⛔️ 暂停建广告的产品: {sorted(paused)}（本次跳过）")
    if DRY:
        lib=tt_lib_index()
        lines.append(f"TT素材库索引: {len(lib)} 个视频")
        for pname,p in PRODUCTS.items():
            if pname in paused:
                lines.append(f"  {pname}: ⛔️ 已暂停，跳过"); continue
            mats=resolve(rank,p["seg"],10,lib=lib,bl=bl)
            hits=sum(1 for m in mats if m[2] in lib)  # 命中库
            lines.append(f"  {pname}: 备好 {len(mats)} 条（库内直取 {hits}）")
        print("\n".join(lines)); feishu("\n".join(lines)); return

    # 加载建广告模块
    spec=importlib.util.spec_from_file_location("iosad",os.path.join(WS,"scripts","tiktok-create-ios-ad.py"))
    iosad=importlib.util.module_from_spec(spec); spec.loader.exec_module(iosad)

    total_built=0; skipped_dup=0; zero_mat=[]
    lib=tt_lib_index()  # 全库索引拉一次，两个产品共用
    lines.append(f"TT素材库索引: {len(lib)} 个视频")
    # ── 幂等：建前拉一次已存在 campaign 名，命中即跳过（防 cron 重试重复建）──
    exist=existing_campaign_names()
    if exist is None:
        lines.append("⚠️ 查重失败(campaign/get异常)，本次不做幂等判重，正常建")
        exist=set()
    else:
        lines.append(f"幂等查重: 账户现存 {len(exist)} 个 campaign 名")
    for pname,p in PRODUCTS.items():
        # 产品级暂停开关：在暂停名单里则整体跳过（不建、不寻址）
        if pname in paused:
            lines.append(f"\n{pname}: ⛔️ 已暂停，本次不建广告"); continue
        # 若本产品 4 个 cname 全已存在，跳过寻址+建广告（省 API、省钱）
        plan_names=[f"{p['cname']}_syh_{DATE_TAG}_{opt}_{seq}" for opt,seq,_ in PLANS]
        if all(n in exist for n in plan_names):
            lines.append(f"\n{pname}: 4 条今日 campaign 均已存在，整体跳过（幂等）")
            skipped_dup+=len(PLANS); continue
        tt=resolve(rank,p["seg"],10,lib=lib,bl=bl)  # 已含库内复用+XMP兜底+黑名单过滤，直接可用
        lines.append(f"\n{pname}: 备好素材 {len(tt)} 条")
        # ── 0 素材守卫：绝不建空壳 campaign/adgroup（07-18 空壳根治）──
        if not tt:
            lines.append(f"  ⚠️ 0 素材，跳过该产品，不建空壳")
            zero_mat.append(pname); continue
        for opt,seq,bid in PLANS:
            cname=f"{p['cname']}_syh_{DATE_TAG}_{opt}_{seq}"
            if cname in exist:
                lines.append(f"  ⏭️ {cname} 已存在，跳过（幂等）"); skipped_dup+=1; continue
            cfg={"advertiser_id":AID,"app_id":p["app_id"],"identity_id":p["identity"],
                 "opt_type":opt,"bid":bid,"campaign_name":cname,"budget":50,"op_status":"ENABLE","materials":tt}
            try:
                iosad.main(cfg); total_built+=1; exist.add(cname)
                lines.append(f"  ✅ {cname} bid={bid} 素材{len(tt)}")
            except Exception as e:
                lines.append(f"  ❌ {cname} 建失败: {e}")
            time.sleep(2)
    lines.append(f"\n共建成 {total_built}/{len(PRODUCTS)*len(PLANS)} 条，均 ENABLE $50/天"+(f"（幂等跳过 {skipped_dup} 条已存在）" if skipped_dup else ""))
    if zero_mat:
        lines.append(f"⚠️ 0 素材跳过的产品（未建，避免空壳）: {zero_mat}")
    print("\n".join(lines)); feishu("\n".join(lines))

if __name__=="__main__": main()
