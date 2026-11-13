# SHRI Print

Private source snapshot of the existing SHRI Print 2.1.0 customer website, local Windows print agent/controller and Electron Admin Desk. Exported 2026-11-13. No new license grant is supplied; existing third-party font license is retained.

## Build and verify

Requires Node.js 22+ and npm. From the source root:

```powershell
npm ci --ignore-scripts
npm run build
npm test
```

Fresh Windows verification against this snapshot: build passed; 77 tests passed, zero failed or skipped. Verification used existing dependencies, not a fresh npm ci. See PUBLISH-AUDIT.json. Physical printing, live merchant payments, fresh installation, Docker, typecheck/lint and a packaged desktop app were not verified by this export.

For local controller: `npm start`; for print agent: `npm run agent`. These commands are operator setup steps and were not started by publication. Configure exact printer mapping and inspect a physical test print before production. Keep runtime secrets and customer documents outside Git. Existing install scripts can create desktop/startup shortcuts; review them before running. Desktop source and instructions are in desktop/.

## Export scope

Includes source, tests, lockfile, migration definitions and font assets/license. Excludes live runtime/customer records, credentials, logs, dependencies, deployment output, generated worker/assets.generated.js, original Git history and stale test-results claims. The build regenerates worker assets. Hosting project ID was removed from .openai/hosting.json; DB and BUCKET binding names remain. The existing auto-publishing workflow is preserved as docs/ci-cd.yml.disabled and does not execute automatically. No cloud deployment or payment configuration was changed.

## Optional source archive recovery

If using the separately supplied source ZIP, extract it and run commands above. If using the separately supplied Git bundle:

```powershell
git clone shri-print-source.bundle shri-print
cd shri-print
```

The bundle contains only this sanitized snapshot, not the original project's private history.
