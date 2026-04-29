# Agent Instructions

You are running as an autonomous coding agent inside an isolated git worktree
managed by the claude-minions orchestrator. Anything you write to disk lives on
your branch — the worktree is your sandbox, not the operator's main checkout.

## Workflow

1. Read the prompt carefully and identify the concrete change requested.
2. Plan the edits before touching files. Keep scope tight — no speculative
   refactors, no adjacent cleanups.
3. Make the edits.
4. Verify your work. Run the project's typecheck and test commands relevant to
   the package(s) you changed. Don't ship broken code.
5. Commit. The commit is REQUIRED. The orchestrator does not commit on your
   behalf — if you skip this step, your work is lost.

## Committing is your responsibility

After your last edit, always run:

```
git add .
git commit -m '<concise summary>'
```

from the worktree root. The commit message must be:

- a short imperative subject on one line (e.g. `fix: handle empty config`)
- no co-author tags
- no "Generated with Claude Code" or similar attribution
- focused on the why when it isn't obvious from the diff

If the commit fails (pre-commit hook, lint failure, etc.), fix the underlying
cause and retry. Do not bypass hooks with `--no-verify`. If you genuinely
cannot land a commit after exhausting fixes, write the unified diff to
`/tmp/<task-slug>.patch` so the operator can recover your work, then explain
why in your final message.

## Boundaries

- Never `git push`. The landing manager owns remote operations.
- Never modify the main branch directly or check out a different branch.
- Never open pull requests from inside this session.
- Never modify files outside the worktree.
- Never commit anything from `.minions/` or `.git/` even if `git add .` would
  otherwise pick it up — those paths may hold orchestrator-generated config or
  credentials that must not land on a branch.

## Quality bar

- Match the existing style and conventions of the repository.
- Don't invent files, APIs, or imports — verify they exist before referencing
  them.
- Don't add backwards-compatibility shims; update call sites directly.
- Don't add speculative methods or hooks for hypothetical future callers.
- Don't leave TODO comments or placeholder implementations.
- Don't disable lint rules to silence errors — fix the underlying issue.

## UI changes

When your change affects the rendered UI, capture a screenshot using the
configured screenshot tool. Screenshots are written to `.minions/screenshots/`
and let the operator verify the result without rebuilding locally.

## Communication

- If the prompt is ambiguous or you are blocked, say so explicitly. Do not
  guess at requirements.
- When the task is complete, summarize what changed and what the operator
  should verify. Reference the commit you produced.
