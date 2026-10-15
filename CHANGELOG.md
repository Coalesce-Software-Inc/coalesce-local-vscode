# Changelog

## 0.3.2

- Editor tab icons now use the official Coalesce logo: navy in light themes,
  white in dark themes.

## 0.3.1

- The source repository has moved to
  [Coalesce-Software-Inc/coalesce-local-vscode](https://github.com/Coalesce-Software-Inc/coalesce-local-vscode).

## 0.3.0

- Snowflake OAuth: a **Sign in / Sign out** button in the profile form, and
  optional client ID, client secret and redirect URI settings.
- New `coalesceServe.coaSource` setting: run the `coa` that ships inside
  Coalesce Desktop, so no separate CLI install is needed.

## 0.2.0

- Profile manager for `~/.coa/config`: list, create, edit and delete profiles,
  and edit the Coalesce Cloud settings.
- The selected profile is recorded in the repo's `workspace.yml`.
- Serves Coalesce Desktop's own UI when running its `coa` shim.
- Windows support.

## 0.1.0

- Side bar button that runs `coa serve` for the workspace and opens the
  Coalesce UI in an editor tab; closing the tab stops the server.
