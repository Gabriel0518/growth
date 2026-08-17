#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tiktok-material-prep.py —— 中午素材预备（iOS + 安卓统一，--platform 选择账户）

目的（屹恒 2026-07-20 拍板）：把「慢活」（补抓素材数据 + 同名寻址 + 上传转码）挪到中午 11:40，
让晚上 23:40 建广告只走「库内直取」，零外部依赖。根治两类故障：
  · 07-19 夜里 cron 走 AI 失败 → 0 广告（本脚本纯脚本、脚本内发飞书，不依赖 AI）
  · 07-18 素材数据管线断更 → 素材榜 0 条 → 建 8 条空壳（本脚本做新鲜度检查+自动补抓）

四段逻辑：
  1) 新鲜度检查 + 自动补抓：窗口 dates=[prev3,prev2,prev1]，creative-{date}.json 缺/过小/损坏
     → 调 `node dashboard/fetch-creative-data.js {date}` 补抓（尊重 XMP 20 QPM，中午慢跑无妨）
  2) 筛素材：复刻对应 build 的榜单（iOS=TT 通道 / 安卓=FB 通道）+ 同名寻址 swap + 黑名单过滤，
     每产品选出今晚要用的 N=10
  3) 预上传到 TT 创意素材库（幂等）：库内已有同名则跳过；没有才 XMP file_url → UPLOAD_BY_URL，
     等转码就绪（suggestcover 取到 9:16 合规封面=就绪信号）；非 9:16 素材顺延不入库
  4) 飞书汇报（脚本内 lark-cli）：补抓了哪几天、每产品库内已有/新传/失败几条；异常也发告警 + 非 0 退出

用法:
  python3 tiktok-material-prep.py --platform ios --dry-run   # 只算窗口/检测缺失/打印将补抓+将上传清单，不真抓不真传
  python3 tiktok-material-prep.py --platform ios             # 真跑：补抓 + 上传入库 + 飞书
  python3 tiktok-material-prep.py --platform android [--dry-run]
