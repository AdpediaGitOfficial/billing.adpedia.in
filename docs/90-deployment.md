# 90 · Deployment — step by step, npm + pm2, no Docker

A plain Ubuntu box: **npm** to install and build, **pm2** to keep it running, **Postgres**
on the same machine, **nginx** in front for TLS. No containers, no registry, no CI.

Everything here was derived from this codebase. The 🔴 items are the ones that fail
silently, or fail at 3am, or fail only once two people use the app at the same time.

What ends up running: **one** Node process (API routes *and* server actions are a single
deployable — `docs/10 §`), **one** Postgres cluster, **one** headless Chromium launched
lazily inside that Node process on the first PDF, and **one** cron line outside it. There
is no queue and no worker.

**Before you start** you need: the repo URL, a domain already pointing an A record at the
box, and the VAPID / secret values generated in Step 6. Budget about 40 minutes, most of it
`npm ci` and `playwright install`.

---

## Step 1 · The box

Ubuntu 24.04 LTS, **2 vCPU / 4 GB RAM**, 40 GB disk. As root:

```bash
# a normal user, not --system: pm2 needs a home it can write and a shell it can log into
adduser --home /srv/adpedia --gecos "" --disabled-password adpedia
apt update && apt upgrade -y
timedatectl set-timezone UTC
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

- 🔴 **2 GB of RAM is not enough.** Node plus a resident Chromium plus a render peak gets
  OOM-killed mid-invoice. The symptom is a download that works all morning and fails the
  first time two people ask at once — and `getBrowser()` relaunches afterwards via
  `isConnected()`, so the box looks healthy and nothing points at memory. The swap above is
  the cheap insurance; 4 GB is the real fix.
- 🔴 **Leave the clock on UTC.** Datetimes are stored UTC and rendered Asia/Kolkata by the
  app itself. Setting the host to IST changes no stored value and puts every log line 5½
  hours from the row it describes.
- Postgres will listen on localhost only and never needs a firewall hole.

> Not an ops note: a DigitalOcean droplet is a **foreign** supply → reverse charge, not
> normal ITC (handover §2; AWS India and GoDaddy India are normal ITC). Book the server
> bill under `CLOUD` accordingly — `docs/04 §2`.

## Step 2 · Node 20 and pm2

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git nginx certbot python3-certbot-nginx
npm install -g pm2
node -v && pm2 -v
```

Node **20 LTS** matches development (`v20.12.2`); 22 also satisfies Next 15.5.

🔴 **Install Node from NodeSource, not nvm.** `pm2 startup` writes a unit file with a fixed
`PATH`; with nvm that path lives inside a shell-managed directory, and the app comes back
after a reboot only if that shell happened to have initialised. This is the classic "works
until the box restarts three months later" failure.

`@node-rs/argon2` ships a prebuilt binary for `linux-x64-gnu`, so no toolchain is needed. If
`npm ci` starts compiling anything: `apt install -y build-essential python3`.

## Step 3 · Postgres — install and create the database

```bash
apt install -y postgresql-16
systemctl enable --now postgresql
sudo -u postgres psql -c "CREATE ROLE adpedia LOGIN PASSWORD 'PUT-A-STRONG-PASSWORD-HERE';"
sudo -u postgres psql -c "CREATE DATABASE adpedia OWNER adpedia;"
```

Verify the credentials work over TCP before going further — a wrong password surfaces
otherwise as a confusing Prisma error three steps later:

```bash
PGPASSWORD='PUT-A-STRONG-PASSWORD-HERE' psql -h 127.0.0.1 -U adpedia -d adpedia -c '\conninfo'
```

Ubuntu's default `pg_hba.conf` already uses `scram-sha-256` for host connections and listens
on localhost only. Leave both alone — nothing outside the box should reach 5432.

🔴 **`npm run pg:start` / `scripts/pg.ts` is for development only.** It is
`embedded-postgres`, a devDependency, on port **5461**, keeping its cluster in `.pgdata`
*inside the checkout*. Nothing restarts it and a redeploy that replaces the directory
destroys the database. Production uses the system cluster on 5432.

The schema itself is applied by Prisma in Step 8 — do not hand-create any table.

