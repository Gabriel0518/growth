#!/usr/bin/env python3
"""
Extract revenue data from SQLite records_202605 + records_202606.
Outputs: revenue_by_campaign_day.csv and revenue_ad_by_campaign_day.csv
"""
import sqlite3, csv, os, time

DB_PATH = '/home/admin/dataserver/data.db'
OUT_DIR = '/home/admin/.openclaw/workspace/analysis'

def extract():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    
    # =========================================================
    # AF data (AppsFlyer sources)
    # =========================================================
    af_sql = """
    SELECT 
      date(install_time, '+8 hours') as install_date,
      source as platform,
      app_id,
      campaign,
      COUNT(CASE WHEN event_name IN ('af_complete_registration','ad_complete_registration') THEN 1 END) as installs,
      SUM(CASE WHEN event_name IN ('af_purchase','ad_purchase') THEN revenue ELSE 0 END) as revenue,
      SUM(CASE WHEN event_name IN ('af_purchase','ad_purchase') 
           AND (julianday(event_time) - julianday(install_time)) < 1.0
           THEN revenue ELSE 0 END) as new_user_revenue,
      COUNT(CASE WHEN event_name IN ('af_purchase','ad_purchase') AND revenue > 0 THEN 1 END) as purchase_events
    FROM ({union_sql})
    WHERE source IN ('Facebook Ads','googleadwords_int','tiktokglobal_int')
    GROUP BY install_date, platform, app_id, campaign
    HAVING (installs > 0 OR revenue > 0)
    """
    
    union_tables = """
        SELECT install_time, source, app_id, campaign, event_name, event_time, revenue
        FROM records_202605
        WHERE source IN ('Facebook Ads','googleadwords_int','tiktokglobal_int')
        UNION ALL
        SELECT install_time, source, app_id, campaign, event_name, event_time, revenue
        FROM records_202606
        WHERE source IN ('Facebook Ads','googleadwords_int','tiktokglobal_int')
    """
    
    print("Extracting AF revenue data (2 tables UNION ALL)...")
    t0 = time.time()
    cur = conn.execute(af_sql.format(union_sql=union_tables))
    rows = cur.fetchall()
    cols = [d[0] for d in cur.description]
    
    af_out = os.path.join(OUT_DIR, 'revenue_by_campaign_day.csv')
    with open(af_out, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)
    print(f"  AF: {len(rows)} rows in {time.time()-t0:.1f}s → {af_out}")
    
    # =========================================================
    # AD data (Adjust sources)
    # =========================================================
    ad_sql = """
    SELECT 
      date(CAST(install_time AS INTEGER), 'unixepoch', '+8 hours') as install_date,
      source as platform,
      app_id,
      campaign,
      COUNT(CASE WHEN event_name IN ('af_complete_registration','ad_complete_registration') THEN 1 END) as installs,
      SUM(CASE WHEN event_name IN ('af_purchase','ad_purchase') THEN revenue ELSE 0 END) as revenue,
      SUM(CASE WHEN event_name IN ('af_purchase','ad_purchase') 
           AND (CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER)) < 86400
           THEN revenue ELSE 0 END) as new_user_revenue,
      COUNT(CASE WHEN event_name IN ('af_purchase','ad_purchase') AND revenue > 0 THEN 1 END) as purchase_events
    FROM ({union_sql})
    WHERE source IN ('Facebook+Installs','Instagram+Installs','Off-Facebook+Installs',
                     'Luma+ios+FB+W2A','Dora+ios+FB+W2A','Facebook+web',
                     'TikTok+SAN')
    GROUP BY install_date, platform, app_id, campaign
    HAVING (installs > 0 OR revenue > 0)
    """
    
    ad_sources = "('Facebook+Installs','Instagram+Installs','Off-Facebook+Installs','Luma+ios+FB+W2A','Dora+ios+FB+W2A','Facebook+web','TikTok+SAN')"
    
    union_tables_ad = f"""
        SELECT install_time, source, app_id, campaign, event_name, event_time, revenue
        FROM records_202605
        WHERE source IN {ad_sources}
        UNION ALL
        SELECT install_time, source, app_id, campaign, event_name, event_time, revenue
        FROM records_202606
        WHERE source IN {ad_sources}
    """
    
    print("Extracting AD revenue data...")
    t0 = time.time()
    cur = conn.execute(ad_sql.format(union_sql=union_tables_ad))
    rows = cur.fetchall()
    cols = [d[0] for d in cur.description]
    
    ad_out = os.path.join(OUT_DIR, 'revenue_ad_by_campaign_day.csv')
    with open(ad_out, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)
    print(f"  AD: {len(rows)} rows in {time.time()-t0:.1f}s → {ad_out}")
    
    conn.close()
    print("\n✅ Revenue extraction complete!")

if __name__ == '__main__':
    extract()
