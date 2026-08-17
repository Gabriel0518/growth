#!/bin/bash
set -u
DB=/home/admin/dataserver/data.db
DIR=/home/admin/.openclaw/workspace/dashboard
PORT=8099
BASE=http://localhost:$PORT
PASS="${DASHBOARD_ADMIN_PASS:?set DASHBOARD_ADMIN_PASS}"

echo "===== 1) SYNTAX CHECK ====="
node --check "$DIR/server.js" && echo "server.js OK" || { echo "server.js SYNTAX FAIL"; exit 1; }
node --check "$DIR/public/app.js" && echo "app.js OK" || { echo "app.js SYNTAX FAIL"; exit 1; }

echo
echo "===== 2) PICK A SAMPLE Doni FB CAMPAIGN (June window) ====="
CAMP=$(sqlite3 -readonly "$DB" "
  SELECT trim(campaign) FROM records_202606
  WHERE event_name='af_purchase' AND app_id='com.doni.appa' AND media_source='Facebook Ads'
    AND date(install_time,'+8 hours') BETWEEN '2026-06-15' AND '2026-06-25'
  GROUP BY trim(campaign) ORDER BY SUM(revenue) DESC LIMIT 1;")
echo "Sample campaign: [$CAMP]"

echo
echo "===== 3) GROUND-TRUTH SQL (Doni / FB / campaign, install-day sum) ====="
sqlite3 -readonly "$DB" "
  SELECT date(install_time,'+8 hours') d, ROUND(SUM(revenue),2) rev
  FROM records_202606
  WHERE event_name='af_purchase' AND app_id='com.doni.appa' AND media_source='Facebook Ads'
    AND trim(campaign)='$CAMP'
    AND date(install_time,'+8 hours') BETWEEN '2026-06-15' AND '2026-06-25'
  GROUP BY d ORDER BY d;"

echo
echo "===== 4) START TEMP SERVER ON PORT $PORT (NOT production 8081) ====="
cd "$DIR"
DASHBOARD_PORT=$PORT node server.js >/tmp/rbi-server.log 2>&1 &
SRV=$!
echo "temp server pid=$SRV"
sleep 3

echo
echo "===== 5) LOGIN ====="
curl -s -c /tmp/rbi.cookies -d "username=admin&password=$PASS" "$BASE/login" -o /dev/null -w "login http=%{http_code}\n"

echo
echo "===== 6) CAMPAIGN LEVEL (should match ground truth) ====="
curl -s -b /tmp/rbi.cookies "$BASE/api/revenue-by-install?level=campaign&product=Doni&channel=FB&date=2026-06-25&days=10&campaign=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$CAMP")" | python3 -m json.tool

echo
echo "===== 7) CHANNEL LEVEL (Doni / FB) ====="
curl -s -b /tmp/rbi.cookies "$BASE/api/revenue-by-install?level=channel&product=Doni&channel=FB&date=2026-06-25&days=10" | python3 -c "import sys,json;d=json.load(sys.stdin);print('keys=',list(d.keys()));print('points=',len(d['series']));print('total=',round(sum(p['revenue'] for p in d['series']),2));print('last3=',d['series'][-3:])"

echo
echo "===== 8) PRODUCT LEVEL (Doni) ====="
curl -s -b /tmp/rbi.cookies "$BASE/api/revenue-by-install?level=product&product=Doni&date=2026-06-25&days=10" | python3 -c "import sys,json;d=json.load(sys.stdin);print('points=',len(d['series']));print('total=',round(sum(p['revenue'] for p in d['series']),2))"

echo
echo "===== 9) OPERATOR LEVEL ====="
OP=$(sqlite3 -readonly "$DB" "SELECT trim(campaign) FROM records_202606 WHERE event_name='af_purchase' AND media_source='Facebook Ads' LIMIT 1;")
echo "(operator inferred from campaigns by matchOperator; querying a known code)"
for code in syh zm1 cyl wcx mcy lh; do
  R=$(curl -s -b /tmp/rbi.cookies "$BASE/api/revenue-by-install?level=operator&operator=$code&date=2026-06-25&days=10")
  T=$(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);print(round(sum(p['revenue'] for p in d['series']),2))" 2>/dev/null)
  echo "operator=$code  total=$T"
done

echo
echo "===== 10) ERROR HANDLING (missing params / bad level) ====="
curl -s -b /tmp/rbi.cookies "$BASE/api/revenue-by-install?level=campaign&product=Doni" -w "\n http=%{http_code}\n"
curl -s -b /tmp/rbi.cookies "$BASE/api/revenue-by-install?level=bogus" -w "\n http=%{http_code}\n"
echo "===== 11) AUTH CHECK (no cookie -> 401) ====="
curl -s "$BASE/api/revenue-by-install?level=product&product=Doni" -w "\n http=%{http_code}\n"

echo
echo "===== 12) KILL TEMP SERVER ====="
kill $SRV 2>/dev/null
sleep 1
echo "done. server log tail:"
tail -5 /tmp/rbi-server.log
