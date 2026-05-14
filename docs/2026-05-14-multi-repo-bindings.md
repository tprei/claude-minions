# Multi-repo bindings

Date: 2026-05-14
Branch: `multi-repo-bindings`

## Goal

Let one engine instance drive workflows against multiple bound repos. Today the engine is hardcoded to a single repo via env (`MWF_GITHUB_REPO_OWNER`, `MWF_GITHUB_REPO_NAME`, `MWF_REPO_PATH`). After this change the engine reads `data/workspace/repos.json` as the source of truth, and every workflow carries a required `repoId` that selects which bound repo the workflow targets.

The motivating user-visible change: the PWA at `claude.prschdt.xyz` can drive PRs into both `tprei/claude-minions` and `tprei/pwa-playground` from a single engine.

## Scope decisions

- **Drop env-based repo config entirely.** `MWF_REPO_PATH`, `MWF_GITHUB_REPO_OWNER`, `MWF_GITHUB_REPO_NAME`, `MWF_GITHUB_BASE_BRANCH` are removed. `repos.json` is the only source. `.env.deploy` on the host must be updated.
- **Auto-clone on boot.** Any binding with a `remote` that has no local clone at `data/repos/<id>` gets cloned during `createEngine()` using `MWF_GITHUB_TOKEN`.
- **One global GitHub token.** `MWF_GITHUB_TOKEN` is the single auth token. Both bound repos live under `tprei` and share auth; a per-repo token table is out of scope.
- **Workflow `repoId` is required.** No default fallback. `POST /workflows` rejects missing or unknown `repoId`.

## Layout

```
data/
├── engine.db
├── repos/
│   ├── claude-minions/       # bare-ish clone (one per binding)
│   └── playground/
└── workspace/
    ├── repos.json            # binding registry
    └── <repoId>/
        └── <wfSlug>_<taskSlug>/   # per-task worktree
```

Boot-time migration: if legacy `data/repo` exists and `data/repos/claude-minions` does not, the engine moves it once.

## RepoBinding shape

```ts
interface RepoBinding {
  id: string;            // unique key, e.g. "claude-minions"
  label: string;         // display name
  remote?: string;       // https://github.com/OWNER/REPO.git
  defaultBranch?: string; // "main"
}

interface ResolvedRepoBinding extends RepoBinding {
  localPath: string;     // data/repos/<id>
  githubOwner?: string;  // parsed from remote when present
  githubRepo?: string;
  defaultBranch: string; // always set; defaults to "main"
}
```

`repos.json` schema:

```json
[
  { "id": "claude-minions", "label": "claude-minions", "remote": "https://github.com/tprei/claude-minions.git", "defaultBranch": "main" },
  { "id": "playground",     "label": "PWA playground", "remote": "https://github.com/tprei/pwa-playground.git", "defaultBranch": "main" }
]
```

## Touched layers

### 1. Domain
- `packages/engine/src/domain/types.ts`: `WorkflowSpec.repoId: string`, `Workflow.repoId: string`.
- `packages/engine/src/domain/workflow.ts`: `createWorkflow` validates + copies `repoId`. Helpers `createSingleTaskWorkflow` / `createThinkThreadWorkflow` accept `repoId`.
- `packages/engine/src/transport/validators.ts`: `WORKFLOW_SPEC_CHECKS` gains `{ path: "repoId", isNonEmptyString }`.

### 2. Engine config
- `packages/engine/src/engine.ts` `EngineConfig`: drop `repoPath`, `githubRepo`, `githubBaseBranch`. Add `repos: RepoBinding[]` (non-empty) and a single `githubToken` (already present).
- `buildRepoBindings(config)` becomes pass-through (returns `config.repos`).
- `packages/engine/src/main.ts`: drop env reads for the three removed fields. Add `loadRepoBindings()` that reads `${workspaceRoot}/repos.json`, parses, validates uniqueness of `id`. Fail boot on empty / invalid / missing file.