## Step 4 · Directories

```bash
mkdir -p /srv/adpedia-storage && chown adpedia:adpedia /srv/adpedia-storage
mkdir -p /var/backups/adpedia && chown adpedia:adpedia /var/backups/adpedia
```

🔴 **`STORAGE_DIR` must live outside the checkout.** It defaults to `./.storage`
(`src/server/services/storage/driver.ts:51`). Receipts and bills are *files on disk* keyed
from the database — not blobs in Postgres. A deploy that moves or replaces the checkout
takes every uploaded receipt with it, and the database carries on pointing at them.

## Step 5 · Clone

Everything from here runs as the app user:

```bash
sudo -iu adpedia
git clone <repo-url> /srv/adpedia/app
cd /srv/adpedia/app
```

## Step 6 · The environment file

`.env` in the app root. 🔴 Both `next start` and the Prisma CLI load it from the working
directory themselves — which is why `ecosystem.config.js` sets `cwd` and carries no secrets.
`.env*` is gitignored, so this file survives every `git pull`.

Generate the secrets first:

```bash
openssl rand -base64 48                        # JWT_SECRET
openssl rand -hex 24                           # CRON_SECRET
npx web-push generate-vapid-keys --json        # the VAPID pair
```

```bash
cat > /srv/adpedia/app/.env <<'ENV'
DATABASE_URL="postgresql://adpedia:PUT-A-STRONG-PASSWORD-HERE@127.0.0.1:5432/adpedia"
NODE_ENV=production

JWT_SECRET="<openssl rand -base64 48>"
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_SECONDS=2592000

WEBAUTHN_ORIGIN=https://accounts.adpedia.in
WEBAUTHN_RP_ID=accounts.adpedia.in

VAPID_PUBLIC_KEY=<public>
VAPID_PRIVATE_KEY=<private>
NEXT_PUBLIC_VAPID_PUBLIC_KEY=<public>
VAPID_SUBJECT=mailto:accounts@adpedia.in

CRON_SECRET="<openssl rand -hex 24>"

STORAGE_DRIVER=local
STORAGE_DIR=/srv/adpedia-storage

SEED_OWNER_EMAIL=akash@adpedia.in
SEED_OWNER_PASSWORD=<a temporary password, changed at first login>
ENV
chmod 600 /srv/adpedia/app/.env
```

| Variable | What breaks if it is wrong |
|---|---|
| `JWT_SECRET` | `env()` throws at first use below 32 characters — `src/lib/env.ts` |
| `NODE_ENV=production` | 🔴 this is what sets `secure` on the session cookie (`auth/service.ts:12`). Over plain HTTP **nobody can log in at all** — which is why TLS (Step 14) comes before the first login, not after |
| `WEBAUTHN_ORIGIN` | exactly the https origin, no trailing slash |
| `WEBAUTHN_RP_ID` | the bare domain. 🔴 A mismatch does not warn — every passkey assertion simply fails. The RP ID is baked into each credential, so changing the domain later invalidates every passkey already enrolled |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | 🔴 **inlined at build time**, not read at runtime. It must be in `.env` before Step 11, and rotating push keys is a rebuild, not a restart |
| `CRON_SECRET` | ≥16 characters, or `/api/cron/notify` answers **503 by design** rather than running open to the internet |
| `STORAGE_DRIVER` | `s3` throws — not implemented (`docs/38 §6`) |
| `SEED_OWNER_*` | used once, in Step 9. Delete both lines afterwards |

Do not carry the development `.env` over: its VAPID pair and JWT secret are dev values
(`docs/60 §`).

## Step 7 · Install dependencies

```bash
cd /srv/adpedia/app
npm ci
```

🔴 **Keep devDependencies.** `prisma` and `tsx` are devDependencies and every future
migration and seed needs them. `npm prune --omit=dev` saves 200 MB and breaks upgrades.

## Step 8 · Create the schema

```bash
npx prisma migrate deploy
```

46 migrations apply in order. 🔴 **`migrate deploy`, never `migrate dev`** — `migrate dev`
is the authoring command: it wants to generate migrations and may offer to reset the
database. Confirm:

