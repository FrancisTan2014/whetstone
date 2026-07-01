# Deploy whetstone to your MacBook (continuous, on every merge to `main`)

This is the step-by-step runbook for the deploy described in #184. Follow it once to stand up your
Mac; after that, **every merge to `main` auto-builds and restarts the app**, reachable from your phone
over HTTPS at a stable URL — by default a private, fast **Tailscale** `.ts.net` address.

It stays in sync with [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml): the workflow
builds and restarts a `launchd` app service, health-checks it, and (when opted in) asserts the
Tailscale `serve` mapping; this doc sets up that service, the self-hosted runner, the URL, and
persistence.

## How it works

- A **self-hosted GitHub Actions runner** on the Mac (a `launchd` service) runs `deploy.yml` on every
  `push` to `main`. If the Mac is asleep/offline at merge time, the job **queues** and runs when it is
  back online. It runs **only on `main`** (never on `pull_request`), so untrusted PR code never
  executes on your Mac.
- The deploy job does `pnpm install --frozen-lockfile`, `pnpm build`, then **restarts the app service**.
- The **app** is a `launchd` service running the built `src/apps/server/dist/index.js`. It **runs DB
  migrations on boot** and **serves the built web client and the API from one port** (single origin),
  so there is no separate web server and no SPA-fallback config (the client uses a hash router).
- A **stable, fast public-to-you URL:** by default, **Tailscale `serve`** publishes the app on your
  **tailnet** at a fixed `https://<machine>.<tailnet>.ts.net` over a **direct WireGuard** path (near-LAN
  speed, private — your devices only), the **same URL across reboots**. A **named Cloudflare Tunnel**
  (`whetstone.<your-domain>`) is the alternative if you have a Cloudflare domain; **Tailscale Funnel** is
  the opt-in path to share the app **publicly**. Any tokens/keys live on the host — never committed.
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
    <!-- Optional: local Whisper STT for spoken practice (docs/SPEECH.md). Leave out to run without
         voice (spoken turns transcribe to empty). On the deploy host run `pnpm setup --voice` once,
         then copy the WHISPER_BINARY / WHISPER_MODEL_PATH / WHISPER_LANGUAGE it wrote into .env here. -->
    <!-- <key>WHISPER_BINARY</key><string>/Users/<YOU>/Library/Python/3.x/bin/whetstone-whisper</string> -->
    <!-- <key>WHISPER_MODEL_PATH</key><string>small</string> -->
    <!-- <key>WHISPER_LANGUAGE</key><string>en</string> -->
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

## 5. A stable, fast URL (Tailscale `serve` — recommended)

`tailscale serve` publishes the app on your **tailnet** (your own signed-in devices) at a fixed
`https://<machine>.<tailnet>.ts.net`, over a **direct WireGuard** peer-to-peer path — near-LAN
throughput, private by default, and the **same URL across reboots**. This is the recommended default
for personal use: it is materially faster than any relayed tunnel (the quick tunnel is
throughput-throttled) and it never exposes the reader to the public internet. To share the app
publicly — with someone **off** your tailnet — use **Funnel** below instead; that is the only public
option.

**One-time host setup (on the Mac):**

```bash
brew install tailscale
sudo tailscale up                 # opens a browser for SSO; sign in to your account
```

Then **disable node-key expiry** so the machine (and its `.ts.net` URL) never lapses — Tailscale keys
otherwise expire ~6-monthly: in the admin console, **Machines → this Mac → ⋯ → Disable key expiry**.

**Serve the app (persistent):**

```bash
tailscale serve --bg 3000         # serves 127.0.0.1:3000 at https://<machine>.<tailnet>.ts.net
tailscale serve status            # shows the .ts.net URL → your local port
```

`serve` config persists across reboots, so this is a one-time command by hand. The deploy CI also
re-asserts it after every healthy restart once you opt in (below), keeping the served port in sync with
`WHETSTONE_PORT`.

**Reach it from your phone:** install the **Tailscale** app on the phone and sign in to the **same
account** (this adds the phone to your tailnet), then open `https://<machine>.<tailnet>.ts.net`. Because
the phone is on your tailnet, the connection is direct and private — no public exposure.

**Turn on the CI assertion:** set the repo variable so the deploy re-applies `serve` after each health
check:

```bash
gh variable set TAILSCALE_SERVE_ENABLED --body true    # or: --repo FrancisTan2014/whetstone
```

With it set, `deploy.yml` runs `tailscale serve --bg "$WHETSTONE_PORT"` (idempotent) after the app is
healthy, verifies the port is served via `tailscale serve status`, and best-effort curls the `.ts.net`
`/health`. Unset/false → the step **skips** (it never queues and never fails), so deploys behave exactly
as before. The one-time `tailscale up` SSO is a **host prerequisite**, not a CI secret; if you later
automate it, pass a host-provided `TS_AUTHKEY` from the Mac's environment — never commit it.

### Alternative: named Cloudflare Tunnel (if you have a Cloudflare domain)

Prefer a custom domain over a `.ts.net` name? A **named** Cloudflare tunnel keeps the **same hostname
across reboots** — unlike a quick tunnel, whose `trycloudflare.com` URL is random on every start. The
modern token-based setup needs **no `credentials-file` and no committed config**: Cloudflare stores the
routing, and the Mac only holds a token (kept in env, never in the repo).

