# Client Site Watchdog: User Guide

Nuform Social · T1 of the "Tiny Blocks" automation series

This guide explains every feature in plain language. You do not need to be technical to use the dashboard. The last part (Admin notes) is for whoever looks after the server.

## 1. What it does

The watchdog keeps an eye on every client website and tells your team on Microsoft Teams when something is wrong. It does two jobs:

1. **Outage watching, every 30 seconds.** A free tool called **Uptime Kuma** opens each site over and over. If a site stops answering, the watchdog posts an alert in your Teams group chat and @mentions the person on call.
2. **Daily health checks, every morning at 09:00 IST.** The watchdog itself checks things that break quietly: the SSL certificate, the domain registration, whether Google is blocked from the site, whether the contact form works, how fast the homepage is, and a few extras.

```
Client websites
      ^   every 30 seconds
Uptime Kuma  ---- site is down ---->  Watchdog  ---->  Teams group chat
                                         |                (@on-call, @always-alert)
 daily at 09:00 IST ---------------------+
 (SSL, domain, indexing, form, speed)    |
                                         +---->  Dashboard (http://localhost:3001)
```

**What is open source and what is custom**

| Part | Type |
|---|---|
| Uptime Kuma (checks sites every 30 s) | Open source, used as is |
| Docker, Node.js, Express | Open source |
| RDAP / WHOIS (public domain databases) | Public services |
| The watchdog app: Teams cards, daily checks, dashboard, on-call rota, Kuma connection, login | Custom, built for Nuform |

## 2. Signing in

Open the dashboard at **http://localhost:3001** (or your server's address). If you are not signed in you land on the sign-in page.

- Sign in with your **Uptime Kuma username and password**. One account for both tools.
- The `nuform` login stored in the `.env` file (`DASH_USER` and `DASH_PASS`) also works. Use it if you forget the Kuma password.
- Use the **eye icon** in the password box to show or hide what you typed.
- You stay signed in for 7 days. **Log out** is in the top right.
- After 10 wrong attempts in a minute the page asks you to wait.
- If Uptime Kuma has no account yet, the sign-in page shows a button that opens Kuma so you can create one first.

## 3. The dashboard, top to bottom

**Headline.** One sentence that says whether everything is fine, how many sites need attention, or how many are down right now. The coloured bar beside it is green, amber or red. Underneath you see when the daily checks last ran.

**On call now.** Who is responsible this week. This name is used in Teams alerts.

**Banner "No Teams destination is switched on".** Shows when no destination is switched on. **Set up Teams** opens the settings.

**The five number boxes**

| Box | Meaning |
|---|---|
| Average uptime, 30 days | How much of the last 30 days your sites were up, averaged across sites |
| Outages caught, 30 days | How many times a site went down |
| Average outage to alert | Time from a site going down to the Teams alert being sent |
| Expired SSL or domains now | Sites whose certificate or domain has already expired |
| Alerts that failed to reach Teams | Alerts the watchdog could not deliver |

Uptime and outage numbers come from Uptime Kuma. Until Kuma is connected they show a dash or zero.

**The site list.** One row per site. Use the filters **All / Needs attention / Paused**.

## 4. Reading a site row

| Part of the row | What it shows |
|---|---|
| Coloured bar on the left | Green: all good. Amber: warning. Red: a problem or the site is down. Dashed grey: paused |
| Name and client | Click the name to open the details panel |
| 30-day strip | 30 small bars, one per day, oldest on the left. Green = day passed, amber = warning, red = critical, grey = no check that day. Hover a bar to see the date and the issues |
| Uptime % and "avg ms" | Uptime over 30 days and the average response time |
| Status | Up or Down right now. "No events" means Uptime Kuma has not reported on this site yet |
| SSL | Days until the HTTPS certificate expires |
| Domain | Days until the domain name registration expires |
| Indexing | "Indexable" means Google may list the site. "noindex" or "Blocked" is a serious problem (see section 7) |
| Form | The contact form result: Working, Broken or Not set up |
| Check now | Runs all checks for that site immediately |

If the site has no Uptime Kuma data you see: *"No uptime events yet. Check this site is added in Uptime Kuma with the exact same name."* Fix it with **Connect Uptime Kuma** (section 6).

**The details panel** (click the site name) lists what needs fixing, the 30-day history with dates, and extra facts: homepage load time, Kuma average response, uptime for 24 hours and 30 days, whether `http://` redirects to `https://`, and whether `sitemap.xml` exists. It also holds the buttons **Edit site**, **Pause monitoring**, **Open site** and **Delete**.

## 5. Managing sites

### Add a site
Click **Add site** and fill in:

