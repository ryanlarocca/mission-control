// Review page: tap "Sign here" → sheet (type name, pick a style or draw) →
// Adopt → signature shows on the document → tick box → Finish.
(function () {
  var form = document.getElementById('signform'); if (!form) return;
  var $ = function (id) { return document.getElementById(id); };
  var sheet = $('sheet'), tab = $('signtab'), preview = $('sigpreview'), typed = $('typed_name'), agree = $('agree'), finish = $('finish'), hint = $('finishhint');
  var pad = $('pad'), clearBtn = $('clearpad'), err = $('sheeterr'), adoptBtn = $('adopt'), cancelBtn = $('cancelsheet');
  var mode = 'type', ctx, drawing = false, drawn = false, last, adopted = false, submitted = false;

  function fontOf(key) { var el = document.querySelector('.fontprev[data-font="' + key + '"]'); return el ? el.style.fontFamily : 'cursive'; }
  function pickedFont() { var r = document.querySelector('input[name=fontpick]:checked'); return r ? r.value : 'greatvibes'; }
  function refreshPreviews() { var n = typed.value.trim() || typed.placeholder; document.querySelectorAll('.fontprev').forEach(function (el) { el.textContent = n; }); }
  typed.addEventListener('input', refreshPreviews);

  function openSheet() { sheet.hidden = false; document.body.classList.add('noscroll'); err.hidden = true; refreshPreviews(); if (!typed.value) setTimeout(function () { typed.focus(); }, 50); if (mode === 'draw') setupPad(); }
  function closeSheet() { sheet.hidden = true; document.body.classList.remove('noscroll'); }
  tab.addEventListener('click', openSheet);
  if (/[?&]sheet=1/.test(location.search)) openSheet();
  cancelBtn.addEventListener('click', closeSheet);

  document.querySelectorAll('.tabbtn').forEach(function (b) {
    b.addEventListener('click', function () {
      mode = b.getAttribute('data-tab');
      document.querySelectorAll('.tabbtn').forEach(function (x) { x.classList.toggle('on', x === b); });
      $('tab-type').hidden = mode !== 'type'; $('tab-draw').hidden = mode !== 'draw';
      if (mode === 'draw') setupPad();
    });
  });

  function setupPad() {
    var r = pad.getBoundingClientRect(); if (!r.width) return;
    var dpr = window.devicePixelRatio || 1;
    pad.width = Math.round(r.width * dpr); pad.height = Math.round(r.height * dpr);
    ctx = pad.getContext('2d'); ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1a1a40';
    drawn = false;
  }
  function pos(e) { var r = pad.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  pad.addEventListener('pointerdown', function (e) { e.preventDefault(); pad.setPointerCapture(e.pointerId); drawing = true; last = pos(e); });
  pad.addEventListener('pointermove', function (e) { if (!drawing) return; e.preventDefault(); var p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; drawn = true; });
  pad.addEventListener('pointerup', function () { drawing = false; }); pad.addEventListener('pointercancel', function () { drawing = false; });
  clearBtn.addEventListener('click', function () { setupPad(); });

  function croppedPng() {
    var w = pad.width, h = pad.height, data = ctx.getImageData(0, 0, w, h).data, minX = w, minY = h, maxX = 0, maxY = 0, x, y, i;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) { i = (y * w + x) * 4 + 3; if (data[i] > 20) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } }
    if (maxX <= minX) return null;
    var padPx = 8, out = document.createElement('canvas');
    out.width = (maxX - minX) + padPx * 2; out.height = (maxY - minY) + padPx * 2;
    out.getContext('2d').drawImage(pad, minX - padPx, minY - padPx, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  adoptBtn.addEventListener('click', function () {
    var name = typed.value.trim().replace(/\s+/g, ' ');
    if (name.indexOf(' ') < 1) { err.textContent = 'Please type your full legal name (first and last).'; err.hidden = false; return; }
    var png = null;
    if (mode === 'draw') { png = drawn ? croppedPng() : null; if (!png) { err.textContent = 'Draw your signature in the box, or switch to "Choose a style".'; err.hidden = false; return; } }
    $('f_typed_name').value = name; $('f_method').value = png ? 'drawn' : 'typed'; $('f_font').value = pickedFont(); $('f_png').value = png || '';
    preview.innerHTML = '';
    if (png) { var img = document.createElement('img'); img.src = png; img.alt = 'your signature'; preview.appendChild(img); }
    else { var sp = document.createElement('span'); sp.textContent = name; sp.style.fontFamily = fontOf(pickedFont()); preview.appendChild(sp); }
    tab.classList.add('signed'); adopted = true; closeSheet();
    hint.textContent = 'Signature added. Tick the box, then tap Finish.';
    $('finishcard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    refresh();
  });

  function refresh() { finish.disabled = !(adopted && agree.checked); agree.parentNode.classList.toggle('on', agree.checked); }
  agree.addEventListener('change', refresh); refresh();
  finish.addEventListener('click', function () {
    if (finish.disabled || submitted) return;
    submitted = true; $('f_agree').value = '1'; finish.disabled = true; finish.textContent = 'Signing…'; form.submit();
  });
})();