```bash
npx prisma migrate status
```

## Step 9 · Seed — once

```bash
npm run db:seed
```

**This is not demo data, and production needs it.** It lays down the chart of accounts, the
effective-dated TDS rates, the Kerala profession-tax slabs, the expense categories, the bank
matching rules, the document series, the financial years, the verified company profile
(`docs/01`), and the first OWNER user. Every write is an upsert, so re-running is safe.

Then remove `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` from `.env`.

🔴 Per `docs/65 §6` the seed only lays down the document series that existed when it was
written. After an upgrade adds a document type, that series must be backfilled, or
`allocateNumber` refuses with an instruction pointing at a Settings screen.

## Step 10 · Chromium for the PDFs

The OS libraries need root, once — exit to your sudo user:

```bash
exit                                               # back to the sudo user
# 🔴 from the app directory, so npx resolves the INSTALLED playwright. Run from anywhere
# else and npx silently downloads a different version from the registry, as root.
cd /srv/adpedia/app && sudo npx playwright install-deps chromium

sudo -iu adpedia
cd /srv/adpedia/app && npx playwright install chromium   # ~100 MB into /srv/adpedia/.cache
```

🔴 **Chromium is mandatory, not optional.** `/api/invoices/[id]/document` and the credit
note, voucher, payslip and statement routes all render through it. Installed as the app
user, it lands in that user's `~/.cache/ms-playwright` — which is why pm2 must run as the
same user, and why a `root`-installed browser is invisible to the app.

## Step 11 · Build

```bash
cd /srv/adpedia/app
npm run build
```

`build` runs `prisma generate` first. The build reads `.env`, which it must, because
`NEXT_PUBLIC_VAPID_PUBLIC_KEY` is inlined now and not at runtime.

`next.config.ts` sets no `output: 'standalone'`, so the checkout and its `node_modules` stay
on the box. There is no slim bundle to copy anywhere.

## Step 12 · pm2

The process definition is committed as `ecosystem.config.js` — read the 🔴 comments in it
before changing anything, particularly the instance count.

```bash
cd /srv/adpedia/app
pm2 start ecosystem.config.js
pm2 status
curl -sI http://127.0.0.1:3000/login | /usr/bin/head -1      # expect 200
pm2 save                                                      # freeze this process list
```

Then make it survive a reboot. `pm2 startup` must be run as root but told which user owns
the processes:

```bash
exit
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u adpedia --hp /srv/adpedia
sudo systemctl status pm2-adpedia --no-pager
```

🔴 **`pm2 save` is what makes a reboot come back.** The generated unit resurrects the saved
process list, not whatever is running — start the app, check it, *then* save. A `pm2 start`
you never saved is gone after the first reboot, and the app is simply down with nothing in
any log explaining why.

Log rotation, or `~/.pm2/logs` eventually fills the disk:

```bash
sudo -iu adpedia pm2 install pm2-logrotate
sudo -iu adpedia pm2 set pm2-logrotate:max_size 20M
sudo -iu adpedia pm2 set pm2-logrotate:retain 14
```

## Step 13 · nginx

`/etc/nginx/sites-available/adpedia`:

```nginx
server {
  listen 80;
  server_name accounts.adpedia.in;

  # 🔴 attachments cap at 12 MB (MAX_BYTES, services/storage/attachments.ts). nginx's 1 MB
  # default rejects a phone photo with a 413 the app never sees — so the user gets nginx's
  # error page instead of the message docs/38 wrote for exactly this case.
  client_max_body_size 16m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # 🔴 longer than the renderer's own 20 s page timeout, so a slow render surfaces the
    # app's error rather than a bare 504 with nothing behind it.
    proxy_read_timeout 60s;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/adpedia /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

## Step 14 · TLS — before the first login

```bash
sudo certbot --nginx -d accounts.adpedia.in     # also installs the HTTP→HTTPS redirect
sudo systemctl list-timers snap.certbot.renew.service certbot.timer --all --no-pager
```

The certificate host must equal `WEBAUTHN_ORIGIN` exactly, and `NODE_ENV=production` means
the session cookie is `secure` — so there is no "try it over HTTP first" step.

## Step 15 · Smoke test

1. `https://accounts.adpedia.in/login` → sign in as the seeded owner, **change the password**.
2. Open `/dashboard`, `/invoices`, `/tax/gst` — a 500 here is almost always `.env`.
3. 🔴 **Download one invoice PDF and look at it.** This is the first time Chromium launches,
   and it is the step that catches a missing browser, a missing font and a broken logo at
   once. Every module in this project that rendered its output and looked at it found a bug
   the tests did not (handover §6).