**One-time setup** (domain must be on Cloudflare — added as a zone in your account):

1. Create the tunnel and bind a fixed hostname in the Cloudflare **Zero Trust** dashboard
   (**Networks → Tunnels → Create a tunnel → Cloudflared**): name it `whetstone`, then under
   **Public Hostname** add `whetstone.<your-domain>` → service `http://localhost:3000`. The dashboard
   shows the tunnel's **token** (a long `eyJ…` string) on the install screen — copy it.

   _(CLI alternative: `cloudflared tunnel login`, `cloudflared tunnel create whetstone`,
   `cloudflared tunnel route dns whetstone whetstone.<your-domain>`, then read the token with
   `cloudflared tunnel token whetstone`.)_

2. Run the tunnel as a `launchd` service that reads the token **from the environment** — no secret in
   the repo, no machine path in any tracked file. Create
   `~/Library/LaunchAgents/com.whetstone.tunnel.plist` (replace `<YOU>`; paste your token):

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key>
     <string>com.whetstone.tunnel</string>
     <key>ProgramArguments</key>
     <array>
       <string>/opt/homebrew/bin/cloudflared</string>
       <string>tunnel</string>
       <string>--no-autoupdate</string>
       <string>run</string>
       <string>--token</string>
       <string>TUNNEL_TOKEN_PLACEHOLDER</string>
     </array>
     <key>KeepAlive</key><true/>
     <key>RunAtLoad</key><true/>
     <key>StandardOutPath</key><string>/Users/<YOU>/whetstone/tunnel.log</string>
     <key>StandardErrorPath</key><string>/Users/<YOU>/whetstone/tunnel.err.log</string>
   </dict>
   </plist>
   ```

   > Keep the real token out of anything you commit. The plist lives only on the Mac. If you prefer not
   > to inline it, store it in a file the service sources (e.g. `~/whetstone/tunnel.env`) and launch
   > `cloudflared` from a tiny wrapper that exports it — either way the token stays on the host.

   Load it (`cloudflared` path is `$(brew --prefix)/bin/cloudflared`):

   ```bash
   launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.whetstone.tunnel.plist
   launchctl kickstart -k "gui/$(id -u)/com.whetstone.tunnel"
   ```

Your app is now permanently at `https://whetstone.<your-domain>` — the **same URL after every reboot**.

### Share publicly: Tailscale Funnel (opt-in)

Need to share the reader with someone **off** your tailnet? **Tailscale Funnel** exposes it on the
public internet at the same stable `https://<machine>.<tailnet>.ts.net` URL — but routed through
Tailscale's public **DERP relays** (slower than `serve`'s direct path) and reachable by anyone with the
link. Use it deliberately for sharing, not as your everyday personal path (prefer `serve` above):

```bash
brew install tailscale
sudo tailscale up
tailscale funnel --bg 3000      # PUBLIC: serves localhost:3000 at https://<machine>.<tailnet>.ts.net
tailscale funnel status         # shows the fixed public URL
```

The `.ts.net` hostname is tied to the machine, so it is also **stable across reboots** (re-run
`tailscale funnel --bg 3000` once; it persists). `serve` and `funnel` are mutually exclusive on a port —
pick one.

### Quick tunnel (throwaway test only)

For a one-off smoke test with **no** setup — note the URL is random and changes on every start, so it
is **not** for the real deploy:

```bash
cloudflared tunnel --url http://localhost:3000
```

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
3. On your **phone**, open your stable URL (the Tailscale `https://<machine>.<tailnet>.ts.net`, or your
   named Cloudflare `https://whetstone.<your-domain>`). The reader loads over HTTPS, and it is the
   **same URL after every reboot**.
4. **Add to Home Screen** (Safari → Share → Add to Home Screen). _(Full PWA install polish — manifest,
   iOS icons — is a separate follow-up, not part of #184.)_
5. Create a note / scroll, merge another change to trigger a redeploy, and confirm the note and your
   reading position **survive** (they live in `DATABASE_DIR`).

## Troubleshooting

- **Deploy job is "skipped":** `DEPLOY_ENABLED` isn't `true` (step 7).
- **Job waits forever ("Waiting for a runner"):** the runner service isn't running — `cd ~/actions-runner && ./svc.sh status`.
- **Health check fails:** read `~/whetstone/app.err.log`; confirm the `node` path and `WEB_DIR` in the
  plist, and that `dist/` exists (a deploy has built it).
- **URL unreachable from the phone:** the Mac is asleep, or the phone/Mac isn't connected. For the
  Tailscale default, confirm both devices are up on the tailnet (`tailscale status`) and the mapping is
  live (`tailscale serve status`); make sure the phone is signed in to the **same** Tailscale account.
  For the Cloudflare alternative, check `launchctl print "gui/$(id -u)/com.whetstone.tunnel"` (a
  bad/expired token shows in `~/whetstone/tunnel.err.log`); for public sharing, `tailscale funnel
status`.
- **Deploy's "Serve over Tailscale" step is "skipped":** `TAILSCALE_SERVE_ENABLED` isn't `true` (§5). If
  it runs but fails, the machine isn't authed — run the one-time `sudo tailscale up` on the Mac (§5).
- **Brief 404s right after a merge:** expected — the runner cleans then rebuilds the workspace during a
  deploy; the app restarts onto the new build within a minute.

_Continuous-deploy smoke test triggered: 2026-06-28._
