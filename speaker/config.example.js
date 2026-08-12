/**
 * Speaker Portal local configuration.
 *
 * Setup:
 *   1. Copy this file to speaker/config.js (gitignored — do not commit).
 *   2. Fill in values below. Rotate any passwords that were previously
 *      embedded in speaker/index.html (treat those as compromised).
 *   3. Deploy config.js with the site. On public GitHub Pages, prefer a
 *      deploy step that writes this file from CI secrets so it never lands
 *      in git history. See speaker/README.md.
 *
 * window.SPEAKER_PORTAL_CONFIG is read by speaker/index.html.
 */
window.SPEAKER_PORTAL_CONFIG = {
  // Deployed Apps Script web app URL (.../exec)
  googleScriptUrl: 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec',

  // Shared secret that must match Script Property SCRIPT_PASSWORD on the
  // Apps Script project. Visible to anyone who can load this file — bridge
  // only; plan Form/Drive cutover (docs/SPEAKER_PORTAL_REBUILD.md).
  scriptPassword: 'REPLACE_WITH_ROTATED_SCRIPT_PASSWORD',

  // Optional soft gate. Leave empty string for visitor-friendly no-login UX.
  pagePassword: '',

  // Client-side total upload cap (bytes) before Base64. Keep under typical
  // Apps Script POST limits; 20 MiB is a practical default for this bridge.
  maxTotalUploadBytes: 20 * 1024 * 1024,

  // Shown when submit fails so speakers can still reach Media.
  fallbackEmail: 'media@anchorfalls.org'
};