"""
import os, sys, json, time, hashlib, urllib.request, urllib.parse, subprocess, datetime

DRY = "--dry-run" in sys.argv
WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── 平台配置（统一架构：差异全收敛到这里）──────────────────────────
PLATFORMS = {
    "ios": {
        "aid": "7553499098226819079",       # 省广_Romi_Luma_iOS_syh_Agentic
        "channel": "TT",                     # iOS 素材榜走 TT 通道
        "products": {                        # 面板产品名 → 同名寻址目标段 seg
            "Romi iOS":  "Romi",
            "Luma":      "Luma",
            "GraceChat": "GraceChat",
        },
    },
    "android": {
        "aid": "7559144904526708753",        # 省广_Dora_Doni_Jovia_And_syh_Agentic
        "channel": "FB",                     # 安卓素材榜走 FB 通道（与安卓 build 一致）
        "products": {
            "Doni And":  "Doni",
            "Dora And":  "Dora",
            "Jovia And": "Jovia",
        },
    },
}

NEED = 10                                    # 每产品预备条数（对齐 build）
FRESH_MIN_BYTES = 50 * 1024                  # creative-{date}.json 小于此视为损坏/断更，触发补抓

SEG_LIST = ['Dora','Romi','Doni','Luma','Jovia','GraceChat','Kira','Nalo','Mora']
CREATIVE_DIR = os.path.join(WS, "dashboard", "data")
BLACKLIST_FP = os.path.join(WS, "config", "tiktok-material-blacklist.json")
FETCH_JS = os.path.join(WS, "dashboard", "fetch-creative-data.js")

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

# ── 黑名单（不区分产品段，命中跳过顺延；与 build 一致）──
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

def tt_lib_index(aid):
    """TT 创意素材库索引 file_name → video_id（同名取最新，库按 modify_time 降序）。"""
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
    """仅接受 9:16(约1.778) 竖版封面。TT Smart+ 拒收非标比例(如 AIGC 1080x1790=1.657)，
    会报 'Unsupported image size'。宽高缺失时保守放行(交给 TT 校验)。"""
    w,h=c.get("width"),c.get("height")
    if not w or not h: return True
    return abs((h/w)-1.7778)<0.03

def suggest_cover(aid, vid, tries=12, gap=5):
    """取一个 9:16 合规封面 web_uri（也是转码就绪信号）；候选全非标则返回 None(顺延该素材)。
    新上传需等转码，默认延长等待 ~60s。"""
    for _ in range(tries):
        cr=tt_get("file/video/suggestcover",{"advertiser_id":aid,"video_id":vid})
        lst=cr.get("data",{}).get("list",[])
        if lst:
            for c in lst:
                if c.get("id") and _cover_ok(c): return c["id"]
            # 有候选但全非标比例 → 该素材封面不可用，不再等，直接判失败
            if all((c.get("width") and c.get("height")) for c in lst):
                return None
        time.sleep(gap)
    return None

# ── 1. 全局榜（按平台通道）──
def build_rank(channel):
    d=today_bj(); dates=[prev(d,i) for i in (3,2,1)]
    agg={}
    for ds in dates:
        fp=os.path.join(CREATIVE_DIR,f"creative-{ds}.json")
        if not os.path.exists(fp): continue
        try: data=json.load(open(fp))
        except Exception: continue
        for c in data.get("creatives",[]):
            if c.get("channel")!=channel: continue
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

# ── 新鲜度检查 + 自动补抓 ──
def _file_fresh(fp):
    """存在 且 体积达标 且 JSON 可解析 且 creatives 非空 → 视为新鲜。"""
    if not os.path.exists(fp): return False, "缺失"
    try:
        if os.path.getsize(fp) < FRESH_MIN_BYTES: return False, f"过小({os.path.getsize(fp)}B)"
        data=json.load(open(fp))
        if not data.get("creatives"): return False, "creatives 空"
    except Exception as e:
        return False, f"损坏({e})"
    return True, "ok"

def refetch(date):
    """调 node fetch-creative-data.js {date} 补抓该日。返回 (ok, msg)。"""
    env=dict(os.environ); env["PATH"]=os.path.expanduser("~/.npm-global/bin")+":"+env.get("PATH","")
    try:
        out=subprocess.run(["node", FETCH_JS, date], cwd=WS,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True,
            timeout=1200, env=env)   # XMP 20 QPM，单日可能跑几分钟
        ok = out.returncode==0
        return ok, (out.stdout or "")[-300:]
    except Exception as e:
        return False, f"补抓异常: {e}"

def ensure_fresh(dates, report):
    """对窗口内每个 date 做新鲜度检查，缺/坏则补抓。dry 不真抓、只报告。
    返回 refetched 列表（本次补抓成功的日期），并把告警写进 report['warn']。"""
    refetched=[]
    for ds in dates:
        fp=os.path.join(CREATIVE_DIR,f"creative-{ds}.json")
        fresh, why = _file_fresh(fp)
        if fresh:
            report["fresh"].append(ds); continue
        if DRY:
            report["would_fetch"].append(f"{ds}({why})"); continue
        print(f"  补抓 {ds} … 原因:{why}")
        ok, msg = refetch(ds)
        fresh2, why2 = _file_fresh(fp)
        if ok and fresh2:
            refetched.append(ds)
        else:
            report["warn"].append(f"补抓失败 {ds}: rc/{'ok' if ok else 'fail'} 复检:{why2} | {msg.strip()[:120]}")
    return refetched

# ── 3. 筛素材 + 预上传（幂等）──
def prep_product(aid, rank, seg, lib, bl):
    """为单个产品选 NEED 条并确保入库。返回 dict 统计 + 明细。dry 只判定库内/待上传、不真传。"""
    have=[]; uploaded=[]; failed=[]; would_upload=[]; seen=set(); skipped_bl=0; skipped_noxmp=0
    for r in rank:
        if len(have)+len(uploaded)+len(would_upload) >= NEED: break
        if is_blacklisted(r["name"], bl):
            skipped_bl+=1; continue
        nn=swap(r["name"], seg)
        if not nn or nn in seen: continue
        seen.add(nn)
        if nn in lib:
            have.append(nn); continue                 # ① 库内已有 → 幂等跳过
        if DRY:
            would_upload.append(nn); continue          # dry 不真传
        # ② 上传：XMP 取 file_url → UPLOAD_BY_URL → 等转码就绪(9:16 校验)
        row=xmp_search(nn); time.sleep(6)   # XMP 20 QPM 节流：拉长到 6s 大幅降低触发限流概率（屹恒 2026-07-20 定）
        if not (row and row.get("file_url")):
            # 正常顺延：swap 后的名字在 XMP 无对应产品同款 → 不是失败，继续下一个候选（屹恒 2026-07-20 口述逻辑）
            skipped_noxmp+=1; continue
        r2=tt_post("file/video/ad/upload",{"advertiser_id":aid,"upload_type":"UPLOAD_BY_URL",
                                           "video_url":row["file_url"],"file_name":nn})
        if r2.get("code")!=0:
            failed.append(f"{nn}(upload {r2.get('code')})"); continue
        data=r2.get("data"); uvid=data[0]["video_id"] if isinstance(data,list) else data.get("video_id")
        time.sleep(3)
        cover=suggest_cover(aid, uvid, tries=12, gap=5)
        if cover:
            uploaded.append(nn); lib[nn]=uvid          # 入库并更新本地索引（防同产品重复）
        else:
            failed.append(f"{nn}(转码/封面非9:16)")
    return {"have":have,"uploaded":uploaded,"failed":failed,"would_upload":would_upload,
            "skipped_bl":skipped_bl,"skipped_noxmp":skipped_noxmp}

def main():
    # 解析平台
    plat=None
    for i,a in enumerate(sys.argv):
        if a=="--platform" and i+1<len(sys.argv): plat=sys.argv[i+1]
    if plat not in PLATFORMS:
        print("用法: --platform ios|android [--dry-run]"); sys.exit(2)
    cfg=PLATFORMS[plat]; aid=cfg["aid"]; channel=cfg["channel"]; products=cfg["products"]

    d=today_bj()
    tag="（DRY）" if DRY else ""
    report={"fresh":[], "would_fetch":[], "warn":[]}

    rank,dates=build_rank(channel)
    refetched=ensure_fresh(dates, report)
    # 补抓后重算榜单（可能刚补上缺失日）
    if refetched:
        rank,_=build_rank(channel)

    bl=load_blacklist()
    lib=tt_lib_index(aid)

    head=[f"🎬 TikTok {plat.upper()} 素材预备 {d} 11:40{tag}",
          f"账户: {aid}",
          f"素材榜窗口({channel}): {dates[0]}~{dates[-1]}（3天），全局{len(rank)}条",
          f"TT素材库索引: {len(lib)} 个视频，黑名单 {len(bl)} 条"]
    if report["fresh"]:      head.append(f"数据新鲜: {report['fresh']}")
    if report["would_fetch"]: head.append(f"[DRY] 待补抓: {report['would_fetch']}")
    if refetched:            head.append(f"✅ 已补抓: {refetched}")

    lines=list(head)
    tot_have=tot_up=tot_fail=0
    for pname, seg in products.items():
        st=prep_product(aid, rank, seg, lib, bl)
        tot_have+=len(st["have"]); tot_up+=len(st["uploaded"]); tot_fail+=len(st["failed"])
        if DRY:
            lines.append(f"\n{pname}: 命中榜 {len(st['have'])+len(st['would_upload'])} 条"
                         f"（库内已有 {len(st['have'])} / 待上传 {len(st['would_upload'])}）")
            for nn in st["would_upload"]: lines.append(f"      ⬆︎ {nn}")
        else:
            got=len(st["have"])+len(st["uploaded"])
            lines.append(f"\n{pname}: 库内已有 {len(st['have'])} / 新上传 {len(st['uploaded'])} = {got}/{NEED} 条"
                         f"（顺延 XMP无同款 {st['skipped_noxmp']} / 黑名单 {st['skipped_bl']}"
                         + (f" / 真失败 {len(st['failed'])}" if st['failed'] else "") + "）")
            for nn in st["uploaded"]: lines.append(f"      ✅ {nn}")
            for f in st["failed"]:    lines.append(f"      ❌ {f}"); report["warn"].append(f"{pname} 真失败: {f}")
            if got < NEED:
                report["warn"].append(f"{pname} 只凑到 {got}/{NEED} 条（今晚建广告素材可能不足）")

    if not DRY:
        lines.append(f"\n合计: 库内已有 {tot_have} / 新上传 {tot_up}" + (f" / 真失败 {tot_fail}" if tot_fail else ""))
    if report["warn"]:
        lines.append("\n⚠️ 告警:")
        lines += [f"  · {w}" for w in report["warn"]]

    msg="\n".join(lines)
    print(msg); feishu(msg)
    # 关键失败以非 0 退出（方便日志排查），但正常汇报已发飞书
    if report["warn"] and not DRY: sys.exit(1)

if __name__=="__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        import traceback
        err=traceback.format_exc()[-800:]
        print(err)
        feishu(f"🛑 tiktok-material-prep 异常中止\n{err[-400:]}")
        sys.exit(1)
