# Speaker Submission Portal

Live URL: https://ergunkodesh.org/speaker/

Pastors, speakers, and visitors submit sermon decks once. Media, livestream, and video-edit teams get the files and related text reliably.

This directory is a **reliability bridge**: harden the existing static page + Google Apps Script path. It is not the long-term Form/Drive intake. See [docs/SPEAKER_PORTAL_REBUILD.md](../docs/SPEAKER_PORTAL_REBUILD.md).

## Files

| Path | Purpose |
|------|---------|
| `index.html` | Visitor-facing form (no secrets in git) |
| `config.example.js` | Template for local/deploy config |
| `config.js` | **Gitignored.** Real URL + passwords. Required at runtime |
| `apps-script/Code.gs` | Backend to paste/deploy in Apps Script |
| `README.md` | This document |

## Frontend setup (`config.js`)

1. Copy `config.example.js` → `config.js`.
2. Set:
   - `googleScriptUrl` — Web app `/exec` URL from Apps Script deploy
   - `scriptPassword` — **new** secret; must match Script Property `SCRIPT_PASSWORD`
   - `pagePassword` — leave `''` for visitor-friendly no-login UX (recommended)
   - `maxTotalUploadBytes` — client cap (default 20 MiB)
   - `fallbackEmail` — default `media@anchorfalls.org`
3. Deploy `config.js` with the site **without committing it**.

### GitHub Pages note

This repo is public. Anything committed is world-readable. `config.js` is gitignored on purpose.

Options:

- **Recommended:** GitHub Action (or other deploy) that writes `speaker/config.js` from repository secrets before publishing Pages artifacts.
- **Manual cutover:** On a trusted machine, create `config.js`, then publish via a private deploy path that includes that file. Do not push secrets to `main`.
- Until `config.js` is present on the host, the page shows a clear “Portal not configured” message and points speakers to email Media.

**Rotate** any passwords that were previously embedded in `speaker/index.html`. Treat them as compromised.

## Apps Script deploy

Project today: **Speaker Submission** under `serviceexperience@anchorfalls.org`.

1. Open the Apps Script editor → replace `Code.gs` with `apps-script/Code.gs` from this repo.
2. Enable advanced services if needed: **Drive API**, **Google Slides API**.
3. **Project Settings → Script properties** (create/update):

| Property | Example / notes |
|----------|-----------------|
| `SCRIPT_PASSWORD` | New long random secret (match `config.js`) |
| `PARENT_FOLDER_ID` | `1XkogH8UKx0etKrrhfubf0CLk8ZKJHzSl` (Speaker Submissions folder) |
| `SHEET_ID` | `1s_D22RcizEnbkPiLB5rvHe-FBk33TWDl2NkIV8VRjtA` (Speaker Submission Log) |
| `NOTIFY_EMAILS` | `serviceexperience@anchorfalls.org,media@anchorfalls.org,video@anchorfalls.org,communications@anchorfalls.org` |
| `ERROR_EMAILS` | Optional; defaults to `NOTIFY_EMAILS` |
| `GEMINI_API_KEY` | Optional; scripture assist only |

4. Deploy → **New deployment** (or new version) → Web app:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the `/exec` URL into `config.js` → `googleScriptUrl`.
6. Do **not** put personal Gmail addresses in `NOTIFY_EMAILS` defaults.

### Behavior (backend)

- Validates password from Script Properties (not hardcoded).
- Rejects oversized payloads early.
- Saves presentation + extras under `{serviceDate} - {speakerName}` (versioned if needed).
- Best-effort slide text + Gemini scripture files; **failures never block** Drive save or notify email.
- Idempotent when the client sends `submissionId` (retries return success without duplicating work).
- HTML-escapes fields in notification email.
- `contextDetails` is always defined in catch/report paths.

## Test checklist

- [ ] Without `config.js`, page shows configure message + Media email (icon + text, not color-only).
- [ ] With `pagePassword: ''`, form is visible with no login gate.
- [ ] Next Sunday (or today if before ~10:00 local Sunday) is prefilled as service date.
- [ ] Template + Mulish + Montserrat links still work.
- [ ] Oversized file selection shows a clear size-limit error and mailto fallback.
- [ ] Happy path: small `.pptx` → success status with ✓ icon + “Success: Submitted”.
- [ ] Media recipients get one email with Drive folder link; sheet gains a row.
- [ ] Wrong `scriptPassword` → Failed status + fallback mailto to `media@anchorfalls.org`.
- [ ] Forced network/server failure → Failed status + same mailto fallback.
- [ ] Retry with same `submissionId` does not create a duplicate folder (idempotency).
- [ ] Confirm no passwords/secrets appear in `git grep` on tracked files.
- [ ] Confirm `/sed` assets were not modified.

## Security

- Shared browser secrets are a **bridge only**. Anyone who can load `config.js` can submit as the portal. Rotate often; prefer Form/Drive cutover.
- Never commit `config.js`, API keys, or Script Property values.
- Old plaintext passwords that lived in `index.html` must be rotated in Apps Script and retired from any bookmarks/docs.
- Notification lists should use church domain addresses, not personal Gmail.
- HTML email bodies escape speaker-provided fields.

## Owners

Media / Service Experience (`serviceexperience@anchorfalls.org`, `media@anchorfalls.org`). Speakers are untrusted external users — keep UX simple and fallback email obvious.
