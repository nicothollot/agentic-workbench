# One-File Desktop Packaging

This project has packaging commands for producing shareable desktop artifacts from the current source tree:

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

- WSL/Linux and native Windows build a Windows portable `.exe`.
- macOS builds a `.dmg`.
- `npm run package:win` always requests the Windows `.exe`.
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

## Windows Code Signing

Smart App Control can block unsigned or unfamiliar `.exe` files. The Windows packaging path supports Authenticode signing through Electron Builder, but it does not create or embed a private key. Use a trusted RSA code-signing certificate, such as a `.pfx` from a certificate authority or Microsoft Trusted Signing.

The normal command remains available for unsigned local builds:

```bash
npm run package:win
```

For a signed build, configure the certificate and run:

```bash
export WIN_CSC_LINK="/mnt/c/Users/<you>/certs/codex-agent-workbench.pfx"
export WIN_CSC_KEY_PASSWORD="<certificate password>"
npm run package:win:signed
```

`WIN_CSC_LINK` can be a local `.pfx`/`.p12` path, a base64-encoded certificate payload, or an HTTPS URL supported by Electron Builder. Under WSL, Windows paths are also accepted through `AWB_WIN_CSC_LINK` and are converted to `/mnt/<drive>/...` before Electron Builder runs:

```bash
export AWB_WIN_CSC_LINK="C:\\Users\\<you>\\certs\\codex-agent-workbench.pfx"
export AWB_WIN_CSC_KEY_PASSWORD="<certificate password>"
npm run package:win:signed
```

For local certificate paths, the packaging script checks that the converted file exists before running the full production build.

If you already have the certificate in the Windows certificate store on a native Windows build host, you can select it explicitly:

```powershell
$env:AWB_WIN_CERTIFICATE_SUBJECT_NAME = "Your Publisher Name"
npm run package:win:signed
```

Signing behavior:

- `npm run package:win` signs automatically only when Windows-specific signing material is present, such as `WIN_CSC_LINK` or `AWB_WIN_CSC_LINK`.
- `npm run package:win:signed` requires signing material and fails instead of producing an unsigned `.exe`.
- `node scripts/package-app.mjs --win --unsigned` forces the old unsigned WSL-friendly path.
- Signed Windows builds turn `win.signAndEditExecutable` back on so the app executable and final portable `.exe` can be signed.

## How To Launch Or Share

Windows:

- Send or run the generated `.exe`.
- This is a native Windows Electron build. It does not depend on the Linux Electron runtime at launch.

macOS:

- Send or open the generated `.dmg`.
- The current developer build is unsigned and not notarized, so macOS Gatekeeper may warn until proper signing is configured.

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
- Windows executable resource editing is disabled for unsigned developer exports so WSL builds do not require Wine for signing or icon editing. Signed builds enable it explicitly.
- The macOS package uses a universal `.dmg` target and must be built on macOS.
- `npm run dist:win` remains available as a compatibility alias and routes to `npm run package:win`.
