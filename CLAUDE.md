# CLAUDE.md — pazka/livecode

Build the project specified in `BRIEF.md` (read it fully first). Owner: Alexandre (pazka).
Target: **https://code.hosh.it** on the owner's hosh.it box. **`docs/BOX-CONTRACT.md` is binding**:
an app that follows it deploys first try. Values already fixed for this project:

| | |
|---|---|
| Image | `ghcr.io/pazka/livecode` |
| Host | `code.hosh.it` (DNS already points at the box) |
| Loopback port | `127.0.0.1:9134` → container port 8000 |
| Data | named volume `livecode-data` at `/data` |
| Env file on the box | `/srv/livecode/livecode.env` (mode 600, from `.env.example`) |

## Scope of the cloud builder
- You work on this GitHub repo only: code, tests, Dockerfile, CI. You have **no access to the
  production server**: a one-time on-box registration (DEPLOY.md §1b) binds the app; after that,
  releases deploy themselves (below). Never try to reach the box directly.
- The box-side files are already scaffolded. Keep them working and adapt them, don't replace them:
  `docker-compose.example.yml` (hardening is enforced by the box), `.env.example` (box defaults +
  `# required:` secrets line), `deploy/hosh-deploy.conf` (set `POST_DEPLOY` to a capability smoke
  that runs inside the container), `deploy/traefik-route.yml.tmpl`, `.github/workflows/ci.yml`
  (fill the test job for the stack), `release.yml` (its `deploy` job = auto-deploy), `deploy.yml`,
  `DEPLOY.md` (complete every TODO).
- **Dependency updates merge themselves** (Decision #18): keep `.github/dependabot.yml` (add the
  stack's ecosystem), `workflows/dependabot-merge.yml` and `scripts/dependabot-merge.sh`. Tested
  minor/patch Dependabot PRs merge when CI is green; a `needs-review` (major) PR is yours to check:
  merge it only if CI is green and the changelog has nothing that touches this app.
- **Deploying = cutting a release.** Once the owner has done the one-time registration (DEPLOY.md §1b),
  every release you build is deployed by GitHub through the box's `hosh-deploy` runner, which
  verifies it and rolls back by itself. You may also run Actions → deploy (`vX.Y.Z`, `rollback`,
  `status`) and read its log. You can't reach the box any other way, and that's by design.
- Finish with: tests green, CI green on `main` (incl. Trivy gate + hardened container smoke), a
  `v0.1.0` release built (Actions → release → version, or push a tag), `.env.example`'s
  `APP_IMAGE` pinned to that tag, and `DEPLOY.md` listing the capability checks (not just a 200).

## Rules
- Never commit secrets, `*.env`, databases, exports. Never install MCP servers.
- Owner secrets (admin password, API keys) are set by an interactive owner-run script that writes
  the env file; nothing secret is printed, logged or passed on a command line.
- Commit in small, clearly described steps on `main`.

## If you are the on-box deployment session (production server)
- Box rules (`/home/pazka/MIGRATION/CLAUDE.md`): `ACTIONS-LOG.md` intent BEFORE + result/revert
  AFTER; `scripts/smoke.sh` BEFORE and AFTER; root only inside an owner-opened sudo window.
- Releases deploy themselves (DEPLOY.md §1). You may run `sudo hosh-deploy deploy|rollback|status livecode …`
  any time (no sudo window needed), with an ACTIONS-LOG line. A first install follows DEPLOY.md §1b
  exactly, inside an owner sudo window: register + key on the box; the first deploy itself is
  Actions → deploy, never a manual `hosh-deploy deploy`. Otherwise only read-only diagnostics.
- `livecode.env`: you may create it from `.env.example` BEFORE any secret is in it; after the owner
  has filled it, **never print, cat, grep, copy or edit it**. If a variable is wrong, name it to the
  owner and stop. Never run owner-only interactive scripts; never delete the `livecode-data` volume.

## Project notes (livecode)
- Stack and approved deps: `BRIEF.md` § Stack. **No new third-party dependency without the owner's yes**
  (Decision #17); pins are exact in `deno.json`, `deno.lock` is frozen.
- No local Deno needed: Actions → **bootstrap** regenerates `deno.lock`, produces a `deno fmt` patch and a
  full report (build, lint, check, tests, e2e) as artifacts.
- Pure modules have unit tests (`tests/`): keys/keymaps (every preset conflict-free on PC and Mac),
  loop guard, preview composition, themes (WCAG contrast of every theme), TypeScript service + source maps.
- TypeScript (feature 14): `src/client/ts/` runs in `/ts-worker.js` (bundled separately, embedded gzip-only);
  its lib files come from the pinned package at build time (`deno task tslibs` → `libs.gen.ts`, gitignored). Server: real-socket integration
  tests. `e2e/` drives two Chromium windows in one room.

## Agent system: QA gate, journal, "what happened to X"
Canonical rules: `AGENTS.md` in the private hub `pazka/hosh-management`
(`gh api repos/pazka/hosh-management/contents/AGENTS.md -H "Accept: application/vnd.github.raw"`).
Summary, binding for every agent that works in this repo:
- **Nothing is merged without the independent QA agent.** Work on `agent/<topic>-<yyyymmdd>`, get CI
  green, write in the PR body what changed, which use cases it touches and how it was tested, then add
  the label `qa:requested`. Merge only when the PR has `qa:approved` AND a comment
  `QA-VERDICT: APPROVED sha=<current head sha>`. On `qa:changes-requested`: fix on the same branch,
  answer each finding, ask again; QA re-tests the whole PR. Never approve your own PR. After QA's
  approval the agent that opened the PR merges it: this replaces "the owner merges" and "merge when
  CI is green" wherever this file still says so.
- **QA owns the tests and the visual regression**: every use case a user can reach (listed in
  `TESTING.md`), screenshots at 1400 / 1024 / 390 px, baselines in the repo. A wanted visual change
  must be announced in the PR. Never weaken a test or a gate to get green.
- A NEW third-party dependency always needs the owner: open an issue in `pazka/hosh-management`
  labelled `ready-for-human` (that label is the list of places where the owner is needed).
- Release = Actions → release with `version=vX.Y.Z` on the default branch. Never push a git tag.
- **Journal**: after each event (PR ready, QA verdict, merge, release, deploy, rollback, incident,
  blocker) add one comment to this project's journal, `pazka/hosh-management#9`.
- **When the owner asks "what happened to X"** (this app, another one, or the server): open the index
  in `pazka/hosh-management` `README.md`, read the last comments of X's journal issue
  (`gh issue view <n> -R pazka/hosh-management --comments`), then the open `ready-for-human` issues,
  then PRs / Actions runs if needed. Server facts you cannot see: ask the Box agent (mailbox from a
  laptop session, or an issue labelled `box-question`). Answer with: what happened (dated), the state
  now, where the owner is needed.
- Online checks use only the URLs in `pazka/hosh-management` `uptime/checks.json`.
