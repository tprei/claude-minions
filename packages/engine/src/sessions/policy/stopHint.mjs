#!/usr/bin/env node
import process from "node:process";

async function drainStdin() {
  try {
    for await (const chunk of process.stdin) {
      void chunk;
    }
  } catch {
    /* ignore — avoid EPIPE on drain */
  }
}

async function main() {
  await drainStdin();
  process.stdout.write(
    "Reminder: if you produced code changes, commit them in the worktree before ending the session.\n",
  );
  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
