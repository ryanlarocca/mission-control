# LRG business card generator

Renders front/back of the 3.5×2 in card (with 0.125 in bleed → 3.75×2.25 in) as
300-DPI PNG previews + vector PDFs, using the lrghomes.com brand (navy #1a2d4f,
gold #d4a017, Inter, white/black logo).

    node scripts/business-card/build.mjs            # → /tmp/lrg-business-card/
    OUT=~/Desktop/card node scripts/business-card/build.mjs

Edit the `cfg` block at the top for name/title/phone/copy/QR URL. Needs Google
Chrome installed (Playwright `channel: 'chrome'`) and the `qrcode` npm package
(currently resolved from /tmp/lrg-business-card/node_modules — `npm i qrcode`
there, or in the repo, if it's gone).

Dashed red line in the *-preview.png files is the trim line (not in the PDFs).
