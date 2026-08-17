#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""扫描 TT 账户所有广告，找出 creative_list 含【灰名单】素材的广告（不区分产品段）。
灰名单规则：只清理【部分过审广告】(secondary_status=AD_STATUS_REVIEW_PARTIALLY_APPROVED)
里的灰名单素材；【完全过审广告】(AD_STATUS_DELIVERY_OK) 即使命中也保留。
命中且【需清理】(部分过审) 的存 /tmp/tt_gl_hits.json；所有命中打印时标注是否清理。
用法: source /etc/environment && python3 scripts/tt-scan-graylist-ads.py [advertiser_id]
只读，不做任何修改。"""
import os, sys, json, time, urllib.request, urllib.parse

API="https://business-api.tiktok.com/open_api/v1.3"
TK=os.environ["TIKTOK_ACCESS_TOKEN"]
AID=sys.argv[1] if len(sys.argv)>1 else "7553499098226819079"

# 只有【部分过审】广告才清理灰名单素材
CLEAN_STATUS={"AD_STATUS_REVIEW_PARTIALLY_APPROVED"}

SEG_LIST=['Dora','Romi','Doni','Luma','Jovia','GraceChat','Kira','Nalo','Mora']
def norm(name):
    if not name: return ""
    base=name[:-4] if str(name).lower().endswith(".mp4") else name
    return "_".join(s for s in str(base).split("_") if s not in SEG_LIST).lower()

# 灰名单归一化键
data=json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),"config","tiktok-material-graylist.json")))
GL={norm(m) for m in data.get("materials",[]) if m}
print(f"灰名单归一化键: {GL}")
print(f"清理触发状态: {CLEAN_STATUS}（其余状态命中仅记录、保留素材）")

def tt_get(ep,params):
    url=f"{API}/{ep}/?"+urllib.parse.urlencode(params)
    req=urllib.request.Request(url,headers={"Access-Token":TK})
    try: return json.loads(urllib.request.urlopen(req,timeout=90).read())
    except urllib.error.HTTPError as e: return json.loads(e.read())

# 1) 拉全账户 smart_plus ad 列表（分页）
clean_hits=[]  # 需清理（部分过审）
keep_hits=[]   # 命中但保留（其它状态）
total_ads=0
page=1
while True:
    r=tt_get("smart_plus/ad/get",{"advertiser_id":AID,"page":page,"page_size":50,
        "fields":json.dumps(["smart_plus_ad_id","ad_name","campaign_id","adgroup_id","operation_status","secondary_status","creative_list"])})
    if r.get("code")!=0:
        print("ad/get FAIL:",r.get("code"),r.get("message")); break
    d=r.get("data",{}); lst=d.get("list",[])
    for ad in lst:
        total_ads+=1
        cl=ad.get("creative_list",[]) or []
        matched=[]; allm=[]
        for cr in cl:
            ci=cr.get("creative_info",{}) or {}
            vi=ci.get("video_info",{}) or {}
            fn=vi.get("file_name","")
            allm.append(fn)
            if norm(fn) in GL: matched.append(fn)
        if matched:
            rec={"campaign_id":ad.get("campaign_id"),"adgroup_id":ad.get("adgroup_id"),
                "smart_plus_ad_id":ad.get("smart_plus_ad_id"),"ad_name":ad.get("ad_name"),
                "op":ad.get("operation_status"),"status":ad.get("secondary_status"),
                "matched":matched,"total_mats":len(allm),"all_mats":allm}
            if ad.get("secondary_status") in CLEAN_STATUS:
                clean_hits.append(rec)
            else:
                keep_hits.append(rec)
    pi=d.get("page_info",{})
    tp=pi.get("total_page",1)
    print(f"  page {page}/{tp}: {len(lst)} ads (累计 {total_ads})")
    if page>=tp or not lst: break
    page+=1; time.sleep(0.3)

print(f"\n扫描完成: 共 {total_ads} 条广告")
print(f"命中灰名单: {len(clean_hits)+len(keep_hits)} 条（需清理 {len(clean_hits)} / 保留 {len(keep_hits)}）")
print(f"\n=== 需清理（部分过审 PARTIALLY_APPROVED）===")
for h in clean_hits:
    print(f"★ {h['ad_name']} | ad_id={h['smart_plus_ad_id']} | camp={h['campaign_id']} | op={h['op']} status={h['status']}")
    print(f"   总素材{h['total_mats']}个, 命中灰名单: {h['matched']}")
print(f"\n=== 命中但保留（完全过审 / 其它状态）===")
for h in keep_hits:
    print(f"○ {h['ad_name']} | ad_id={h['smart_plus_ad_id']} | status={h['status']} | 命中: {h['matched']}")
json.dump(clean_hits,open("/tmp/tt_gl_hits.json","w"),ensure_ascii=False,indent=2)
print(f"\n需清理结果已存 /tmp/tt_gl_hits.json（{len(clean_hits)} 条）")
