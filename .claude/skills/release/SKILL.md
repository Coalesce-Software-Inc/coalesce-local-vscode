---
name: release
description: Release a new version of the Coalesce Local UI extension (coalesce.coalesce-local-ui) to the VS Code Marketplace and Open VSX — changelog, version bump and tag, the tag-triggered GitHub Action, and checking both registries afterwards. Use when asked to release, publish, ship or bump the extension.
---

# Releasing coalesce.coalesce-local-ui

Every release goes to **both** registries. Cortex Code Desktop and other VS Code
forks install from Open VSX, not the Marketplace, and CoCo auto-updates
allowlisted extensions from there.

Publishing is done by `.github/workflows/release.yml` when a `vX.Y.Z` tag is
pushed. Pushing the tag publishes to two public registries and cannot be undone
(a published version can't be reused), so **confirm with the user before
pushing the tag**.

## 1. Preflight

```sh
git switch main && git pull --ff-only
git status --short          # must be clean
npm test
```

Pick the bump with the user: `patch` for fixes and docs, `minor` for features.

## 2. Changelog

Add a section at the top of `CHANGELOG.md` for the new version, matching the
existing entries (short user-facing bullets). Commit it:

```sh
git commit -am "Changelog for X.Y.Z"
```

`npm version` refuses to run on a dirty tree, so the changelog must be
committed first.

## 3. Bump, tag, push (ask first)

```sh
npm version patch           # or minor: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

The workflow fails fast if the tag doesn't match `package.json`'s version.

## 4. Watch the workflow

```sh
gh run list --workflow release.yml --limit 1
gh run watch <run-id> --exit-status
```

It runs the tests, packages `coalesce-local-ui-X.Y.Z.vsix`, publishes to the
Marketplace and Open VSX, and attaches the `.vsix` to a GitHub release. A
failed run can be re-run as is: both publish steps use `--skip-duplicate`.

## 5. Verify both registries

```sh
# Open VSX
curl -s https://open-vsx.org/api/coalesce/coalesce-local-ui \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('version'),d.get('timestamp'),d.get('error'))"

# VS Code Marketplace
curl -s -X POST https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery \
  -H 'Content-Type: application/json' -H 'Accept: application/json;api-version=7.1-preview.1' \
  -d '{"filters":[{"criteria":[{"filterType":7,"value":"coalesce.coalesce-local-ui"}]}],"flags":103}' \
  | python3 -c "import json,sys;v=json.load(sys.stdin)['results'][0]['extensions'][0]['versions'][0];print(v['version'],v['lastUpdated'])"
```

Neither shows the new version straight away:

- **Open VSX** holds every upload in a security scan first; this has taken
  several minutes. `.../coalesce-local-ui/X.Y.Z` returns "not found" until then.
- **Marketplace** verifies each version before listing it. Status is on the hub:
  https://marketplace.visualstudio.com/manage/publishers/coalesce/extensions/coalesce-local-ui/hub

Only treat it as a failure if the workflow log shows one, or it's still missing
after ~15 minutes.

## Manual fallback

If the workflow can't run (e.g. missing secrets), publish from a checkout of
the tag with the user's tokens in `VSCE_PAT` / `OVSX_PAT`:

```sh
npx @vscode/vsce package
npx @vscode/vsce publish --packagePath coalesce-local-ui-X.Y.Z.vsix
npx ovsx publish coalesce-local-ui-X.Y.Z.vsix
```

Always publish a freshly built `.vsix`. The repo folder may hold old builds
named `coalesce-local-vscode-*.vsix` under the pre-Marketplace `local`
publisher; never upload those.

## Facts that bite

- Repo: `Coalesce-Software-Inc/coalesce-local-vscode`. Publisher/namespace
  `coalesce` on both registries. Extension ID `coalesce.coalesce-local-ui`.
- The workflow needs repository secrets `VSCE_PAT` (Azure DevOps token with
  Marketplace › Manage) and `OVSX_PAT` (open-vsx.org access token). Adding them
  needs repo admin, which a transferred-in member may not have.
- `VSCE_PAT` tokens expire; an auth error from the Marketplace step usually
  means it needs renewing.
- `.vscodeignore` keeps `.github/`, `.claude/`, `test/` and `*.vsix` out of the
  package. Check with `npx @vscode/vsce ls` if you add top-level files.
