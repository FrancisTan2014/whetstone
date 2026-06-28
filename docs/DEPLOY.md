# Deploy whetstone to your MacBook (continuous, on every merge to `main`)

This is the step-by-step runbook for the deploy described in #184. Follow it once to stand up your
Mac; after that, **every merge to `main` auto-builds and restarts the app**, served over HTTPS via a
Cloudflare Tunnel and reachable from your phone at a stable URL.

It stays in sync with [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml): the workflow
builds and restarts a `launchd` app service and health-checks it; this doc sets up that service, the
self-hosted runner, the tunnel, and persistence.

## How it works

- A **self-hosted GitHub Actions runner** on the Mac (a `launchd` service) runs `deploy.yml` on every
  `push` to `main`. If the Mac is asleep/offline at merge time, the job **queues** and runs when it is
  back online. It runs **only on `main`** (never on `pull_request`), so untrusted PR code never
  executes on your Mac.
- The deploy job does `pnpm install --frozen-lockfile`, `pnpm build`, then **restarts the app service**.
- The **app** is a `launchd` service running the built `src/apps/server/dist/index.js`. It **runs DB
  migrations on boot** and **serves the built web client and the API from one port** (single origin),
  so there is no separate web server and no SPA-fallback config (the client uses a hash router).
- **`cloudflared`** (another `launchd` service) maps a public HTTPS hostname to `http://localhost:<port>`
  — free, no port-forwarding, automatic TLS.
- **Persistence:** `DATABASE_DIR` (and the source/image folders) live outside the runner workspace, so
  notes and reading position survive every redeploy.

Throughout, replace `<YOU>` with your macOS short username (`whoami`).

---

## 1. Prerequisites

```bash
# Homebrew (if you don't have it): https://brew.sh
brew install node@22 cloudflared
corepack enable           # provides pnpm, pinned by the repo's packageManager field
node --version            # expect v22.x
```

## 2. Persistent data folder (survives every redeploy)

```bash
mkdir -p ~/whetstone/data/db ~/whetstone/data/sources ~/whetstone/data/images
```

These absolute paths are referenced by the app service below as `DATABASE_DIR`, `SOURCE_FILES_DIR`,
and `IMAGE_RESOURCES_DIR`. They are **outside** the runner workspace, so a redeploy never wipes them.

## 3. Install and register the self-hosted runner (as a service)

1. On GitHub: **Repo → Settings → Actions → Runners → New self-hosted runner → macOS**. GitHub shows
   the exact download + `./config.sh` commands **with a one-time token**. Run them. When `./config.sh`
   asks, accept the defaults (labels include `self-hosted`).
2. Install it as a `launchd` service so it runs in the background and survives reboots:

   ```bash
   cd ~/actions-runner          # the folder you unpacked the runner into
   ./svc.sh install
   ./svc.sh start
   ./svc.sh status              # should show the service running
   ```

Note the **workspace path** the runner uses for this repo — you need it for the app service below:

```bash
echo "$HOME/actions-runner/_work/whetstone/whetstone"
```

(That is the default for `FrancisTan2014/whetstone`. If you cloned under a different name, adjust.)

## 4. The app `launchd` service

Create `~/Library/LaunchAgents/com.whetstone.app.plist`. Replace `<YOU>` everywhere. `WEB_DIR` points
at the web build inside the runner workspace; `ProgramArguments` runs the freshly built server.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.whetstone.app</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/<YOU>/actions-runner/_work/whetstone/whetstone/src/apps/server/dist/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/<YOU>/actions-runner/_work/whetstone/whetstone</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key><string>127.0.0.1</string>
    <key>PORT</key><string>3000</string>
    <key>WEB_DIR</key><string>/Users/<YOU>/actions-runner/_work/whetstone/whetstone/src/apps/web/dist</string>
    <key>DATABASE_DIR</key><string>/Users/<YOU>/whetstone/data/db</string>
    <key>SOURCE_FILES_DIR</key><string>/Users/<YOU>/whetstone/data/sources</string>
    <key>IMAGE_RESOURCES_DIR</key><string>/Users/<YOU>/whetstone/data/images</string>
    <key>LOG_LEVEL</key><string>info</string>
  </dict>

  <!-- Keep the app running and bring it back after a crash or reboot. -->
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>

  <key>StandardOutPath</key><string>/Users/<YOU>/whetstone/app.log</string>
  <key>StandardErrorPath</key><string>/Users/<YOU>/whetstone/app.err.log</string>
