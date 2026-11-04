# Deploying code.hosh.it

Deployment on the hosh.it box (box standard: `docs/BOX-CONTRACT.md`). Releases deploy themselves
through **hosh-deploy** (§1); a first install is a one-time on-box step (§1b). `.env.example`
defaults already fit the box; the **owner** only provides secrets.

## 1. How releases go live (hosh-deploy — the only deploy path on the box)

Every release (`release` workflow: tag `vX.Y.Z` or Actions → release) ends with the **`deploy`** job:
GitHub connects to the box as `deployer` with this repo's `HOSH_DEPLOY_KEY` (bound to livecode only)
and runs `hosh-deploy deploy livecode vX.Y.Z`. The box pulls the image, swaps the tag in
`livecode.env`, waits healthy, checks `/healthz` on the loopback port and through Traefik, runs
`POST_DEPLOY` inside the container (`deploy/hosh-deploy.conf`) and **rolls back by itself** if any
check fails (the workflow then goes red). Nothing from the repo runs on the host.

- Redeploy / roll forward / back: Actions → **deploy** → `vX.Y.Z`, `rollback` or `status`.
- On the box (owner, or the on-box Claude without a sudo window): `sudo hosh-deploy deploy livecode vX.Y.Z`,
  `sudo hosh-deploy rollback livecode`, `sudo hosh-deploy status livecode`. Log: `/var/log/hosh-deploy.log`.
- Repo variable `HOSH_AUTODEPLOY=false` stops auto-deploy after releases (manual dispatch still works).

## 1b. First install on the box (once; on-box Claude in an owner-opened sudo window)

Box rules: `ACTIONS-LOG.md` intent BEFORE, result + revert AFTER; `/home/pazka/MIGRATION/scripts/smoke.sh`
BEFORE and AFTER. Prerequisites done by `scripts/new-project.sh` + the on-box session: DNS record,
port registered in `11-BOX-STANDARD.md`, a `v0.1.0` release built.

```sh
# A — release checkout (provides docker-compose.example.yml, .env.example, deploy/*)
sudo mkdir -p /srv/livecode && sudo chmod 750 /srv/livecode && cd /srv/livecode
[ -d .git ] || { sudo git init -q && sudo git remote add origin https://github.com/pazka/livecode; }
sudo git fetch -q --depth 1 origin tag v0.1.0 && sudo git checkout -q v0.1.0
# B — env file from the template (no secret in it yet); never read it after step C
[ -e livecode.env ] || sudo install -m 600 .env.example livecode.env
```
**C — owner: secrets.** None: livecode has no secret (rooms are capability links). Step C is skipped.
```sh
# D — pin the box config (validates the compose hardening), first deploy (writes the Traefik route)
sudo hosh-deploy register livecode
sudo hosh-deploy deploy livecode v0.1.0
# E — GitHub key for auto-deploys (claude_agent: keygen; root: bind; gh: secret; private key shredded)
ssh-keygen -q -t ed25519 -N '' -C hosh-deploy:livecode -f /tmp/livecode-deploy
sudo /home/pazka/MIGRATION/scripts/setup-hosh-deploy.sh key livecode /tmp/livecode-deploy.pub
gh secret set HOSH_DEPLOY_KEY -R pazka/livecode < /tmp/livecode-deploy && shred -u /tmp/livecode-deploy /tmp/livecode-deploy.pub
```
Then add `svc_livecode` to the box smoke harness (`scripts/smoke.sh`: function, host in `TLS_HOSTS`, name
in `SERVICES`, new `c_*` helpers in its `export -f` list) from §3, run `scripts/smoke.sh all` (AFTER),
and test the GitHub path once: Actions → deploy → `status`.

**Revert:** `cd /srv/livecode && sudo docker compose --env-file livecode.env down` (keeps the volume) +
`sudo rm /root/hosh-deploy/edge/traefik/dynamic/livecode.yml /etc/hosh-deploy/apps/livecode.conf` +
`sudo .../setup-hosh-deploy.sh unkey livecode`.

## 2. Variables (`livecode.env`, mode 600)
All optional; `.env.example` holds the box values. Nobody needs to edit the file for a normal install.

