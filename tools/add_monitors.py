"""
Bulk-add every site in config/sites.json to Uptime Kuma (v1).
  pip install uptime-kuma-api
  KUMA_URL=http://localhost:3000 KUMA_USER=admin KUMA_PASS=xxx KUMA_NOTIFICATION_ID=1 python tools/add_monitors.py
Monitor name = site "name" in sites.json (the dashboard matches on it, keep them identical).
"""
import json, os
from uptime_kuma_api import UptimeKumaApi, MonitorType

api = UptimeKumaApi(os.environ.get("KUMA_URL", "http://localhost:3000"))
api.login(os.environ["KUMA_USER"], os.environ["KUMA_PASS"])
notif_id = int(os.environ["KUMA_NOTIFICATION_ID"])

existing = {m["name"] for m in api.get_monitors()}
sites = json.load(open(os.path.join(os.path.dirname(__file__), "..", "config", "sites.json")))

for s in sites:
    if s["name"] in existing:
        print("skip  ", s["name"])
        continue
    api.add_monitor(
        type=MonitorType.HTTP,
        name=s["name"],
        url=s["url"],
        interval=30,            # check every 30 s
        retryInterval=20,       # confirm once after 20 s (avoids false alarms)
        maxretries=1,
        expiryNotification=True,
        notificationIDList=[notif_id],
        accepted_statuscodes=["200-299"],
    )
    print("added ", s["name"])

api.disconnect()
