# Coalesce Local UI

Run Coalesce directly on your local repo. This extension opens the Coalesce UI
in a VS Code tab, working on the pipeline files in your checkout instead of a
cloud workspace — perfect when working with AI agents.

## Why

When an AI agent (Claude Code, Copilot, Cursor, …) edits your Coalesce nodes,
it changes files on disk. With the Coalesce UI running against that same
checkout, you see each change in the graph as it lands, and can review, tweak
and run it, without pushing anything first. You, the agent and Git all work on
one copy of the pipeline.

## Features

- **One click to start.** The Coalesce icon in the side bar starts
  `coa serve` for the current folder and opens the UI in an editor tab.
  Closing the tab stops the server.
- **Warehouse profiles.** List, create, edit and delete the connection
  profiles in `~/.coa/config` (Snowflake, Databricks, BigQuery) in a form, and
  pick which one this repo uses.
- **Snowflake OAuth sign-in** from the profile form.
- **Coalesce Cloud settings.** Set the Coalesce domain, API key and
  environment ID without editing the config file by hand.
- **Works with Coalesce Desktop.** No separate CLI install needed if you have
  the Coalesce Desktop app.
- **Remote-friendly.** Works over Remote SSH and Codespaces.

## Requirements

- The Coalesce CLI (`coa`) on your `PATH`, **or** Coalesce Desktop installed
  (macOS and Windows).
- A Coalesce repo initialised for local work, i.e. with a `workspace.yml`. If
  it has none, the side bar offers to run `coa init` for you.

## Getting started

1. Open your Coalesce repo in VS Code.
2. Click the **Coalesce** icon in the activity bar.
3. Pick or create a profile under **Profiles**.
4. Press **▶ Open Coalesce UI**.

The rest of this page describes the details.

## The workspace must be initialised

The local UI only starts in a folder that has a **`workspace.yml`** — the
per-repo file holding the local location→database/schema mappings that
`coa serve` renders against. Without it the sidebar shows

```
LOCAL UI
  ⚠ Workspace not initialised     no workspace.yml
  ▷ Run `coa init`…
```

and pressing the run button explains the same thing with a **Run coa init**
button, which opens a terminal in that folder (`coa init` is interactive, so it
is handed to a terminal rather than spawned headless). Multi-root workspaces
prefer the folder that has a `workspace.yml`, then one with `data.yml`, then the
first folder — `coalesceServe.workspaceFolder` overrides that.

## Profiles

The selected profile is recorded **in the repo's `workspace.yml`**, as a
top-level key:

```yaml
profile: my_sf_conn
locations:
  TARGET:
    database: DEV_DB
    schema: MARK
```

`coa` resolves it from there (`coa doctor` reports `profile: my_sf_conn
(workspace.yml)`), so switching profile is a one-line edit to that file and
different repos can use different profiles at the same time. Nothing is ever
copied into `[default]` — that section is coa's own fallback, not a mirror of
the selected profile.

The sidebar shows:

```
LOCAL UI
  ▶ Open Coalesce UI                          my_sf_conn
COALESCE CLOUD                                my_sf_conn
  Coalesce domain    https://sandbox…        ✎
  Coalesce API key   ••••••••                     ✎
  Environment ID     12                           ✎
PROFILES
  ● my_sf_conn        Snowflake · active        ✎ 🗑
  ○ analytics_dev    Databricks                ✎ 🗑
  + New profile…
```

The **Coalesce Cloud** settings come from `~/.coa/config`, not from the repo, so
they show up even outside an initialised workspace — with no profile selected
the section falls back to what `coa` itself uses, `[default]`, and says so in
the group's label. Editing a field there writes to `[default]`; that is the only
time this extension touches that section.

The circles are radio buttons: **click a row to select that profile**, which
writes `profile: <name>` into `workspace.yml`. The inline buttons edit and
delete. To *clear* the selection, open the profile and untick **Use this profile
for this workspace** — that checkbox is a live view of the key, so it is ticked
on the profile `workspace.yml` names and disabled when there is no
`workspace.yml` to record a choice in.

Safety rules the code follows:

- Every write to `~/.coa/config` takes a timestamped `.bak.<iso>` first, last 10
  kept. Writes are atomic (temp file + rename in the same directory) and the
  file stays `0600`.
- `workspace.yml` is edited **line by line**: only the `profile:` line is
  touched, the file's mode is preserved, and comments and mappings survive byte
  for byte. A missing `workspace.yml` is never created — that is `coa init`'s
  job.
- Sections the form did not touch are carried through **verbatim**, comments
  included — the `~/.coa/config` parser is line-based rather than a lossy
  round-trip.
