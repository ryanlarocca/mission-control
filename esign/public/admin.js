(function () {
  var rows = document.getElementById('signers'); if (!rows) return;
  var tpl = document.getElementById('signer-tpl').innerHTML;
  var add = document.getElementById('addsigner');
  function addRow(v) {
    v = v || {};
    var div = document.createElement('div'); div.className = 'signer-row'; div.innerHTML = tpl;
    div.querySelector('[name="s_name[]"]').value = v.name || '';
    div.querySelector('[name="s_email[]"]').value = v.email || '';
    div.querySelector('[name="s_phone[]"]').value = v.phone || '';
    div.querySelector('[name="s_role[]"]').value = v.role || 'seller';
    div.querySelector('[name="s_order[]"]').value = v.order || (v.role === 'buyer' ? '2' : '1');
    div.querySelector('.rm').addEventListener('click', function (e) { e.preventDefault(); div.remove(); });
    rows.appendChild(div);
  }
  window.addSignerRow = addRow;
  add.addEventListener('click', function (e) { e.preventDefault(); addRow(); });
  var pre = window.PREFILL || [];
  if (pre.length) pre.forEach(addRow); else addRow();
  var src = document.querySelectorAll('input[name=source]');
  function srcRefresh() {
    var v = document.querySelector('input[name=source]:checked').value;
    document.getElementById('src-drive').style.display = v === 'drive' ? 'block' : 'none';
    document.getElementById('src-upload').style.display = v === 'upload' ? 'block' : 'none';
  }
  src.forEach(function (r) { r.addEventListener('change', srcRefresh); }); srcRefresh();
  var sel = document.getElementById('drive_file_id');
  if (sel) sel.addEventListener('change', function () {
    var o = sel.options[sel.selectedIndex]; var t = document.getElementById('title'); var a = document.getElementById('property_address');
    if (o && o.dataset.name && !t.value) t.value = o.dataset.name;
    if (o && o.dataset.folder && !a.value) a.value = o.dataset.folder;
  });
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () { navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () { b.textContent = 'Copied'; }); });
  });
  var f = document.getElementById('newform');
  if (f) f.addEventListener('submit', function () { var b = f.querySelector('button[type=submit]'); b.disabled = true; b.textContent = 'Sending…'; });
})();
