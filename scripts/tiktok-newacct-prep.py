#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tiktok-newacct-prep.py —— 新增3个安卓账户素材预备（中午11:40，对齐 tiktok-material-prep.py）

对 Nalo And / Kira And / Romi And 三账户各自：从 FB 素材榜同名寻址 → 预上传进各自 TT 创意素材库（幂等），
让晚上 23:40 build --lib-only 纯库内秒建。每账户独立 token。

用法:
  python3 tiktok-newacct-prep.py --dry-run   # 只算库内已有/待上传清单，不真传
  python3 tiktok-newacct-prep.py             # 真跑：上传入库 + 飞书
"""
import os, sys, json, time, hashlib, urllib.request, urllib.parse, subprocess, datetime

DRY = "--dry-run" in sys.argv
WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ACCT_FP = os.path.join(WS, "config", "tiktok-newacct-accounts.json")

NEED = 10
SEG_LIST = ['Dora','Romi','Doni','Luma','Jovia','GraceChat','Kira','Nalo','Mora']
CREATIVE_DIR = os.path.join(WS, "dashboard", "data")
BLACKLIST_FP = os.path.join(WS, "config", "tiktok-material-blacklist.json")

XMP_HOST="xmp-open.mobvista.com"; XMP_CID="d607c5992ba7c40f19d9834da9b425e6"; XMP_SEC="5520f711776d92ab13e8683c72e0fd30"
TT_API="https://business-api.tiktok.com/open_api/v1.3"
YIHENG="ou_b2467dac5ff1d686fb48ccf1fbaa0c0d"; LARK=os.path.expanduser("~/.npm-global/bin/lark-cli")
TK=""  # 每账户切换

def load_tokens():
    t={}
    for l in open("/etc/environment"):
        l=l.strip()
        for k in ["TIKTOK_ACCESS_TOKEN_4","TIKTOK_ACCESS_TOKEN_3","TIKTOK_ACCESS_TOKEN_2","TIKTOK_ACCESS_TOKEN"]:
            if l.startswith(k+"="): t[k]=l.split("=",1)[1].strip().strip('"'); break
    return t
TOKENS=load_tokens()
def load_accounts(): return json.load(open(ACCT_FP)).get("accounts",[])

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

def _norm_key(name):
    if not name: return ""
    base = name[:-4] if name.lower().endswith(".mp4") else name
    return "_".join(s for s in base.split("_") if s not in SEG_LIST).lower()
def load_blacklist():
    try: return {_norm_key(m) for m in json.load(open(BLACKLIST_FP)).get("materials",[]) if m}
    except Exception: return set()
def is_blacklisted(name, bl): return _norm_key(name) in bl if bl else False

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
def suggest_cover(aid, vid, tries=12, gap=5):
    for _ in range(tries):
        cr=tt_get("file/video/suggestcover",{"advertiser_id":aid,"video_id":vid})
        lst=cr.get("data",{}).get("list",[])
        if lst:
            for c in lst:
                if c.get("id") and _cover_ok(c): return c["id"]
            if all((c.get("width") and c.get("height")) for c in lst): return None
        time.sleep(gap)
    return None

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

def prep_product(aid, rank, seg, lib, bl):
    have=[]; uploaded=[]; failed=[]; would_upload=[]; seen=set(); skipped_bl=0; skipped_noxmp=0
    for r in rank:
        if len(have)+len(uploaded)+len(would_upload) >= NEED: break
        if is_blacklisted(r["name"], bl): skipped_bl+=1; continue
        nn=swap(r["name"], seg)
        if not nn or nn in seen: continue
        seen.add(nn)
        if nn in lib: have.append(nn); continue
        if DRY: would_upload.append(nn); continue
        row=xmp_search(nn); time.sleep(6)   # XMP 20 QPM 节流
        if not (row and row.get("file_url")): skipped_noxmp+=1; continue
        r2=tt_post("file/video/ad/upload",{"advertiser_id":aid,"upload_type":"UPLOAD_BY_URL",
                                           "video_url":row["file_url"],"file_name":nn})
        if r2.get("code")!=0: failed.append(f"{nn}(upload {r2.get('code')})"); continue
        data=r2.get("data"); uvid=data[0]["video_id"] if isinstance(data,list) else data.get("video_id")
        time.sleep(3)
        cover=suggest_cover(aid, uvid, tries=12, gap=5)
        if cover: uploaded.append(nn); lib[nn]=uvid
        else: failed.append(f"{nn}(转码/封面非9:16)")
    return {"have":have,"uploaded":uploaded,"failed":failed,"would_upload":would_upload,
            "skipped_bl":skipped_bl,"skipped_noxmp":skipped_noxmp}

def main():
    global TK
    d=today_bj(); tag="（DRY）" if DRY else ""
    accounts=load_accounts()
    rank,dates=build_rank()
    bl=load_blacklist()
    warn=[]
    lines=[f"🎬 TikTok 新增账户素材预备 {d} 11:40{tag}",
           f"账户数: {len(accounts)}（Nalo/Kira/Romi And）",
           f"素材榜窗口(FB): {dates[0]}~{dates[-1]}（3天），全局{len(rank)}条，黑名单 {len(bl)} 条"]
    tot_have=tot_up=tot_fail=0
    for acc in accounts:
        pname=acc["product"]; aid=acc["advertiser_id"]; seg=acc["seg"]
        TK=TOKENS.get(acc["token_env"],"")
        if not TK: lines.append(f"\n{pname}: ⚠️ token 缺失，跳过"); warn.append(f"{pname} token 缺失"); continue
        lib=tt_lib_index(aid)
        st=prep_product(aid, rank, seg, lib, bl)
        tot_have+=len(st["have"]); tot_up+=len(st["uploaded"]); tot_fail+=len(st["failed"])
        if DRY:
            lines.append(f"\n{pname} ({aid}): TT库{len(lib)}个，命中榜 {len(st['have'])+len(st['would_upload'])} 条"
                         f"（库内已有 {len(st['have'])} / 待上传 {len(st['would_upload'])}）")
            for nn in st["would_upload"]: lines.append(f"      ⬆︎ {nn}")
        else:
            got=len(st["have"])+len(st["uploaded"])
            lines.append(f"\n{pname} ({aid}): 库内已有 {len(st['have'])} / 新上传 {len(st['uploaded'])} = {got}/{NEED} 条"
                         f"（顺延 XMP无同款 {st['skipped_noxmp']} / 黑名单 {st['skipped_bl']}"
                         + (f" / 真失败 {len(st['failed'])}" if st['failed'] else "") + "）")
            for nn in st["uploaded"]: lines.append(f"      ✅ {nn}")
            for f in st["failed"]: lines.append(f"      ❌ {f}"); warn.append(f"{pname} 真失败: {f}")
            if got < NEED: warn.append(f"{pname} 只凑到 {got}/{NEED} 条（今晚建广告素材可能不足）")
    if not DRY:
        lines.append(f"\n合计: 库内已有 {tot_have} / 新上传 {tot_up}" + (f" / 真失败 {tot_fail}" if tot_fail else ""))
    if warn:
        lines.append("\n⚠️ 告警:"); lines += [f"  · {w}" for w in warn]
    msg="\n".join(lines); print(msg); feishu(msg)
    if warn and not DRY: sys.exit(1)

if __name__=="__main__":
    try: main()
    except SystemExit: raise
    except Exception as e:
        import traceback; err=traceback.format_exc()[-800:]; print(err)
        feishu(f"🛑 tiktok-newacct-prep 异常中止\n{err[-400:]}"); sys.exit(1)
