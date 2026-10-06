# T1 Client Site Watchdog

Uptime Kuma (outages, every 30 s) + a small Node service (daily SSL / domain / noindex / form checks, Teams alerts, dashboard, metrics).

```
Client sites ──► Uptime Kuma ──webhook──► watchdog ──► Teams channel (@on-call)
                                  ▲            │
             daily 09:00 cron ────┘            └──► dashboard :3001 + state.json
             (SSL, domain, noindex, robots, form)
```

## 1. Server (Ubuntu VPS, 1 GB RAM is enough)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
git clone <your-repo> site-watchdog   # or scp this folder
cd site-watchdog
cp .env.example .env
openssl rand -hex 24                  # paste into HOOK_TOKEN
nano .env                             # set HOOK_TOKEN, DASH_PASS, TEAMS_WEBHOOK_URL, DASHBOARD_URL
nano config/sites.json                # every client site
nano config/oncall.json               # rota (upn = Teams email, optional, enables @mention)
docker compose up -d --build
docker compose logs -f watchdog
```

Uptime Kuma: `http://SERVER_IP:3000` (create admin on first visit)
Dashboard: `http://SERVER_IP:3001` (DASH_USER / DASH_PASS)

## 2. Teams webhook

Teams channel > `...` > **Workflows** > "Post to a channel when a webhook request is received" > pick team + channel > copy URL > `TEAMS_WEBHOOK_URL` in `.env` > `docker compose up -d`.
Test: dashboard > **Send test alert**.

## 3. Connect Uptime Kuma to the watchdog

Kuma > Settings > Notifications > Setup Notification
- Type: **Webhook**
- URL: `http://watchdog:3001/hooks/kuma?token=<HOOK_TOKEN>`
- Request body: **Preset – application/json**
- Tick **Default enabled** and **Apply on all existing monitors** > Test > Save

## 4. Add monitors

Manual: Add New Monitor > HTTP(s) > Name **exactly as in sites.json** > interval 30, retries 1, retry interval 20 > tick Certificate Expiry Notification.

Bulk:
```bash
pip install uptime-kuma-api
KUMA_URL=http://localhost:3000 KUMA_USER=admin KUMA_PASS='xxx' KUMA_NOTIFICATION_ID=1 python3 tools/add_monitors.py
```

## 5. sites.json form options

| mode | what it does | use when |
|---|---|---|
| (no `form`) | skipped | no form on the site |
| `presence` | loads the page, checks `expectText` (default `<form`) exists | reCAPTCHA forms, client does not want test emails |
| `submit` | POSTs `fields` to `url`, expects `expectStatus` + `expectText` | CF7 / custom API forms. Ask client to filter subject "Automated daily form test" |

Contact Form 7 endpoint: `/wp-json/contact-form-7/v1/contact-forms/<ID>/feedback`, success text `mail_sent`.

## 6. Production

- Put both ports behind Nginx + Let's Encrypt (e.g. `kuma.nuformsocial.com`, `watchdog.nuformsocial.com`), close 3000/3001 in the firewall.
- Watch the watchdog: add `https://watchdog.../healthz` to a free external monitor (UptimeRobot / Healthchecks.io).
- Backups: `docker run --rm -v site-watchdog_kuma-data:/d -v $PWD:/b alpine tar czf /b/kuma.tgz -C /d .`

## 7. Useful commands

```bash
docker compose restart watchdog          # after .env change
docker compose exec watchdog npm run check   # run checks in terminal, print JSON
curl -u nuform:PASS -X POST localhost:3001/api/run
docker compose logs --tail 100 watchdog
```
