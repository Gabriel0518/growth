#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从【部分过审】命中广告的 creative_list 移除灰名单素材（保留其余素材，不补新素材）。
读 /tmp/tt_gl_hits.json（由 tt-scan-graylist-ads.py 生成，已只含需清理的部分过审广告）。
用法:
  source /etc/environment && python3 scripts/tt-remove-graylist-mats.py            # DRY-RUN 只打印
  source /etc/environment && python3 scripts/tt-remove-graylist-mats.py --apply    # 真正写回
"""
import os, sys, json, time, urllib.request, urllib.parse

API="https://business-api.tiktok.com/open_api/v1.3"
TK=os.environ["TIKTOK_ACCESS_TOKEN"]
AID=os.environ.get("TT_AID","7553499098226819079")
BC="7118908157199384578"
APPLY="--apply" in sys.argv

SEG_LIST=['Dora','Romi','Doni','Luma','Jovia','GraceChat','Kira','Nalo','Mora']
def norm(name):
    if not name: return ""
    base=name[:-4] if str(name).lower().endswith(".mp4") else name
    return "_".join(s for s in str(base).split("_") if s not in SEG_LIST).lower()

data=json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),"config","tiktok-material-graylist.json")))
GL={norm(m) for m in data.get("materials",[]) if m}

def tt_get(ep,params):
    url=f"{API}/{ep}/?"+urllib.parse.urlencode(params)
    req=urllib.request.Request(url,headers={"Access-Token":TK})
    try: return json.loads(urllib.request.urlopen(req,timeout=90).read())
    except urllib.error.HTTPError as e: return json.loads(e.read())
def tt_post(ep,body):
    req=urllib.request.Request(f"{API}/{ep}/",data=json.dumps(body).encode(),
        headers={"Access-Token":TK,"Content-Type":"application/json"})
    try: return json.loads(urllib.request.urlopen(req,timeout=120).read())
    except urllib.error.HTTPError as e: return json.loads(e.read())

hits=json.load(open("/tmp/tt_gl_hits.json"))
print(f"{'[APPLY]' if APPLY else '[DRY-RUN]'} 待处理【部分过审】广告 {len(hits)} 条, 灰名单键={GL}\n")

ok=0; fail=0; results=[]
for i,h in enumerate(hits,1):
    ad_id=h["smart_plus_ad_id"]; camp=h["campaign_id"]; name=h["ad_name"]
    # 拉该 ad 完整 creative_list（按 campaign_ids 查更可靠，再按 ad_id 匹配）
    r=tt_get("smart_plus/ad/get",{"advertiser_id":AID,
        "filtering":json.dumps({"campaign_ids":[camp]}),
        "fields":json.dumps(["smart_plus_ad_id","ad_name","adgroup_id","creative_list"])})
    if r.get("code")!=0:
        print(f"{i:2d}. ❌ {name} ad/get失败 {r.get('message')}"); fail+=1; continue
    target=None
    for ad in r.get("data",{}).get("list",[]):
        if str(ad.get("smart_plus_ad_id"))==str(ad_id): target=ad; break
    if not target:
        print(f"{i:2d}. ❌ {name} 未在campaign内匹配到ad_id={ad_id}"); fail+=1; continue
    cl=target.get("creative_list",[]) or []
    new_cl=[]; removed=[]
    for cr in cl:
        ci=cr.get("creative_info",{}) or {}
        fn=(ci.get("video_info",{}) or {}).get("file_name","")
        if norm(fn) in GL:
            removed.append(fn); continue
        # 重建 creative_info（保留必要字段）
        vi=ci.get("video_info",{}) or {}
        imgs=ci.get("image_info",[]) or []
        new_cl.append({"creative_info":{
            "ad_format": ci.get("ad_format","SINGLE_VIDEO"),
            "identity_id": ci.get("identity_id"),
            "identity_type": ci.get("identity_type","BC_AUTH_TT"),
            "identity_authorized_bc_id": ci.get("identity_authorized_bc_id") or BC,
            "video_info": {"video_id": vi.get("video_id"), "file_name": vi.get("file_name")},
            "image_info": [{"web_uri": (im.get("web_uri") if isinstance(im,dict) else im)} for im in imgs],
        }})
    if not removed:
        print(f"{i:2d}. ⏭️  {name} 实际未含灰名单素材（可能已处理），跳过"); continue
    if not new_cl:
        print(f"{i:2d}. ⚠️  {name} 移除后素材为空！跳过（避免建空广告）"); fail+=1; continue
    print(f"{i:2d}. {name} ad_id={ad_id}: {len(cl)}→{len(new_cl)} 素材, 移除 {removed}")
    if APPLY:
        u=tt_post("smart_plus/ad/update",{"advertiser_id":AID,"smart_plus_ad_id":ad_id,"creative_list":new_cl})
        if u.get("code")==0:
            print(f"     ✅ 更新成功"); ok+=1
            results.append({"ad_name":name,"ad_id":ad_id,"removed":removed,"kept":len(new_cl)})
        else:
            print(f"     ❌ 更新失败 code={u.get('code')} msg={u.get('message')}"); fail+=1
        time.sleep(0.6)
    else:
        ok+=1
        results.append({"ad_name":name,"ad_id":ad_id,"removed":removed,"kept":len(new_cl)})

print(f"\n{'✅实际更新' if APPLY else 'DRY待更新'} {ok} 条, 失败/跳过 {fail} 条")
json.dump(results,open("/tmp/tt_gl_removed.json","w"),ensure_ascii=False,indent=2)
