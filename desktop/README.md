# SHRI Print Admin — Desktop Application

## Overview

This is a native Windows desktop application (Electron 44) that provides the **admin interface** for SHRI Print. It runs alongside the existing local controller/agent and connects to the cloud print server.

**This is NOT the customer-facing website.** Customers continue to use the public QR website at:
`https://shri-print-bahadurgarh.shristream.chatgpt.site`

The desktop app is exclusively for **shop administrators** to manage printers, view reports, configure settings, and monitor the local print agent.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  SHRI Print Admin (Electron Desktop App)                        │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ BrowserWindow (sandboxed, contextIsolation, no Node)      │  │
│  │   → Loads http://localhost:4888/local-login               │  │
│  │   → Redirects to cloud admin panel via one-time ticket    │  │
│  └───────────────────────────────────────────────────────────┘  │
│                          │                                      │
│         ┌────────────────┴────────────────┐                     │
│         ▼                                 ▼                     │
│  Local Controller                    Cloud Server               │
│  (localhost:4888)                    (HTTPS)                    │
│  - launch.ps1 -NoOpen                  - Admin panel            │
│  - local/server.mjs                    - Printer management     │
│  - Agent/Worker                        - Reports & analytics    │
└─────────────────────────────────────────────────────────────────┘
```

### Key Separation

| Component               | Purpose                                  | Access                                                                 |
| ----------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| **Customer QR Website** | Public ordering, payments, uploads       | `https://shri-print-bahadurgarh.shristream.chatgpt.site` (any browser) |
| **Desktop Admin App**   | Shop management, printer config, reports | This Electron app (Windows only)                                       |
| **Local Controller**    | Print agent, device communication        | `http://localhost:4888` (loopback only)                                |

---

## Startup Behavior

1. **Project Root Detection** — The app locates the SHRI Print project root via:
   - `desktop-config.json` beside the EXE (packaged), or
   - `../..` from `desktop/` (development via `__dirname`), or
   - `../shri-print` sibling fallback

2. **Local Controller Launch** — Spawns `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <root>/launch.ps1 -NoOpen` with `shell:false, windowsHide:true`. This starts the local server and agent if not already running. Uses system Node 26 via `launch.ps1` external runtime.

3. **Config Polling** — Polls `http://localhost:4888/api/config` (bounded timeout) to discover the cloud server origin from `server` key.

4. **Authentication** — Loads `http://localhost:4888/local-login` which:
   - Accepts only loopback requests
   - Creates a single-use desktop sign-in ticket
   - Redirects to the cloud admin panel with an authenticated session
   - **Never exposes the admin key** to the Electron shell

5. **Window Display** — Shows the 1360×900 window titled "SHRI Print — Admin Desk" after ready.

---

## Tray Behavior

Closing the main window **hides it to the system tray** (does not quit). The admin panel and local agent remain running.

**Tray Menu:**

- **Show Admin** — Restore and focus the admin window
- **Reload** — Reload the current page
- **Open Customer Page** — Opens the public customer site in the default browser
- **Local Controls** — Opens `http://localhost:4888` in the default browser
- **Quit** — Fully exits the application (also stops the tray)

Double-clicking the tray icon shows the admin window.

---

## Application Menu

Native Windows menu bar with:

- **File** → Dashboard, Printers, Reports, Settings, Reload, Force Reload, Quit
- **Edit** → Standard clipboard/undo shortcuts
- **View** → Zoom In/Out/Reset, Toggle DevTools (F12)
- **Window** → Minimize, Close
- **Help** → Open Customer Page, Local Controls, About

Navigation links use the configured cloud server origin (read from `agent/config.json` `server` key at runtime). Admin routes use hash fragments: `/admin#printers`, `/admin#reports`, `/admin#settings`.

---

## Security Model

| Feature                      | Setting                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `nodeIntegration`            | `false`                                                                                                               |
| `contextIsolation`           | `true`                                                                                                                |
| `sandbox`                    | `true`                                                                                                                |
| `webSecurity`                | `true`                                                                                                                |
| `experimentalFeatures`       | `false`                                                                                                               |
| Navigation                   | Restricted to `localhost:4888` and configured HTTPS cloud origin                                                      |
| Redirects                    | Blocked to unallowed origins via `will-redirect`                                                                      |
| New windows / external links | Only exact allowed-origin `/customer*` or `*.pdf` links open via validated `shell.openExternal` with safe URL parsing |
| Permissions                  | **All denied** — both request and check handlers return `false`                                                       |
| CSP                          | No override — uses Electron defaults                                                                                  |
| Admin key                    | Never copied to renderer; authentication via local-login ticket                                                       |

---

## Data Isolation

- **User Data** — Stored in `%LOCALAPPDATA%\SHRI Print Admin` (distinct from CSC AI/Vault)
- **Session/Cookies** — Persisted in the same isolated namespace
- **No cross-contamination** with other Electron apps on the system

---

## Dependencies

### Runtime (pre-installed on target PC)

- Electron 44.10.1 (supervisor provides trusted runtime)

### Local Controller (must be present in project root)

- `launch.ps1` — Starts local server + agent (uses system Node 26)
- `local/server.mjs` — Local HTTP server (port 4888)
- `agent/config.json` — Contains `server` URL (HTTPS)

### Payment Provider Setup (external)

- Cloud server must be configured with a valid payment provider (UPI/QR)
- Payment verification requires **authenticated provider evidence** — never trusts screenshots, user claims, or arbitrary UPI URIs
- All photo processing happens **on-device** — never sent to AI services

---

## Installation (Supervisor-Managed)

The supervisor handles native executable packaging. After packaging:

1. Run `desktop/install-native.ps1 -AppExecutable "<path>\SHRI Print Admin.exe"` once per user
2. This creates:
   - Desktop shortcut: `%USERPROFILE%\Desktop\SHRI Print.lnk`
   - Startup shortcut: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SHRI Print Admin.lnk`
3. Existing **only these specific** SHRI Print shortcuts are backed up to `%LOCALAPPDATA%\SHRI Print Shortcut Backups\` before replacement
4. Other CSC/Vault shortcuts are **never modified**

---

## Development

```bash
cd desktop
npm install          # Only for local dev tooling; runtime uses pre-installed Electron
npm start            # Runs with development project root detection
npm run dev          # Alias with --dev flag
```

---

## Packaging Requirements (Supervisor)

- **Electron** 44.10.1 (use system/trusted runtime)
- **App name/title**: SHRI Print Admin
- **Version**: 2.0.0
- **Main entry**: `main.cjs` (CommonJS)
- **Icon**: `desktop/icon.png` (supervisor rasterizes existing logo)
- **Output**: Single EXE + resources
- **Config file**: Generate `desktop-config.json` beside EXE with `{ "projectRoot": "<absolute-path-to-project-root>" }`

---

## Troubleshooting

| Issue                           | Resolution                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| "Could not locate project root" | Ensure `desktop-config.json` exists beside EXE with correct `projectRoot`, or run from development structure |
| Blank/white window              | Check local controller is running on port 4888; try tray → Local Controls                                    |
| "local-login" fails             | Verify `launch.ps1 -NoOpen` works manually; check agent/config.json has valid `server` (HTTPS)               |
| Tray icon missing               | Supervisor must provide `icon.png` in packaged resources                                                     |
| Shortcuts not created           | Run `install-native.ps1` with correct `-AppExecutable` path                                                  |

---

## License

MIT — Internal SHRI Print tooling.