4. `/settings/device` → enrol a passkey, then sign out and back in with it. This is what
   proves `WEBAUTHN_ORIGIN` and `WEBAUTHN_RP_ID`.
5. `pm2 logs adpedia --lines 50` — confirm no `Invalid environment` on boot.

## Step 16 · The daily reminder run

🔴 **There is no scheduler inside the app, deliberately**
(`src/app/api/cron/notify/route.ts`): a `setInterval` in a module fires once per process,
stops silently on a restart, and runs four times behind a load balancer. The schedule lives
outside and calls in, carrying `CRON_SECRET`.

Rehearse first — `dry=1` sends nothing and prints what it would decide:

```bash
cd /srv/adpedia/app && set -a && . ./.env && set +a
curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://accounts.adpedia.in/api/cron/notify?dry=1&on=2026-04-07" | /usr/bin/head -40
```

Then as the app user, `crontab -e`:

```cron
30 2 * * * cd /srv/adpedia/app && set -a && . ./.env && set +a && curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://accounts.adpedia.in/api/cron/notify >> /srv/adpedia/notify.log 2>&1
```

02:30 UTC is 08:00 IST. A real send is always about *today* — the `on=` parameter is honoured
only in a dry run, because otherwise the idempotency key means nothing.

## Step 17 · Backups — 🔴 two things, not one

As the app user, `crontab -e`:

```cron
0 1 * * * cd /srv/adpedia/app && set -a && . ./.env && set +a && pg_dump -Fc "$DATABASE_URL" > /var/backups/adpedia/db-$(date +\%F).dump 2>> /srv/adpedia/backup.log
15 1 * * * rsync -a --delete /srv/adpedia-storage/ /var/backups/adpedia/storage/
0 2 * * 0 find /var/backups/adpedia -name 'db-*.dump' -mtime +30 -delete
```

A database-only backup restores the books and leaves **every receipt and bill a dead link**,
because attachments are files on disk keyed from the database. Nothing financial is ever
hard-deleted — a trigger refuses it — so the database only grows; size the disk for that.

🔴 **Test a restore before go-live**, into a scratch database, and open a report:

```bash
sudo -u postgres createdb restore_test
pg_restore -d "postgresql://adpedia:...@127.0.0.1:5432/restore_test" /var/backups/adpedia/db-2026-10-05.dump
```

An untested dump is not a backup. Copy both off the box as well — a backup on the disk that
dies is not a backup either.

## Redeploying a change

```bash
sudo -iu adpedia
cd /srv/adpedia/app
pm2 stop adpedia
git pull
npm ci
npx prisma migrate deploy
npm run build
pm2 start adpedia && pm2 save
```

- 🔴 **`npm ci` can take the browser away.** It reinstalls the Playwright package, and if the
  version moved, the browser revision it now wants was never downloaded — every document in the
  system fails at once. Run `npx playwright install chromium` after any `npm ci`, as the app user,
  and check `/api/health?deep=1` before letting an invoice go out.
- **Migrations before the build, the build before the restart.**
- 🔴 **Do not build while the old process is serving.** Both read the same `.next`; the dev
  version of this clash is `Cannot find module './897.js'` (handover §5), and in production
  it means serving a chunk that is half-written. The `pm2 stop` above is the simple answer
  (~1 minute of downtime). To avoid even that, build in a parallel checkout and switch a
  symlink, then `pm2 reload`.
- 🔴 A migration that adds an enum value **and** inserts a row referencing it must be two
  files — Prisma runs each file in one transaction, and Postgres will not use a new enum
  value in the transaction that added it (`docs/65 §6`).