- Deleting the selected profile removes the `profile:` key too, so the repo is
  never left pointing at a section that does not exist. If it happens anyway
  (a hand edit, a colleague's name), the sidebar flags it rather than silently
  falling back.
- Existing secrets are never sent into the webview. Their inputs render empty
  with an "unchanged" placeholder; a blank secret on save keeps the stored
  value. To *clear* one, edit `~/.coa/config` directly.
- Changing a profile's platform drops the previous platform's keys, so a
  Snowflake→Databricks switch leaves no stranded `snowflake*` entries.
- Values are quoted on write exactly where `ini` (the parser `coa` itself uses)
  would quote them, so a base64 OAuth client secret — anything containing `=` —
  survives the round trip instead of being cut short.

Platform fields come from `coa describe config` (CLI 7.44): Snowflake
(Basic / KeyPair / OAuth), Databricks (Token / OAuth M2M), BigQuery (service
account).

### Snowflake OAuth

`snowflakeAuthType=OAuth` stores no credential of its own — you sign in through
a browser and `coa` caches the tokens. The form reflects that:

- **client ID**, **client secret** and **redirect URI** boxes — all three
  optional, and all three together. Empty means Snowflake's built-in OAuth,
  which is what most setups want; fill them in only for a custom security
  integration, where the redirect URI has to match the one registered there.
  The redirect box shows `http://localhost:8080` as a greyed-out example
  rather than a value, because left blank `coa` picks a loopback port itself.
- a **Sign in / Sign out** button running `coa auth warehouse login|logout`.

Sign-in saves the profile first, because `coa` reads those client settings back
off disk. The button's state comes from the cached tokens in
`~/.coa/snowflake-oauth-tokens.json`; since the driver keys that one cache by
account and user rather than by profile, it reports "signed in to a warehouse"
rather than "signed in to *this* profile", and signing out clears it for every
profile.

Because `coa serve` resolves the profile once at startup, switching profiles
while the server runs offers to restart it.

## How the tab finds the server

`coa serve` prints a machine-readable readiness line on startup:

```
COA_SERVE_READY {"url":"http://localhost:8082#nonce=…","port":8082,"nonce":"…"}
```

The extension reads that line — the URL carries the auth nonce in its fragment —
and loads the URL into a webview itself.

## Which `coa` gets run

Coalesce Desktop carries its own `coa`, so the extension can work for someone
who has the app but cannot install the CLI separately. `coalesceServe.coaSource`
picks between them:

| Value | Resolution order |
| --- | --- |
| `auto` (default) | the shim Desktop publishes **while it is running**, else `coa` from `PATH`, else the CLI inside an installed Desktop |
| `desktop` | Desktop's CLI, running or not — no separate CLI install needed |
| `path` | `coa` from `PATH`, and nothing else |

`coalesceServe.coaPath` overrides all of it.

`auto` reaches for the app only when there is no CLI at all, so installing
Desktop never displaces a `coa` you installed on purpose. It still prefers the
running-Desktop shim over `PATH`, because while the app is up its CLI build is
the one matching the UI being served.

Desktop only publishes `~/.coalesce/desktop/agent.json` and its `coa` shim
**while it is running** — it deletes both on quit. So `desktop` does not use the
shim; it goes to the installed app and runs the CLI the way the app's own shim
does:

| | macOS | Windows |
| --- | --- | --- |
| App | `/Applications/Coalesce.app`, `~/Applications/Coalesce.app` | `%LOCALAPPDATA%\Programs\Coalesce`, `%PROGRAMFILES%\Coalesce` |
| Node | `Contents/MacOS/Coalesce` | `Coalesce.exe` |
| CLI | `Contents/Resources/coa/coa.js` | `resources\coa\coa.js` |

The app is Electron, and Electron started with `ELECTRON_RUN_AS_NODE=1` is a
plain Node — which is the trick that runs `coa.js` without a Node on `PATH`.
That matters: `coa.js` has a `#!/usr/bin/env node` shebang and the app ships no
`node` of its own, so the app's own binary is the only interpreter guaranteed to
be there. The extension therefore spawns two words rather than one, which is why
`coa` is resolved to a launcher (command + leading arguments + environment)
instead of a path.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `coalesceServe.coaSource` | `"auto"` | Which `coa` to run: `auto`, `desktop` (the copy inside Coalesce Desktop), or `path`. See [above](#which-coa-gets-run). |
| `coalesceServe.coaPath` | `""` | Path to `coa`. Overrides `coaSource`. Empty lets that setting choose. |
| `coalesceServe.port` | `8082` | Preferred port. If taken, the next free port up to +49 is used. |
| `coalesceServe.workspaceFolder` | `""` | Folder to serve. Empty picks the folder containing `workspace.yml`, else `data.yml`, else the first folder. |
| `coalesceServe.showStatusBarItem` | `true` | Show a status bar item while the server runs. |

## Commands

- `Coalesce: Open Local UI` — start + show the tab
- `Coalesce: Stop Local UI Server`
- `Coalesce: Restart Local UI Server`
- `Coalesce: Show Local UI Server Log`
- `Coalesce: New Profile…`
- `Coalesce: Reload Profiles`
- `Coalesce: Initialise Workspace (coa init)`
- `Coalesce: Open ~/.coa/config`
- `Coalesce: Open workspace.yml`

Select / edit / delete act on a sidebar row: selecting is the row click, edit
and delete are inline buttons, so none of them are palette entries.

## Notes and limits

- Uses activity-bar container id `coalesceServe`, so it coexists with the
  separate `coalesce-vscode-extension` (which claims `coalesce`).
- Coalesce Desktop installs its shim on launch, and the CLI behind it reports
  version `0.0.0-ci`. Run on its own it tries to download
  `coa-ui-0.0.0-ci.zip`, gets an HTTP 404 and exits — so `coa serve` breaks
  once Desktop has been started. The app ships the matching UI next to its CLI
  entry point, so the extension sets `COALESCE_UI_PATH` to that directory
  whenever it resolves to Desktop's CLI — by the shim or by the app. That
  override is also what makes `coaSource: "desktop"` work at all. If the app has
  no usable copy, the notification suggests quitting Coalesce Desktop and the
  log has the detail.
- The extension builds its own webview rather than calling the built-in
  `simpleBrowser.show`: it needs the panel's `onDidDispose` event to know when
  to kill the server.
- The UI is framed in a webview. That works because `coa serve` sends no
  `X-Frame-Options` and no CSP `frame-ancestors`. If a future CLI build adds
  either, the frame will go blank and you would need `simpleBrowser`/external
  browser instead.
- `asExternalUri` + `portMapping` are used so the tab also works over Remote
  SSH / Codespaces; the `#nonce=` fragment is re-attached if the rewrite drops
  it.
- If the server exits on its own, the tab is closed and the error is surfaced
  with a link to the log.

## Windows

- `coa` installs as `coa.cmd`. Node's shell-less spawn reaches `CreateProcess`,
  which appends `.exe` but never `.cmd`, and since Node 20.12 spawning a batch
  file without a shell throws `EINVAL` outright — while `shell: true` would
  hand cmd.exe its arguments unescaped. So the extension walks `PATHEXT`
  itself and builds the `cmd.exe /d /s /c "…"` line with its own quoting, which
  carries a workspace path like `C:\R&D\my repo` through intact. A `%` in the
  path is the one thing cmd.exe cannot be stopped from expanding.
- The server is stopped with `taskkill /T /F`: `SIGTERM` does not reach the node
  process behind the `.cmd` shim, and there is a cmd.exe parent in the tree too.
- The Desktop shim is looked for as `coa.cmd`, `coa.exe`, `coa.bat` or `coa`,
  and paths are compared case-insensitively, so a hand-typed
  `coalesceServe.coaPath` still registers as the shim.
- `~/.coa/config` and `workspace.yml` keep whichever line ending they already
  have, so changing one key in a CRLF checkout is a one-line diff rather than a
  whole-file one. The atomic rename retries for a moment: on Windows it fails
  while a search indexer or virus scanner still holds the target open.
- POSIX file modes are advisory there — `chmod 0600` only clears the read-only
  bit — so `%USERPROFILE%\.coa` is as protected as its NTFS ACL makes it and no
  more.
- `coa init` is handed to a terminal quoted for PowerShell, cmd.exe or a POSIX
  shell, whichever `vscode.env.shell` reports.

## Development

No build step — it is plain JavaScript with no dependencies. To run a checkout
instead of the Marketplace build, link the folder into the extensions
directory:

```sh
# macOS / Linux
ln -s ~/GitHub/coalesce-local-vscode ~/.vscode/extensions/coalesce-local-vscode
```

```powershell
# Windows — needs Developer Mode on, or an elevated prompt
New-Item -ItemType SymbolicLink `
  -Path   "$env:USERPROFILE\.vscode\extensions\coalesce-local-vscode" `
  -Target "$env:USERPROFILE\GitHub\coalesce-local-vscode"
```

Then reload the window (`Developer: Reload Window`). For VS Code Insiders use
`.vscode-insiders/extensions/`.

To hack on it instead, open this folder in VS Code and press `F5` for an
Extension Development Host.

### Tests

```sh
npm test        # ~/.coa/config and workspace.yml models, coa resolution, failure messages
npm run test:e2e   # spawns a real `coa serve`, asserts the handshake and the kill
```

The suite runs on macOS, Linux and Windows. The Windows-only helpers (`PATHEXT`
resolution, cmd.exe quoting) are pure functions and are asserted on every host,
so a Mac catches a regression in them; the mode and case-sensitivity
assertions ask the host for its own answer.

## Icons

The Coalesce mark in `media/` is borrowed from
[`coalesce-vscode-extension`](https://github.com/jessemarshall/coalesce-vscode-extension)
(MIT, Jesse Marshall):

| File | Source | Used for |
| --- | --- | --- |
| `icon.svg` | `media/icons/coalesce.svg` | activity bar (`fill="currentColor"`, VS Code masks it) |
| `logo-light-theme.svg` | `media/icons/coalesce-icon-dark.svg` | editor tab icon, light themes (`#1B1B1F` ink) |
| `logo-dark-theme.svg` | `media/icons/coalesce-icon-light.svg` | editor tab icon, dark themes (white ink) |
| `icon.png` | `media/icon.png` | extension gallery icon (256×256) |

Note the swap in the two tab icons: upstream names them after the ink colour,
VS Code's `iconPath` names them after the theme they are shown in.

## License

MIT
