# Speaker Portal — bridge vs future rebuild

## Goal

Guest and staff speakers deliver slide decks and assets to Media, livestream, and video-edit teams before Sunday, with brand-consistent guidelines and a reliable audit trail.

## Current bridge (this PR)

Keep the familiar static page at `/speaker/` and Google Apps Script backend, but harden it:

- Secrets out of tracked HTML (`config.example.js` + gitignored `config.js`; Script Properties on GAS)
- Icon + text status (not color-only; deuteranopia-safe)
- Client and server size caps with clear errors
- Submit-failure fallback to `media@anchorfalls.org`
- Idempotent `submissionId`
- Gemini/scripture assist must not block file save + notify
- Source for `Code.gs` living in git for review/paste-deploy

This bridge is intentional weekend insurance. It does **not** fix the structural issue that Base64-through-Apps-Script is quota-fragile, or that a browser-visible shared secret is not real auth.

## Why rebuild

| Pain | Bridge mitigation | Real fix |
|------|-------------------|----------|
| Passwords in public HTML | Move to gitignored config + Script Properties; rotate | No shared browser password; identity or Workspace ACL |
| Large PPTX/Keynote fails | Size caps + email fallback | Direct Drive / Form file upload (not Base64 via GAS) |
| Duplicate submits | `submissionId` cache | Platform-native idempotency / one folder per speaker+date |
| Color-only success/fail | Icon + text | Keep in any UI |
| Gemini outage blocks Sunday | Non-blocking assist | Keep assist async/optional |
| No SED checklist link | Out of scope here | Service calendar object + “slides ready” |

## Recommended future intake (no SED work in this PR)

**Preferred:** Google Workspace-native intake

1. Google Form (or equivalent) with file upload into a Shared Drive folder.
2. Naming convention: `{serviceDate} - {speakerName}` (Apps Script or Drive workflow on form submit is fine if it only organizes/notifies).
3. Notify Media / livestream / video via group email or Chat — church addresses only.
4. Optional: thin automation writes sermon metadata toward the service calendar / SED “Presentation slides ready” checklist later.

**Alternatives:** Microsoft Forms + SharePoint if that becomes church standard; or signed upload URLs (Firebase/GCS) with a tiny Cloud Function.

**Avoid:** More shared passwords; raising Base64/GAS quotas as a strategy; folding Speaker into the SED PIN/app shell.

## Cutover sketch (future)

1. Stand up Form + Shared Drive folder permissions for Media leads.
2. Run Form in parallel with `/speaker/` for one or two Sundays.
3. Point speakers to Form; keep `/speaker/` as emergency fallback or retire with a static redirect + mailto.
4. Archive old Apps Script deployments; revoke old `SCRIPT_PASSWORD` and any leaked web app URLs.
5. Only then consider SED checklist automation (separate project; **do not** ship SED changes in the Speaker bridge PR).

## Out of scope for the bridge PR

- Any `/sed` asset or Firebase changes
- VolunteerCal / Breeze integration
- Full identity (magic links, accounts)

## Related

- Deploy and test steps: [speaker/README.md](../speaker/README.md)
- Live bridge UI: https://ergunkodesh.org/speaker/
