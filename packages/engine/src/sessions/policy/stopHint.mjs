#!/usr/bin/env node
import process from "node:process";

process.stdout.write(
  "Reminder: commit any pending changes from the worktree before ending — run `git add . && git commit -m '...'`. Uncommitted work is lost when the session ends.",
);
process.exit(0);
