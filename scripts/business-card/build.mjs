import QRCode from '/tmp/lrg-business-card/node_modules/qrcode/lib/index.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire('/Users/ryanlarocca/Projects/PROJECTS/mission-control/package.json');
const { chromium } = require('playwright');

const OUT = process.env.OUT || '/tmp/lrg-business-card'; fs.mkdirSync(OUT, { recursive: true });
const NAVY = '#1a2d4f', GOLD = '#d4a017';
const cfg = {
  name: 'Ryan LaRocca',
  title: 'Founder & CEO',
  company: 'LRG Homes',
  phone: '(408) 458-5442',
  email: 'ryan@lrghomes.com',
  site: 'lrghomes.com',
  tagline: 'We buy Bay Area homes for cash.',
  sub: 'Any condition. No repairs, no commissions. Close on your timeline.',
  qrUrl: 'https://www.lrghomes.com/?utm_source=bizcard',
};
const qr = await QRCode.toString(cfg.qrUrl, { type: 'svg', margin: 0, color: { dark: NAVY, light: '#0000' }, errorCorrectionLevel: 'M' });
const logoWhite = 'data:image/png;base64,' + fs.readFileSync(new URL('./lrg-logo-white.png', import.meta.url)).toString('base64');
const logoDark  = 'data:image/png;base64,' + fs.readFileSync(new URL('./lrg-logo.png', import.meta.url)).toString('base64');

// Card = 3.5 x 2 in. Bleed = 0.125 in each side -> 3.75 x 2.25. Safe zone = 0.125 in inside trim.
const css = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 3.75in; height: 2.25in; font-family: 'Inter', sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.card { position: relative; width: 3.75in; height: 2.25in; overflow: hidden; }
.safe { position: absolute; inset: 0.25in; }
.front .safe { left: 0.34in; bottom: 0.32in; }          /* bleed 0.125 + safe 0.125 */
.trim { position: absolute; inset: 0.125in; border: 0.5px dashed rgba(255,0,0,.6); pointer-events: none; }
.guides .trim { display: block; } .noguides .trim { display: none; }
`;

const front = (guides) => `<!doctype html><html><head><style>${css}
.card { background: ${NAVY}; color: #fff; }
.rule { position:absolute; left:0; bottom:0; width:100%; height:0.2in; background:${GOLD}; }
.bar { position:absolute; top:0; left:0; width:0.215in; height:100%; background:${GOLD}; }
.logo { height: 0.5in; }
.name { font-weight: 800; font-size: 15pt; letter-spacing: -0.01em; margin-top: 0.1in; line-height: 1.1; }
.title { font-weight: 500; font-size: 8pt; color: ${GOLD}; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 0.04in; }
.contact { position:absolute; left:0; bottom:0; font-size: 8.2pt; line-height: 1.5; font-weight: 500; color:#e5e7eb; }
.contact b { color:#fff; font-weight:600; }
.qr { position:absolute; right:0; bottom:0; width:0.62in; height:0.62in; background:#fff; padding:0.05in; border-radius:3px; }
.qr svg { width:100%; height:100%; }
</style></head><body class="${guides?'guides':'noguides'}"><div class="card front">
<div class="bar"></div>
<div class="safe">
  <img class="logo" src="${logoWhite}">
  <div class="name">${cfg.name}</div>
  <div class="title">${cfg.title} · ${cfg.company}</div>
  <div class="contact"><b>${cfg.phone}</b><br>${cfg.email}<br>${cfg.site}</div>
  <div class="qr">${qr}</div>
</div>
<div class="rule"></div>
<div class="trim"></div>
</div></body></html>`;

const back = (guides) => `<!doctype html><html><head><style>${css}
.card { background: #fff; color: ${NAVY}; }
.rule { position:absolute; left:0; top:0; width:100%; height:0.2in; background:${GOLD}; }
.h { font-weight: 800; font-size: 14.5pt; letter-spacing:-0.01em; line-height:1.15; margin-top:0.12in; max-width:2.25in; }
.s { font-weight: 500; font-size: 8.5pt; color:#334155; margin-top:0.08in; line-height:1.45; max-width: 2.4in; }
.proof { position:absolute; left:0; bottom:0; max-width:2.1in; white-space:nowrap; font-size:7.4pt; font-weight:600; color:${NAVY}; line-height:1.45; }
.proof span { color:${GOLD}; letter-spacing:0.05em; }
.mark { position:absolute; right:-0.04in; top:0.06in; height:0.36in; opacity:.9; }
</style></head><body class="${guides?'guides':'noguides'}"><div class="card back">
<div class="rule"></div>
<div class="safe" style="top:0.32in">
  <img class="mark" src="${logoDark}">
  <div class="h">${cfg.tagline}</div>
  <div class="s">${cfg.sub}</div>
  <div class="proof"><span>★★★★★</span>&nbsp; 4.9 &nbsp;·&nbsp; 29 reviews<br>Google &amp; Yelp &nbsp;·&nbsp; South Bay since 2017</div>
</div>
<div class="trim"></div>
</div></body></html>`;

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1125, height: 675 }, deviceScaleFactor: 4 }); // 3.75in*300dpi = 1125
for (const [nm, html] of [['front', front], ['back', back]]) {
  await page.setContent(html(true), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${nm}-preview.png`, clip: { x:0, y:0, width:360, height:216 } });
  await page.setContent(html(false), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: `${OUT}/${nm}-print.pdf`, width: '3.75in', height: '2.25in', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
}
await browser.close();
console.log('done');
