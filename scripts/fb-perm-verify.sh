#!/bin/bash
unset https_proxy http_proxy
FB='EAAYwAOHLpG8BR8adOjrZCzzCdJzxpJOFMAVnq7xUUCjMX8qFPOqNXocDVQHKXc3LpnY3NTVdOOedMAGvOIjNeO4c6ZBBNTb7vZAN7Kk4ZBTnogg7F2hSRuaxVJAq4BQQxXGTBjnlzEI4unQjE7fSyQ3zdJrR0PRL8dr2LpAcF8nH1jNfcWZCZBuQoIkRUvZClRkEuPQLlh1kSPkSzfP4t0VFPeZB8LRsa93BApCB6SWWhaX7BlplTZCNHXLnEOoYbZCmZBsoXPzDtjl15MnOyoVWmrE19RS9s45jYDm7AZDZD'
V=v25.0
B="https://graph.facebook.com/$V"
ACT=act_1548558926611600
ACT2=act_3625139237624596
PAGE=923122287560740   # TinyTale page

pass=0; fail=0
run(){  # $1=权限标签  $2=描述  $3=完整url(不含token)
  local sep='?'; [[ "$3" == *'?'* ]] && sep='&'
  local resp; resp=$(curl -s "$3${sep}access_token=$FB")
  if echo "$resp" | grep -q '"error"'; then
    local msg=$(echo "$resp" | python3 -c "import sys,json;print(json.load(sys.stdin)['error'].get('message','?'))" 2>/dev/null)
    echo "  ❌ [$1] $2 -> $msg"; fail=$((fail+1))
  else
    local head=$(echo "$resp" | head -c 120)
    echo "  ✅ [$1] $2 -> ${head}..."; pass=$((pass+1))
  fi
}

echo "########## ads_read ##########"
run ads_read "读广告账户元数据" "$B/$ACT?fields=id,name,account_status,currency,amount_spent"
run ads_read "读 campaigns 列表" "$B/$ACT/campaigns?fields=id,name,status,objective&limit=5"
run ads_read "读 adsets 列表" "$B/$ACT/adsets?fields=id,name,status,daily_budget&limit=5"
run ads_read "读 ads 列表" "$B/$ACT/ads?fields=id,name,status&limit=5"
run ads_read "读账户2元数据" "$B/$ACT2?fields=id,name,account_status,currency"

echo "########## read_insights ##########"
run read_insights "账户级insights(maximum)" "$B/$ACT/insights?fields=spend,impressions,clicks,ctr,actions&date_preset=maximum&level=account"
run read_insights "campaign级insights" "$B/$ACT/insights?fields=spend,impressions,clicks&level=campaign&date_preset=maximum&limit=5"
run read_insights "账户2 insights" "$B/$ACT2/insights?fields=spend,impressions&date_preset=maximum&level=account"

echo "########## business_management ##########"
run business_management "读我的business列表" "$B/me/businesses?fields=id,name,verification_status"
run business_management "读我的广告账户(经BM)" "$B/me/adaccounts?fields=account_id,name,business"
run business_management "读账户所属business" "$B/$ACT?fields=id,name,business"

echo "########## pages_read_engagement ##########"
run pages_read_engagement "读我的pages列表" "$B/me/accounts?fields=id,name,category"
run pages_read_engagement "读page详情" "$B/$PAGE?fields=id,name,category,fan_count,about"
run pages_read_engagement "读page posts" "$B/$PAGE/posts?fields=id,message,created_time&limit=3"

echo "########## pages_manage_ads ##########"
run pages_manage_ads "读page的leadgen/广告关联(ads能力)" "$B/$PAGE?fields=id,name,ads_posts.limit(2)"
run pages_manage_ads "读page可投放的promotable posts" "$B/$PAGE/promotable_posts?fields=id,message&limit=3"

echo "########## ads_management (读侧复验) ##########"
run ads_management "读账户(management可读)" "$B/$ACT?fields=id,name,funding_source_details,spend_cap"
run ads_management "读customaudiences数量" "$B/$ACT/customaudiences?fields=id,name&limit=3"

echo
echo "================ 汇总: 成功 $pass / 失败 $fail ================"
