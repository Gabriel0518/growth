#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fb-android-prep.py —— FB 安卓素材预备（XMP 同名寻址 → FB 素材库预上传）

只服务广告账户 act_646387524897026（省广_Dora_And_3_syh_Agentic）。
从近3天 FB 素材榜(newUserRevenue 排序) → 换成 Dora 版名 → XMP 同名寻址拿 file_url
→ 上传进 FB 素材库(/advideos by URL) → 轮询转码 ready → 记 video_id + 缩略图。
幂等：已在 FB 库(本地索引)里的同名素材跳过。凑满 NEED 条。

黑灰名单（与 TikTok 完全独立）：
  - 黑名单命中 → 跳过顺延
  - 灰名单拒审 >=3 次 → 跳过顺延（1~2 次照用）

用法:
  source /etc/environment   # 需要 FB_LONG_TOKEN（若未存则用 --token 传）
  python3 scripts/fb-android-prep.py --dry-run   # 只列库内已有/待上传，不真传
  python3 scripts/fb-android-prep.py             # 真跑：上传入库
  python3 scripts/fb-android-prep.py --token 'EAA...'  # 手动传 token

产物：config/fb-android-material-lib.json（本地 FB 素材库索引 {归一化名: {video_id, file_name, thumb, ts}}）
"""
import os, sys, json, time, hashlib, urllib.request, urllib.parse, datetime, glob

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRY = "--dry-run" in sys.argv

# ===== 账户锁死（只此一个）=====
ACT = "act_646387524897026"
SEG = "Dora"                       # 该账户产品段
NEED = 10

GRAPH = "https://graph.facebook.com/v25.0"
XMP_HOST = "xmp-open.mobvista.com"
XMP_CID = "d607c5992ba7c40f19d9834da9b425e6"
XMP_SEC = "5520f711776d92ab13e8683c72e0fd30"

SEG_LIST = ['Dora', 'Romi', 'Doni', 'Luma', 'Jovia', 'GraceChat', 'Kira', 'Nalo']
CREATIVE_DIR = os.path.join(WS, "dashboard", "data")
LIB_FP = os.path.join(WS, "config", "fb-android-material-lib.json")
BLACKLIST_FP = os.path.join(WS, "config", "fb-material-blacklist.json")
GREYLIST_FP = os.path.join(WS, "config", "fb-material-greylist.json")


def get_token():
    for i, a in enumerate(sys.argv):
        if a == "--token" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    t = os.environ.get("FB_LONG_TOKEN") or os.environ.get("FB_TOKEN")
    if not t:
        # 兜底从 /etc/environment 读
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


# ---------- 名单归一化 ----------
def norm_key(name):
    if not name:
        return ""
    base = name
    for ext in (".mp4", ".mov"):
        if base.lower().endswith(ext):
            base = base[:-4]
            break
    return "_".join(s for s in base.split("_") if s not in SEG_LIST).lower()


def load_blacklist():
    try:
        return {norm_key(m) for m in json.load(open(BLACKLIST_FP)).get("materials", []) if m}
    except Exception:
        return set()


def load_greylist_counts():
    try:
        raw = json.load(open(GREYLIST_FP)).get("counts", {})
        return {norm_key(k): int(v) for k, v in raw.items()}
    except Exception:
        return {}


def is_blocked(name, bl, grey):
    """黑名单 或 灰名单拒审>=3 → 建广告不用。"""
    k = norm_key(name)
    if k in bl:
        return "black"
    if grey.get(k, 0) >= 3:
        return "grey3"
    return None


# ---------- 本地 FB 素材库索引 ----------
def load_lib():
    try:
        return json.load(open(LIB_FP))
    except Exception:
        return {}


def save_lib(lib):
    json.dump(lib, open(LIB_FP, "w"), ensure_ascii=False, indent=2)


# ---------- XMP ----------
def xmp_search(name):
    ts = int(time.time())
    sign = hashlib.md5((XMP_SEC + str(ts)).encode()).hexdigest()
    body = json.dumps({"material_name": [name], "page": 1, "page_size": 5,
                       "client_id": XMP_CID, "timestamp": ts, "sign": sign}).encode()
    req = urllib.request.Request(f"https://{XMP_HOST}/v1/media/material/list", data=body,
                                 headers={"Content-Type": "application/json", "Content-Length": len(body)})
    for _ in range(3):
        try:
            r = json.loads(urllib.request.urlopen(req, timeout=30).read())
            data = r.get("data", {})
            rows = data.get("data", []) if isinstance(data, dict) else []
            return rows[0] if rows else None
        except urllib.error.HTTPError as e:
            try:
                json.loads(e.read())
            except Exception:
                pass
            return None
        except Exception:
            time.sleep(2)
    return None


# ---------- FB ----------
def fb_post(path, params):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(f"{GRAPH}/{path}", data=data)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=180).read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def fb_get(path, params):
    url = f"{GRAPH}/{path}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def fb_upload_video(file_url, name):
    r = fb_post(f"{ACT}/advideos", {"file_url": file_url, "name": name, "access_token": TOKEN})
    return r.get("id"), r


def fb_wait_ready(vid, tries=18, gap=8):
    """轮询转码，返回 (ready_bool, thumb_url)。"""
    for _ in range(tries):
        r = fb_get(vid, {"fields": "status,picture", "access_token": TOKEN})
        st = r.get("status", {}).get("video_status")
        if st == "ready":
            return True, r.get("picture")
        if st == "error":
            return False, None
        time.sleep(gap)
    return False, None


# ---------- 素材榜 ----------
def build_rank():
    d = (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).strftime("%Y-%m-%d")
    dates = [(datetime.datetime.strptime(d, "%Y-%m-%d") - datetime.timedelta(days=i)).strftime("%Y-%m-%d")
             for i in (3, 2, 1)]
    agg = {}
    for ds in dates:
        fp = os.path.join(CREATIVE_DIR, f"creative-{ds}.json")
        if not os.path.exists(fp):
            continue
        try:
            data = json.load(open(fp))
        except Exception:
            continue
        for c in data.get("creatives", []):
            if c.get("channel") != "FB":
                continue
            nm = c.get("name", "")
            if not nm:
                continue
            agg[nm] = agg.get(nm, 0) + (c.get("newUserRevenue", 0) or 0)
    return [{"name": k, "rev": v} for k, v in sorted(agg.items(), key=lambda x: -x[1])], dates


def swap(name, target):
    base = name[:-4] if name.lower().endswith(".mp4") else name
    segs = base.split("_")
    for i, s in enumerate(segs):
        if s in SEG_LIST:
            if s != target:
                segs[i] = target
            return "_".join(segs) + ".mp4"
    return None


def main():
    if not TOKEN:
        print("❌ 缺 FB token（--token 或 FB_LONG_TOKEN/FB_TOKEN 环境变量）")
        sys.exit(1)
    rank, dates = build_rank()
    bl = load_blacklist()
    grey = load_greylist_counts()
    lib = load_lib()

    have, uploaded, would, failed = [], [], [], []
    skipped_block, skipped_noxmp = 0, 0
    seen = set()

    print(f"🎬 FB 安卓素材预备  账户 {ACT}  段 {SEG}")
    print(f"   素材榜窗口(FB): {dates[0]}~{dates[-1]}（3天），全局 {len(rank)} 条")
    print(f"   本地FB库 {len(lib)} 条 / 黑名单 {len(bl)} / 灰名单(拒审计数) {len(grey)}")

    for r in rank:
        if len(have) + len(uploaded) + len(would) >= NEED:
            break
        block = is_blocked(r["name"], bl, grey)
        if block:
            skipped_block += 1
            continue
        nn = swap(r["name"], SEG)
        if not nn or nn in seen:
            continue
        seen.add(nn)
        k = norm_key(nn)
        if k in lib and lib[k].get("video_id"):
            have.append(nn)
            continue
        if DRY:
            would.append(nn)
            continue
        row = xmp_search(nn)
        time.sleep(6)  # XMP 限频
        if not (row and row.get("file_url")):
            skipped_noxmp += 1
            continue
        vid, resp = fb_upload_video(row["file_url"], nn)
        if not vid:
            failed.append(f"{nn}(upload: {json.dumps(resp.get('error',{}),ensure_ascii=False)[:80]})")
            continue
        ready, thumb = fb_wait_ready(vid)
        if not ready:
            failed.append(f"{nn}(转码失败/超时 vid={vid})")
            continue
        lib[k] = {"video_id": vid, "file_name": nn, "thumb": thumb,
                  "ts": int(time.time())}
        save_lib(lib)
        uploaded.append(nn)

    print()
    if DRY:
        print(f"[DRY] 命中榜 {len(have)+len(would)} 条：库内已有 {len(have)} / 待上传 {len(would)}")
        for nn in would:
            print(f"   ⬆︎ {nn}")
    else:
        got = len(have) + len(uploaded)
        print(f"库内已有 {len(have)} / 新上传 {len(uploaded)} = {got}/{NEED} 条"
              f"（顺延 XMP无同款 {skipped_noxmp} / 黑灰名单 {skipped_block}"
              + (f" / 真失败 {len(failed)}" if failed else "") + "）")
        for nn in uploaded:
            print(f"   ✅ {nn}")
        for f in failed:
            print(f"   ❌ {f}")
        if got < NEED:
            print(f"⚠️ 只凑到 {got}/{NEED} 条")
    print(f"\n本地库文件: {LIB_FP}")


if __name__ == "__main__":
    main()
