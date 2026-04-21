# Local Run And One-File Packaging

For personal use on the same machine, run the app from the repo instead of creating a new Windows executable:

```bash
npm run build:app
npm start
```

`npm run build:app` compiles the local Electron assets. `npm start` launches those assets through the locally installed Electron runtime.

The project also has packaging commands for producing shareable desktop artifacts from the current source tree:

```bash
npm run build
npm run package:win
npm run package:mac
```

What the commands do:

- run the normal production compile step
- regenerate the build icon assets from `assets/branding/interface_icon.png`
- stages a minimal packaged-app directory so `electron-builder` does not depend on the full dev workspace layout
- packages one-file artifacts with `electron-builder`
- copies the final distributable into the detected Downloads folder

Default target selection:

- `npm run build` selects the native one-file package for the current build host.
- WSL/Linux and native Windows build a Windows portable `.exe`.
- `npm run package:win` requests the Windows portable `.exe`.
- `npm run package:mac` requests the macOS `.dmg` and must be run on macOS.

## Output Location

Final distributables are copied to the detected Downloads folder. In WSL, the script first asks Windows for `%USERPROFILE%` and converts that to the mounted WSL path, so this machine resolves to:

```text
/mnt/c/Users/nicot/Downloads
```

Typical final artifacts:

- `Codex Agent Workbench-0.1.0-windows-x64.exe`
- `Codex Agent Workbench-0.1.0-macos-universal.dmg`

Set `AWB_PACKAGE_OUTPUT_DIR=/path/to/output` to override the destination. `AWB_DOWNLOADS_DIR` is also supported for compatibility.

Internal staging output is written under `.electron-builder/` and can be deleted safely after packaging.

## Windows Executable Notes

Smart App Control can block newly built or unfamiliar `.exe` files. It does not infer that a file is for personal use from product names, repository names, or documentation. If you do not need a one-file Windows executable, use the local workflow:

```bash
npm run build:app
npm start
```

The Windows packaging command creates a portable `.exe` for local use:

```bash
npm run package:win
```

The packaging script does not request extra files or secrets for Windows builds.

## How To Launch Or Share

Windows:

- For personal use from the repo without packaging, run `npm run build:app` and then `npm start`.
- Send or run the generated `.exe`.
- This is a native Windows Electron build. It does not depend on the Linux Electron runtime at launch.

macOS:

- Send or open the generated `.dmg`.
- The current developer build is not notarized, so macOS Gatekeeper may warn.

The app can still use WSL for Git, Codex, and repository operations on Windows, which is the intended architecture.

## What To Compare Against WSL Dev Mode

Compare the packaged Windows app against `npm run dev` in WSL for:

- startup time
- window open/maximize smoothness
- sidebar and large-list scrolling smoothness
- tab or pane switching latency
- resize responsiveness
- general input latency while the UI is busy

Keep the same repository loaded in both cases so the comparison stays meaningful.

## Notes

- Packaging from WSL may need outbound access so `electron-builder` can fetch Windows Electron artifacts the first time.
- The Windows package uses Electron Builder's `portable` target for a single `.exe`.
- Windows executable resource editing is disabled for local developer exports so WSL builds do not require Wine.
- The macOS package uses a universal `.dmg` target and must be built on macOS.
- `npm run dist:win` remains available as a compatibility command for the Windows portable `.exe`.
