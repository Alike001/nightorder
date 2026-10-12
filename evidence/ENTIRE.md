# Entire setup evidence

- **Public evidence note:** maintained on `main` at [`evidence/ENTIRE.md`](https://github.com/Alike001/nightorder/blob/main/evidence/ENTIRE.md). The underlying checkpoint repository remains private.
- **Codex integration evidence:** A real Codex session and checkpoint were captured and verified in an Entire-configured local environment. The current public `main` contains this evidence note but does not contain the `.codex/hooks.json` or `.entire/settings.json` setup files; collaborators need a separately configured local Entire CLI to capture checkpoints.
- **Shared repository default:** Checkpoint pushing is disabled to keep agent transcripts off the public GitHub `origin`.
- **Private checkpoint repository:** [NightOrder on Entire](https://entire.io/et/nightorder/nightorder) (`/et/nightorder/nightorder`, private).
- **Codex session:** [Initial Entire setup session](https://entire.io/et/nightorder/nightorder/session/01a12586-20c2-76a1-8424-6305634bb1d7) (`01a12586-20c2-76a1-8424-6305634bb1d7`).
- **Initial checkpoint:** `adcc6eecbc9fb4793720b4527272f3c346157a47`. `entire checkpoint list --pending --json` and `entire checkpoint explain <id>` confirmed its captured Codex context.
- **Local push destination:** This clone routes checkpoints to the private `entire` remote with ignored `.entire/settings.local.json`. Shared defaults remain off; each collaborator must have access to the private Entire repo and configure a private destination before syncing sessions.
