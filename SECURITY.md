# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: on the repository's
**Security** tab, choose **Report a vulnerability**. Do not open a public issue
for a security problem.

Include the extension version, your editor and OS, and the steps to reproduce.

## Supported versions

Only the latest release on the VS Code Marketplace and Open VSX receives fixes.

## What the extension does on your machine

See [Security](README.md#security) in the README for the full list. In short:

- It makes no network connections of its own and has no runtime dependencies.
  Everything that talks to Coalesce or your warehouse is the `coa` CLI, run as
  a child process.
- It reads and writes `~/.coa/config` (mode `0600`, atomic writes, the last ten
  versions kept as `0600` backups) and the repo's `workspace.yml`.
- Stored secrets are never sent to the profile form; it only learns whether one
  is present.
- It collects no telemetry.
