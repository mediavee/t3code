# mediavee/t3code fork

This fork is pingdotgg/t3code plus Mediavee's orchestration and agent-quality work. It follows upstream's
**nightly** tags: on each new one, the Mac mini's `t3-fork-sync` LaunchAgent (dotfiles, polls `git ls-remote`
every 15 min, no LLM) starts a fresh T3 thread "🔄 Sync fork T3 › <tag>" in this project, which runs the
procedure below. Merge, build and prerelease are automatic; **deployment waits for the owner's "go"**.

## Rules for fork code

- Upstream owns every numbered migration (`apps/server/src/persistence/Migrations/NNN_*.ts`). Fork schema
  work goes in unnumbered idempotent hooks such as `Migrations/ForkIndexes.ts`; a test enforces it.
- A `-mediavee.` build never updates itself from upstream (no desktop feed, no upstream self-update default);
  a build check enforces it.
- Never open a PR on pingdotgg/t3code (`gh pr create --repo mediavee/t3code`, never `pull_request_create`).
- Versions read `<upstream base version>-mediavee.<fork sha, 10 chars>`, never a bare upstream version.

## Sync procedure (the sync thread is the lead)

Reports to the owner are in French. Use the `chantier` skill's worker and review contracts for dispatches.

1. **Check.** `git fetch fork` and fetch the tag: `git fetch https://github.com/pingdotgg/t3code.git tag <T>`.
   If `git merge-base --is-ancestor <T> fork/main`, run `t3-fork-sync done <T>` and stop.
2. **Merge (worker on dev2).** `delegate_task` to dev2 (environment `63316d1d-fa7b-4064-95bd-dca7b5972579`,
   project `mcp:2d13059b-8fac-4c04-aa76-4e5f441af62a`, Claude Opus, effort medium). The worker:
   - branches `sync/<T>` from fork/main and runs `git merge --no-ff <T>` (never a rebase);
   - resolves each conflict keeping both behaviours; i18n catalogs: take upstream's, re-add the fork's keys,
     run the i18n check; `agentContextBudget.json`: regenerate with the repo's tool (label
     `agent-context-increase` when it grows);
   - regenerates the upstream migration manifest from the tag and commits it in the sync PR:
     `T3_UPSTREAM_REF=<T> T3_UPDATE_UPSTREAM_MIGRATIONS=1 vp test run apps/server/src/persistence/upstreamMigrations.test.ts`,
     then runs the checks with `T3_UPSTREAM_REF=<T>` so the manifest is compared with the tag;
   - runs the full checks in a clean environment (`env -i`, Node 26.13.1 under
     `/home/agent/t3-fork-builds/toolchain`, non-hidden `TMPDIR`); a failure that also fails on `<T>` itself
     is upstream's and does not block;
   - migrates a copy of dev2's database (`sqlite3 -readonly … ".backup"` to a non-tmpfs directory) with the
     merged build: the ledger must equal upstream's numbered migrations and both fork indexes must exist;
   - pushes with `git push fork sync/<T>` (never `origin`, which may be upstream) and opens the PR on
     mediavee/t3code listing the conflicted files and the files both sides changed that
     merged without conflict.
3. **Review.** Cross-family review (Gemini 4 Neon, thought level high) of the conflicted files and of the
   auto-merged overlap in core paths (`apps/server/src/orchestration-v2/`, `apps/server/src/peer/`,
   `apps/server/src/persistence/`, `packages/contracts/`, `packages/provider-*`). One fix round; the lead
   checks the interdiff, comments `Review of record: <head> mergeable`, then lands it **as a merge commit**:
   `gh pr merge <n> -R mediavee/t3code --merge --match-head-commit <head>`. Never `ship` (it squashes), never
   squash or rebase: `<T>` must stay an ancestor of fork/main, or every later sync conflicts again.
   A P1 left after the fix round, a red gate or a conflict the worker cannot resolve: run
   `t3-fork-sync abort <T>`, merge nothing, and ask the owner.
   From here on `<T>` is merged: a failure in steps 4-5 is reported in this thread and fixed there, never
   with `abort` (step 1 would then skip `<T>` without a release).
4. **Build.** Give both build workers the merged fork/main SHA and check both archives carry the same
   `<version>`. Darwin arm64 archive and desktop DMG on the mini (a worker in this project; `RUSTC_WRAPPER=`
   for cargo), linux-x64 archive on dev2, each smoke-tested in a sandbox `HOME`. Publish a prerelease
   `v<version>` on mediavee/t3code (`--prerelease --latest=false`) with the three files and one `SHA256SUMS`.
5. **Prepare the deploy.** A mediavee/infra PR moving `T3_VERSION` and `T3_SERVER_VERSION` in
   `dev2/agent-bootstrap.sh` and the versions in `macmini/services/t3code.md` and `macmini/agent-stack.md`;
   do not merge it.
6. **Free the trigger and ask.** `t3-fork-sync done <T>`, then ask the owner in this thread: version, what
   upstream brought, conflicts and how they were resolved, the review's residual risks, and "go ?". A newer
   sync that reaches this step supersedes earlier ones: the newer thread closes their infra PRs and says so.
7. **Deploy on "go".** In order dev2, ci1, then the infra PR (boats take it at their 03:40 maintenance), the
   mini, the MacBook. Each host switches only when its T3 has no active turn: `t3-deploy-when-idle <version>`
   (`~/.local/bin` on dev2 and ci1; a one-shot LaunchAgent on the mini; on the MacBook a worker installs the
   DMG and a one-shot job swaps the app). After each host: `serverVersion`, the migration ledger, both fork
   indexes, providers usable. On a failed check, put that host back on the previous version and stop.
8. **Close.** Archive the earlier sync threads, delete merged branches and temporary files, report.
