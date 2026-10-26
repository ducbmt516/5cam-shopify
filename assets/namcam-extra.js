/* ==========================================================
   NĂM CAM — namcam-extra.js
   1. Chuông khuyến mãi   2. Tìm nhạc cụ qua giai điệu / bài hát
   3. Trợ lý AI chọn đàn  4. Mẫu âm thanh sản phẩm
   5. Trang so sánh (chênh lệch giá + nghe mp3 + so sánh nốt nhạc)
   6. Trang yêu thích     7. Toast
   Cần: namcam.js (nạp trước). window.NC.aiEndpoint (tuỳ chọn) = URL proxy AI.
   ========================================================== */
(function () {
  'use strict';

  var CFG = window.NC || {};
  var WISH = 'nc_wishlist', CMP = 'nc_compare';

  /* ================= tiện ích ================= */
  function $(s, c) { return (c || document).querySelector(s); }
  function $all(s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); }
  function read(k) { try { var v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function stripHtml(h) { var d = document.createElement('div'); d.innerHTML = h || ''; return (d.textContent || '').replace(/\s+/g, ' ').trim(); }
  function fmtVND(n) {
    try { return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: CFG.currency || 'VND', maximumFractionDigits: 0 }).format(n); }
    catch (e) { return Math.round(n).toLocaleString('vi-VN') + ' ₫'; }
  }
  function fetchJSON(u) { return fetch(u, { headers: { Accept: 'application/json' } }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  function img(src, size) { return src ? src.replace(/(\.(jpg|jpeg|png|gif|webp))(\?|$)/i, '_' + size + '$1$3') : ''; }
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function fire(name) { document.dispatchEvent(new CustomEvent(name)); }

  /* ----- toast ----- */
  var toastTimer;
  function toast(html) {
    var t = $('#nc-toast');
    if (!t) { t = document.createElement('div'); t.id = 'nc-toast'; document.body.appendChild(t); }
    t.innerHTML = html; t.classList.add('is-show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('is-show'); }, 3800);
  }

  /* ----- danh sách sản phẩm của cửa hàng (cache 10 phút) ----- */
  var productsPromise;
  function getProducts() {
    if (productsPromise) return productsPromise;
    try {
      var c = JSON.parse(sessionStorage.getItem('nc_products_v2') || 'null');
      if (c && Date.now() - c.t < 600000) { productsPromise = Promise.resolve(c.p); return productsPromise; }
    } catch (e) {}
    productsPromise = fetchJSON('/products.json?limit=250').then(function (d) {
      var list = d.products || [];
      try { sessionStorage.setItem('nc_products_v2', JSON.stringify({ t: Date.now(), p: list })); } catch (e) {}
      return list;
    }).catch(function () { return []; });
    return productsPromise;
  }
  function minPrice(p) { return Math.min.apply(null, p.variants.map(function (v) { return parseFloat(v.price) || 0; })); }
  function saleInfo(p) {
    var best = null;
    p.variants.forEach(function (v) {
      var price = parseFloat(v.price) || 0, cmp = parseFloat(v.compare_at_price) || 0;
      if (cmp > price && price > 0) { var off = Math.round((cmp - price) / cmp * 100); if (!best || off > best.off) best = { off: off, price: price, was: cmp }; }
    });
    return best;
  }
  function isAvail(p) { return p.variants.some(function (v) { return v.available; }); }

  /* ----- phân loại nhạc cụ ----- */
  var TYPE_LABEL = { guitar: 'Guitar', piano: 'Piano / Keyboard', drum: 'Trống', uke: 'Ukulele / Violin' };
  var KW = {
    guitar: ['guitar', 'ghi-ta', 'ghita', 'acoustic', 'classic'],
    piano: ['piano', 'keyboard', 'organ'],
    drum: ['trong', 'drum', 'cymbal', 'tom'],
    uke: ['ukulele', 'violin', 'viola', 'cello']
  };
  function hay(p) { return norm(p.title + ' ' + (p.product_type || '') + ' ' + (p.tags || []).join(' ') + ' ' + p.handle + ' ' + (p.vendor || '')); }
  function matchesType(p, t) { var h = hay(p); return KW[t].some(function (k) { return h.indexOf(k) > -1; }); }
  function productsForTypes(list, types, limit) {
    var out = [];
    (list || []).forEach(function (p) {
      if (!isAvail(p)) return;
      var rank = types.findIndex(function (t) { return matchesType(p, t); });
      if (rank > -1) out.push({ p: p, rank: rank });
    });
    out.sort(function (a, b) { return a.rank - b.rank; });
    return out.slice(0, limit || 3).map(function (o) { return o.p; });
  }
  function productCardHTML(p, note) {
    var im = p.images && p.images[0] ? img(p.images[0].src, '200x200') : '';
    var sale = saleInfo(p);
    return '<div class="ai-result"><img src="' + esc(im) + '" alt=""><div><a href="/products/' + esc(p.handle) + '">' + esc(p.title) + '</a>' +
      '<p>' + fmtVND(minPrice(p)) + (sale ? ' <span class="nc-bp-off">-' + sale.off + '%</span>' : '') + (note ? ' — ' + esc(note) : '') + '</p></div></div>';
  }

  /* ----- gọi proxy AI (tuỳ chọn) ----- */
  function callAI(payload) {
    if (!CFG.aiEndpoint) return Promise.reject(new Error('no-endpoint'));
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    return fetch(CFG.aiEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctl ? ctl.signal : undefined })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error(r.status); return r.json(); });
  }

  /* ================= 1. CHUÔNG KHUYẾN MÃI ================= */
  function initBell() {
    var bell = $('#nc-bell'); if (!bell) return;
    var badge = $('.nc-bell-badge', bell), pop = $('#nc-bell-pop'), panel = $('#nc-bell-panel');
    var READ = 'nc_notif_read', POPSIG = 'nc_pop_sig';

    function sig(p) { var s = saleInfo(p); return p.handle + ':' + s.price + ':' + s.was; }
    function markRead(ids) {
      var r = read(READ); ids.forEach(function (id) { if (r.indexOf(id) === -1) r.push(id); });
      write(READ, r.slice(-300));
    }
    function open(v) { panel.hidden = !v; bell.setAttribute('aria-expanded', v ? 'true' : 'false'); if (v) pop.hidden = true; }
    bell.addEventListener('click', function (e) { e.stopPropagation(); open(panel.hidden); });
    document.addEventListener('click', function (e) { if (!panel.hidden && !e.target.closest('.nc-bell-wrap')) open(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') open(false); });

    // Số trên chuông vẽ bằng SVG: mỗi chữ số có khung bao khít nét vẽ nên luôn nằm CHÍNH GIỮA vòng tròn
    var GLYPH = {
      '0': ['M3 0C.6 0 0 2.5 0 5S.6 10 3 10 6 7.5 6 5 5.4 0 3 0Z', 0, 6],
      '1': ['M1 2.2L3.2 0V10', 1, 3.2],
      '2': ['M.3 2.2C.8.4 2 0 3 0c1.8 0 2.8 1.2 2.8 2.7 0 1.3-.8 2.3-2 3.3L.2 10H6', 0.2, 5.8],
      '3': ['M.5 1C1.2.3 2 0 3 0c1.7 0 2.6 1 2.6 2.4 0 1.5-1.1 2.2-2.8 2.3C4.7 4.8 6 5.6 6 7.5 6 9 4.8 10 3 10c-1.3 0-2.3-.5-3-1.4', 0, 6],
      '4': ['M4.5 10V0L0 7H6', 0, 6],
      '5': ['M5.6 0H1.2L.6 4.6C1.2 4.1 2 3.8 3 3.8c1.9 0 3 1.2 3 3.1C6 8.8 4.8 10 3 10c-1.3 0-2.3-.5-3-1.4', 0, 6],
      '6': ['M5.2 1.2C4.6.4 3.8 0 3 0 1.2 0 0 2 0 5.8 0 8.6 1.2 10 3 10c1.8 0 3-1.3 3-3.2 0-1.9-1.1-3.1-3-3.1-1.2 0-2.3.7-2.8 1.8', 0, 6],
      '7': ['M0 0H6L2.2 10', 0, 6],
      '8': ['M3 0C1.4 0 .5 1 .5 2.3c0 1.4 1 2.3 2.5 2.6 1.6.3 2.8 1.1 2.8 2.7C5.8 9 4.7 10 3 10S.2 9 .2 7.6C.2 6 1.4 5.2 3 4.9c1.5-.3 2.5-1.2 2.5-2.6C5.5 1 4.6 0 3 0Z', 0.2, 5.8],
      '9': ['M.8 8.8C1.4 9.6 2.2 10 3 10c1.8 0 3-2 3-5.8C6 1.4 4.8 0 3 0 1.2 0 0 1.3 0 3.2c0 1.9 1.1 3.1 3 3.1 1.2 0 2.3-.7 2.8-1.8', 0, 6],
      '+': ['M3 2.5V7.5M.5 5H5.5', 0.5, 5.5]
    };
    function setBadge(text) {
      var x = 0, minX = null, maxX = null, parts = '';
      String(text).split('').forEach(function (ch) {
        var g = GLYPH[ch]; if (!g) return;
        parts += '<path transform="translate(' + x + ' 0)" d="' + g[0] + '"/>';
        if (minX === null) minX = x + g[1];
        maxX = x + g[2];
        x += 7.6;
      });
      if (minX === null) { badge.innerHTML = ''; return; }
      var w = maxX - minX, pad = 1.6, vbw = w + pad * 2;
      badge.setAttribute('aria-label', text);
      badge.innerHTML = '<svg viewBox="' + (minX - pad) + ' -1 ' + vbw + ' 12" width="' + (vbw * 0.75).toFixed(1) + '" height="9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + parts + '</svg>';
    }
    var cache = [];
    function render(list, allowPop) {
      cache = list;
      var wish = read(WISH), readIds = read(READ);
      var sales = list.filter(function (p) { return isAvail(p) && saleInfo(p); });
      var unread = sales.filter(function (p) { return readIds.indexOf(sig(p)) === -1; });
      var wishUnread = unread.filter(function (p) { return wish.indexOf(p.handle) > -1; });
      var others = unread.filter(function (p) { return wish.indexOf(p.handle) === -1; }).slice(0, 6);

      badge.hidden = unread.length === 0;
      setBadge(unread.length > 9 ? '9+' : String(unread.length));
      bell.classList.toggle('has-sale', unread.length > 0);

      function item(p) {
        var s = saleInfo(p), im = p.images && p.images[0] ? img(p.images[0].src, '120x120') : '';
        return '<a class="nc-bp-item" data-sig="' + esc(sig(p)) + '" href="/products/' + esc(p.handle) + '"><img src="' + esc(im) + '" alt="">' +
          '<span><span class="nc-bp-name">' + esc(p.title) + '</span><span class="nc-bp-price">' + fmtVND(s.price) + '<s>' + fmtVND(s.was) + '</s><span class="nc-bp-off">-' + s.off + '%</span></span></span></a>';
      }
      var html = '<div class="nc-bp-head">🔔 Thông báo khuyến mãi</div>';
      if (!unread.length) html += '<div class="nc-bp-empty">' + (sales.length ? 'Bạn đã xem hết thông báo.' : 'Hiện chưa có khuyến mãi mới.') + '<br>Có ưu đãi mới mình sẽ báo ngay!</div>';
      if (wishUnread.length) html += '<div class="nc-bp-sec is-wish">♥ Món bạn yêu thích đang giảm giá</div>' + wishUnread.map(item).join('');
      if (others.length) html += '<div class="nc-bp-sec">Khuyến mãi đang diễn ra</div>' + others.map(item).join('');
      if (unread.length) html += '<button type="button" class="nc-bp-readall">Đánh dấu đã đọc tất cả</button>';
      html += '<a class="nc-bp-foot" href="/collections/khuyen-mai">Xem tất cả khuyến mãi →</a>';
      panel.innerHTML = html;

      // Bong bóng KHUYẾN MÃI: chỉ hiện khi có thông báo MỚI chưa đọc (không lặp lại mỗi lần tải trang)
      if (!allowPop) return;
      if (!unread.length) { pop.hidden = true; return; }
      var signature = unread.map(sig).sort().join('|') + '#' + wishUnread.length, stored = '';
      try { stored = localStorage.getItem(POPSIG) || ''; } catch (e) {}
      if (signature === stored) { pop.hidden = true; return; }
      pop.className = 'nc-bell-pop' + (wishUnread.length ? ' is-wish' : '');
      pop.innerHTML = '<button type="button" class="nc-pop-x" aria-label="Đóng">&times;</button>' +
        '<span class="nc-pop-title">KHUYẾN MÃI</span>' +
        '<span class="nc-pop-sub">' + (wishUnread.length ? '♥ ' + wishUnread.length + ' món bạn thích đang giảm giá!' : '🎁 ' + unread.length + ' nhạc cụ đang ưu đãi') + '</span>';
      pop.hidden = !panel.hidden;
      try { localStorage.setItem(POPSIG, signature); } catch (e) {}
      clearTimeout(render.t); render.t = setTimeout(function () { pop.hidden = true; }, 10000);
    }
    pop.addEventListener('click', function (e) { if (e.target.closest('.nc-pop-x')) { pop.hidden = true; return; } open(true); });

    // Bấm vào một thông báo -> đánh dấu đã đọc (mất khỏi danh sách); bấm "đã đọc tất cả" -> xoá hết
    panel.addEventListener('click', function (e) {
      var it = e.target.closest('.nc-bp-item');
      if (it) { markRead([it.getAttribute('data-sig')]); return; }
      if (e.target.closest('.nc-bp-readall')) {
        markRead($all('.nc-bp-item', panel).map(function (a) { return a.getAttribute('data-sig'); }));
        render(cache, false);
      }
    });

    getProducts().then(function (list) {
      render(list, true);
      document.addEventListener('nc:change', function () { render(list, false); });
      window.addEventListener('storage', function () { render(list, false); });
    });
  }

  /* ================= 2. TÌM NHẠC CỤ QUA GIAI ĐIỆU / BÀI HÁT ================= */
  var NOTE_VN = ['Đô', 'Đô♯', 'Rê', 'Rê♯', 'Mi', 'Pha', 'Pha♯', 'Son', 'Son♯', 'La', 'La♯', 'Si'];
  function noteName(m) { return NOTE_VN[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
  function pcName(pc) { return NOTE_VN[pc]; }

  // Thư viện bài hát: nhạc cụ gợi ý (cách phối phổ biến) + nốt nhạc (MIDI, Đô giữa = 60) cho các giai điệu dân gian / cổ điển
  var SONGS = [
    { n: ['twinkle twinkle little star', 'twinkle twinkle', 'lap lanh ngoi sao nho', 'ngoi sao nho', 'abc song', 'ba ba black sheep'], t: 'Twinkle Twinkle Little Star', g: 'Thiếu nhi', i: ['piano', 'uke', 'guitar'], w: 'Giai điệu ngắn, dễ nhớ — rất hợp để người mới tập.', m: [60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60] },
    { n: ['ode to joy', 'ode an die freude', 'beethoven 9', 'an die freude'], t: 'Ode to Joy (Beethoven)', g: 'Cổ điển', i: ['piano', 'uke', 'guitar'], w: 'Giai điệu đi theo bậc, dễ chơi trên piano và các đàn dây.', m: [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62] },
    { n: ['happy birthday', 'chuc mung sinh nhat', 'happy birthday to you'], t: 'Happy Birthday', g: 'Thiếu nhi / Lễ', i: ['guitar', 'uke', 'piano'], w: 'Bài đệm hát quen thuộc, guitar và ukulele đệm rất tiện.', m: [67, 67, 69, 67, 72, 71, 67, 67, 69, 67, 74, 72] },
    { n: ['jingle bells'], t: 'Jingle Bells', g: 'Giáng sinh', i: ['piano', 'guitar', 'uke'], w: 'Nhịp vui tươi, hợp đàn dây và keyboard.', m: [64, 64, 64, 64, 64, 64, 64, 67, 60, 62, 64, 65, 65, 65, 65, 65, 64, 64, 64, 64, 64, 62, 62, 64, 62, 67] },
    { n: ['fur elise', 'für elise', 'beethoven fur elise'], t: 'Für Elise (Beethoven)', g: 'Cổ điển', i: ['piano', 'guitar'], w: 'Tác phẩm viết cho piano, cần phím đàn có độ nhạy tốt.', m: [76, 75, 76, 75, 76, 71, 74, 72, 69, 60, 64, 69, 71] },
    { n: ['canon in d', 'canon', 'pachelbel canon'], t: 'Canon in D (Pachelbel)', g: 'Cổ điển', i: ['uke', 'piano', 'guitar'], w: 'Hợp nhất với violin (phần giai điệu) và piano / guitar (phần nền).', m: [78, 76, 74, 73, 71, 69, 71, 73] },
    { n: ['amazing grace'], t: 'Amazing Grace', g: 'Thánh ca / Dân gian', i: ['guitar', 'piano', 'uke'], w: 'Giai điệu chậm, hợp guitar đệm hát.', m: [55, 60, 64, 60, 64, 62, 60, 57, 55] },
    { n: ['mary had a little lamb', 'mary lamb'], t: 'Mary Had a Little Lamb', g: 'Thiếu nhi', i: ['piano', 'uke', 'guitar'], w: 'Chỉ dùng vài nốt liền bậc, rất hợp để học nhập môn.', m: [64, 62, 60, 62, 64, 64, 64, 62, 62, 62, 64, 67, 67] },
    { n: ['let it be'], t: 'Let It Be', g: 'Pop / Rock', i: ['piano', 'guitar', 'drum'], w: 'Bản ballad nền piano, thêm guitar và trống khi muốn hoà tấu.' },
    { n: ['imagine', 'imagine john lennon'], t: 'Imagine', g: 'Pop', i: ['piano', 'guitar'], w: 'Nổi tiếng với phần piano nhẹ nhàng.' },
    { n: ['hotel california'], t: 'Hotel California', g: 'Rock', i: ['guitar', 'drum'], w: 'Đặc trưng bởi guitar solo; phối thêm trống cho đủ chất rock.' },
    { n: ['smoke on the water'], t: 'Smoke on the Water', g: 'Rock', i: ['guitar', 'drum'], w: 'Riff guitar huyền thoại — bài nhập môn guitar điện.' },
    { n: ['bohemian rhapsody'], t: 'Bohemian Rhapsody', g: 'Rock', i: ['piano', 'guitar', 'drum'], w: 'Cần piano, guitar điện và trống để tái hiện đủ các đoạn.' },
    { n: ['somewhere over the rainbow', 'over the rainbow'], t: 'Somewhere Over the Rainbow', g: 'Acoustic', i: ['uke', 'guitar', 'piano'], w: 'Bản ukulele rất nổi tiếng, âm sắc ấm và nhẹ.' },
    { n: ['i m yours', 'im yours', 'i am yours'], t: "I'm Yours", g: 'Pop / Acoustic', i: ['uke', 'guitar'], w: 'Nhịp vui, hợp đệm ukulele và guitar.' },
    { n: ['yesterday beatles', 'yesterday'], t: 'Yesterday', g: 'Pop', i: ['guitar', 'piano', 'uke'], w: 'Guitar acoustic cho cảm giác nguyên bản nhất.' },
    { n: ['nothing else matters'], t: 'Nothing Else Matters', g: 'Rock ballad', i: ['guitar', 'drum', 'piano'], w: 'Mở đầu bằng guitar fingerstyle, sau đó thêm trống.' },
    { n: ['moonlight sonata', 'ao nguyet quang'], t: 'Moonlight Sonata (Beethoven)', g: 'Cổ điển', i: ['piano'], w: 'Viết riêng cho piano.' },
    { n: ['clair de lune'], t: 'Clair de Lune (Debussy)', g: 'Cổ điển', i: ['piano', 'guitar'], w: 'Piano là lựa chọn gần nguyên bản nhất.' },
    { n: ['perfect ed sheeran', 'perfect'], t: 'Perfect (Ed Sheeran)', g: 'Pop / Ballad', i: ['guitar', 'uke', 'piano'], w: 'Bài đệm hát rất phổ biến trên guitar và ukulele.' },
    { n: ['noi vong tay lon'], t: 'Nối vòng tay lớn', g: 'Nhạc Việt', i: ['guitar', 'piano'], w: 'Bài hát tập thể, guitar đệm hát rất hợp.' },
    { n: ['em cua ngay hom qua'], t: 'Em của ngày hôm qua', g: 'Nhạc trẻ Việt', i: ['guitar', 'piano'], w: 'Dễ đệm hát bằng guitar hoặc piano.' },
    { n: ['noi nay co anh'], t: 'Nơi này có anh', g: 'Nhạc trẻ Việt', i: ['guitar', 'piano', 'uke'], w: 'Giai điệu ballad dễ chơi trên guitar, piano, ukulele.' }
  ];
  var GENRES = [
    { k: 'Ballad / Trữ tình', i: ['guitar', 'piano'] }, { k: 'Pop / Nhạc trẻ', i: ['guitar', 'piano', 'uke'] },
    { k: 'Rock / Metal', i: ['guitar', 'drum'] }, { k: 'Cổ điển', i: ['piano', 'uke'] },
    { k: 'Jazz', i: ['piano', 'drum', 'guitar'] }, { k: 'Thiếu nhi', i: ['piano', 'uke'] },
    { k: 'Dân ca / Acoustic', i: ['guitar', 'uke'] }, { k: 'EDM / Nhạc điện tử', i: ['piano', 'drum'] }
  ];
  var GENRE_WORDS = [
    [['ballad', 'tru tinh', 'buon'], 0], [['pop', 'nhac tre', 'vpop', 'kpop'], 1], [['rock', 'metal', 'punk'], 2],
    [['co dien', 'classical', 'beethoven', 'mozart', 'chopin', 'bach'], 3], [['jazz', 'blues'], 4], [['thieu nhi', 'tre em'], 5],
    [['dan ca', 'acoustic', 'hawaii', 'folk'], 6], [['edm', 'dien tu', 'remix'], 7]
  ];

  function findSong(q) {
    var nq = norm(q); if (!nq) return null;
    var best = null;
    SONGS.forEach(function (s) {
      s.n.forEach(function (name) {
        var nn = norm(name);
        if (nq === nn || (nq.length >= 4 && (nn.indexOf(nq) > -1 || nq.indexOf(nn) > -1))) {
          var score = nq === nn ? 2 : 1;
          if (!best || score > best.score) best = { s: s, score: score };
        }
      });
    });
    return best ? best.s : null;
  }
  function genreFromText(q) {
    var nq = norm(q), hit = null;
    GENRE_WORDS.forEach(function (g) { g[0].forEach(function (w) { if (!hit && nq.indexOf(w) > -1) hit = GENRES[g[1]]; }); });
    return hit;
  }
  function instList(arr) { return arr.map(function (t) { return TYPE_LABEL[t]; }).join(', '); }

  // --- modal ---
  var modal, modalBody;
  function ensureModal() {
    if (modal) return;
    modal = document.createElement('div'); modal.id = 'nc-modal';
    modal.innerHTML = '<div class="nc-modal-card" role="dialog" aria-modal="true"><button type="button" class="nc-modal-x" aria-label="Đóng">&times;</button><div id="nc-modal-body"></div></div>';
    document.body.appendChild(modal);
    modalBody = $('#nc-modal-body', modal);
    modal.addEventListener('click', function (e) { if (e.target === modal || e.target.closest('.nc-modal-x')) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  }
  function openModal(html) { ensureModal(); modalBody.innerHTML = html; modal.classList.add('is-open'); }
  function closeModal() { if (modal) modal.classList.remove('is-open'); }

  function showResult(title, sub, answerHTML, types) {
    openModal('<h2>' + esc(title) + '</h2><p class="nc-sub">' + esc(sub || '') + '</p>' + answerHTML + '<div id="nc-mod-products"><div class="nc-loading">Đang tìm sản phẩm phù hợp trong cửa hàng…</div></div>');
    getProducts().then(function (list) {
      var found = productsForTypes(list, types, 3);
      var host = $('#nc-mod-products'); if (!host) return;
      host.innerHTML = found.length
        ? '<h3 style="margin:14px 0 8px;font-size:16px">Nhạc cụ trong cửa hàng phù hợp với bạn</h3>' + found.map(function (p) { return productCardHTML(p); }).join('')
        : '<p class="nc-sub">Hiện cửa hàng chưa có sản phẩm còn hàng thuộc nhóm này. <a href="/pages/ho-tro">Nhắn tư vấn</a> nhé.</p>';
    });
  }

  function searchSong(q) {
    q = (q || '').trim();
    if (!q) { openModal('<h2>Tìm theo bài hát</h2><p class="nc-sub">Hãy nhập tên bài hát hoặc thể loại bạn thích.</p>'); return; }
    var s = findSong(q);
    if (s) {
      showResult('«' + s.t + '»', 'Thể loại: ' + s.g,
        '<div class="nc-answer">Bài này hợp nhất với: <b>' + esc(instList(s.i)) + '</b>.<br>' + esc(s.w) + '</div>' +
        '<p class="nc-sub">Gợi ý dựa trên cách phối phổ biến của bài, chỉ mang tính tham khảo.</p>', s.i);
      return;
    }
    var g = genreFromText(q);
    if (g) {
      showResult('«' + q + '»', 'Mình đoán thể loại: ' + g.k,
        '<div class="nc-answer">Mình chưa có bài này trong thư viện, nhưng với thể loại <b>' + esc(g.k) + '</b> bạn nên thử: <b>' + esc(instList(g.i)) + '</b>.</div>', g.i);
      return;
    }
    // chưa biết bài: hỏi AI (nếu đã cấu hình) hoặc cho chọn thể loại
    openModal('<h2>«' + esc(q) + '»</h2><div class="nc-loading">Đang tìm…</div>');
    callAI({ mode: 'song', query: q }).then(function (r) {
      var types = (r.types || []).filter(function (t) { return TYPE_LABEL[t]; });
      if (!types.length) throw new Error('empty');
      showResult('«' + q + '»', 'Gợi ý từ trợ lý AI',
        '<div class="nc-answer">' + esc(r.text || '') + ' <span class="ai-tag">AI</span></div><p class="nc-sub">Nhạc cụ gợi ý: ' + esc(instList(types)) + '</p>', types);
    }).catch(function () {
      openModal('<h2>«' + esc(q) + '»</h2>' +
        '<div class="nc-answer">Mình chưa nhận ra bài này. Bạn hãy chọn thể loại gần nhất bên dưới nhé.</div>' +
        '<div class="nc-chips">' + GENRES.map(function (x, i) { return '<button type="button" data-genre="' + i + '">' + esc(x.k) + '</button>'; }).join('') +
        '</div>');
    });
  }

  /* ---- Tiện ích giai điệu dùng chung ---- */
  // Phân loại link: file âm thanh trực tiếp (phát ngay) hay link ngoài (YouTube, Spotify... mở tab mới)
  function classifyLink(u) {
    u = (u || '').trim();
    if (!/^https?:\/\//i.test(u)) return {};
    return /\.(mp3|m4a|wav|ogg|aac)(\?|#|$)/i.test(u) ? { a: u } : { x: u };
  }
  // Đọc nốt chữ: "Đô Đô Son Son La La Son" hoặc "C C G G A A G" -> MIDI
  function parseNotes(text) {
    var base = { do: 0, c: 0, re: 2, d: 2, mi: 4, e: 4, pha: 5, fa: 5, f: 5, son: 7, sol: 7, g: 7, la: 9, a: 9, si: 11, b: 11 };
    var out = [];
    String(text || '').split(/[\s,\-–]+/).forEach(function (tok) {
      var m = norm(tok).replace(/\s/g, '').match(/^(do|re|mi|pha|fa|son|sol|la|si|[a-g])(#?)(\d?)$/);
      if (!m) { var raw = String(tok).toLowerCase().match(/^([a-g])(#?)(\d?)$/); if (!raw) return; m = raw; }
      var pc = base[m[1]]; if (pc == null) return;
      out.push(12 * ((m[3] ? +m[3] : 4) + 1) + pc + (m[2] ? 1 : 0));
    });
    return out;
  }

  var MELODY_URL = '/pages/tim-nhac-cu';
  function initMelody() {
    // Chọn thể loại gợi ý trong cửa sổ kết quả
    document.addEventListener('click', function (e) {
      var g = e.target.closest('[data-genre]');
      if (g) { var x = GENRES[+g.getAttribute('data-genre')]; showResult(x.k, 'Gợi ý theo thể loại', '<div class="nc-answer">Với thể loại <b>' + esc(x.k) + '</b>, bạn nên thử: <b>' + esc(instList(x.i)) + '</b>.</div>', x.i); }
    });
  }

  /* ---- Nhận dạng nhạc cụ từ file âm thanh bằng AST / AudioSet ----
     Mô hình MIT/ast-finetuned-audioset (BSD-3-Clause), bản ONNX Xenova cho Transformers.js. */
  var NI_MODEL = 'Xenova/ast-finetuned-audioset-10-10-0.4593';
  var NI_LABELS = {
    'guitar': ['Guitar', 'guitar'], 'acoustic guitar': ['Guitar acoustic', 'guitar'],
    'electric guitar': ['Guitar điện', 'guitar'], 'bass guitar': ['Bass guitar', 'guitar'],
    'electric bass': ['Bass điện', 'guitar'], 'bass': ['Bass', 'guitar'],
    'piano': ['Piano', 'piano'], 'electric piano': ['Piano điện', 'piano'],
    'keyboard musical': ['Keyboard', 'piano'], 'organ': ['Organ', 'piano'],
    'synthesizer': ['Synthesizer', 'piano'], 'sampler': ['Sampler', 'piano'],
    'drum': ['Trống', 'drum'], 'drums': ['Trống bộ', 'drum'], 'drum kit': ['Bộ trống', 'drum'],
    'drum machine': ['Trống điện tử / Drum machine', 'drum'], 'electronic drums': ['Trống điện tử', 'drum'],
    'electronic drum kit': ['Bộ trống điện tử', 'drum'], 'snare drum': ['Snare drum', 'drum'],
    'bass drum': ['Bass drum', 'drum'], 'kick drum': ['Kick drum', 'drum'],
    'cymbal': ['Cymbal', 'drum'], 'hi hat': ['Hi-hat', 'drum'], 'percussion': ['Bộ gõ', 'drum'],
    'ukulele': ['Ukulele', 'uke'], 'violin fiddle': ['Violin', 'uke'], 'viola': ['Viola', 'uke'],
    'cello': ['Cello', 'uke'], 'double bass': ['Double bass', 'uke'],
    'flute': ['Flute', 'uke'], 'saxophone': ['Saxophone', 'uke'], 'trumpet': ['Trumpet', 'uke'],
    'trombone': ['Trombone', 'uke'], 'clarinet': ['Clarinet', 'uke'], 'harmonica': ['Harmonica', 'uke'],
    'accordion': ['Accordion', 'uke'], 'banjo': ['Banjo', 'guitar'], 'mandolin': ['Mandolin', 'guitar'],
    'harp': ['Harp', 'uke'], 'marimba xylophone': ['Marimba / Xylophone', 'piano'],
    'glockenspiel': ['Glockenspiel', 'piano'], 'vibraphone': ['Vibraphone', 'piano']
  };
  function niLabelMeta(label) {
    var key = norm(label);
    if (NI_LABELS[key]) return NI_LABELS[key];
    // AudioSet có nhiều biến thể nhãn số ít/số nhiều hoặc tên mở rộng.
    if (/\b(acoustic|electric)? ?guitar\b/.test(key)) return [/electric/.test(key) ? 'Guitar điện' : (/acoustic/.test(key) ? 'Guitar acoustic' : 'Guitar'), 'guitar'];
    if (/\b(bass guitar|electric bass|bass)\b/.test(key)) return ['Bass guitar', 'guitar'];
    if (/\b(drum machine|electronic drum|drum kit|drums?|snare drum|bass drum|kick drum|cymbal|hi hat|percussion)\b/.test(key)) {
      if (/drum machine/.test(key)) return ['Trống điện tử / Drum machine', 'drum'];
      if (/electronic drum/.test(key)) return ['Trống điện tử', 'drum'];
      if (/percussion/.test(key)) return ['Bộ gõ', 'drum'];
      return ['Bộ trống / bộ gõ', 'drum'];
    }
    if (/\b(synthesizer|synthesiser|keyboard|electric piano|piano|organ)\b/.test(key)) return ['Keyboard / Synthesizer', 'piano'];
    if (/\b(ukulele|violin|viola|cello|double bass|flute|saxophone|trumpet|trombone|clarinet|harmonica|accordion|harp)\b/.test(key)) return [label, 'uke'];
    return null;
  }
  /* Các nguồn dự phòng: thư viện (Transformers.js) và nơi chứa mô hình. Thử lần lượt, nguồn nào truy cập được thì dùng. */
  var NI_LIBS = [
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/dist/transformers.min.js',
    'https://unpkg.com/@huggingface/transformers@3.7.2/dist/transformers.min.js',
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2'
  ];
  var NI_HOSTS = ['https://huggingface.co/', 'https://hf-mirror.com/'];

  /* Mã chạy trong Web Worker (được chuyển thành chuỗi nên KHÔNG dùng biến bên ngoài).
     Báo lỗi có mã: lib = không nạp được thư viện, model = không tải được mô hình, run = lỗi khi phân tích. */
  function niWorkerMain() {
    var lib = null, classifier = null;
    function say(m) { self.postMessage(m); }
    function msg(e) { return e && e.message ? e.message : String(e); }
    function fail(code, text) { var er = new Error(text); er.code = code; return er; }

    function withStall(start, stallMs) {
      return new Promise(function (resolve, reject) {
        var last = Date.now(), finished = false;
        var timer = setInterval(function () {
          if (!finished && Date.now() - last > stallMs) { finished = true; clearInterval(timer); reject(new Error('không có phản hồi sau ' + Math.round(stallMs / 1000) + ' giây')); }
        }, 500);
        start(function () { last = Date.now(); }).then(
          function (v) { if (!finished) { finished = true; clearInterval(timer); resolve(v); } },
          function (e) { if (!finished) { finished = true; clearInterval(timer); reject(e); } }
        );
      });
    }

    async function loadLib(urls, notes) {
      if (lib) return;
      for (var i = 0; i < urls.length; i++) {
        try {
          var m = await import(urls[i]);
          if (m && typeof m.pipeline === 'function') { lib = m; return; }
          notes.push('thư viện ' + urls[i] + ': nạp được nhưng thiếu hàm pipeline');
        } catch (e) { notes.push('thư viện ' + urls[i] + ': ' + msg(e)); }
      }
      throw fail('lib', 'Không nạp được thư viện AI');
    }

    async function loadModel(data, notes) {
      if (classifier) return;
      var env = lib.env;
      try { env.allowLocalModels = false; } catch (e) {}
      try { env.backends.onnx.wasm.numThreads = 1; } catch (e) {}
      for (var i = 0; i < data.hosts.length; i++) {
        var host = data.hosts[i];
        try {
          env.remoteHost = host;
          say({ type: 'status', stage: 'model', host: host });
          classifier = await withStall(function (touch) {
            return lib.pipeline('audio-classification', data.model, {
              dtype: 'q8', device: 'wasm',
              progress_callback: function (p) {
                touch();
                if (p && p.status === 'progress' && isFinite(p.progress)) say({ type: 'progress', value: p.progress });
              }
            });
          }, data.stallMs || 45000);
          return;
        } catch (e) { classifier = null; notes.push('mô hình từ ' + host + ': ' + msg(e)); }
      }
      throw fail('model', 'Không tải được mô hình AI');
    }

    self.onmessage = async function (event) {
      var data = event.data, notes = (data.notes || []).slice();
      try {
        say({ type: 'status', stage: 'lib' });
        await loadLib(data.libs, notes);
        await loadModel(data, notes);
        var totals = Object.create(null);
        for (var i = 0; i < data.segments.length; i++) {
          say({ type: 'status', stage: 'analyze', index: i + 1, total: data.segments.length });
          var output;
          try { output = await classifier(data.segments[i], { top_k: 80 }); }
          catch (e) { throw fail('run', 'Mô hình chạy lỗi: ' + msg(e)); }
          output.forEach(function (row) { totals[row.label] = (totals[row.label] || 0) + row.score / data.segments.length; });
        }
        var predictions = Object.keys(totals).map(function (label) { return { label: label, score: totals[label] }; }).sort(function (x, y) { return y.score - x.score; });
        say({ type: 'result', predictions: predictions });
      } catch (e) {
        say({ type: 'error', code: e && e.code ? e.code : 'run', message: msg(e), notes: notes });
      }
    };
  }
  var NI_WORKER_SOURCE = '(' + niWorkerMain.toString() + ')();';
  var niWorkerUrl = null, niActiveWorker = null;

  /* Kiểm tra trước nguồn nào truy cập được (HEAD, nếu không được thì GET) để khỏi chờ vô ích. */
  function niReach(url, ms) {
    return new Promise(function (resolve) {
      var ctl = ('AbortController' in window) ? new AbortController() : null, over = false;
      var timer = setTimeout(function () { over = true; if (ctl) ctl.abort(); resolve({ ok: false, why: 'hết thời gian chờ ' + Math.round(ms / 1000) + 's' }); }, ms);
      function end(res) { if (over) return; clearTimeout(timer); over = true; resolve(res); }
      function viaGet() {
        fetch(url, { signal: ctl ? ctl.signal : undefined }).then(function (r) { end({ ok: r.ok, why: 'HTTP ' + r.status }); })
          .catch(function () { end({ ok: false, why: 'bị chặn hoặc không có mạng' }); });
      }
      fetch(url, { method: 'HEAD', signal: ctl ? ctl.signal : undefined })
        .then(function (r) { if (r.ok) end({ ok: true, why: 'HTTP ' + r.status }); else viaGet(); })
        .catch(viaGet);
    });
  }
  function niProbe() {
    var cfg = 'Xenova/ast-finetuned-audioset-10-10-0.4593/resolve/main/config.json';
    return Promise.all([
      Promise.all(NI_LIBS.map(function (u) { return niReach(u, 8000); })),
      Promise.all(NI_HOSTS.map(function (h) { return niReach(h + cfg, 8000); }))
    ]).then(function (r) {
      var notes = [], libs = [], hosts = [];
      NI_LIBS.forEach(function (u, i) { notes.push('kiểm tra ' + u + ' → ' + (r[0][i].ok ? 'được' : 'không (' + r[0][i].why + ')')); if (r[0][i].ok) libs.push(u); });
      NI_HOSTS.forEach(function (h, i) { notes.push('kiểm tra ' + h + ' → ' + (r[1][i].ok ? 'được' : 'không (' + r[1][i].why + ')')); if (r[1][i].ok) hosts.push(h); });
      if (!libs.length && !hosts.length) { var er = new Error('Không có nguồn nào truy cập được'); er.code = 'net'; er.notes = notes; throw er; }
      return { libs: libs.length ? libs : NI_LIBS.slice(), hosts: hosts.length ? hosts : NI_HOSTS.slice(), notes: notes, libOk: libs.length > 0, hostOk: hosts.length > 0 };
    });
  }

  function niReadFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('read')); };
      reader.readAsArrayBuffer(file);
    });
  }
  function niResample(channel, sourceRate, start, end) {
    var first = Math.max(0, Math.floor(start * sourceRate));
    var last = Math.min(channel.length, Math.ceil(end * sourceRate));
    var length = Math.max(1, Math.round((last - first) / sourceRate * 16000));
    var out = new Float32Array(length);
    for (var i = 0; i < length; i++) {
      var pos = first + i * (last - first - 1) / Math.max(1, length - 1);
      var lo = Math.floor(pos), hi = Math.min(last - 1, lo + 1), mix = pos - lo;
      out[i] = (channel[lo] || 0) * (1 - mix) + (channel[hi] || 0) * mix;
    }
    return out;
  }
  function niDecode(file) {
    return niReadFile(file).then(function (bytes) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('unsupported');
      var ctx = new AC();
      return new Promise(function (resolve, reject) { ctx.decodeAudioData(bytes, resolve, function (e) { var d = new Error(e && e.message ? e.message : 'decode'); d.code = 'decode'; reject(d); }); }).then(function (buffer) {
        try { ctx.close(); } catch (e) {}
        var duration = buffer.duration;
        if (!isFinite(duration) || duration < 0.6) throw new Error('short');
        if (duration > 900) throw new Error('long');
        var mono = new Float32Array(buffer.length);
        for (var c = 0; c < buffer.numberOfChannels; c++) {
          var input = buffer.getChannelData(c);
          for (var i = 0; i < input.length; i++) mono[i] += input[i] / buffer.numberOfChannels;
        }
        // Lấy mẫu ở nhiều vị trí trải đều trong bài, tránh chỉ nghe intro/đoạn cuối.
        var count = duration > 45 ? 5 : duration > 20 ? 3 : duration > 10 ? 2 : 1, segments = [];
        var windowSeconds = Math.min(10, duration);
        for (var s = 0; s < count; s++) {
          var start = count === 1 ? Math.max(0, (duration - windowSeconds) / 2)
            : (duration - windowSeconds) * (s + 0.5) / count;
          var end = Math.min(duration, start + windowSeconds);
          segments.push(niResample(mono, buffer.sampleRate, start, end));
        }
        var peaks = new Float32Array(180), block = Math.max(1, Math.floor(mono.length / peaks.length));
        for (var p = 0; p < peaks.length; p++) {
          var peak = 0, from = p * block, to = Math.min(mono.length, from + block);
          for (var j = from; j < to; j += 16) peak = Math.max(peak, Math.abs(mono[j]));
          peaks[p] = peak;
        }
        return { segments: segments, duration: duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, peaks: peaks };
      });
    });
  }
  function niInfer(segments, route, onProgress) {
    return new Promise(function (resolve, reject) {
      var worker, settled = false, watchdog;
      try {
        if (!niWorkerUrl) niWorkerUrl = URL.createObjectURL(new Blob([NI_WORKER_SOURCE], { type: 'text/javascript' }));
        worker = new Worker(niWorkerUrl, { type: 'module' });
      } catch (e) {
        var u = new Error('Trình duyệt không chạy được Web Worker dạng module: ' + (e && e.message ? e.message : e)); u.code = 'unsupported'; reject(u); return;
      }
      niActiveWorker = worker;
      function done(err, value) {
        if (settled) return; settled = true; clearTimeout(watchdog); worker.terminate();
        if (niActiveWorker === worker) niActiveWorker = null;
        if (err) { err.notes = (route.notes || []).concat(err.notes || []); reject(err); } else resolve(value);
      }
      function arm() { clearTimeout(watchdog); watchdog = setTimeout(function () { var t = new Error('Quá trình phân tích không có phản hồi'); t.code = 'timeout'; done(t); }, 150000); }
      arm();
      worker.onmessage = function (event) {
        arm();
        var d = event.data;
        if (d.type === 'progress') onProgress(12 + Math.round(d.value * 0.55), 'Đang tải mô hình AI… ' + Math.round(d.value) + '%');
        else if (d.type === 'status' && d.stage === 'lib') onProgress(9, 'Đang nạp thư viện AI…');
        else if (d.type === 'status' && d.stage === 'model') onProgress(10, 'Đang chuẩn bị mô hình nhận dạng…');
        else if (d.type === 'status' && d.stage === 'analyze') onProgress(72 + Math.round((d.index - 1) / d.total * 24), 'Đang phân tích đoạn ' + d.index + ' / ' + d.total + '…');
        else if (d.type === 'result') done(null, d.predictions);
        else if (d.type === 'error') { var er = new Error(d.message || 'model'); er.code = d.code || 'run'; er.notes = d.notes || []; done(er); }
      };
      worker.onerror = function (ev) {
        var er = new Error('Worker lỗi khi khởi động' + (ev && ev.message ? ': ' + ev.message : '')); er.code = 'worker'; done(er);
        if (ev && ev.preventDefault) ev.preventDefault();
      };
      worker.postMessage({ model: NI_MODEL, segments: segments, libs: route.libs, hosts: route.hosts, notes: route.notes || [] });
    });
  }
  function niFormatTime(seconds) { var s = Math.round(seconds); return Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2); }
  function niWaveform(canvas, peaks, color) {
    if (!canvas) return;
    var ratio = Math.min(2, window.devicePixelRatio || 1), width = canvas.clientWidth || 600, height = 104;
    canvas.width = width * ratio; canvas.height = height * ratio;
    var ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height);
    var gap = 2, bar = Math.max(1, (width - gap * (peaks.length - 1)) / peaks.length);
    for (var i = 0; i < peaks.length; i++) {
      var h = Math.max(2, peaks[i] * (height - 12));
      ctx.fillStyle = color || '#c87932';
      ctx.fillRect(i * (bar + gap), (height - h) / 2, bar, h);
    }
  }
  function initInstrumentRecognition() {
    var host = $('#nc-instrument-ai'); if (!host) return;
    var melodyHost = $('#nc-melody-page');
    var lastAnalyzedFile = null;
    var input = $('#ni-file', host), drop = $('#ni-drop', host), fileBox = $('#ni-filebox', host);
    var status = $('#ni-status', host), results = $('#ni-results', host), currentUrl = null, workerRun = 0, busy = false, lastProgress = 0;
    function progress(percent, message) {
      percent = Math.max(lastProgress, percent); lastProgress = percent;
      status.hidden = false;
      status.innerHTML = '<div class="ni-progress-head"><span>' + esc(message) + '</span><b>' + percent + '%</b></div>' +
        '<div class="ni-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + percent + '"><i style="width:' + percent + '%"></i></div>' +
        '<button type="button" class="nc-btn nc-btn-ghost nc-btn-small" id="ni-cancel">Hủy phân tích</button>';
    }
    function reset() {
      workerRun++; busy = false;
      if (niActiveWorker) { niActiveWorker.terminate(); niActiveWorker = null; }
      input.value = ''; status.hidden = true; results.innerHTML = ''; fileBox.hidden = true; drop.hidden = false;
      if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
    }
    function fail(message, detail) {
      busy = false; status.hidden = false;
      status.innerHTML = '<div class="nc-alert err" role="alert">' + esc(message) + '</div>' +
        (detail ? '<details class="ni-detail"><summary>Chi tiết kỹ thuật (gửi cho người hỗ trợ nếu cần)</summary><pre>' + esc(detail) + '</pre></details>' : '') +
        '<button type="button" class="nc-btn nc-btn-dark nc-btn-small" id="ni-retry">Chọn file khác</button>';
    }
    function explain(error) {
      var code = error && error.code, m = (error && error.message) || '';
      if (m === 'short') return 'File quá ngắn. Hãy chọn âm thanh dài tối thiểu khoảng 1 giây.';
      if (m === 'long') return 'File dài hơn 15 phút. Hãy cắt một đoạn ngắn hơn để phân tích.';
      if (m === 'unsupported') return 'Trình duyệt này chưa hỗ trợ xử lý âm thanh. Hãy dùng Chrome, Edge, Safari hoặc Firefox bản mới.';
      if (code === 'decode') return 'Không đọc được file âm thanh này. Hãy thử một file MP3, WAV, M4A hoặc OGG khác.';
      if (code === 'net') return 'Không kết nối được tới nơi chứa mô hình AI (huggingface.co, hf-mirror.com) và thư viện (jsdelivr, unpkg). Hãy kiểm tra mạng, tắt VPN hoặc tiện ích chặn quảng cáo, hoặc thử mạng khác rồi bấm "Chọn file khác" để thử lại.';
      if (code === 'lib') return 'Không nạp được thư viện AI. Hãy kiểm tra mạng, tắt VPN hoặc tiện ích chặn quảng cáo rồi thử lại.';
      if (code === 'model') return 'Không tải được mô hình AI. Lần đầu cần tải khoảng 90 MB: hãy giữ nguyên tab, kiểm tra mạng rồi thử lại. File âm thanh của bạn vẫn chưa được gửi đi đâu.';
      if (code === 'unsupported' || code === 'worker') return 'Trình duyệt chưa chạy được bộ phân tích AI. Hãy cập nhật hoặc đổi sang Chrome / Edge bản mới.';
      if (code === 'timeout') return 'Quá trình phân tích mất nhiều thời gian hơn dự kiến. Hãy kiểm tra mạng, giữ nguyên tab rồi thử lại với đoạn âm thanh ngắn hơn.';
      if (code === 'run') return 'Mô hình gặp lỗi khi phân tích file này. Hãy thử một đoạn âm thanh khác.';
      return 'Không phân tích được file này. Hãy thử một file khác.';
    }
    function showProducts(types) {
      if (!types.length) return;
      var box = document.createElement('div'); box.className = 'ni-products'; box.innerHTML = '<h3>Sản phẩm cùng nhóm nhạc cụ</h3><div class="nc-loading">Đang tìm trong cửa hàng…</div>';
      results.appendChild(box);
      getProducts().then(function (list) {
        var found = productsForTypes(list, types, 3);
        box.innerHTML = '<h3>Sản phẩm cùng nhóm nhạc cụ</h3>' + (found.length ? found.map(function (p) { return productCardHTML(p); }).join('') : '<p class="nc-sub">Chưa tìm thấy sản phẩm còn hàng phù hợp.</p>');
      });
    }
    function draw(predictions, decoded) {
      var instruments = predictions.map(function (row) {
        var meta = niLabelMeta(row.label);
        return meta ? { label: meta[0], type: meta[1], score: row.score } : null;
      }).filter(Boolean);
      var unique = [], seen = {};
      instruments.forEach(function (row) { if (!seen[row.label]) { seen[row.label] = true; unique.push(row); } });
      instruments = unique.slice(0, 12);
      status.hidden = true;
      if (lastAnalyzedFile && melodyHost && melodyHost._ncOnAnalyzed) melodyHost._ncOnAnalyzed(lastAnalyzedFile, instruments);
      if (!instruments.length) {
        results.innerHTML = '<div class="ni-empty-result"><h3>Chưa nhận dạng đủ chắc chắn</h3><p>Mô hình chưa tìm thấy nhãn nhạc cụ phù hợp. Hãy thử đoạn 10–30 giây có nhạc cụ nổi rõ; bản phối điện tử nhiều lớp có thể khó phân biệt.</p></div>'; return;
      }
      var max = instruments[0].score, types = [];
      instruments.forEach(function (row) { if (row.score >= 0.02 && types.indexOf(row.type) === -1) types.push(row.type); });
      results.innerHTML = '<div class="ni-result-head"><div><span class="ni-kicker">KẾT QUẢ DỰ ĐOÁN</span><h3>' + (instruments.length > 1 ? 'Các nhạc cụ nổi bật' : 'Nhạc cụ nổi bật') + '</h3></div><span class="ni-samples">' + decoded.segments.length + ' đoạn · ' + niFormatTime(decoded.duration) + '</span></div>' +
        '<div class="ni-predictions">' + instruments.map(function (row, index) {
          var pct = row.score < 0.1 ? (row.score * 100).toFixed(1) : Math.round(row.score * 100), width = Math.max(3, Math.round(row.score / max * 100));
          return '<div class="ni-prediction"><div class="ni-prediction-label"><span><b>' + (index + 1) + '</b>' + esc(row.label) + '</span><strong>' + pct + '%</strong></div><div class="ni-score"><i style="width:' + width + '%"></i></div></div>';
        }).join('') + '</div>' +
        '<p class="ni-disclaimer">Tỷ lệ là điểm tin cậy của mô hình, không phải xác suất chắc chắn. Bản phối nhiều lớp âm thanh hoặc có giọng hát có thể làm kết quả giảm độ chính xác.</p>' +
        '<button type="button" class="nc-btn nc-btn-dark nc-btn-small" id="ni-again">Phân tích file khác</button>';
      showProducts(types.slice(0, 3));
    }
    function analyze(file) {
      if (busy) return;
      if (!file) return;
      if (file.size > 25 * 1024 * 1024) { fail('File vượt quá 25 MB. Hãy chọn bản ngắn hơn hoặc nén file trước khi tải lên.'); return; }
      if (file.type && file.type.indexOf('audio/') !== 0 && !/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name)) { fail('Định dạng chưa được hỗ trợ. Hãy chọn MP3, WAV, M4A, AAC, OGG hoặc FLAC.'); return; }
      busy = true; var run = ++workerRun; lastProgress = 0; lastAnalyzedFile = file;
      results.innerHTML = ''; drop.hidden = true; fileBox.hidden = false;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = URL.createObjectURL(file);
      $('#ni-name', host).textContent = file.name;
      $('#ni-size', host).textContent = (file.size / 1024 / 1024).toFixed(2) + ' MB · xử lý ngay trên thiết bị';
      $('#ni-audio', host).src = currentUrl;
      progress(3, 'Đang đọc file âm thanh…');
      var probe = niProbe().then(function (route) { return { route: route }; }, function (err) { return { error: err }; });
      niDecode(file).then(function (decoded) {
        if (run !== workerRun) return;
        $('#ni-meta', host).textContent = niFormatTime(decoded.duration) + ' · ' + decoded.channels + ' kênh · ' + Math.round(decoded.sampleRate / 1000) + ' kHz';
        niWaveform($('#ni-wave', host), decoded.peaks);
        progress(8, 'Đã đọc xong. Chuẩn bị mô hình AI…');
        return probe.then(function (pr) {
          if (run !== workerRun) return;
          if (pr.error) throw pr.error;
          return niInfer(decoded.segments, pr.route, function (pct, msg) { if (run === workerRun) progress(pct, msg); }).then(function (predictions) {
            if (run !== workerRun) return;
            progress(100, 'Hoàn tất phân tích'); busy = false; draw(predictions, decoded);
          });
        });
      }).catch(function (error) {
        if (run !== workerRun) return;
        fail(explain(error), [error && error.message].concat((error && error.notes) || []).filter(Boolean).join('\n'));
      });
    }
    input.addEventListener('change', function () { analyze(input.files[0]); });
    ['dragenter', 'dragover'].forEach(function (name) { drop.addEventListener(name, function (e) { e.preventDefault(); drop.classList.add('is-drag'); }); });
    ['dragleave', 'drop'].forEach(function (name) { drop.addEventListener(name, function (e) { e.preventDefault(); drop.classList.remove('is-drag'); }); });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer.files.length) analyze(e.dataTransfer.files[0]); });
    if (melodyHost) melodyHost._ncAnalyze = analyze;
    host.addEventListener('click', function (e) {
      if (e.target.closest('#ni-cancel') || e.target.closest('#ni-again') || e.target.closest('#ni-retry')) reset();
    });
  }

  /* ---- Trang riêng: thư viện bài hát kiểu Spotify ---- */
  var synth = { ctx: null, timers: [], btn: null };
  function stopSynth() {
    synth.timers.forEach(clearTimeout); synth.timers = [];
    if (synth.btn) { synth.btn.classList.remove('is-playing'); synth.btn.innerHTML = '&#9654;'; synth.btn = null; }
    if (synth.nodes) { synth.nodes.forEach(function (o) { try { o.stop(); } catch (e) {} }); synth.nodes = []; }
  }
  function playTune(notes, btn) {
    if (synth.btn === btn) { stopSynth(); return; }
    stopSynth(); try { audio.pause(); } catch (e) {}
    var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    synth.ctx = synth.ctx || new AC(); if (synth.ctx.state === 'suspended') synth.ctx.resume();
    var ctx = synth.ctx, t = ctx.currentTime + 0.05, dur = 0.34; synth.nodes = [];
    notes.forEach(function (m, i) {
      var o = ctx.createOscillator(), g = ctx.createGain(), s = t + i * dur;
      o.type = 'triangle'; o.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
      g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.35, s + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, s + dur * 0.95);
      o.connect(g); g.connect(ctx.destination); o.start(s); o.stop(s + dur); synth.nodes.push(o);
    });
    synth.btn = btn; btn.classList.add('is-playing'); btn.innerHTML = '&#10074;&#10074;';
    synth.timers.push(setTimeout(stopSynth, notes.length * dur * 1000 + 150));
  }
  var GENRE_CHIPS = [['Tất cả', ''], ['Thiếu nhi', 'thiếu nhi'], ['Cổ điển', 'cổ điển'], ['Pop', 'pop'], ['Rock', 'rock'], ['Acoustic', 'acoustic'], ['Nhạc Việt', 'việt'], ['Giáng sinh', 'giáng sinh']];
  var GENRE_COLORS = ['#c87932', '#8c5a3c', '#5b6b7a', '#9b2c2c', '#3f7d4e', '#7a5c99', '#b4541a'];

  function initMelodyPage() {
    var host = $('#nc-melody-page'); if (!host) return;
    var LIB = [], USER_KEY = 'nc_uploaded_songs_v3';
    var TYPE_ALIASES = { guitar: 'guitar', piano: 'piano', keyboard: 'piano', organ: 'piano', trong: 'drum', drum: 'drum', ukulele: 'uke', uke: 'uke', violin: 'uke' };
    // Thư viện bắt đầu trống; chỉ hiển thị các file khách tự tải lên.
    // (b) Khách tự thêm bài (lưu trên trình duyệt của khách)
    var userSongs = [];
    try { userSongs = JSON.parse(localStorage.getItem(USER_KEY) || '[]'); } catch (e) {}
    userSongs.forEach(function (u) { LIB.push({ n: [norm(u.t)], t: u.t, g: u.g || 'Bài của bạn', i: u.i, w: u.w || 'Bạn tự thêm bài này.', u: true, m: u.m || null, a: u.a, x: u.x }); });
    function saveUser() { try { localStorage.setItem(USER_KEY, JSON.stringify(userSongs.slice(-100))); } catch (e) {} }
    var qs = new URLSearchParams(location.search), filter = norm(qs.get('q') || ''), chip = '', selected = [];
    host.innerHTML =
      '<section class="ni-panel" id="nc-instrument-ai" aria-labelledby="ni-title">' +
      '<div class="ni-intro"><div><span class="ni-kicker">THƯ VIỆN ÂM THANH CỦA BẠN</span><h2 id="ni-title">Thêm nhạc của bạn</h2></div><p>Tải file âm thanh lên để xem dạng sóng, nghe lại và nhận diện chi tiết các nhạc cụ. File được xử lý ngay trên thiết bị.</p></div>' +
      '<label class="ni-upload-title-label" for="ni-upload-title">Tên bài hát (không bắt buộc)</label><input id="ni-upload-title" class="ni-upload-title" type="text" maxlength="100" placeholder="Ví dụ: Let It Happen" />' +
      '<label class="ni-drop" id="ni-drop" for="ni-file">' +
      '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 32V10m0 0-8 8m8-8 8 8M8 29v8a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3v-8"/></svg>' +
      '<strong>Kéo &amp; thả file âm thanh vào đây</strong><span>hoặc bấm để chọn từ thiết bị</span><small>MP3, WAV, M4A, AAC, OGG, FLAC · tối đa 25 MB</small></label>' +
      '<input type="file" id="ni-file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac" hidden>' +
      '<div class="ni-filebox" id="ni-filebox" hidden><div class="ni-file-head"><div><strong id="ni-name"></strong><span id="ni-size"></span></div><span id="ni-meta"></span></div>' +
      '<canvas id="ni-wave" aria-label="Dạng sóng của file âm thanh"></canvas><audio id="ni-audio" controls preload="metadata">Trình duyệt không hỗ trợ phát âm thanh.</audio></div>' +
      '<div class="ni-status" id="ni-status" aria-live="polite" hidden></div><div class="ni-results" id="ni-results" aria-live="polite"></div><p class="ni-save-msg" id="ni-save-msg" aria-live="polite"></p>' +
      '<div class="ni-note"><b>Phân tích tại chỗ</b><span>Lần đầu cần tải mô hình khoảng 90 MB; các lần sau trình duyệt sử dụng bộ nhớ đệm. Nên dùng đoạn 10–30 giây có tiếng nhạc cụ rõ.</span></div></section>' +
      '<div class="ml-top"><div class="ml-search"><input type="text" id="ml-q" placeholder="Tìm bài hát hoặc thể loại..." autocomplete="off" aria-label="Tìm bài hát"></div></div>' +
      '<div class="ml-library-heading"><h2>Bài hát của bạn</h2><p>Những bài đã tải lên, có thể nghe lại và xem đầy đủ kết quả nhạc cụ.</p></div>' +
      '<div class="nc-chips" id="ml-chips"></div>' +
      '<div class="ml-layout"><div class="ml-list" id="ml-list"></div><aside class="ml-side" id="ml-side"></aside></div>';
    var q = $('#ml-q'); q.value = qs.get('q') || '';
    $('#ml-chips').innerHTML = GENRE_CHIPS.map(function (c, i) { return '<button type="button" data-chip="' + i + '"' + (i === 0 ? ' class="is-on"' : '') + '>' + c[0] + '</button>'; }).join('');

    function listSongs() {
      return LIB.filter(function (s) {
        var hayS = norm(s.t + ' ' + s.g + ' ' + s.n.join(' '));
        return (!filter || hayS.indexOf(filter) > -1) && (!chip || norm(s.g).indexOf(norm(chip)) > -1);
      });
    }
    function drawList() {
      var songs = listSongs(), el = $('#ml-list');
      if (!songs.length) {
        el.innerHTML = '<div class="nc-empty">' + (filter ? 'Chưa tìm thấy bài phù hợp với từ khóa này.' : 'Thư viện đang trống. Hãy tải một file âm thanh ở phía trên để phân tích và lưu bài hát đầu tiên.') + '</div>';
        return;
      }
      el.innerHTML = songs.map(function (s) {
        var idx = LIB.indexOf(s), on = selected.indexOf(idx) > -1, color = GENRE_COLORS[idx % GENRE_COLORS.length];
        return '<div class="ml-row' + (on ? ' is-on' : '') + '" data-song="' + idx + '">' +
          (s.audioKey ? '<button type="button" class="nc-play ml-play" data-user-audio="' + idx + '" aria-label="Nghe bài đã tải">&#9654;</button>' : s.a ? '<button type="button" class="nc-play ml-play" data-audio="' + idx + '" aria-label="Nghe thử">&#9654;</button>' :
            s.m ? '<button type="button" class="nc-play ml-play" data-tune="' + idx + '" aria-label="Nghe thử giai điệu">&#9654;</button>' :
            s.x ? '<a class="nc-play ml-play ml-ext" href="' + esc(s.x) + '" target="_blank" rel="noopener" title="Nghe trên trang khác" aria-label="Nghe trên trang khác">&#8599;</a>' :
            '<span class="ml-noplay" title="Chưa có bản nghe thử">–</span>') +
          '<span class="ml-cover" style="background:' + color + '">♪</span>' +
          '<span class="ml-meta"><span class="ml-title">' + esc(s.t) + '</span><span class="ml-genre">' + esc(s.g) + (s.u ? ' · <b style="color:#a96127">của bạn</b>' : '') + '</span></span>' +
          '<span class="ml-tags">' + s.i.map(function (t) { return '<span class="ml-tag">' + esc(TYPE_LABEL[t]) + '</span>'; }).join('') + '</span>' +
          '<button type="button" class="ml-pick" data-pick="' + idx + '" aria-label="Chọn bài">' + (on ? '✓' : '+') + '</button>' + (s.u ? '<button type="button" class="ml-del" data-del="' + idx + '" aria-label="Xoá bài" title="Xoá bài này">&times;</button>' : '') + '</div>';
      }).join('');
    }
    function drawSide() {
      var el = $('#ml-side');
      if (!selected.length) { el.innerHTML = '<h3>Nhạc cụ hợp với bạn</h3><p class="nc-sub">Bấm <b>+</b> ở một hoặc nhiều bài hát bạn thích. Mình sẽ tổng hợp nhạc cụ phù hợp nhất và gợi ý sản phẩm trong cửa hàng.</p>'; return; }
      var score = {};
      selected.forEach(function (i) { LIB[i].i.forEach(function (t, r) { score[t] = (score[t] || 0) + (3 - r > 0 ? 3 - r : 1); }); });
      var ranked = Object.keys(score).sort(function (a, b) { return score[b] - score[a]; }), max = score[ranked[0]];
      var names = selected.map(function (i) { return LIB[i]; });
      var html = '<h3>Nhạc cụ hợp với bạn</h3><p class="nc-sub">Dựa trên ' + selected.length + ' bài bạn chọn</p>' +
        '<div class="ml-bars">' + ranked.map(function (t) { return '<div class="ml-bar"><span>' + esc(TYPE_LABEL[t]) + '</span><i style="width:' + Math.round(score[t] / max * 100) + '%"></i></div>'; }).join('') + '</div>' +
        '<div class="nc-answer">Hợp nhất với: <b>' + esc(instList(ranked.slice(0, 2))) + '</b>.' + (names.length === 1 ? '<br>' + esc(names[0].w) : '') + '</div>' +
        '<div id="ml-prods"><div class="nc-loading">Đang tìm sản phẩm…</div></div>' +
        '<button type="button" class="nc-btn nc-btn-ghost nc-btn-small" id="ml-clear" style="margin-top:12px">Xoá lựa chọn</button>';
      el.innerHTML = html;
      getProducts().then(function (list) {
        var f = productsForTypes(list, ranked.slice(0, 3), 3), hostP = $('#ml-prods'); if (!hostP) return;
        hostP.innerHTML = f.length ? '<h4 style="margin:12px 0 6px;font-size:15px">Có trong cửa hàng</h4>' + f.map(function (p) { return productCardHTML(p); }).join('') : '<p class="nc-sub">Cửa hàng hiện chưa có sản phẩm còn hàng thuộc nhóm này.</p>';
      });
    }
    function redraw() { drawList(); drawSide(); }

    q.addEventListener('input', function () { filter = norm(q.value); drawList(); });
    host.addEventListener('click', function (e) {
      var c = e.target.closest('[data-chip]');
      if (c) { chip = GENRE_CHIPS[+c.getAttribute('data-chip')][1]; $all('#ml-chips button').forEach(function (b) { b.classList.toggle('is-on', b === c); }); drawList(); return; }
      if (e.target.closest('.ml-ext')) { e.stopPropagation(); return; }
      var userAu = e.target.closest('[data-user-audio]');
      if (userAu) { e.stopPropagation(); var us = LIB[+userAu.getAttribute('data-user-audio')]; if (us && us.audioKey) readAudio(us.audioKey).then(function (blob) { var url = URL.createObjectURL(blob); playSrc(url, userAu); }).catch(function () { toast('Không tìm thấy file đã lưu trên trình duyệt này.'); }); return; }
      var au = e.target.closest('[data-audio]');
      if (au) { e.stopPropagation(); stopSynth(); playSrc(LIB[+au.getAttribute('data-audio')].a, au); return; }
      var del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation(); var di = +del.getAttribute('data-del'), s = LIB[di];
        userSongs = userSongs.filter(function (u) { return u.t !== s.t; }); saveUser();
        LIB.splice(di, 1); selected = selected.filter(function (x) { return x !== di; }).map(function (x) { return x > di ? x - 1 : x; });
        redraw(); return;
      }
      var pl = e.target.closest('[data-tune]');
      if (pl) { e.stopPropagation(); playTune(LIB[+pl.getAttribute('data-tune')].m, pl); return; }
      var pk = e.target.closest('[data-pick]') || e.target.closest('.ml-row');
      if (pk) {
        var idx = +(pk.getAttribute('data-pick') || pk.getAttribute('data-song')), at = selected.indexOf(idx);
        if (at > -1) selected.splice(at, 1); else selected.push(idx);
        redraw(); return;
      }
      if (e.target.closest('#ml-clear')) { selected = []; redraw(); return; }
      if (e.target.closest('#ml-ask')) { searchSong(q.value); return; }
    });
    function openAudioDB() { return new Promise(function (resolve, reject) { if (!window.indexedDB) return reject(new Error('Trình duyệt không hỗ trợ lưu file cục bộ')); var req = indexedDB.open('namcam-audio-library', 1); req.onupgradeneeded = function () { if (!req.result.objectStoreNames.contains('tracks')) req.result.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true }); }; req.onsuccess = function () { resolve(req.result); }; req.onerror = function () { reject(req.error || new Error('Không mở được thư viện âm thanh')); }; }); }
    function storeAudio(file) { return openAudioDB().then(function (db) { return new Promise(function (resolve, reject) { var tx = db.transaction('tracks', 'readwrite'), req = tx.objectStore('tracks').add({ name: file.name, blob: file, savedAt: Date.now() }); req.onsuccess = function () { resolve(req.result); }; req.onerror = function () { reject(req.error); }; tx.oncomplete = function () { db.close(); }; }); }); }
    function readAudio(id) { return openAudioDB().then(function (db) { return new Promise(function (resolve, reject) { var req = db.transaction('tracks', 'readonly').objectStore('tracks').get(Number(id)); req.onsuccess = function () { var rec = req.result; db.close(); if (rec && rec.blob) resolve(rec.blob); else reject(new Error('Không tìm thấy file đã lưu')); }; req.onerror = function () { db.close(); reject(req.error); }; }); }); }
    // Lưu file đã phân tích vào IndexedDB và lưu thông tin bài hát vào localStorage.
    function saveAnalyzedUpload(file, instruments) {
      var titleInput = $('#ni-upload-title'), msg = $('#ni-save-msg');
      var title = ((titleInput && titleInput.value) || file.name.replace(/\.[^.]+$/, '')).trim() || file.name;
      var types = [];
      (instruments || []).forEach(function (it) { if (it && it.type && TYPE_LABEL[it.type] && types.indexOf(it.type) === -1) types.push(it.type); });
      if (!types.length) { if (msg) msg.textContent = 'Phân tích xong nhưng chưa nhận diện được nhóm nhạc cụ đủ rõ để lưu kết quả.'; return; }
      // Tránh lưu lặp nếu callback được gọi nhiều lần cho cùng file.
      if (userSongs.some(function (u) { return u._fileName === file.name && u._fileSize === file.size && u._lastModified === file.lastModified; })) return;
      if (msg) msg.textContent = 'Đang lưu file và kết quả phân tích…';
      storeAudio(file).then(function (audioKey) {
        var item = { t: title, g: 'Bài đã tải lên', i: types, w: 'Nhạc cụ được AI dự đoán từ file âm thanh.', audioKey: audioKey, _fileName: file.name, _fileSize: file.size, _lastModified: file.lastModified };
        userSongs.push(item); saveUser();
        LIB.push({ n: [norm(item.t)], t: item.t, g: item.g, i: item.i, w: item.w, u: true, audioKey: item.audioKey });
        filter = ''; q.value = ''; selected = [LIB.length - 1];
        if (msg) msg.textContent = '✓ Đã phân tích và lưu “' + title + '”. Bài hát xuất hiện bên dưới để nghe lại và xem nhạc cụ.';
        redraw();
      }).catch(function (err) { if (msg) msg.textContent = 'Không lưu được file trên trình duyệt: ' + (err.message || 'lỗi lưu trữ'); });
    }

    redraw();
    host._ncOnAnalyzed = function (file, instruments) { var upload = $('#ni-file'); if (file && upload && upload.files[0] === file) saveAnalyzedUpload(file, instruments); };
    initInstrumentRecognition();
  }

  /* ================= 3. TRỢ LÝ AI CHỌN ĐÀN ================= */
  function initAI() {
    var host = $('#nc-ai'); if (!host) return;
    var log = $('.ai-log', host), answers = {};
    var LV = { new: 'mới bắt đầu', mid: 'đã chơi một thời gian', pro: 'chơi chuyên nghiệp' };
    var PU = { learn: 'học / luyện tập', perform: 'biểu diễn', fun: 'giải trí tại nhà', gift: 'tặng quà' };
    var PURPOSE_KW = { learn: ['beginner', 'starter', 'hoc', 'entry', 'soprano', 'combo'], perform: ['stage', 'bieu dien', 'pro', 'masterworks', 'concert', 'electric', 'dien'], fun: ['mini', 'travel', 'soprano', 'ukulele'], gift: ['set', 'combo', 'qua', 'gift', 'bo'] };
    var steps = [
      { key: 'type', q: 'Xin chào! Mình là trợ lý của NĂM CAM. Bạn quan tâm loại nhạc cụ nào?', opts: [['Guitar', 'guitar'], ['Piano / Keyboard', 'piano'], ['Trống', 'drum'], ['Ukulele & Violin', 'uke'], ['Chưa biết', 'any']] },
      { key: 'level', q: 'Trình độ hiện tại của bạn?', opts: [['Mới bắt đầu', 'new'], ['Đã chơi một thời gian', 'mid'], ['Chơi chuyên nghiệp', 'pro']] },
      { key: 'purpose', q: 'Bạn mua để làm gì?', opts: [['Học / luyện tập', 'learn'], ['Biểu diễn', 'perform'], ['Giải trí tại nhà', 'fun'], ['Tặng quà', 'gift']] },
      { key: 'budget', q: 'Ngân sách của bạn khoảng bao nhiêu?', opts: [['Dưới 3 triệu', [0, 3e6]], ['3 – 10 triệu', [3e6, 1e7]], ['10 – 30 triệu', [1e7, 3e7]], ['Trên 30 triệu', [3e7, 1e12]]] }
    ];
    var BUDGET_TXT = function (b) { return b[1] > 1e11 ? 'trên 30 triệu' : b[0] === 0 ? 'dưới ' + b[1] / 1e6 + ' triệu' : 'từ ' + b[0] / 1e6 + ' đến ' + b[1] / 1e6 + ' triệu'; };

    function say(t, who) { var d = document.createElement('div'); d.className = 'ai-msg ' + (who || 'bot'); d.innerHTML = t; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
    function choices(opts, cb) {
      var w = document.createElement('div'); w.className = 'ai-choices';
      opts.forEach(function (o) { var b = document.createElement('button'); b.type = 'button'; b.textContent = o[0]; b.addEventListener('click', function () { w.remove(); say(esc(o[0]), 'me'); cb(o[1]); }); w.appendChild(b); });
      log.appendChild(w); log.scrollTop = log.scrollHeight;
    }
    function ask(i) {
      if (i >= steps.length) return askFree();
      var s = steps[i]; say(s.q); choices(s.opts, function (v) { answers[s.key] = v; ask(i + 1); });
    }
    function askFree() {
      say('Cuối cùng: bạn có thích bài hát / ca sĩ / thể loại nào không? (ví dụ "Ed Sheeran", "nhạc rock", "ballad") — có thể bỏ qua.');
      var w = document.createElement('div'); w.className = 'ai-free';
      w.innerHTML = '<input type="text" maxlength="120" placeholder="Sở thích âm nhạc của bạn..." aria-label="Sở thích"><button type="button">Gửi</button><button type="button" style="background:#201b18">Bỏ qua</button>';
      log.appendChild(w); log.scrollTop = log.scrollHeight;
      var inp = $('input', w), btns = $all('button', w);
      function go(text) { w.remove(); answers.free = text || ''; if (text) say(esc(text), 'me'); recommend(); }
      btns[0].addEventListener('click', function () { go(inp.value.trim()); });
      btns[1].addEventListener('click', function () { go(''); });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(inp.value.trim()); });
      inp.focus();
    }

    function score(list) {
      var b = answers.budget, type = answers.type, free = norm(answers.free || '');
      var tFromText = null;
      Object.keys(KW).forEach(function (k) { KW[k].forEach(function (w) { if (!tFromText && free.indexOf(w) > -1) tFromText = k; }); });
      if (type === 'any' && tFromText) type = tFromText;
      var g = genreFromText(answers.free || ''); var song = findSong(answers.free || '');
      var prefTypes = song ? song.i : (g ? g.i : []);
      return list.map(function (p) {
        var price = minPrice(p), h = hay(p), sc = 0, why = [];
        if (type !== 'any') { if (matchesType(p, type)) { sc += 6; why.push('đúng loại bạn chọn'); } else sc -= 4; }
        else if (prefTypes.some(function (t) { return matchesType(p, t); })) { sc += 3; why.push('hợp gu âm nhạc của bạn'); }
        if (price >= b[0] && price <= b[1]) { sc += 5; why.push('nằm trong ngân sách'); }
        else if (price > b[1] && price <= b[1] * 1.2) { sc += 1; why.push('hơi vượt ngân sách một chút'); } else sc -= 3;
        if (answers.level === 'new' && price <= (b[1] > 1e11 ? 5e7 : b[1]) * 0.7) { sc += 1; why.push('dễ làm quen'); }
        if (answers.level === 'pro' && price >= b[0] + (Math.min(b[1], 1e8) - b[0]) * 0.4) { sc += 1; why.push('phân khúc cao cấp'); }
        if (PURPOSE_KW[answers.purpose].some(function (k) { return h.indexOf(k) > -1; })) { sc += 1; why.push('hợp mục đích'); }
        if (type !== 'any' && prefTypes.indexOf(type) > -1) sc += 1;
        var sale = saleInfo(p); if (sale) { sc += 0.5; why.push('đang giảm ' + sale.off + '%'); }
        if (!isAvail(p)) sc -= 5;
        return { p: p, price: price, score: sc, why: why };
      }).filter(function (r) { return isAvail(r.p) && r.score > 3; }).sort(function (a, b2) { return b2.score - a.score; });
    }
    function localText(top) {
      var t = top[0];
      return 'Với trình độ <b>' + LV[answers.level] + '</b>, mục đích <b>' + PU[answers.purpose] + '</b> và ngân sách ' + BUDGET_TXT(answers.budget) + ', mình gợi ý <b>' + esc(t.p.title) + '</b> (' + fmtVND(t.price) + ') — ' + esc(t.why.slice(0, 3).join(', ')) + '.';
    }

    function recommend() {
      var wait = say('Đợi mình một chút, mình đang chọn nhạc cụ phù hợp…');
      getProducts().then(function (list) {
        var ranked = score(list), top = ranked.slice(0, 3);
        if (!ranked.length) { wait.remove(); say('Hiện mình chưa tìm thấy sản phẩm khớp hoàn toàn. Bạn thử nới ngân sách hoặc <a href="/pages/ho-tro">nhắn đội ngũ tư vấn</a> nhé.'); return end(); }
        var cand = ranked.slice(0, 8).map(function (r) { return { handle: r.p.handle, title: r.p.title, price: Math.round(r.price), type: r.p.product_type || '', reasons: r.why }; });
        function show(text, tag, picks) {
          wait.remove();
          say(text + (tag ? ' <span class="ai-tag">AI</span>' : ''));
          picks.forEach(function (r) { var el = document.createElement('div'); el.innerHTML = productCardHTML(r.p, r.why.join(', ')); log.appendChild(el.firstChild); });
          end();
        }
        callAI({ mode: 'recommend', answers: { loai: answers.type, trinh_do: LV[answers.level], muc_dich: PU[answers.purpose], ngan_sach: BUDGET_TXT(answers.budget), so_thich: answers.free || '' }, candidates: cand })
          .then(function (r) {
            var picks = (r.picks || []).map(function (h) { return ranked.find(function (x) { return x.p.handle === h; }); }).filter(Boolean).slice(0, 3);
            if (!r.text) throw new Error('empty');
            show(esc(r.text), true, picks.length ? picks : top);
          })
          .catch(function () { show(localText(top), false, top); });
      });
    }
    function end() {
      var again = document.createElement('div'); again.className = 'ai-choices';
      again.innerHTML = '<button type="button">Hỏi lại từ đầu</button>';
      again.firstChild.addEventListener('click', function () { log.innerHTML = ''; answers = {}; ask(0); });
      log.appendChild(again); log.scrollTop = log.scrollHeight;
    }
    ask(0);
  }

  /* ================= 4. MẪU ÂM THANH SẢN PHẨM ================= */
  var audio = new Audio(), audioBtn = null;
  audio.preload = 'none'; audio.crossOrigin = 'anonymous';
  function setBtn(btn, playing) { if (!btn) return; btn.classList.toggle('is-playing', playing); btn.innerHTML = playing ? '&#10074;&#10074;' : '&#9654;'; btn.setAttribute('aria-label', playing ? 'Tạm dừng' : 'Nghe thử'); }
  function playSrc(src, btn) {
    if (audioBtn === btn && audio.src && !audio.paused) { audio.pause(); return; }
    if (audioBtn && audioBtn !== btn) setBtn(audioBtn, false);
    audioBtn = btn;
    if (audio.getAttribute('data-src') !== src) { audio.setAttribute('data-src', src); audio.src = src; }
    audio.play().catch(function () { toast('Không phát được file âm thanh này.'); setBtn(btn, false); });
  }
  audio.addEventListener('play', function () { setBtn(audioBtn, true); });
  audio.addEventListener('pause', function () { setBtn(audioBtn, false); });
  audio.addEventListener('ended', function () { setBtn(audioBtn, false); });
  function fmtT(s) { s = Math.floor(s || 0); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  audio.addEventListener('timeupdate', function () {
    if (!audioBtn) return;
    var box = audioBtn.closest('.nc-sound'); if (!box) return;
    var bar = $('.nc-sound-bar > i', box), tm = $('.nc-sound-time', box);
    if (bar && audio.duration) bar.style.width = (audio.currentTime / audio.duration * 100) + '%';
    if (tm) tm.textContent = fmtT(audio.currentTime) + ' / ' + fmtT(audio.duration);
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-nc-play]');
    if (b) { e.preventDefault(); playSrc(b.getAttribute('data-nc-play'), b); return; }
    var bar = e.target.closest('.nc-sound-bar');
    if (bar && audio.duration && bar.closest('.nc-sound') === (audioBtn && audioBtn.closest('.nc-sound'))) {
      var r = bar.getBoundingClientRect(); audio.currentTime = (e.clientX - r.left) / r.width * audio.duration;
    }
  });
  function initSound() {
    // Video YouTube trong mô tả được gập lại: bấm mới tải và phát (nhẹ trang hơn, gọn hơn).
    var hasMp3 = !!$('.nc-sound');
    $all('.pd-video').forEach(function (v) {
      if (v.closest('details.nc-videobox')) return;
      var d = document.createElement('details'); d.className = 'nc-videobox';
      d.innerHTML = '<summary>' + (hasMp3 ? '🎬 Xem video (có hình)' : '🎬 Bấm để xem / nghe video') + '</summary>';
      v.parentNode.insertBefore(d, v); d.appendChild(v);
      var f = $('iframe', v);
      if (f && f.src) {
        f.setAttribute('data-src', f.src); f.removeAttribute('src');
        d.addEventListener('toggle', function () {
          if (d.open) { if (!f.src) f.src = f.getAttribute('data-src'); }
          else { f.removeAttribute('src'); }   // đóng lại thì dừng video
        });
      }
    });
  }

  /* ================= 5. TRANG SO SÁNH ================= */
  var COLORS = ['#201b18', '#c87932', '#8a8f98'];
  function fft(re, im) {
    var n = re.length, i, j, k, t;
    for (i = 1, j = 0; i < n; i++) { var bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (i = 0; i < n; i += len) {
        var cr = 1, ci = 0;
        for (k = 0; k < len / 2; k++) {
          var ur = re[i + k], ui = im[i + k], vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          var nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }
  // Phân tích 1 file âm thanh -> chroma (12 nốt), cao độ trung bình / thấp / cao, các nốt nổi bật
  function analyzeBuffer(ab) {
    var sr = ab.sampleRate, ch = ab.getChannelData(0), len = Math.min(ch.length, Math.floor(sr * 30));
    var f = Math.max(1, Math.floor(sr / 22050)), n = Math.floor(len / f), mono = new Float32Array(n), i, k;
    for (i = 0; i < n; i++) { var s = 0; for (k = 0; k < f; k++) s += ch[i * f + k]; mono[i] = s / f; }
    var sr2 = sr / f, N = 8192, hop = 4096, win = new Float32Array(N);
    for (i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    var binHz = sr2 / N, kLo = Math.ceil(60 / binHz), kHi = Math.min(N / 2 - 1, Math.floor(2000 / binHz));
    var chroma = new Float64Array(12), midis = [], pcCount = new Array(12).fill(0), energyMax = 0, frames = [];
    for (var st = 0; st + N <= n; st += hop) {
      var re = new Float64Array(N), im = new Float64Array(N), e = 0;
      for (i = 0; i < N; i++) { re[i] = mono[st + i] * win[i]; e += re[i] * re[i]; }
      frames.push({ re: re, im: im, e: e }); if (e > energyMax) energyMax = e;
    }
    frames.forEach(function (fr) {
      if (fr.e < energyMax * 0.02) return;
      fft(fr.re, fr.im);
      var mag = new Float64Array(N / 2);
      for (var q = 0; q < N / 2; q++) mag[q] = Math.sqrt(fr.re[q] * fr.re[q] + fr.im[q] * fr.im[q]);
      for (var b = kLo; b <= kHi; b++) {
        var hz = b * binHz, mm = 69 + 12 * Math.log2(hz / 440), pc = ((Math.round(mm) % 12) + 12) % 12;
        chroma[pc] += mag[b];
      }
      var bestK = -1, bestV = 0, kMax = Math.floor(1000 / binHz);
      for (var h = kLo; h <= kMax; h++) {
        var v = mag[h] * mag[2 * h] * mag[3 * h] * (mag[4 * h] || 1);
        if (v > bestV) { bestV = v; bestK = h; }
      }
      if (bestK > 0) { var m = Math.round(69 + 12 * Math.log2(bestK * binHz / 440)); midis.push(m); pcCount[((m % 12) + 12) % 12]++; }
    });
    var sum = 0; for (i = 0; i < 12; i++) sum += chroma[i];
    var cn = Array.prototype.map.call(chroma, function (v) { return sum ? v / sum : 0; });
    var sorted = midis.slice().sort(function (a, b) { return a - b; });
    var top = pcCount.map(function (c, pc) { return { pc: pc, c: c }; }).sort(function (a, b) { return b.c - a.c; }).filter(function (x) { return x.c > 0; }).slice(0, 3).map(function (x) { return x.pc; });
    return { chroma: cn, med: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null, lo: sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : null, hi: sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : null, top: top, frames: midis.length };
  }
  function cosine(a, b) { var d = 0, x = 0, y = 0; for (var i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? d / Math.sqrt(x * y) : 0; }
  function decodeArray(ab) {
    var AC = window.AudioContext || window.webkitAudioContext, ctx = new AC();
    return new Promise(function (res, rej) { ctx.decodeAudioData(ab, res, rej); }).then(function (buf) { try { ctx.close(); } catch (e) {} return buf; });
  }
  function analyzeUrl(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error('fetch'); return r.arrayBuffer(); }).then(decodeArray).then(analyzeBuffer); }
  function analyzeFile(file) { return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = rej; fr.readAsArrayBuffer(file); }).then(decodeArray).then(analyzeBuffer); }

  function renderNoteReport(host, items) {
    // items: [{name, a}]
    var bars = '', labels = '', legend = '';
    for (var pc = 0; pc < 12; pc++) {
      var maxv = Math.max.apply(null, items.map(function (it) { return Math.max.apply(null, it.a.chroma); })) || 1;
      bars += '<div class="cmp-bar-col">' + items.map(function (it, idx) { return '<i style="height:' + Math.max(2, it.a.chroma[pc] / maxv * 100) + '%;background:' + COLORS[idx % 3] + '" title="' + esc(it.name) + ': ' + Math.round(it.a.chroma[pc] * 100) + '%"></i>'; }).join('') + '</div>';
      labels += '<span>' + pcName(pc) + '</span>';
    }
    legend = items.map(function (it, idx) { return '<span><i style="background:' + COLORS[idx % 3] + '"></i>' + esc(it.name) + '</span>'; }).join('');
    var lines = items.map(function (it) {
      return '<li><b>' + esc(it.name) + '</b>: nốt nổi bật ' + (it.a.top.length ? it.a.top.map(pcName).join(', ') : '—') +
        (it.a.med != null ? ' · cao độ trung bình ≈ <b>' + noteName(it.a.med) + '</b> (từ ' + noteName(it.a.lo) + ' đến ' + noteName(it.a.hi) + ')' : '') + '</li>';
    }).join('');
    var sim = '';
    if (items.length >= 2) {
      var pairs = [];
      for (var x = 0; x < items.length; x++) for (var y = x + 1; y < items.length; y++) {
        var c = Math.round(cosine(items[x].a.chroma, items[y].a.chroma) * 100), d = items[y].a.med != null && items[x].a.med != null ? items[y].a.med - items[x].a.med : null;
        pairs.push('<li><b>' + esc(items[x].name) + '</b> và <b>' + esc(items[y].name) + '</b>: giống nhau khoảng <b>' + c + '%</b> về phân bố nốt nhạc' +
          (d != null ? '; ' + (d === 0 ? 'cao độ trung bình tương đương' : esc(items[d > 0 ? y : x].name) + ' cao hơn khoảng ' + Math.abs(d) + ' bán cung') : '') + '.</li>');
      }
      sim = '<ul>' + pairs.join('') + '</ul>';
    }
    host.innerHTML = '<div class="cmp-legend">' + legend + '</div><div class="cmp-bars">' + bars + '</div><div class="cmp-bar-labels">' + labels + '</div>' +
      '<div class="cmp-result"><b>Kết quả phân tích</b><ul>' + lines + '</ul>' + (sim ? '<b>So sánh</b>' + sim : '') +
      '<p style="margin:8px 0 0;font-size:12px;color:#766456">Phân tích tự động trên trình duyệt, chỉ mang tính tham khảo. Cột cao = nốt đó xuất hiện nhiều hơn trong đoạn âm thanh.</p></div>';
  }

  function renderCompare() {
    var host = $('#nc-compare'); if (!host) return;
    var list = read(CMP);
    if (!list.length) { host.innerHTML = '<div class="nc-empty">Chưa có sản phẩm nào để so sánh. Bấm nút <b>So sánh</b> ở từng sản phẩm (tối đa 3).<br><br><a class="nc-btn nc-btn-dark" href="/collections/all">Chọn sản phẩm</a></div>'; return; }
    host.innerHTML = '<div class="nc-empty">Đang tải…</div>';
    Promise.all(list.map(function (h) { return fetchJSON('/products/' + encodeURIComponent(h) + '.js').catch(function () { return null; }); })).then(function (items) {
      items = items.filter(Boolean);
      if (!items.length) { host.innerHTML = '<div class="nc-empty">Không tải được sản phẩm.</div>'; return; }
      var sounds = window.NC_SOUNDS || {};
      var prices = items.map(function (p) { return p.price / 100; }), minP = Math.min.apply(null, prices);

      // thẻ đầu trang
      var html = '<div class="cmp-hero">' + items.map(function (p) {
        return '<div class="cmp-hero-card"><img src="' + esc(img(p.featured_image, '400x400')) + '" alt=""><div class="cmp-name"><a href="' + esc(p.url) + '">' + esc(p.title) + '</a></div><div class="cmp-price">' + fmtVND(p.price / 100) + '</div></div>';
      }).join('') + '</div>';

      // chênh lệch giá
      var diff = '';
      if (items.length === 2) {
        var a = items[0], b = items[1], d = Math.abs(a.price - b.price) / 100;
        if (d === 0) diff = 'Hai sản phẩm có <b>giá bằng nhau</b>.';
        else {
          var cheap = a.price < b.price ? a : b, dear = cheap === a ? b : a, pct = Math.round(d / (dear.price / 100) * 100);
          diff = '<b>' + esc(cheap.title) + '</b> rẻ hơn <b>' + esc(dear.title) + '</b> là <b>' + fmtVND(d) + '</b> (khoảng ' + pct + '%).<br>Hay nói cách khác, <b>' + esc(dear.title) + '</b> đắt hơn <b>' + fmtVND(d) + '</b>.';
        }
      } else if (items.length >= 3) {
        diff = 'Rẻ nhất: <b>' + esc(items[prices.indexOf(minP)].title) + '</b> (' + fmtVND(minP) + ')<ul>' + items.map(function (p) {
          var d = p.price / 100 - minP; return '<li>' + esc(p.title) + ': ' + (d === 0 ? 'giá thấp nhất' : 'đắt hơn <b>' + fmtVND(d) + '</b> so với món rẻ nhất') + '</li>';
        }).join('') + '</ul>';
      }
      if (diff) html += '<div class="cmp-diff"><b>💰 Chênh lệch giá</b><br>' + diff + '</div>';

      function row(label, fn) { return '<tr><td>' + label + '</td>' + items.map(function (p, i) { return '<td>' + fn(p, i) + '</td>'; }).join('') + '</tr>'; }
      html += '<div class="nc-scroll-x"><table class="nc-table cmp-table"><tbody>' +
        row('Giá', function (p) { return '<span class="' + (items.length > 1 && p.price / 100 === minP ? 'cmp-best' : '') + '">' + fmtVND(p.price / 100) + '</span>' + (p.compare_at_price > p.price ? '<br><s>' + fmtVND(p.compare_at_price / 100) + '</s>' : ''); }) +
        (items.length > 1 ? row('So với món rẻ nhất', function (p) { var d = p.price / 100 - minP; return d === 0 ? '<span class="cmp-min">Rẻ nhất</span>' : '<span class="cmp-plus">+' + fmtVND(d) + '</span>'; }) : '') +
        row('Thương hiệu', function (p) { return esc(p.vendor || '—'); }) +
        row('Loại', function (p) { return esc(p.type || '—'); }) +
        row('Phiên bản', function (p) { return p.variants.length > 1 ? p.variants.length + ' lựa chọn' : '1'; }) +
        row('Tình trạng', function (p) { return p.available ? '<span style="color:#3f7d4e">Còn hàng</span>' : '<span style="color:#9b2c2c">Hết hàng</span>'; }) +
        row('Nghe thử', function (p) { return sounds[p.handle] ? '<div class="cmp-sound-row"><button type="button" class="nc-play" data-nc-play="' + esc(sounds[p.handle]) + '" aria-label="Nghe thử">&#9654;</button>Nghe mẫu</div>' : '<span class="cmp-sound-row">Chưa có mẫu âm thanh</span>'; }) +
        row('Mô tả ngắn', function (p) { var t = stripHtml(p.description); return esc(t.length > 170 ? t.slice(0, 170) + '…' : t || '—'); }) +
        row('', function (p) { return '<a class="nc-btn nc-btn-dark nc-btn-small" href="' + esc(p.url) + '">Xem</a> <button type="button" class="nc-btn nc-btn-small nc-btn-ghost" data-nc-compare="' + esc(p.handle) + '">Bỏ</button>'; }) +
        '</tbody></table></div>';

      // so sánh nốt nhạc
      var withSound = items.filter(function (p) { return sounds[p.handle]; });
      html += '<h2 class="cmp-section">🎼 So sánh nốt nhạc giữa các file mp3</h2>';
      if (withSound.length >= 2) {
        html += '<p class="nc-lead">Phân tích file âm thanh mẫu của các sản phẩm đang so sánh: nốt nổi bật, cao độ trung bình và độ giống nhau.</p><button type="button" class="nc-btn nc-btn-primary" id="cmp-analyze">Phân tích nốt nhạc</button><div id="cmp-report" style="margin-top:12px"></div>';
      } else {
        html += '<p class="nc-lead">Cần ít nhất 2 sản phẩm có mẫu âm thanh để so sánh tự động (gắn file mp3 cho sản phẩm trong metafield <code>custom.sound_url</code>). Bạn cũng có thể tự chọn 2 file bên dưới.</p>';
      }
      html += '<h3 style="margin:22px 0 4px;font-size:16px">Hoặc so sánh 2 file mp3 / âm thanh bất kỳ</h3>' +
        '<div class="cmp-upload"><div><label>File A</label><input type="file" accept="audio/*" id="cmp-fa"></div><div><label>File B</label><input type="file" accept="audio/*" id="cmp-fb"></div></div>' +
        '<button type="button" class="nc-btn nc-btn-dark nc-btn-small" id="cmp-analyze-files">So sánh 2 file</button><div id="cmp-report-files" style="margin-top:12px"></div>';
      host.innerHTML = html;

      var bA = $('#cmp-analyze');
      if (bA) bA.addEventListener('click', function () {
        var rep = $('#cmp-report'); bA.disabled = true; rep.innerHTML = '<div class="nc-loading">Đang phân tích âm thanh… (vài giây)</div>';
        Promise.all(withSound.map(function (p) { return analyzeUrl(sounds[p.handle]).then(function (a) { return { name: p.title, a: a }; }); })).then(function (res) {
          renderNoteReport(rep, res); bA.disabled = false;
        }).catch(function () {
          rep.innerHTML = '<div class="nc-alert err">Không tải được file âm thanh để phân tích (có thể do trình duyệt chặn). Hãy dùng phần "so sánh 2 file" bên dưới.</div>'; bA.disabled = false;
        });
      });
      $('#cmp-analyze-files').addEventListener('click', function () {
        var fa = $('#cmp-fa').files[0], fb = $('#cmp-fb').files[0], rep = $('#cmp-report-files');
        if (!fa || !fb) { rep.innerHTML = '<div class="nc-alert err">Hãy chọn đủ 2 file.</div>'; return; }
        rep.innerHTML = '<div class="nc-loading">Đang phân tích âm thanh…</div>';
        Promise.all([analyzeFile(fa), analyzeFile(fb)]).then(function (r) {
          renderNoteReport(rep, [{ name: fa.name, a: r[0] }, { name: fb.name, a: r[1] }]);
        }).catch(function () { rep.innerHTML = '<div class="nc-alert err">Không đọc được file âm thanh.</div>'; });
      });
    });
  }

  /* ================= 6. TRANG YÊU THÍCH ================= */
  function renderWishlist() {
    var host = $('#nc-wishlist'); if (!host) return;
    var list = read(WISH);
    if (!list.length) { host.innerHTML = '<div class="nc-empty">Bạn chưa có sản phẩm yêu thích nào.<br>Bấm biểu tượng ♡ trên sản phẩm để lưu lại.<br><br><a class="nc-btn nc-btn-dark" href="/collections/all">Khám phá cửa hàng</a></div>'; return; }
    host.innerHTML = '<div class="nc-empty">Đang tải…</div>';
    Promise.all(list.map(function (h) { return fetchJSON('/products/' + encodeURIComponent(h) + '.js').catch(function () { return null; }); })).then(function (items) {
      items = items.filter(Boolean);
      items.sort(function (a, b) { return (b.compare_at_price > b.price ? 1 : 0) - (a.compare_at_price > a.price ? 1 : 0); });
      var saleN = items.filter(function (p) { return p.compare_at_price > p.price; }).length;
      var html = '<div class="wl-top"><span>Bạn có <b>' + items.length + '</b> sản phẩm yêu thích' + (saleN ? ' · <span class="wl-sale-tag">' + saleN + ' món đang giảm giá 🔥</span>' : '') + '</span>' +
        '<span><a class="nc-btn nc-btn-ghost nc-btn-small" href="/pages/so-sanh">Xem so sánh</a> <button type="button" class="nc-btn nc-btn-ghost nc-btn-small" data-wl-clear>Xoá tất cả</button></span></div><div class="wl-grid">';
      items.forEach(function (p) {
        var sale = p.compare_at_price > p.price, off = sale ? Math.round((p.compare_at_price - p.price) / p.compare_at_price * 100) : 0;
        var v = p.variants.filter(function (x) { return x.available; })[0];
        html += '<div class="wl-card' + (sale ? ' is-sale' : '') + '">' +
          (sale ? '<span class="nc-badge sale" style="position:absolute;z-index:2;top:18px;left:18px">-' + off + '%</span>' : '') +
          '<a class="wl-img" href="' + esc(p.url) + '"><img loading="lazy" src="' + esc(img(p.featured_image, '600x600')) + '" alt="' + esc(p.title) + '"></a>' +
          '<div class="wl-name"><a href="' + esc(p.url) + '">' + esc(p.title) + '</a></div>' +
          (p.vendor ? '<div class="wl-vendor">Hãng: ' + esc(p.vendor) + '</div>' : '') +
          '<div class="wl-price">' + fmtVND(p.price / 100) + (sale ? '<s>' + fmtVND(p.compare_at_price / 100) + '</s>' : '') + '</div>' +
          '<div class="wl-stock' + (p.available ? '' : ' is-out') + '">' + (p.available ? 'Còn hàng' : 'Hết hàng') + '</div>' +
          '<div class="wl-actions">' +
          (v ? '<button type="button" class="nc-btn nc-btn-primary" data-wl-add="' + v.id + '">Thêm vào giỏ</button>' : '<span class="nc-btn is-disabled" style="grid-column:1/-1">Hết hàng</span>') +
          '<a class="nc-btn nc-btn-dark" href="' + esc(p.url) + '">Chi tiết</a>' +
          '<button type="button" class="nc-btn nc-btn-ghost" data-nc-wish="' + esc(p.handle) + '">Bỏ thích</button></div></div>';
      });
      host.innerHTML = html + '</div>';
      document.dispatchEvent(new CustomEvent('nc:refresh-state'));
    });
  }
  document.addEventListener('click', function (e) {
    var add = e.target.closest('[data-wl-add]');
    if (add) {
      add.disabled = true;
      fetch('/cart/add.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ id: +add.getAttribute('data-wl-add'), quantity: 1 }] }) })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function () { toast('Đã thêm vào giỏ hàng. <a href="/cart">Xem giỏ</a>'); return fetchJSON('/cart.js'); })
        .then(function (c) { var s = $('a[href="/cart"] span'); if (s) s.innerHTML = 'GIỎ HÀNG (' + c.item_count + ')'; })
        .catch(function () { toast('Không thêm được vào giỏ. Thử lại nhé.'); })
        .then(function () { add.disabled = false; });
      return;
    }
    if (e.target.closest('[data-wl-clear]')) { if (confirm('Xoá toàn bộ danh sách yêu thích?')) { write(WISH, []); fire('nc:change'); } }
  });

  /* ================= 7. TOAST khi thêm / bỏ yêu thích ================= */
  var lastWish = read(WISH).length;
  document.addEventListener('nc:change', function () {
    var n = read(WISH).length;
    if (n > lastWish) toast('♥ Đã thêm vào Yêu thích. <a href="/pages/yeu-thich">Xem danh sách</a>');
    else if (n < lastWish && !$('#nc-wishlist')) toast('Đã bỏ khỏi Yêu thích.');
    lastWish = n;
    renderWishlist(); renderCompare();
  });
  window.addEventListener('storage', function () { lastWish = read(WISH).length; });

  document.addEventListener('DOMContentLoaded', function () {
    initBell(); initMelody(); initMelodyPage(); initAI(); initSound(); renderCompare(); renderWishlist();
  });
})();
