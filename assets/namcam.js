/* ==========================================================
   NĂM CAM — namcam.js  (vanilla JS, không cần Prototype/jQuery)
   ========================================================== */
(function () {
  'use strict';

  var CFG = window.NC || {};
  var KEYS = { wish: 'nc_wishlist', compare: 'nc_compare' };
  var MAX_COMPARE = 3;

  /* ---------- tiện ích ---------- */
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $all(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function read(key) {
    try { var v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function write(key, arr) { try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) {} }
  function money(cents) {
    var cur = CFG.currency || 'VND';
    try { return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(cents / 100); }
    catch (e) { return Math.round(cents / 100).toLocaleString('vi-VN') + ' ' + cur; }
  }
  function moneyMajor(v) { return money(Number(v) * 100); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function stripHtml(h) { var d = document.createElement('div'); d.innerHTML = h || ''; return (d.textContent || '').replace(/\s+/g, ' ').trim(); }
  function fetchJSON(url) { return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  function img(src, size) {
    if (!src) return '';
    return src.replace(/(\.(jpg|jpeg|png|gif|webp))(\?|$)/i, '_' + size + '$1$3');
  }

  /* ---------- yêu thích + so sánh: đếm + trạng thái nút ---------- */
  function refreshState() {
    var wish = read(KEYS.wish), cmp = read(KEYS.compare);
    $all('[data-nc-count="wish"]').forEach(function (el) { el.textContent = wish.length; });
    $all('[data-nc-count="compare"]').forEach(function (el) { el.textContent = cmp.length; });
    $all('[data-nc-wish]').forEach(function (b) {
      var on = wish.indexOf(b.getAttribute('data-nc-wish')) > -1;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      var lbl = b.querySelector('[data-label]');
      if (lbl) lbl.textContent = on ? 'Đã yêu thích' : 'Yêu thích';
      else if (b.classList.contains('nc-icon-btn')) b.innerHTML = on ? '&#9829;' : '&#9825;';
    });
    $all('[data-nc-compare]').forEach(function (b) {
      var on = cmp.indexOf(b.getAttribute('data-nc-compare')) > -1;
      b.classList.toggle('is-on', on);
      var lbl = b.querySelector('[data-label]');
      if (lbl) lbl.textContent = on ? '✓ Đã chọn' : 'So sánh';
    });
    var bar = $('#nc-compare-bar');
    if (bar) {
      bar.classList.toggle('is-show', cmp.length > 0 && !/\/pages\/so-sanh/.test(location.pathname));
      var c = bar.querySelector('[data-bar-count]'); if (c) c.textContent = cmp.length;
    }
  }
  function toggle(key, handle, max) {
    var arr = read(key), i = arr.indexOf(handle);
    if (i > -1) arr.splice(i, 1);
    else {
      if (max && arr.length >= max) { alert('Chỉ so sánh tối đa ' + max + ' sản phẩm cùng lúc. Hãy bỏ bớt một sản phẩm.'); return; }
      arr.push(handle);
    }
    write(key, arr);
    refreshState();
    document.dispatchEvent(new CustomEvent('nc:change', { detail: { key: key } }));
  }
  document.addEventListener('click', function (e) {
    var w = e.target.closest('[data-nc-wish]');
    if (w) { e.preventDefault(); toggle(KEYS.wish, w.getAttribute('data-nc-wish')); return; }
    var c = e.target.closest('[data-nc-compare]');
    if (c) { e.preventDefault(); toggle(KEYS.compare, c.getAttribute('data-nc-compare'), MAX_COMPARE); return; }
    if (e.target.closest('[data-nc-compare-clear]')) { write(KEYS.compare, []); refreshState(); document.dispatchEvent(new CustomEvent('nc:change')); }
  });

  function buildCompareBar() {
    var bar = document.createElement('div');
    bar.id = 'nc-compare-bar';
    bar.innerHTML = '<span>Đang so sánh <b data-bar-count>0</b>/' + MAX_COMPARE + ' sản phẩm</span>' +
      '<a href="/pages/so-sanh">So sánh ngay</a><button type="button" data-nc-compare-clear>Xoá hết</button>';
    document.body.appendChild(bar);
  }

  /* ---------- TRANG SẢN PHẨM: gallery, biến thể, số lượng, tab ---------- */
  function initProduct() {
    var root = $('[data-pd]');
    if (!root) return;

    // Gallery
    var stage = $('[data-stage]', root);
    var slides = $all('.pd-slide', root);
    var thumbs = $all('.pd-thumb', root);
    var counter = $('[data-counter]', root);
    var idx = 0;
    function show(i) {
      if (!slides.length) return;
      idx = (i + slides.length) % slides.length;
      slides.forEach(function (s, n) { s.classList.toggle('is-active', n === idx); });
      thumbs.forEach(function (t, n) { t.classList.toggle('is-active', n === idx); });
      if (counter) counter.textContent = (idx + 1) + ' / ' + slides.length;
      var at = thumbs[idx];
      if (at && at.parentNode) at.parentNode.scrollLeft = at.offsetLeft - at.parentNode.clientWidth / 2 + at.clientWidth / 2;
      if (stage) stage.classList.remove('is-zoom');
    }
    thumbs.forEach(function (t, n) { t.addEventListener('click', function () { show(n); }); });
    var prev = $('.pd-prev', root), next = $('.pd-next', root);
    if (prev) prev.addEventListener('click', function () { show(idx - 1); });
    if (next) next.addEventListener('click', function () { show(idx + 1); });
    if (slides.length < 2) { [prev, next].forEach(function (b) { if (b) b.style.display = 'none'; }); if (counter) counter.style.display = 'none'; }
    show(0);

    // Vuốt trên điện thoại
    var sx = null;
    if (stage) {
      stage.addEventListener('touchstart', function (e) { sx = e.touches[0].clientX; }, { passive: true });
      stage.addEventListener('touchend', function (e) {
        if (sx == null) return;
        var dx = e.changedTouches[0].clientX - sx;
        if (Math.abs(dx) > 40) show(idx + (dx < 0 ? 1 : -1));
        sx = null;
      });
      // Rê chuột để xem chi tiết
      stage.addEventListener('mousemove', function (e) {
        if (!stage.classList.contains('is-zoom')) return;
        var r = stage.getBoundingClientRect();
        var s = slides[idx];
        if (s) s.style.transformOrigin = ((e.clientX - r.left) / r.width * 100) + '% ' + ((e.clientY - r.top) / r.height * 100) + '%';
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') show(idx - 1);
      if (e.key === 'ArrowRight') show(idx + 1);
      if (e.key === 'Escape') closeBox();
    });

    // Lightbox
    var box = document.createElement('div');
    box.id = 'nc-lightbox';
    box.innerHTML = '<button type="button" aria-label="Đóng">&times;</button><img alt="">';
    document.body.appendChild(box);
    function openBox() {
      var s = slides[idx]; if (!s) return;
      $('img', box).src = s.getAttribute('data-large') || s.src;
      box.classList.add('is-open');
    }
    function closeBox() { box.classList.remove('is-open'); }
    box.addEventListener('click', closeBox);
    slides.forEach(function (s) { s.addEventListener('click', openBox); });
    var zb = $('.pd-zoom-btn', root);
    if (zb) zb.addEventListener('click', openBox);

    // Biến thể + giá + tồn kho
    var sel = $('#nc-variant', root);
    var priceEl = $('[data-price]', root), cmpEl = $('[data-compare]', root), saveEl = $('[data-save]', root);
    var stockEl = $('[data-stock]', root);
    var addBtn = $('[data-add]', root), buyBtn = $('[data-buy]', root);
    var qty = $('[data-qty]', root);
    function applyVariant() {
      if (!sel) return;
      var o = sel.options[sel.selectedIndex]; if (!o) return;
      var avail = o.getAttribute('data-available') === 'true';
      var managed = o.getAttribute('data-managed') === 'true';
      var stock = parseInt(o.getAttribute('data-stock'), 10) || 0;
      var deny = o.getAttribute('data-deny') === 'true';
      if (priceEl) priceEl.textContent = o.getAttribute('data-price');
      var cp = o.getAttribute('data-compare');
      if (cmpEl) { cmpEl.textContent = cp || ''; cmpEl.style.display = cp ? '' : 'none'; }
      var sv = o.getAttribute('data-save');
      if (saveEl) { saveEl.textContent = sv ? '-' + sv + '%' : ''; saveEl.style.display = sv ? '' : 'none'; }
      if (stockEl) {
        stockEl.className = 'pd-stock';
        if (!avail) { stockEl.textContent = 'Hết hàng'; stockEl.classList.add('is-out'); }
        else if (managed && stock > 0 && stock <= 5) { stockEl.textContent = 'Chỉ còn ' + stock + ' sản phẩm'; stockEl.classList.add('is-low'); }
        else { stockEl.textContent = 'Còn hàng'; }
      }
      [addBtn, buyBtn].forEach(function (b) { if (b) { b.disabled = !avail; b.classList.toggle('is-disabled', !avail); } });
      if (addBtn) { var t = addBtn.querySelector('[data-text]'); if (t) t.textContent = avail ? 'Thêm vào giỏ' : 'Hết hàng'; }
      if (qty) {
        if (managed && deny && stock > 0) { qty.max = stock; if (+qty.value > stock) qty.value = stock; } else qty.removeAttribute('max');
      }
      var imgId = o.getAttribute('data-image-id');
      if (imgId) slides.forEach(function (s, n) { if (s.getAttribute('data-image-id') === imgId) show(n); });
    }
    if (sel) { sel.addEventListener('change', applyVariant); applyVariant(); }

    // Số lượng +/-
    if (qty) {
      var minus = $('[data-qty-minus]', root), plus = $('[data-qty-plus]', root);
      function clamp(v) { v = parseInt(v, 10) || 1; var m = parseInt(qty.max, 10); if (m && v > m) v = m; return Math.max(1, v); }
      if (minus) minus.addEventListener('click', function () { qty.value = clamp(+qty.value - 1); });
      if (plus) plus.addEventListener('click', function () { qty.value = clamp(+qty.value + 1); });
      qty.addEventListener('change', function () { qty.value = clamp(qty.value); });
    }

    // Chuẩn hoá video trong mô tả: bọc mọi iframe/video vào khung 16:9 cùng cỡ
    $all('.pd-desc iframe, .pd-desc video', root).forEach(function (v) {
      if (v.closest('.pd-video')) return;
      var top = v, desc = v.closest('.pd-desc');
      while (top.parentNode && top.parentNode !== desc && top.parentNode.children.length === 1 && !(top.parentNode.textContent || '').trim()) top = top.parentNode;
      var wrap = document.createElement('div'); wrap.className = 'pd-video';
      top.parentNode.insertBefore(wrap, top);
      v.removeAttribute('width'); v.removeAttribute('height'); v.removeAttribute('style');
      wrap.appendChild(v);
      if (top !== v && top.parentNode) top.parentNode.removeChild(top);
    });

    // Tabs
    var tabBtns = $all('[data-tab]', root), panels = $all('.pd-tab-panel', root);
    function openTab(name) {
      tabBtns.forEach(function (b) { b.classList.toggle('is-active', b.getAttribute('data-tab') === name); });
      panels.forEach(function (p) { p.classList.toggle('is-active', p.id === 'tab-' + name); });
    }
    tabBtns.forEach(function (b) { b.addEventListener('click', function () { openTab(b.getAttribute('data-tab')); }); });
    if (/review/i.test(location.hash)) openTab('reviews');
    $all('[data-open-tab]', root).forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); openTab(a.getAttribute('data-open-tab')); var t = $('.pd-tabs', root); if (t) t.scrollIntoView({ behavior: 'smooth' }); });
    });
  }

  /* ---------- Điền sẵn form từ URL (?product=...&subject=...) ---------- */
  function prefill() {
    var qs = new URLSearchParams(location.search);
    var product = qs.get('product'), subject = qs.get('subject');
    $all('[data-prefill="product"]').forEach(function (el) {
      if (!product) return;
      if (el.tagName === 'SELECT') {
        Array.prototype.some.call(el.options, function (o) { if (o.getAttribute('data-handle') === product || o.value === product) { o.selected = true; return true; } });
      } else el.value = product;
    });
    $all('[data-prefill="subject"]').forEach(function (el) { if (subject) el.value = subject; });
    $all('input[type=date][data-min-today]').forEach(function (el) {
      var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      el.min = d.toISOString().slice(0, 10);
    });
  }

  /* ---------- Bảo dưỡng: tính ngày bảo dưỡng kế tiếp ---------- */
  function initMaintenance() {
    var sel = $('#mt-instrument'), date = $('#mt-last'), out = $('#mt-next');
    if (!sel || !date || !out) return;
    function calc() {
      if (!date.value) { out.textContent = ''; return; }
      var months = parseInt(sel.options[sel.selectedIndex].getAttribute('data-months'), 10) || 6;
      var d = new Date(date.value); d.setMonth(d.getMonth() + months);
      out.textContent = 'Nên bảo dưỡng lần tới vào khoảng: ' + d.toLocaleDateString('vi-VN') + ' (chu kỳ ' + months + ' tháng).';
    }
    sel.addEventListener('change', calc); date.addEventListener('change', calc);
  }

  /* ---------- khởi động ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    buildCompareBar();
    refreshState();
    initProduct();
    initMaintenance();
    prefill();
  });
  document.addEventListener('nc:change', function () { refreshState(); });
  window.addEventListener('storage', function () { refreshState(); document.dispatchEvent(new CustomEvent('nc:change')); });
})();
