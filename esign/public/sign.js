// Signing page: consent checkbox gating, optional draw-your-signature pad,
// typed-name requirement, and a single submit that never double-fires.
(function () {
  var form = document.getElementById('signform');
  if (!form) return;
  var agree = document.getElementById('agree');
  var typed = document.getElementById('typed_name');
  var btn = document.getElementById('signbtn');
  var pad = document.getElementById('pad');
  var padWrap = document.getElementById('padwrap');
  var toggle = document.getElementById('drawtoggle');
  var clearBtn = document.getElementById('clearpad');
  var methodInput = document.getElementById('method');
  var pngInput = document.getElementById('signature_png');
  var drawn = false, drawing = false, ctx, last;

  function refresh() {
    var ok = agree.checked && typed.value.trim().indexOf(' ') > 0;
    btn.disabled = !ok;
    agree.parentNode.classList.toggle('on', agree.checked);
  }
  agree.addEventListener('change', refresh);
  typed.addEventListener('input', refresh);
  refresh();

  function setupPad() {
    var r = pad.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    pad.width = Math.round(r.width * dpr); pad.height = Math.round(r.height * dpr);
    ctx = pad.getContext('2d'); ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1a1a40';
    drawn = false;
  }
  function pos(e) {
    var r = pad.getBoundingClientRect();
    var t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }
  function down(e) { e.preventDefault(); drawing = true; last = pos(e); }
  function move(e) {
    if (!drawing) return; e.preventDefault();
    var p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; drawn = true;
  }
  function up() { drawing = false; }
  if (pad) {
    pad.addEventListener('pointerdown', down); pad.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up); pad.addEventListener('pointerleave', up);
  }
  if (toggle) toggle.addEventListener('click', function (e) {
    e.preventDefault();
    var show = padWrap.style.display === 'none';
    padWrap.style.display = show ? 'block' : 'none';
    toggle.textContent = show ? 'Use my typed name instead' : 'Draw my signature instead (optional)';
    if (show) setupPad();
    methodInput.value = show ? 'drawn' : 'typed';
  });
  if (clearBtn) clearBtn.addEventListener('click', function (e) { e.preventDefault(); setupPad(); });

  form.addEventListener('submit', function (e) {
    if (btn.disabled) { e.preventDefault(); return; }
    if (methodInput.value === 'drawn') {
      if (!drawn) { methodInput.value = 'typed'; }
      else {
        // trim to the ink's bounding box so the signature fills the line
        var dpr = window.devicePixelRatio || 1, w = pad.width, h = pad.height;
        var data = ctx.getImageData(0, 0, w, h).data, minX = w, minY = h, maxX = 0, maxY = 0, i, x, y;
        for (y = 0; y < h; y++) for (x = 0; x < w; x++) { i = (y * w + x) * 4 + 3; if (data[i] > 20) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } }
        var out = document.createElement('canvas'); var padPx = 6 * dpr;
        out.width = (maxX - minX) + padPx * 2; out.height = (maxY - minY) + padPx * 2;
        out.getContext('2d').drawImage(pad, minX - padPx, minY - padPx, out.width, out.height, 0, 0, out.width, out.height);
        pngInput.value = out.toDataURL('image/png');
      }
    }
    btn.disabled = true; btn.textContent = 'Signing…';
  });
})();
