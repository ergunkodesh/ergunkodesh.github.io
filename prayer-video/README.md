# Prayer video sign-up

Live URL (for the QR code): https://ergunkodesh.org/prayer-video/

People who receive prayer during Prophet Alan Ross's visits scan the QR code on the printed sheet and leave their names and email. We email each person or group an unlisted YouTube link to their clip.

## Unlisted

- No links to this page from anywhere else on the site.
- `<meta name="robots" content="noindex, nofollow">` keeps it out of search results.
- The site has no `sitemap.xml`. If one is added later, leave this page out.
- Not listed in `robots.txt`, since that file is public.

## How submissions are sent

The site is static on GitHub Pages, so the form posts to [Web3Forms](https://web3forms.com), which emails each entry to **jasonpaschall@anchorfalls.org** with the subject "Alan Ross prayer video sign-up".

The Web3Forms access key lives in `index.html` (`WEB3FORMS_ACCESS_KEY`). Web3Forms documents this key as safe to publish: it can only deliver to the inbox it was created for. No server secret is involved.

### The key

The access key was created on 2026-10-17 in the Web3Forms account for jasonpaschall@anchorfalls.org (form name "Alan Ross prayer video sign-up"). To replace it, create a new form at https://app.web3forms.com, paste the new key into `WEB3FORMS_ACCESS_KEY` in `index.html`, and push to `main`.

### Spam

A hidden honeypot field (`website`) catches simple bots. If it is filled in, the page shows the thank-you message and sends nothing. No CAPTCHA.

### Send a test entry

1. Open https://ergunkodesh.org/prayer-video/ on a phone.
2. Enter a test name and one or two addresses separated by a comma.
3. Tap **Send my info**. You should see the thank-you message, and an email should land in jasonpaschall@anchorfalls.org within a minute. Check spam the first time.