- **Site name.** The label you see everywhere. It must match the monitor name in Uptime Kuma exactly. If you use *Connect Uptime Kuma*, the match is automatic.
- **Client.** Optional, shown under the name.
- **Homepage URL.** Starts with `http://` or `https://`.
- **Domain for expiry check.** Optional. Leave it empty and the watchdog uses the homepage's domain. You can paste `www.example.com` or a full address; it is cleaned to `example.com`.
- **Contact form check.** See below.

If a field is wrong, the form lists what to fix in red. Nothing is saved until it is correct.

### Contact form check: three modes

| Mode | What it does | When to use |
|---|---|---|
| No form check | Skips the form | The site has no form |
| Form is on the page | Opens the page and looks for the form (or for text you choose) | Forms with reCAPTCHA, or clients who do not want test emails |
| Send a test submission | Actually sends the form with the fields you list, then checks the answer | Contact Form 7 or custom forms |

For test submissions you set the fields to send (name and value rows), the expected HTTP status (usually 200), and text that must appear in the answer (for Contact Form 7 that is `mail_sent`). The Contact Form 7 address looks like `/wp-json/contact-form-7/v1/contact-forms/ID/feedback`. **Test submissions can email the client**, so ask them to filter the subject "Automated daily form test".

**Test this form now** (inside Edit site) runs only the form check, using what is on screen, before you save. It works for saved sites.

### Edit, pause, delete
- **Edit site** changes any detail. Renaming keeps the site's history.
- **Pause monitoring** skips the site in the daily checks and greys it out. **Resume monitoring** brings it back. Pausing does not stop the monitor inside Uptime Kuma; pause it there too if you need to.
- **Delete** removes the site and its history after you confirm. A backup copy of the settings is kept.

Every change is saved safely and the previous version is copied to `config/backups/`.

## 6. Connecting Uptime Kuma

Uptime Kuma is the part that watches sites every 30 seconds. Open **Connect Uptime Kuma** in the top bar. The window checks Kuma and shows the step you need:

| What the window says | What to do |
|---|---|
| Kuma is not reachable | Start it with `docker compose up -d`, then reopen the window |
| Kuma has no account yet | Choose a username and password. **Generate strong password** makes one, and **Copy password** saves it to your clipboard. Click **Create account and connect** |
| Kuma has an account | Type your Kuma username and password once and click **Connect and sync** |
| Connected | Use **Sync sites now** any time. New sites are added automatically |

What the connect step does for you:

1. Creates the Kuma account (first time only).
2. Creates a Kuma notification called "Watchdog (Teams relay)" that calls the watchdog when a site goes down or comes back.
3. Adds a monitor for every active site: checks every 30 seconds, one quick retry after 20 seconds to avoid false alarms, certificate expiry notices on, and any 200-299 answer counts as up.
4. Skips monitors that already exist.

**Remember this login on the server** (ticked by default) saves the Kuma login in the server's private data folder, readable only by the server. That is what makes new sites sync automatically. **Forget saved login** removes it.

After connecting, the watchdog reads live numbers from Kuma every 2 minutes: Up or Down, uptime for 24 hours and 30 days, and average response time. The dashboard fills in with real data straight away.

Prefer to do it by hand? The window has a "Prefer to do it by hand?" section with the exact link to paste into Kuma and the bulk script command.

## 7. The daily checks and what the results mean

The watchdog runs these every day at 09:00 IST, and whenever you click **Run all checks** or **Check now**.

| Check | Warning | Critical |
|---|---|---|
| **SSL certificate** (the padlock) | Expires in 14 days or less | Expired, invalid, or the check failed |
| **Domain registration** | Expires in 30 days or less, or the date could not be found | Already expired |
| **Homepage** | Loads slower than 3 seconds | Not reachable, or an error status (400 and above) |
| **Google indexing** | | A `noindex` tag or header is hiding the site, or `robots.txt` blocks the whole site |
| **http to https redirect** | `http://` does not move visitors to `https://` | |
| **Contact form** | | The form is missing or the test submission failed |
| **sitemap.xml** | Shown as information only, never an alert | |

Good to know:

- **Domain expiry** is looked up in public databases (RDAP first, then WHOIS). If today's lookup fails, the last known date is kept and marked so you are not shown "Unknown" for no reason.
- A site's overall colour is the worst result: any critical makes it red, otherwise any warning makes it amber.
- The 30-day strip keeps one result per day, up to 30 days. Running checks twice in a day replaces that day's cell.
- Paused sites are skipped.

## 8. Teams alerts

Alerts arrive as cards in your Teams **group chat**. You will see:

- **DOWN: Site name**, with the site, URL, reason, time detected, and an **Open dashboard** button.
- **Back up: Site name**, with how many minutes it was down.
- **Daily check: N of M sites need attention**, after the 09:00 run, listing each site and its issues. Nothing is posted when all is well.
- Every card ends with **On call:** the person on call, plus everyone on the **Always alert** list, all @mentioned.