- If the schema changed, `pm2 restart` alone is not enough: the Prisma client is generated
  during `npm run build`.

## pm2 cheat sheet

| | |
|---|---|
| `pm2 status` | is it up, how many restarts |
| `pm2 logs adpedia --lines 100` | app output; `--err` for errors only |
| `pm2 restart adpedia` | after an `.env` change (no rebuild needed unless `NEXT_PUBLIC_*`) |
| `pm2 reload adpedia` | zero-downtime in cluster mode only — in fork mode it is a restart |
| `pm2 describe adpedia` | resolved cwd, script, env — the first thing to check when `.env` seems ignored |
| `pm2 save` | after any change to the process list, or a reboot loses it |
| `pm2 monit` | live CPU/memory — Chromium will not appear here, it is a child process |

## Troubleshooting

| Symptom | Cause |
|---|---|
| Login form reloads, no session | `NODE_ENV` not `production` over HTTPS, or being tried over HTTP — the cookie is `secure` |
| `Invalid environment: JWT_SECRET …` on boot | secret under 32 characters |
| `EADDRINUSE` after a restart | pm2 was pointed at `npm start`, orphaning the real server. Use `ecosystem.config.js` as written |
| PDF download fails | `/api/health?deep=1` as the owner names the cause. Since docs/85 the download itself says so too: a missing browser, missing system libraries and an out-of-memory kill each get their own message |
| PDF download 500s, `Executable doesn't exist` | Chromium installed as the wrong user — reinstall as `adpedia` |
| A document 500s but others are fine | since docs/85 it does not: an archived copy whose bytes are missing is logged with its storage key and the document is re-rendered. `x-document-source: rebuilt-now` is the sign |
| PDFs render in the wrong typeface | the templates fetch Poppins from Google at render time and the renderer deliberately does not wait for it. No egress → fallback face, silently. Vendor the font into `templates/` |
| Receipt upload fails with nginx's 413 | `client_max_body_size` — the app's own limit is 12 MB |
| Passkey enrols but will not sign in | `WEBAUTHN_RP_ID` ≠ the domain, or the domain changed after enrolment |
| `/api/cron/notify` returns 503 | `CRON_SECRET` unset or under 16 characters — refusing by design |
| App gone after a reboot | `pm2 save` was never run, or `pm2 startup` was run without `-u adpedia` |
| Invoice download fails only under concurrency | memory. See Step 1 |

## Known gaps on the box

- ~~**No health route.**~~ Closed in docs/85. `GET /api/health` is public and checks the
  database — point monitoring at that, not at `/login`, which returns 200 for as long as Next
  is running whatever is happening underneath. `GET /api/health?deep=1`, signed in as the
  OWNER, additionally **renders a PDF and writes a file**, which is the one way to tell a
  broken invoice from a box that cannot produce any document at all.
- **One process only.** If a second instance is ever added behind nginx, the notify endpoint
  must still be called once a day in total; the per-notification idempotency key is the only
  thing standing between a double call and a double send.

## Go-live checklist

| | |
|---|---|
| ☐ | TLS live, and `WEBAUTHN_ORIGIN` matches the certificate host exactly |
| ☐ | `JWT_SECRET` fresh and ≥32 chars — not the development one |
| ☐ | Fresh VAPID pair, `NEXT_PUBLIC_VAPID_PUBLIC_KEY` in `.env` **before** the build |
| ☐ | `CRON_SECRET` ≥16 chars, cron rehearsed with `?dry=1` |
| ☐ | `STORAGE_DIR` outside the checkout, and in the backup |
| ☐ | `pg_dump` restored into a scratch database once, successfully |
| ☐ | `pm2 save` run, and a reboot actually tested |
| ☐ | `GET /api/health?deep=1` as the owner — database, storage and renderer all `ok` |
| ☐ | An invoice PDF downloaded from the deployed box and **looked at** |
| ☐ | Seed owner password changed, `SEED_OWNER_*` deleted from `.env` |
| ☐ | The handover §1 blockers — PANs for 13 people, annual tax estimates, FY 2026-27 LUT, CA sign-off on the TDS table — are still client-side, and still block a right answer |
