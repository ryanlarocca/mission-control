// Review page: tap "Sign here" → sheet (type name, pick a style or draw) →
// Adopt → signature shows on the document → tick box → Finish.
(function () {
  var form = document.getElementById('signform'); if (!form) return;
  var $ = function (id) { return document.getElementById(id); };
  var sheet = $('sheet'), tab = $('signtab'), preview = $('sigpreview'), typed = $('typed_name'), agree = $('agree'), finish = $('finish'), hint = $('finishhint');
  var err = $('sheeterr'), adoptBtn = $('adopt'), cancelBtn = $('cancelsheet');
  var mode = 'type', adopted = false, submitted = false;
  // Initials boxes (several signers on a document's own lines): each one must be tapped before signing.
  var initsTotal = +(form.getAttribute('data-inits') || 0), letters = form.getAttribute('data-initials') || '', tapped = {};
  var initTabs = Array.prototype.slice.call(document.querySelectorAll('.inittab'));
  var initPng = null; // drawn initials (draw mode, or a saved drawn signature's initials)
  var savedSpan = document.querySelector('#savedcard .savedsig > span');
  var inkFont = savedSpan ? savedSpan.style.fontFamily : null; // the style the initials show in on the page
  function initialsOf(name) { return name.split(/[\s-]+/).filter(Boolean).map(function (w) { return w[0].toUpperCase(); }).slice(0, 3).join(''); }
  function initsLeft() { var n = 0; initTabs.forEach(function (t) { if (!tapped[t.getAttribute('data-i')]) n++; }); return initsTotal ? n : 0; }
  function paintInits() {
    initTabs.forEach(function (t) {
      var on = !!tapped[t.getAttribute('data-i')], sp = t.querySelector('.ini');
      t.classList.toggle('done', on); sp.innerHTML = '';
      if (!on) return;
      if (initPng) { var im = document.createElement('img'); im.src = initPng; im.alt = 'your initials'; sp.appendChild(im); }
      else { sp.textContent = letters; sp.style.fontFamily = inkFont || fontOf(pickedFont()); sp.style.fontSize = Math.max(10, Math.round(t.clientHeight * 0.95)) + 'px'; }
    });
    $('f_initials').value = Object.keys(tapped).filter(function (k) { return tapped[k]; }).sort().join(',');
  }
  initTabs.forEach(function (t) { t.addEventListener('click', function () { if (submitted) return; var k = t.getAttribute('data-i'); tapped[k] = !tapped[k]; paintInits(); refresh(); }); });
  function firstUntapped() { for (var i = 0; i < initTabs.length; i++) if (!tapped[initTabs[i].getAttribute('data-i')]) return initTabs[i]; return null; }
  // A returning signer with drawn initials on file: the page shows those.
  var onetapBtn = $('onetap');
  if (onetapBtn && onetapBtn.getAttribute('data-ipng')) initPng = onetapBtn.getAttribute('data-ipng');

  function fontOf(key) { var el = document.querySelector('.fontprev[data-font="' + key + '"]'); return el ? el.style.fontFamily : 'cursive'; }
  function pickedFont() { var r = document.querySelector('input[name=fontpick]:checked'); return r ? r.value : 'greatvibes'; }
  // Shrink a one-line preview until it fits its box (long names, narrow phones). `max` is the font's natural size.
  // `box` is the element whose clientWidth is the room available (the preview itself when it is a
  // shrinkable flex item, else its container).
  function fit(el, max, min, box) {
    var size = max;
    if (!box.clientWidth) return; // hidden — measured again when shown
    el.style.fontSize = size + 'px';
    while (size > min && el.scrollWidth > box.clientWidth - 2) { size -= 1; el.style.fontSize = size + 'px'; }
  }
  function refreshPreviews() {
    var n = typed.value.trim() || typed.placeholder;
    document.querySelectorAll('.fontprev').forEach(function (el) {
      el.textContent = n;
      if (!el.dataset.max) el.dataset.max = parseInt(el.style.fontSize, 10) || 30;
      fit(el, +el.dataset.max, 16, el);
    });
    document.querySelectorAll('.fontini').forEach(function (el) { el.textContent = initialsOf(n); });
  }
  typed.addEventListener('input', refreshPreviews);
  // Hidden text never triggers a web-font download, so fetch the script fonts up front and re-fit once they land.
  if (document.fonts) {
    document.querySelectorAll('.fontprev').forEach(function (el) { try { document.fonts.load('24px ' + el.style.fontFamily); } catch (e) { /* ignore */ } });
    document.fonts.ready.then(refreshPreviews);
  }

  // Drawing pads: the signature, and (documents with initials boxes) the initials.
  function makePad(canvas, clearBtn) {
    var p = { canvas: canvas, ctx: null, drawn: false, drawing: false, last: null };
    p.setup = function (clear) {
      var r = canvas.getBoundingClientRect(); if (!r.width) return;
      var dpr = window.devicePixelRatio || 1, w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
      if (!clear && p.ctx && canvas.width === w && canvas.height === h) return;
      canvas.width = w; canvas.height = h;
      p.ctx = canvas.getContext('2d'); p.ctx.scale(dpr, dpr);
      p.ctx.lineWidth = 2.6; p.ctx.lineCap = 'round'; p.ctx.lineJoin = 'round'; p.ctx.strokeStyle = '#1a1a40';
      p.drawn = false;
    };
    function pos(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    canvas.addEventListener('pointerdown', function (e) { e.preventDefault(); canvas.setPointerCapture(e.pointerId); p.drawing = true; p.last = pos(e); });
    canvas.addEventListener('pointermove', function (e) { if (!p.drawing) return; e.preventDefault(); var q = pos(e); p.ctx.beginPath(); p.ctx.moveTo(p.last.x, p.last.y); p.ctx.lineTo(q.x, q.y); p.ctx.stroke(); p.last = q; p.drawn = true; });
    canvas.addEventListener('pointerup', function () { p.drawing = false; }); canvas.addEventListener('pointercancel', function () { p.drawing = false; });
    if (clearBtn) clearBtn.addEventListener('click', function () { p.setup(true); });
    p.png = function () {
      if (!p.drawn) return null;
      var w = canvas.width, h = canvas.height, data = p.ctx.getImageData(0, 0, w, h).data, minX = w, minY = h, maxX = 0, maxY = 0, x, y, i;
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) { i = (y * w + x) * 4 + 3; if (data[i] > 20) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } }
      if (maxX <= minX) return null;
      var padPx = 8, out = document.createElement('canvas');
      out.width = (maxX - minX) + padPx * 2; out.height = (maxY - minY) + padPx * 2;
      out.getContext('2d').drawImage(canvas, minX - padPx, minY - padPx, out.width, out.height, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    };
    return p;
  }
  var sigPad = makePad($('pad'), $('clearpad'));
  var iniPad = $('ipad') ? makePad($('ipad'), $('clearipad')) : null;
  function setupPads() { sigPad.setup(); if (iniPad) iniPad.setup(); }

  function openSheet() {
    sheet.hidden = false; document.body.classList.add('noscroll'); err.hidden = true; refreshPreviews();
    if (document.fonts) document.fonts.ready.then(refreshPreviews);
    if (!typed.value) setTimeout(function () { typed.focus(); }, 50);
    if (mode === 'draw') setupPads();
  }
  function closeSheet() { sheet.hidden = true; document.body.classList.remove('noscroll'); }
  tab.addEventListener('click', openSheet);
  if (/[?&]sheet=1/.test(location.search)) openSheet();
  cancelBtn.addEventListener('click', closeSheet);

  document.querySelectorAll('.tabbtn').forEach(function (b) {
    b.addEventListener('click', function () {
      mode = b.getAttribute('data-tab');
      document.querySelectorAll('.tabbtn').forEach(function (x) { x.classList.toggle('on', x === b); });
      $('tab-type').hidden = mode !== 'type'; $('tab-draw').hidden = mode !== 'draw';
      err.hidden = true;
      if (mode === 'draw') setupPads();
    });
  });

  adoptBtn.addEventListener('click', function () {
    var name = typed.value.trim().replace(/\s+/g, ' ');
    if (name.indexOf(' ') < 1) { err.textContent = 'Please type your full legal name (first and last).'; err.hidden = false; return; }
    var png = null, ipng = null;
    if (mode === 'draw') {
      png = sigPad.png(); if (!png) { err.textContent = 'Draw your signature in the box, or switch to "Choose a style".'; err.hidden = false; return; }
      if (iniPad) { ipng = iniPad.png(); if (!ipng) { err.textContent = 'Draw your initials in the second box too.'; err.hidden = false; return; } }
    }
    $('f_typed_name').value = name; $('f_method').value = png ? 'drawn' : 'typed'; $('f_font').value = pickedFont(); $('f_png').value = png || ''; $('f_ipng').value = ipng || '';
    preview.innerHTML = '';
    if (png) { var img = document.createElement('img'); img.src = png; img.alt = 'your signature'; preview.appendChild(img); }
    else { var sp = document.createElement('span'); sp.textContent = name; sp.style.fontFamily = fontOf(pickedFont()); preview.appendChild(sp); fit(sp, Math.max(12, Math.min(28, Math.round(preview.clientHeight * 1.15))), 9, preview); }
    tab.classList.add('signed'); tab.setAttribute('aria-label', 'Your signature — tap to change'); adopted = true; closeSheet();
    letters = initialsOf(name); initPng = ipng; inkFont = null; paintInits();
    setTimeout(function () { (firstUntapped() || $('finishcard')).scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60);
    refresh();
  });

  // Returning signer: one tap adopts their saved signature, agrees and signs.
  var onetap = onetapBtn, usedifferent = $('usedifferent');
  if (onetap) {
    onetap.addEventListener('click', function () {
      if (submitted) return;
      if (initsLeft()) { var t = firstUntapped(); var m = $('onetapmsg'); if (m) { m.textContent = 'Tap each yellow Initial tab on the document first (' + initsLeft() + ' left).'; m.hidden = false; } if (t) t.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      var img = document.querySelector('#savedcard .savedsig > img');
      $('f_typed_name').value = onetap.getAttribute('data-name');
      $('f_method').value = onetap.getAttribute('data-method');
      $('f_font').value = onetap.getAttribute('data-font');
      $('f_png').value = img ? img.getAttribute('src') : '';
      $('f_ipng').value = onetap.getAttribute('data-ipng') || '';
      $('f_reused').value = '1'; $('f_agree').value = '1';
      submitted = true; onetap.disabled = true; onetap.textContent = 'Signing…'; form.submit();
    });
    usedifferent.addEventListener('click', function (e) {
      e.preventDefault(); $('savedcard').hidden = true; $('finishcard').hidden = false; $('f_reused').value = '';
      initPng = null; inkFont = null; paintInits();
      tab.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  function refresh() {
    var left = initsLeft();
    finish.disabled = !(adopted && agree.checked && !left); agree.parentNode.classList.toggle('on', agree.checked);
    if (adopted && left) hint.innerHTML = 'Signature added. Now tap each yellow <strong>Initial</strong> tab (' + left + ' left), tick the box, then tap <strong>Finish</strong>.';
    else if (adopted) hint.innerHTML = 'Signature added. Tick the box, then tap <strong>Finish</strong>. Tap your signature on the document to change it.';
    var m = $('onetapmsg'); if (m && !left) m.hidden = true;
  }
  agree.addEventListener('change', refresh); refresh();
  finish.addEventListener('click', function () {
    if (finish.disabled || submitted) return;
    submitted = true; $('f_agree').value = '1'; finish.disabled = true; finish.textContent = 'Signing…'; form.submit();
  });
})();
