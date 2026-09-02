# Cody Brief — Restore & Fix lrghomes.com Main Website

**Owner:** Ryan LaRocca (LRG Homes)
**Status:** Ready to execute — no questions, no clarifications needed
**Estimated time:** 15–25 minutes
**Production domain:** `www.lrghomes.com` (Vercel)

---

## 1. Context (read once, then act)

LRG Homes runs two sites today:

- **`www.lrghomes.com`** — the main marketing site (this is what we're fixing).
- **`lrghomes-landing.vercel.app`** — a single-page landing page that is being retired. We are migrating all Google Ads traffic over to the main site, so the main site **must have working conversion tracking** before that switch happens.

The main site's deploy folder (`/Users/ryanlarocca/.openclaw/workspace/lrg-homes-website/`) was wiped at some point and only `logs/` remains. A complete, working copy of the site (minus a tracking bug) is preserved in the archive folder.

**Two things to fix in this job:**
1. Restore all the files from the archive into the deploy folder.
2. Fix the conversion-tracking bug in `index.html` so it fires Google Ads conversions correctly (currently it routes through GTM, which silently drops them).

Then deploy to Vercel prod.

---

## 2. Source-of-truth paths (verified to exist)

| Purpose | Path |
|---|---|
| Archive (source) | `/Users/ryanlarocca/.openclaw/workspace/PROJECTS/_archive/lrg-homes-website/` |
| Deploy target | `/Users/ryanlarocca/.openclaw/workspace/lrg-homes-website/` |
| Reference (correct tracking) | `/Users/ryanlarocca/.openclaw/workspace/PROJECTS/lrghomes-landing/index.html` |

**Archive contents (confirmed):**
```
about.html
api/                  (submit-lead.js)
blog/                 (6 posts — *.html)
blog.html
how-it-works.html
index.html
lib/
package.json
package-lock.json
scripts/
SETUP.md
styles.css
test-endpoints.sh
thank-you.html
vercel.json
```

**Deploy folder currently contains:** only `logs/` (everything else was wiped — must be restored).

---

## 3. Tracking rules — READ TWICE, do not deviate

These rules are the entire point of this job. Get them wrong and Ryan's Google Ads stop optimizing.

### MUST include
- **Google Ads gtag (standalone, NOT via GTM):**
  ```html
  <script async src="https://www.googletagmanager.com/gtag/js?id=AW-11434036654"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'AW-11434036654');
  </script>
  ```
- **Conversion fire (on form submit, BEFORE the async fetch):**
  ```js
  if (typeof gtag === 'function') {
    gtag('event', 'conversion', {'send_to': 'AW-11434036654/j2ZECKrh_IYcEK6blswq'});
  }
  ```
- **Facebook Pixel ID `2287230658217255`** — keep the existing snippet and the `fbq('track', 'Lead')` on form submit. Use `if (window.fbq) { window.fbq('track', 'Lead'); }` (NOT `typeof fbq === 'function'` — the pixel snippet stubs fbq synchronously, the looser check is correct).

### MUST NOT include
- **`GT-5DFRBD56`** — do not load. This is a Google Tag Manager container that silently re-routes conversions and breaks them.
- **`GTM-TK72454K`** — same problem. Do not load.
- **No `<script src="https://www.googletagmanager.com/gtm.js?id=...">`** anywhere.
- **No `<noscript>` GTM iframe.**
- **No `dataLayer.push({event: 'conversion', ...})` patterns** intended to fire a GTM trigger. Conversions must fire via direct `gtag('event', 'conversion', ...)`.

### The bug to fix
The archive's `index.html` currently fires conversions through GTM (either by including the GTM container script or by pushing a `conversion` event into the dataLayer for GTM to consume). Both are wrong. Strip out everything GTM-related and replace the conversion fire with the direct `gtag('event', 'conversion', ...)` call shown above. Use the reference implementation in section 4.

---

## 4. Reference implementation (copy from the landing page)

The landing page (`/Users/ryanlarocca/.openclaw/workspace/PROJECTS/lrghomes-landing/index.html`) has the correct, working form-submit handler. Use it as the template:

```html
<script>
  // Handle lead form submissions via /api/submit-lead
  function setupForm(formId, thanksId) {
    const form = document.getElementById(formId);
    const thanks = document.getElementById(thanksId);
    if (!form) return;

    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      const formData = Object.fromEntries(new FormData(form));
      const btn = form.querySelector('.btn-cta');
      btn.textContent = 'Sending…';
      btn.disabled = true;

      // Fire conversion events immediately on submit (before async fetch)
      if (typeof gtag === 'function') {
        gtag('event', 'conversion', {'send_to': 'AW-11434036654/j2ZECKrh_IYcEK6blswq'});
      }
      if (window.fbq) {
        window.fbq('track', 'Lead');
      }

      try {
        const res = await fetch('/api/submit-lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData)
        });

        if (res.ok) {
          form.style.display = 'none';
          thanks.style.display = 'block';
        } else {
          btn.textContent = 'Get My Cash Offer →';
          btn.disabled = false;
          alert('Something went wrong. Please call us at (650) 670-3914.');
        }
      } catch (err) {
        btn.textContent = 'Get My Cash Offer →';
        btn.disabled = false;
        alert('Something went wrong. Please call us at (650) 670-3914.');
      }
    });
  }
</script>
```

Adapt the `setupForm(...)` calls at the bottom to match whatever form IDs exist in the archive's `index.html` (likely the same `hero-form`/`hero-thanks` and `bottom-form`/`bottom-thanks` pattern, but verify against the actual file).

**Key principle:** conversion fires **synchronously on submit, BEFORE `fetch`**. Do not put it inside the `try` block or after the `await`. If the network is slow or fails, we still want the conversion recorded.

---

## 5. Step-by-step execution

Run each step in order. Do not skip verification.

### Step 1 — Copy archive to deploy folder

```bash
# Preserve directory structure, exclude node_modules and logs
rsync -av \
  --exclude 'node_modules' \
  --exclude 'logs' \
  /Users/ryanlarocca/.openclaw/workspace/PROJECTS/_archive/lrg-homes-website/ \
  /Users/ryanlarocca/.openclaw/workspace/lrg-homes-website/
```

After copying, confirm:
```bash
ls /Users/ryanlarocca/.openclaw/workspace/lrg-homes-website/
```
Expected: `about.html api blog blog.html how-it-works.html index.html lib logs package.json package-lock.json scripts SETUP.md styles.css test-endpoints.sh thank-you.html vercel.json`

### Step 2 — Audit `index.html` for GTM contamination

```bash
grep -nE 'GTM-TK72454K|GT-5DFRBD56|gtm\.js|googletagmanager\.com/gtm' \
  /Users/ryanlarocca/.openclaw/workspace/lrg-homes-website/index.html
```
Every match must be removed. Also grep for any `dataLayer.push({event: 'conversion'` patterns — those are GTM triggers and need to be replaced with the direct `gtag('event', 'conversion', ...)` call.

### Step 3 — Fix `index.html`

Edit `/Users/ryanlarocca/.openclaw/workspace/lrg-homes-website/index.html`:

1. In `<head>`: confirm only the standalone gtag (`AW-11434036654`) and the Facebook Pixel snippet are present. Remove any GTM container script tags and the corresponding `<noscript>` GTM iframe.
2. Find the form submit handler at the bottom of the file. Replace it with the reference implementation in section 4, adapting the `setupForm(...)` IDs to match the form IDs that exist in the archive's index.html (do not invent new form IDs — use whatever the existing markup uses).
3. Make sure the conversion fires **before** the `await fetch(...)` call.
4. Keep all `fbq(...)` calls intact (`fbq('init', '2287230658217255')`, `fbq('track', 'PageView')`, and `fbq('track', 'Lead')` on submit).

### Step 4 — Verify `thank-you.html`

Open `/Users/ryanlarocca/.openclaw/workspace/lrg-homes-website/thank-you.html` and confirm:
- It loads `https://www.googletagmanager.com/gtag/js?id=AW-11434036654` (standalone gtag, NOT gtm.js).
- It fires `gtag('event', 'conversion', {'send_to': 'AW-11434036654/j2ZECKrh_IYcEK6blswq'});` on page load (typically inside the initial `<script>` block in `<head>` or right after the gtag config).
- It does NOT reference `GTM-TK72454K` or `GT-5DFRBD56`.

If any of those are wrong, fix them the same way as in step 3.

### Step 5 — Final pre-deploy audit (whole site)

```bash
cd /Users/ryanlarocca/.openclaw/workspace/lrg-homes-website
grep -rnE 'GTM-TK72454K|GT-5DFRBD56|gtm\.js' --include='*.html' .
```
Expected output: **nothing**. If anything matches, fix it before deploying.

```bash
grep -rn 'AW-11434036654' --include='*.html' .
```
Expected: matches in `index.html` (config + conversion send_to) and `thank-you.html` (config + conversion send_to). The blog pages and other subpages may or may not have the gtag — leave whatever the archive had, do not add new tags.

### Step 6 — Deploy to production

```bash
cd /Users/ryanlarocca/.openclaw/workspace/lrg-homes-website && vercel --prod
```

If Vercel prompts for project linking, the project is already linked via the existing `vercel.json` and `.vercel/` metadata in the archive copy. If `.vercel/` was NOT copied (it may have been excluded), `vercel --prod` will prompt to link — link to the existing `lrg-homes-website` project under Ryan's account (production domain `www.lrghomes.com`).

### Step 7 — Post-deploy verification

After deploy completes, fetch the live HTML and confirm:

```bash
curl -s https://www.lrghomes.com/ | grep -E 'AW-11434036654|GTM-|GT-5DFR|gtm\.js' | head -50
```
Expected: matches for `AW-11434036654` only. **Zero matches for `GTM-`, `GT-5DFR`, or `gtm.js`.**

Then walk through each page and confirm a 200 response:
```bash
for path in / /about.html /how-it-works.html /blog.html /thank-you.html \
            /blog/cash-buyer-vs-listing-bay-area.html \
            /blog/divorce-sell-house-fast-bay-area.html \
            /blog/hidden-costs-listing-your-home.html \
            /blog/inherited-home-california.html \
            /blog/sell-home-during-probate-california.html \
            /blog/selling-parents-home-bay-area.html; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://www.lrghomes.com${path}")
  echo "$code  $path"
done
```
Every line should show `200`.

---

## 6. Acceptance criteria (Ryan's bar)

- [ ] All files from the archive (excluding `node_modules/` and `logs/`) exist in `/Users/ryanlarocca/.openclaw/workspace/lrg-homes-website/`.
- [ ] `index.html` and `thank-you.html` load the standalone `AW-11434036654` gtag only — no GTM container.
- [ ] `index.html` fires `gtag('event', 'conversion', {'send_to': 'AW-11434036654/j2ZECKrh_IYcEK6blswq'})` directly on form submit, BEFORE the `fetch` call.
- [ ] `fbq('init', '2287230658217255')` and `fbq('track', 'Lead')` are present and unchanged.
- [ ] Zero occurrences of `GTM-TK72454K`, `GT-5DFRBD56`, or `gtm.js` anywhere in `*.html`.
- [ ] `vercel --prod` deploy succeeds.
- [ ] All listed URLs return HTTP 200 on `www.lrghomes.com`.
- [ ] `curl` of the live homepage contains `AW-11434036654` and contains no `GTM-` or `gtm.js` strings.

---

## 7. Out of scope (do not do)

- Do not rewrite HTML/CSS. Keep the archive's design exactly as-is. The only HTML edits are the tracking surgery in `index.html` (and any equivalent cleanup in `thank-you.html` if it has GTM contamination).
- Do not touch `api/submit-lead.js` or `lib/` — those are server-side and unrelated to the tracking bug.
- Do not modify `vercel.json` unless the deploy fails for a routing reason.
- Do not add new conversion IDs, new pixels, or new analytics. The stack is exactly: gtag (`AW-11434036654`) + Facebook Pixel (`2287230658217255`). Nothing else.
- Do not push to git — Ryan will commit after he eyeballs the deploy.

---

## 8. Quick reference card

```
Google Ads tag:        AW-11434036654       (standalone gtag only)
Conversion send_to:    AW-11434036654/j2ZECKrh_IYcEK6blswq
Facebook Pixel ID:     2287230658217255
NEVER load:            GT-5DFRBD56, GTM-TK72454K, gtm.js
Production domain:     www.lrghomes.com
Deploy command:        cd /Users/ryanlarocca/.openclaw/workspace/lrg-homes-website && vercel --prod
```