**Send test alert** posts a test card so you can confirm the link works.

### Where alerts go: your list of destinations
Everything about who gets which alert is decided in the dashboard, not in code or files. Open **Alerts and on-call**. **Where alerts are sent** is a list of **destinations**. A destination is one Teams workflow: a group chat or a personal chat. Add as many as you like, for example one group chat for the dev team and one personal chat for each person on the rota.

Press **Add destination** (or **Edit** on an existing one) and set:

| Setting | What it does |
|---|---|
| **Name** | A label only you see, such as "Dev team group" or "Sushant" |
| **Type** | Group chat or Personal chat |
| **Teams link** | The secret link from that destination's Teams workflow. It is kept on the server and never shown again (you see only its last few characters). Paste a new one only to replace it |
| **Send these alerts** | Tick the ones it should get: a site goes down, a site comes back up, the daily check summary, and notices from Uptime Kuma (such as certificate expiry) |
| **For which sites** | All sites, or only the sites you tick. In a daily summary a destination sees only its own sites |
| **When to send** | Always, or **only while a chosen person is on call**. This is how each person's own personal chat gets the alerts only during their week |
| **@mention people** | Turns real @mentions on or off. Leave it off for a personal chat |

Each row in the list has an **On** tick (switch it on or off without losing its settings), **Test** (sends exactly one test message to that destination, whatever its rules say) and **Edit**. Inside **Edit** you can also **Delete** it.

An alert goes to **every** destination whose rules match it. If none match, the alert still appears in the dashboard's outage list and is marked "No destination matched".

Nothing is sent unless there is a real alert, a daily check with problems, a manual **Run all checks**, or you press a test button. The top bar's **Send test alert** asks you to confirm and then sends one message to every destination that is on. The automatic run when the watchdog first starts only fills the dashboard and never posts to Teams.

**Example setup**

- *Dev team group*: group chat, outages and recoveries, all sites, always.
- *Sushant*: personal chat, all alerts, all sites, only while Sushant is on call.
- *Gemkara lead*: personal chat, outages only, only the site "OYA by Gemkara", always.

**How to get a link for a destination**

1. In Teams open **Workflows** and pick the template **Send webhook alerts to a chat**.
2. **Group chat:** for "Post in" choose Group chat and pick the chat.
3. **Personal chat:** the person who should receive the alerts creates it and chooses **Chat with Workflow bot**. If Teams shows a **Recipient** box instead, enter their email there.
4. Create it, copy the link at the end and paste it into the destination. Each destination needs its own link.

Keep every link secret. Anyone who has it can post in that chat. If a link is shared by mistake, create a new workflow and paste the new link into the destination.

### Alerts and on-call window
- **Always alert.** People who are @mentioned on every alert (for example Sushant, `sushant@nuformsocial.com`). Add a name and Teams email.
- **Weekly on-call rota.** Add a person with a name, optional Teams email, and from/to dates. The person whose dates include today is "on call now". Without a Teams email the name shows but there is no @mention.

## 9. How often sites are rechecked and what data we collect

**Timing**

| What | How often |
|---|---|
| Uptime Kuma opens every site | **Every 30 seconds** |
| After a failed check | Kuma checks again after **20 seconds**. If that fails too, the site is marked **Down** and the alert goes out |
| Time from a real outage to the alert | About **20 to 50 seconds** for Kuma to confirm, plus a few seconds to reach Teams. The "Average outage to alert" box shows the real figure |
| Site comes back | The "Back up" alert goes out at the first successful check, within about 30 seconds |
| Daily checks (SSL, domain, indexing, form, speed and more) | **Every day at 09:00 IST**, and any time you press **Check now** or **Run all checks** |
| Uptime numbers from Kuma on the dashboard | Refreshed **every 2 minutes** |
| The dashboard screen | Updates by itself the moment something changes |

These timings are set when a monitor is created. Sync never changes monitors that already exist, so to use a different interval, edit that monitor inside Uptime Kuma.

**Data we collect**

| Source | Data |
|---|---|
| Uptime Kuma | Up or Down now and the reason, uptime for 24 hours and 30 days, average response time, and every outage and recovery |
| SSL check | Days left, expiry date, who issued it, and whether the certificate is valid |
| Domain check | Days until the domain registration expires, and where the date came from (RDAP or WHOIS) |
| Homepage check | HTTP status, load time in milliseconds, `noindex` tag or header, whether `robots.txt` blocks everything |
| Extra checks | Whether `http://` redirects to `https://`, whether `sitemap.xml` exists |
| Contact form | Present, or a test submission worked, with the HTTP status |
| Kept over time | One result per site per day for 30 days (with the load time), and the last 500 outage alerts |

## 10. Live updates

