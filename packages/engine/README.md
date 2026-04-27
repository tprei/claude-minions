# @minions/engine

The orchestrator engine that drives session lifecycles, DAGs, ship/loops/variants,
landing, CI babysitting, and GitHub integration.

## GitHub credentials

The engine talks to GitHub via either:

1. **GitHub App installation token** (preferred when configured)
2. **Personal access token** via `GITHUB_TOKEN`

If both are configured, the App token wins. If neither is configured, GitHub
features are disabled.

### Setup: GitHub App

1. Create a GitHub App at https://github.com/settings/apps/new with **Repository
   Permissions**: Contents=read/write, Pull requests=read/write, Checks=read,
   Metadata=read.
2. Install the App on the target repository (or org).
3. Save:
   - the App ID (numeric)
   - the `.pem` private key
   - the Installation ID (visible after install)
4. Set the following environment variables:

   - `MINIONS_GH_APP_ID` — the App ID
   - `MINIONS_GH_APP_PRIVATE_KEY` — either the PEM contents (must start with
     `-----BEGIN`) or a path to the `.pem` file on disk
   - `MINIONS_GH_APP_INSTALLATION_ID` — the Installation ID

The engine mints a short-lived JWT, exchanges it for an installation token, and
caches the token until shortly before expiry. Outbound git pushes over HTTPS use
a `GIT_ASKPASS` shim that reads the cached token.

### Setup: Personal access token

Set `GITHUB_TOKEN` to a classic or fine-grained PAT with `repo` scope. Used
verbatim as the bearer for REST calls and for HTTPS pushes via the askpass
shim.
