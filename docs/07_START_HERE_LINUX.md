# 07 · First terminal actions (Ubuntu / zsh)

Your screenshot shows `~/Desktop/neathack` is ready. This ZIP has a single `nightorder/` top-level folder.

## A. Unzip and inspect

```bash
cd ~/Desktop/neathack
unzip ~/Downloads/NightOrder-Team-Bravo-Context.zip
cd nightorder
ls -la
cat README.md
```

If your browser saves downloads elsewhere, replace `~/Downloads/` with the exact downloaded location. The extracted context is safe to review; it is not working application code.

## B. Local prerequisites

```bash
git --version
node --version
npm --version
pnpm --version
gh --version
entire --help
codex --version
```

Install missing tools from official sources if a command is unavailable. `gh auth login` may be needed for GitHub. Use the Entire official guide for the installed CLI version, not copied outdated flags.

## C. Initialize once and push (user owns initial repository)

```bash
cd ~/Desktop/neathack/nightorder
git init -b main
git add .
git commit -m "docs: freeze NightOrder product, contracts and two-person tasks"
gh auth status
gh repo create Alike001/nightorder --public --source=. --remote=origin --push
```

If the repo name already exists, create a different available repository name and use it consistently. If no `gh`, create an empty public repository on GitHub, then `git remote add origin <repo-url>` and `git push -u origin main`. **Public repo means no secrets or private access links anywhere in the ZIP/git history**. Invite teammate through GitHub Repo Settings → Collaborators, then confirm they can push their branch.

## D. Create GitHub issues from prepared issue bodies

```bash
chmod +x scripts/create-issues.sh
./scripts/create-issues.sh
```

The script checks `gh` auth and repository, checks for existing exact issue titles to avoid duplicates, and creates issues from `issues/*.md`. Assign issues on GitHub once your teammate has accepted the invitation. Each developer opens a feature branch and PR; no direct concurrent edits to `main`.

## E. Essential kickoff meeting (15–30 minutes)
- Both developers read `docs/02_SHARED_CONTRACTS.md` and approve names, decimals, exact operation semantics, timezone, order status.
- Decide who owns SQLite migration files and `pnpm-lock.yaml` (suggest A). Freeze interface in a tiny PR first.
- Both follow Entire guide; capture actual Codex checkpoints, not just installation screenshot.
- Create Neatlogs workspace and prove SDK trace at first runnable agent path.
- Start cfo.ai plan and input assumptions early, not at the end.

## F. First work instructions for Codex

Use one scoped prompt per issue; do not ask Codex to implement all NightOrder at once.

**B / contract PR:**
> Read README.md, docs/02_SHARED_CONTRACTS.md, docs/03_ARCHITECTURE_AND_SAFETY.md and issue 01. Implement ONLY `packages/domain` TypeScript Zod schemas, precision-safe pure guards, exported interfaces and targeted tests. Do not modify apps/worker or executor. Run tests and report files/tests. No made-up passing results. Keep secrets out of git.

**A / worker PR:**
> Read README.md, docs/02_SHARED_CONTRACTS.md, docs/03_ARCHITECTURE_AND_SAFETY.md and issue 02. Implement ONLY apps/worker and packages/quotes: durable scheduler/restart and source-labeled fresh bid/ask quote adapter. Use domain interfaces and fixtures until domain PR merges. No Freqtrade dependency, no live funds. Tests for stale feed, expiration and restart. Report actual results.

## Branching
```bash
git checkout main
git pull --ff-only
git switch -c feat/telegram-confirmation  # your example branch
# edit, test, commit
git push -u origin feat/telegram-confirmation
gh pr create --fill
```

Coordinate root dependency changes to avoid lockfile conflicts. The first merge should be domain contracts, not UI.