</dict>
</plist>
```

> `node` path: `brew --prefix`/bin/node — `/opt/homebrew/bin/node` on Apple Silicon, `/usr/local/bin/node`
> on Intel. Confirm with `which node`.

The app can only start **after the first successful deploy has produced `dist/`** (step 7). Load it:

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.whetstone.app.plist
launchctl kickstart -k "gui/$(id -u)/com.whetstone.app"   # this is exactly what deploy.yml runs
curl -fsS http://127.0.0.1:3000/health                     # {"service":"whetstone-server","status":"ok"}
```

> If you change `PORT` or the `Label`, set matching repo variables so the workflow's restart +
> health-check use them: `gh variable set WHETSTONE_PORT --body <port>` and
> `gh variable set WHETSTONE_SERVICE_LABEL --body <label>`.

## 5. The Cloudflare Tunnel `launchd` service

**Quick test (no domain)** — a throwaway `https://<random>.trycloudflare.com` URL:

```bash
cloudflared tunnel --url http://localhost:3000
```

**Stable URL with your domain** (domain must be on Cloudflare):

```bash
cloudflared tunnel login
cloudflared tunnel create whetstone
cloudflared tunnel route dns whetstone reader.<your-domain>
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: whetstone
credentials-file: /Users/<YOU>/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: reader.<your-domain>
    service: http://localhost:3000
  - service: http_status:404
```

Run it as a service so the URL is up whenever the Mac is awake:

```bash
sudo cloudflared service install     # installs a launchd service from ~/.cloudflared/config.yml
sudo launchctl kickstart -k system/com.cloudflare.cloudflared
```

Your app is now at `https://reader.<your-domain>`.

## 6. Keep the Mac awake while you want the URL up

A laptop isn't 24/7. The URL is live only while the Mac is awake with the services running:

```bash
caffeinate -dimsu &        # prevent sleep for this session
```

For longer runs use **System Settings → Battery / Energy → Prevent automatic sleeping** (on power).
`KeepAlive` in the plists brings the app + tunnel back after a reboot or crash.

## 7. Turn the deploy on

```bash
gh variable set DEPLOY_ENABLED --body true     # in the repo, or: --repo FrancisTan2014/whetstone
```

With `DEPLOY_ENABLED` unset/false the deploy job **skips** (it does not queue), so the repo is safe to
merge before any of the above is set up.

## 8. Verify end to end

1. Merge any PR to `main` (or push a trivial change).
2. **Repo → Actions → Deploy** — watch the run land on your self-hosted runner: install → build →
   restart → health check (green).
3. On your **phone**, open the Cloudflare URL (`https://reader.<your-domain>` or the `trycloudflare`
   URL). The reader loads over HTTPS.
4. **Add to Home Screen** (Safari → Share → Add to Home Screen). _(Full PWA install polish — manifest,
   iOS icons — is a separate follow-up, not part of #184.)_
5. Create a note / scroll, merge another change to trigger a redeploy, and confirm the note and your
   reading position **survive** (they live in `DATABASE_DIR`).

## Troubleshooting

- **Deploy job is "skipped":** `DEPLOY_ENABLED` isn't `true` (step 7).
- **Job waits forever ("Waiting for a runner"):** the runner service isn't running — `cd ~/actions-runner && ./svc.sh status`.
- **Health check fails:** read `~/whetstone/app.err.log`; confirm the `node` path and `WEB_DIR` in the
  plist, and that `dist/` exists (a deploy has built it).
- **URL unreachable from the phone:** the Mac is asleep, or `cloudflared` isn't running —
  `sudo launchctl print system/com.cloudflare.cloudflared`.
- **Brief 404s right after a merge:** expected — the runner cleans then rebuilds the workspace during a
  deploy; the app restarts onto the new build within a minute.

_Continuous-deploy smoke test triggered: 2026-06-28._