### 3. Workspace backend
- `packages/engine/src/plugins/workspace/git-worktree-backend.ts`: replace `repoPath: string` field with `bindings: Map<string, ResolvedRepoBinding>` keyed by `repoId`. Public API gains `repoId` on `WorkspaceCreateSpec`. Worktree path becomes `${workspaceRoot}/${repoId}/${wfSlug}_${taskSlug}`.
- `WorkspaceBackend` interface (`plugins/workspace-backend.ts`): `WorkspaceCreateSpec.repoId: string`.
- All callers (`retry-task-service`, `continue-task-service`, `merge-service`, `quality-gate-service`, `local-finalize-service`, `restack-executor`, `run-orchestrator`) read `workflow.repoId` and forward.

### 4. Per-workflow GitHub
- New `RepoBindingRegistry` (in-process, frozen at boot) with `get(repoId)` → `ResolvedRepoBinding`.
- `MergeService`: drop `repoCoords` dep; consume registry; resolve coords from `workflow.repoId` per call.
- `CIBabysitterService`: same.
- `LocalFinalizeService`: drop `repoPath` / `baseBranch` deps; resolve per workflow.

### 5. Boot
- Inside `createEngine()` before workspace backend construction:
  1. If `data/repo` exists and `data/repos/claude-minions` does not, rename.
  2. For each binding with `remote`: if `data/repos/<id>` is missing, `git clone --filter=blob:none <remote>` into it (using token in URL when token present).
  3. If `remote` absent but local path missing, fail boot (binding misconfigured).

### 6. Planner
- `PlannerService.plan({ prompt, repoId })`: spec is built with `repoId` set.
- `POST /workflows/plan` requires `repoId` in body.

### 7. PWA
- `packages/web/src/views/newSession.tsx`: include `repoId` in spec sent to `createWorkflow` and `planWorkflow`. When `repos.length > 0`, require selection (no `NONE_REPO`).
- `packages/web/src/transport/rest.ts`: `planWorkflow(conn, prompt, repoId)` signature.
- `packages/web/src/views/__tests__/newSession.test.tsx`: assert `repoId` in payload.

### 8. Docs
- `docs/architecture.md`: update repo layout, feature table row "Workflow create" mentions multi-repo, recovery covers multi-clone.
- `docs/deploy.md` / `docs/deploy/`: env var diff (drop three, document `repos.json` location).

## Migration on host

After image rebuild on the mini PC:

```bash
cd ~/claude-minions
# 1. Remove the three retired env vars
$EDITOR .env.deploy
# 2. Seed the registry
cat > data/workspace/repos.json <<'JSON'
[
  { "id": "claude-minions", "label": "claude-minions", "remote": "https://github.com/tprei/claude-minions.git", "defaultBranch": "main" },
  { "id": "playground",     "label": "PWA playground", "remote": "https://github.com/tprei/pwa-playground.git", "defaultBranch": "main" }
]
JSON
# 3. Redeploy
docker compose --profile tunnel up -d --build
```

The engine handles `data/repo → data/repos/claude-minions` rename and the missing-clone fetch of `data/repos/playground` automatically.

## Test plan

- Engine unit:
  - `repos.json` loader: rejects empty array, duplicate ids, malformed shape.
  - `validateWorkflowSpec`: rejects missing/empty `repoId`.
  - `createWorkflow`: persists `repoId`.
  - Workspace backend: `create` with `repoId` writes under `${workspaceRoot}/${repoId}/...`; cleanup is repo-scoped.
- Engine integration: pipeline harness with two bindings; one workflow per repo.
- Transport: `POST /workflows` 400 when `repoId` missing or unknown; 201 when valid.
- PWA: newSession submits `repoId`; planner request includes `repoId`.
- Smoke/chaos: existing matrix still passes against single-binding fixture.

## Out of scope

- Per-repo GitHub tokens.
- Per-repo SQLite databases.
- Repo CRUD UI / API.
- Splitting `engine.db` per repo.
- Cloudflare Pages / hosting concerns (playground deploys are already CF Pages-driven and out of band).