| Variable | Default | Meaning |
|---|---|---|
| `APP_IMAGE` | `ghcr.io/pazka/livecode:v0.1.0` | image tag (the only line hosh-deploy changes) |
| `APP_BIND` | `127.0.0.1:9134` | loopback port published for Traefik |
| `APP_BASE_URL` | `https://code.hosh.it` | public origin; browsers may open room WebSockets only from it |
| `APP_TRUSTED_PROXIES` | `127.0.0.0/8,::1/128,172.16.0.0/12` | X-Forwarded-For trusted only from these peers |
| `APP_LOG_LEVEL` | `info` | `debug` logs every request (room ids never logged, only a hash tag) |
| `LIVECODE_ROOM_TTL_DAYS` | `7` | a room idle this long (nobody opened, edited or left it) is deleted; smoke rooms after 1 h |
| `LIVECODE_MAX_FILE_KB` | `128` | characters per file: the editor refuses more, the server cuts back beyond it |
| `LIVECODE_MAX_DOC_KB` | `640` | encoded size of one room (3 files + edit history); edits beyond are refused |
| `LIVECODE_MAX_ROOMS` / `_STORAGE_MB` | `2000` / `512` | rooms / bytes on disk; new rooms refused beyond (existing keep working) |
| `LIVECODE_MAX_LIVE_ROOMS` | `100` | rooms in memory at once |
| `LIVECODE_MAX_RSS_MB` | `384` | process memory guard (container 512 MiB): new rooms/connections wait above it |
| `LIVECODE_MAX_PEERS_PER_ROOM` | `32` | people in one room |
| `LIVECODE_MAX_CONNS` / `_PER_IP` | `500` / `24` | WebSockets in total / per client address |
| `LIVECODE_NEW_ROOMS_PER_HOUR` / `_TOTAL` | `20` / `200` | rooms one address / everyone together may create per hour |

Worst case on disk: 512 MB (inside the 7-day TTL); in memory: bounded by the RSS guard. Per message: 512 KiB,
100 msg/s per connection (burst 300).

## 3. Capability checks (what "works" means — not just a 200)
`POST_DEPLOY` = `/app/livecode smoke http://127.0.0.1:8000` runs 1–6 inside the container after every deploy
(any failure ⇒ automatic rollback). From the box, 1–5 and 7–9 through Traefik (`svc_livecode` in smoke.sh).

1. `GET /healthz` → 200 `{"status":"ok","storage":"writable","version":"vX.Y.Z","rooms":{…},"connections":n}`
   (writes and reads back a probe file in `/data`).
2. `GET /r/<room>` → 200 HTML referencing `/app.js?v=<hash>`; CSP has `script-src 'self'` and
   `frame-ancestors 'none'`; `/app.js?v=…` → 200, > 100 KB (the editor bundle), `/app.css` → 200.
3. `GET /preview` → 200 with CSP `form-action 'none'` + `frame-ancestors 'self'`; `/preview.js` has
   `Cross-Origin-Resource-Policy: cross-origin` (the sandboxed frame must be able to load it).
4. `GET /new` → 303 `Location: /r/<12 chars>`.
5. Two WebSocket clients on `/ws/smoke-<rand>`: both get the starter (one `<h1>`), an edit of one reaches the
   other, the presence (name) of one reaches the other.
6. All clients leave → `/data/rooms/<room>.ydoc` exists; a new client gets the edit back, starter not
   duplicated. (The smoke deletes its room file.)
7. `/ws/<room>` with `Origin: https://evil.example` → 403; without upgrade headers → 426.
8. `GET /.env` → 404 (edge block); HSTS header present.
9. Loopback: `127.0.0.1:9134/healthz` ok; nothing on `0.0.0.0:9134`.

By hand once (browser): two windows in one room see each other's cursor and name; typing refreshes the
other's preview; Settings → Theme / Keymap / a shortcut change takes effect at once.

## 4. What runs
| Item | Value |
|---|---|
| Image | `ghcr.io/pazka/livecode:vX.Y.Z` |
| Upstream | container :8000 → `127.0.0.1:9134` |
| Edge | `/root/hosh-deploy/edge/traefik/dynamic/livecode.yml` (router `livecode@file`, resolver `le`, HSTS) |
| Volume | docker volume `livecode-data` → `/data` (in the monthly restic golden backup) |
| Health | `GET /healthz` → `{"status":"ok", …}` |
| Outbound | none (the server calls nothing; pages people write may load CDN files in *their* browsers) |
| Secrets | none |

## 5. Decisions / known limits
- **Deno single binary** (bastonks pattern): `deno compile` with permissions compiled in
  (`--allow-net=0.0.0.0:8000,127.0.0.1:8000 --allow-read=/data --allow-write=/data --allow-env=<list>`).
- **No auth by design** (owner, 2026-11-04): room links are capabilities (60-bit random ids). A typed room
  name is guessable: say so to users who pick one. Abuse is bounded by the limits in §2 (owner, same day:
  7-day idle TTL, a comfortable per-file cap, no way to flood rooms).
- **The preview is user code.** It runs in a sandboxed iframe with an opaque origin and its own CSP: it may
  load external resources and `fetch` (useful for live coding), but can't read the app, submit forms,
  open popups or navigate the top window. It is shown only inside the editor, never as a standalone page.
- **Persistence**: each room is one Yjs state file in `livecode-data` (saved 2 s after edits, at most 10 s,
  when the last person leaves, and on SIGTERM — `stop_grace_period: 20s`). A container kill -9 may lose up
  to ~10 s of edits; the clients still have them and re-send them on reconnect.
- **Undo** is per person (CodeMirror history, remote edits excluded).
- **Loop guard** covers the JS file only (not inline `<script>` in the HTML file).
- **Deno deps are not covered by Dependabot** (no Deno ecosystem): review with `deno outdated` in the cloud
  builder / CI, bump the pins in `deno.json`, regenerate `deno.lock` with Actions → **bootstrap**.