The dashboard refreshes by itself when anything changes: an outage, a finished check, a saved edit. If you have a window open (such as the site editor), the refresh waits until you close it so you do not lose what you typed.

## 11. Where things are stored

| What | Where |
|---|---|
| Site list | `config/sites.json` |
| On-call rota | `config/oncall.json` |
| Always-alert people | `config/settings.json` |
| Previous versions of the above (last 50 each) | `config/backups/` |
| Results, 30-day history, outage log (last 500), Kuma numbers | `state.json` in the data volume |
| Saved Kuma login (if you chose to remember it) | `kuma.json` in the data volume, private to the server |
| Teams destinations and their links | `destinations.json` in the data volume, private to the server |
| Uptime Kuma's own data | The `kuma-data` Docker volume |

You can still edit the config files by hand; changes apply without a restart.

## 12. Troubleshooting

| Problem | Likely cause and fix |
|---|---|
| A test says it failed, or the log says `WorkflowTriggerIsNotEnabled` | That Teams Workflow is switched off. In Teams open **Workflows**, find it and turn it on |
| Messages reach the group but not a personal chat | The personal chat needs its own destination with its own link. Add it under **Alerts and on-call > Where alerts are sent** and make sure it is On |
| An alert shows "No destination matched" | No destination is on for that kind of alert and site, or its on-call rule does not match this week's person. Edit the destination's rules |
| "Teams alerts are off" banner | `TEAMS_WEBHOOK_URL` is empty in `.env` |
| "No uptime events yet" on a site | The site is not in Kuma, or its name differs. Use **Connect Uptime Kuma > Sync sites now** |
| Cannot sign in with the Kuma login | Try the `nuform` login from `.env`. If Kuma is down the Kuma login cannot be checked |
| Forgot the Kuma password | Kuma cannot reset it. Sign in with the `nuform` login. If you need Kuma access, reset Kuma's data (this deletes its monitors; the dashboard can re-add them) |
| Domain shows Unknown | Public lookup failed. The watchdog retries tomorrow. Check the domain field has only the main domain, such as `example.com` |
| Form shows Broken | Open **Edit site > Test this form now** to see the exact error |
| Dashboard will not open | Run `docker compose ps` and check both containers are healthy |

## 13. Admin notes

**Start, stop, logs**
```
docker compose up -d --build      start (or restart after changing .env)
docker compose ps                 check both containers are healthy
docker compose logs -f watchdog   watch the watchdog's log
docker compose down               stop (data is kept)
```

**Run without Docker (watchdog only)**
```
cd app
npm install
npm start          # or: npm run dev   (restarts on file changes)
```
Uptime Kuma still needs Docker (or its own npm install). Settings are read from the `.env` file in the project folder.

**Settings in `.env`**

| Name | Meaning | Default |
|---|---|---|
| `TEAMS_WEBHOOK_URL`, `TEAMS_DM_WEBHOOK_URL` | Optional. Only read **once**, the first time the watchdog starts, to create a destination from an older setup. After that, destinations are managed only in the dashboard | empty |
| `HOOK_TOKEN` | Secret Kuma uses when calling the watchdog | generated |
| `DASH_USER`, `DASH_PASS` | Backup dashboard login | `nuform`, generated |
| `DASHBOARD_URL` | Link behind "Open dashboard" in Teams | `http://localhost:3001` |
| `CHECK_CRON` | When daily checks run | `0 9 * * *` |
| `TZ` | Time zone | `Asia/Kolkata` |
| `SSL_WARN_DAYS` | SSL warning threshold | 14 |
| `DOMAIN_WARN_DAYS` | Domain warning threshold | 30 |
| `SLOW_MS` | Slow homepage threshold in milliseconds | 3000 |

**Before going live on a server:** put both ports behind HTTPS (for example Nginx with Let's Encrypt), change `DASHBOARD_URL` to the public address, and back up the two Docker volumes.

**Health check:** `/healthz` answers without a login so an outside monitor can watch the watchdog itself.

## 14. Not included yet

- Reports (scheduled summaries). The brief for this part was not finished.
- Per-person permissions: everyone who can sign in has full access.
- Pausing a site does not pause its Uptime Kuma monitor.

## 15. Glossary

- **Uptime:** the share of time a site was reachable.
- **Outage:** a period when a site could not be reached.
- **SSL certificate:** what makes the padlock and `https://` work. When it expires, browsers warn visitors.
- **Domain:** the website's name (example.com). It is rented yearly and must be renewed.
- **noindex:** an instruction that tells Google not to list a page. Dangerous if left on by mistake.
- **robots.txt:** a file that tells search engines which parts of a site to skip.
- **sitemap.xml:** a list of pages that helps Google find them all.
- **Webhook:** an automatic message one tool sends another, like a phone call between programs.
- **On call:** the person responsible for reacting to alerts that week.
