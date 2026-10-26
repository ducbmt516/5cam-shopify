/* ==========================================================
   NĂM CAM — audio-separator.js
   Công cụ tách âm thanh chạy NGAY TRÊN TRÌNH DUYỆT:
   - Nhạc nền (giảm giọng hát ở giữa), Bass, Phần giọng/âm thanh ở giữa  -> file WAV nghe + tải được
   - Phổ nốt nhạc (giai điệu chính, đơn âm) -> piano roll + file MIDI
   - Tuỳ chọn: nếu section có "Địa chỉ API" (https) thì gửi thêm file lên máy chủ AI để lấy các stem AI.
   Đây là xử lý bằng thuật toán (không phải AI), nên chỉ mang tính tham khảo.
   ========================================================== */
(function () {
  'use strict';

  var root = document.querySelector('[data-audio-separator]');
  if (!root) return;

  var MAX_BYTES = 15 * 1024 * 1024;     // 15 MB
  var MAX_SECONDS = 240;                // chỉ xử lý 4 phút đầu cho nhẹ máy
  var SERVER_TIMEOUT = 120000;
  var endpoint = (root.getAttribute('data-endpoint') || (window.NC && window.NC.separatorEndpoint) || '').trim();
  if (!/^https:\/\//i.test(endpoint)) endpoint = '';

  function q(id) { return root.querySelector('#' + id); }
  var el = {
    drop: q('dropZone'), input: q('audioInput'), error: q('separatorError'), loading: q('loadingArea'),
    loadingText: q('loadingText'), fill: q('progressFill'), results: q('resultsArea'), fileInfo: q('fileInfo'),
    notice: q('separatorNotice'), stems: q('stemsGrid'), midiBtn: q('downloadMidiBtn'), canvas: q('midiCanvas'),
    stats: q('midiStats'), again: q('againBtn')
  };
  var objectUrls = [], runId = 0;

  /* ---------- tiện ích ---------- */
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtTime(s) { s = Math.round(s); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function setProgress(pct, text) { el.fill.style.width = Math.max(0, Math.min(100, pct)) + '%'; if (text) el.loadingText.textContent = text; }
  function showError(msg) { el.error.textContent = msg; el.error.hidden = false; }
  function clearError() { el.error.textContent = ''; el.error.hidden = true; }
  function track(url) { objectUrls.push(url); return url; }
  function revokeUrls() { objectUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} }); objectUrls = []; }
  var NOTE_VN = ['Đô', 'Đô♯', 'Rê', 'Rê♯', 'Mi', 'Pha', 'Pha♯', 'Son', 'Son♯', 'La', 'La♯', 'Si'];
  function noteName(m) { return NOTE_VN[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }

  /* ---------- bộ lọc (biquad RBJ) ---------- */
  function biquad(type, fc, sr) {
    var w0 = 2 * Math.PI * Math.min(fc, sr / 2 - 1) / sr, cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * 0.7071), b0, b1, b2;
    if (type === 'lp') { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; }
    else { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; }
    var a0 = 1 + alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: -2 * cos / a0, a2: (1 - alpha) / a0 };
  }
  function filter(x, c) {
    var y = new Float32Array(x.length), x1 = 0, x2 = 0, y1 = 0, y2 = 0, i, v;
    for (i = 0; i < x.length; i++) {
      v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }
  function lowpass(x, fc, sr) { var c = biquad('lp', fc, sr); return filter(filter(x, c), c); }      // 24 dB/oct
  function highpass(x, fc, sr) { var c = biquad('hp', fc, sr); return filter(filter(x, c), c); }
  function decimate(x, f) { if (f <= 1) return x; var y = new Float32Array(Math.floor(x.length / f)); for (var i = 0; i < y.length; i++) y[i] = x[i * f]; return y; }
  function rms(x) { var s = 0; for (var i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / (x.length || 1)); }
  function normalize(x) {
    var peak = 0, i; for (i = 0; i < x.length; i++) { var a = Math.abs(x[i]); if (a > peak) peak = a; }
    if (peak < 1e-6) return x;
    var g = Math.min(0.92 / peak, 30), y = new Float32Array(x.length);
    for (i = 0; i < x.length; i++) y[i] = x[i] * g;
    return y;
  }

  /* ---------- WAV 16-bit mono ---------- */
  function wavBlob(samples, sr) {
    var n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), i;
    function str(o, s) { for (var k = 0; k < s.length; k++) v.setUint8(o + k, s.charCodeAt(k)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    for (i = 0; i < n; i++) { var s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true); }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /* ---------- dò giai điệu chính (thuật toán YIN, đơn âm) ---------- */
  function medianOf(arr) { var s = arr.slice().sort(function (a, b) { return a - b; }); return s[Math.floor(s.length / 2)]; }

  async function extractNotes(x, sr, onProgress) {
    var W = 1024, hop = 1024, TH = 0.2;
    var tauMin = Math.max(2, Math.floor(sr / 1000)), tauMax = Math.floor(sr / 100);       // 100–1000 Hz
    var frames = Math.max(0, Math.floor((x.length - W - tauMax) / hop) + 1), f, i, tau, j;
    if (frames < 4) return [];
    var energies = new Float64Array(frames), mx = 0;
    for (f = 0; f < frames; f++) { var s0 = 0; for (i = 0; i < W; i += 2) { var v = x[f * hop + i]; s0 += v * v; } energies[f] = s0; if (s0 > mx) mx = s0; }
    var d = new Float64Array(tauMax + 2), cm = new Float64Array(tauMax + 2), midis = new Array(frames);
    for (f = 0; f < frames; f++) {
      midis[f] = -1;
      if (energies[f] >= mx * 0.003) {                                  // bỏ khung quá nhỏ so với đoạn to nhất
        var base = f * hop, run = 0;
        for (tau = 1; tau <= tauMax; tau++) {
          var s = 0; for (j = 0; j < W; j++) { var df = x[base + j] - x[base + j + tau]; s += df * df; }
          d[tau] = s; run += s; cm[tau] = run > 0 ? s * tau / run : 1;
        }
        var est = -1;
        for (tau = tauMin; tau < tauMax; tau++) {
          if (cm[tau] < TH) { while (tau + 1 < tauMax && cm[tau + 1] < cm[tau]) tau++; est = tau; break; }
        }
        if (est > 1) {
          var y1 = cm[est - 1], y2 = cm[est], y3 = cm[est + 1], den = y1 - 2 * y2 + y3, off = den ? 0.5 * (y1 - y3) / den : 0;
          if (Math.abs(off) > 1) off = 0;
          midis[f] = Math.round(69 + 12 * Math.log2((sr / (est + off)) / 440));
        }
      }
      if (f % 200 === 0) { onProgress(f / frames); await tick(); }
    }
    // làm mượt: trung vị 5 khung trên các khung có tiếng
    var sm = new Array(frames);
    for (f = 0; f < frames; f++) {
      if (midis[f] < 0) { sm[f] = -1; continue; }
      var w5 = []; for (var dd = -2; dd <= 2; dd++) { var g = midis[f + dd]; if (g != null && g > 0) w5.push(g); }
      sm[f] = w5.length >= 3 ? medianOf(w5) : -1;
    }
    var notes = [], runStart = 0, cur = -1, minFrames = 3, cap = 1500, shift = W / 2;
    function push(s, e, p) {
      if (p > 0 && e - s >= minFrames && notes.length < cap) {
        var vel = 0, z; for (z = s; z < e; z++) vel += energies[z];
        vel = Math.max(55, Math.min(115, Math.round(55 + 60 * Math.sqrt((vel / (e - s)) / (mx || 1)))));
        notes.push({ pitch: p, start: (s * hop + shift) / sr, end: (e * hop + shift) / sr, velocity: vel });
      }
    }
    for (f = 0; f <= frames; f++) {
      var pp = f < frames ? sm[f] : -2;
      if (pp !== cur) { push(runStart, f, cur); runStart = f; cur = pp; }
    }
    return notes;
  }

  /* ---------- MIDI (SMF format 0) ---------- */
  function vlq(n) { var bytes = [n & 0x7F]; while ((n >>= 7)) bytes.unshift((n & 0x7F) | 0x80); return bytes; }
  function midiBlob(notes) {
    var TPQ = 480, TPS = TPQ * 2, ev = [];       // 120 BPM -> 960 tick/giây
    notes.forEach(function (n) {
      var on = Math.round(n.start * TPS), off = Math.max(on + 1, Math.round(n.end * TPS));
      ev.push({ t: on, order: 1, d: [0x90, n.pitch, n.velocity || 90] }, { t: off, order: 0, d: [0x80, n.pitch, 0] });
    });
    ev.sort(function (a, b) { return a.t - b.t || a.order - b.order; });
    var data = [0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20], last = 0;      // tempo 500000 µs / phách
    ev.forEach(function (e) { data = data.concat(vlq(e.t - last), e.d); last = e.t; });
    data = data.concat([0x00, 0xFF, 0x2F, 0x00]);
    var head = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (TPQ >> 8) & 255, TPQ & 255];
    var len = data.length, trk = [0x4D, 0x54, 0x72, 0x6B, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255];
    return new Blob([new Uint8Array(head.concat(trk, data))], { type: 'audio/midi' });
  }

  /* ---------- vẽ phổ nốt (piano roll) ---------- */
  function drawPianoRoll(notes) {
    var c = el.canvas, dpr = window.devicePixelRatio || 1, W = Math.max(320, c.parentNode.clientWidth || 800), H = 240;
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    var g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#1e1b19'; g.fillRect(0, 0, W, H);
    if (!notes.length) {
      g.fillStyle = '#b9a99a'; g.font = '14px Georgia, serif'; g.fillText('Không phát hiện được giai điệu rõ ràng trong đoạn này.', 20, H / 2); return;
    }
    var lo = Infinity, hi = -Infinity, maxT = 0;
    notes.forEach(function (n) { if (n.pitch < lo) lo = n.pitch; if (n.pitch > hi) hi = n.pitch; if (n.end > maxT) maxT = n.end; });
    lo -= 2; hi += 2;
    var left = 42, top = 8, bottom = 22, pw = W - left - 10, ph = H - top - bottom, rows = hi - lo + 1, rh = ph / rows;
    g.font = '11px Georgia, serif'; g.textBaseline = 'middle';
    for (var p = lo; p <= hi; p++) {
      var y = top + (hi - p) * rh;
      if (p % 12 === 0) { g.strokeStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.moveTo(left, y + rh); g.lineTo(W - 10, y + rh); g.stroke(); g.fillStyle = '#b9a99a'; g.textAlign = 'right'; g.fillText(noteName(p), left - 6, y + rh / 2); }
      else if ([1, 3, 6, 8, 10].indexOf(p % 12) > -1) { g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(left, y, pw, rh); }
    }
    g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = '#b9a99a';
    var stepS = maxT > 120 ? 30 : maxT > 40 ? 10 : 5;
    for (var t = 0; t <= maxT; t += stepS) { var tx = left + (t / maxT) * pw; g.fillText(fmtTime(t), tx, H - 6); g.strokeStyle = 'rgba(255,255,255,.07)'; g.beginPath(); g.moveTo(tx, top); g.lineTo(tx, top + ph); g.stroke(); }
    g.fillStyle = '#f0a04b';
    notes.forEach(function (n) {
      var x = left + (n.start / maxT) * pw, w = Math.max(2, ((n.end - n.start) / maxT) * pw), y = top + (hi - n.pitch) * rh;
      g.fillRect(x, y + 0.5, w, Math.max(3, rh - 1));
    });
  }

  /* ---------- hiển thị kết quả ---------- */
  function addStemCard(s) {
    var card = document.createElement('div'); card.className = 'stem-card' + (s.ai ? ' is-ai' : '');
    var h = document.createElement('h4'); h.textContent = s.label; card.appendChild(h);
    if (s.desc) { var p = document.createElement('p'); p.textContent = s.desc; card.appendChild(p); }
    var a = document.createElement('audio'); a.controls = true; a.preload = 'metadata'; a.src = s.url; card.appendChild(a);
    var dl = document.createElement('a'); dl.href = s.url; dl.textContent = 'Tải file'; dl.setAttribute('download', s.filename || 'stem.wav');
    if (s.ai) { dl.target = '_blank'; dl.rel = 'noopener'; }
    card.appendChild(dl);
    el.stems.appendChild(card);
  }
  function showResults(info) {
    el.loading.hidden = true; el.results.hidden = false;
    el.fileInfo.textContent = info.fileName + ' · ' + fmtTime(info.duration) + (info.truncated ? ' (đã xử lý ' + fmtTime(info.processed) + ' đầu)' : '') + ' · ' + info.channels + ' kênh';
    el.notice.innerHTML = info.noticeHTML;
    drawPianoRoll(info.notes);
    if (info.notes.length) {
      var lo = Math.min.apply(null, info.notes.map(function (n) { return n.pitch; })), hi = Math.max.apply(null, info.notes.map(function (n) { return n.pitch; }));
      el.stats.textContent = info.notes.length + ' nốt · dải âm ' + noteName(lo) + ' – ' + noteName(hi) + ' · ước lượng giai điệu chính (đơn âm), không phải toàn bộ bản phối.';
      el.midiBtn.href = track(URL.createObjectURL(midiBlob(info.notes))); el.midiBtn.setAttribute('download', info.baseName + '.mid'); el.midiBtn.hidden = false;
    } else { el.stats.textContent = 'Chưa dò được nốt nào rõ ràng.'; el.midiBtn.hidden = true; }
  }
  function resetView() {
    el.loading.hidden = true; el.results.hidden = true; el.drop.hidden = false; el.fill.style.width = '0%'; el.input.value = '';
  }

  /* ---------- máy chủ AI (tuỳ chọn) ---------- */
  var AI_LABELS = { vocal: 'Giọng hát (AI)', vocals: 'Giọng hát (AI)', drums: 'Trống (AI)', bass: 'Bass (AI)', piano: 'Piano (AI)', guitar: 'Guitar (AI)', other: 'Nhạc cụ khác (AI)', instrumental: 'Nhạc nền không giọng (AI)' };
  function callServer(file) {
    var ctl = ('AbortController' in window) ? new AbortController() : null, timer = setTimeout(function () { if (ctl) ctl.abort(); }, SERVER_TIMEOUT), fd = new FormData();
    fd.append('audio', file);
    return fetch(endpoint, { method: 'POST', body: fd, signal: ctl ? ctl.signal : undefined }).then(function (r) {
      clearTimeout(timer); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
    }).then(function (data) {
      if (!data || data.error || !data.stems || typeof data.stems !== 'object') throw new Error((data && data.error) || 'Dữ liệu không hợp lệ');
      return data;
    });
  }

  /* ---------- luồng chính ---------- */
  async function handleFile(file) {
    clearError();
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var okExt = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac'].indexOf(ext) > -1;
    if (!(String(file.type).indexOf('audio/') === 0 || okExt)) { showError('Vui lòng chọn file âm thanh (MP3, WAV, M4A, OGG).'); return; }
    if (file.size > MAX_BYTES) { showError('File nặng ' + (file.size / 1048576).toFixed(1) + ' MB, vượt giới hạn 15 MB. Hãy chọn file nhỏ hơn hoặc cắt bớt.'); return; }

    var id = ++runId; revokeUrls(); el.stems.innerHTML = '';
    el.drop.hidden = true; el.results.hidden = true; el.loading.hidden = false; setProgress(4, 'Đang đọc file âm thanh…');
    try {
      await tick();
      var bytes = await file.arrayBuffer();
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('unsupported');
      setProgress(10, 'Đang giải mã âm thanh…');
      var ctx = new AC(), buffer;
      try { buffer = await new Promise(function (res, rej) { ctx.decodeAudioData(bytes, res, rej); }); }
      catch (e) { throw new Error('decode'); }
      finally { try { ctx.close(); } catch (e) {} }
      if (id !== runId) return;

      var sr = buffer.sampleRate, total = buffer.length, n = Math.min(total, Math.floor(sr * MAX_SECONDS));
      if (n < sr * 1) throw new Error('short');
      var L = buffer.getChannelData(0).subarray(0, n), R = (buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)).subarray(0, n);
      var mid = new Float32Array(n), side = new Float32Array(n), i;
      for (i = 0; i < n; i++) { mid[i] = (L[i] + R[i]) * 0.5; side[i] = (L[i] - R[i]) * 0.5; }
      var stereo = buffer.numberOfChannels > 1 && rms(side) > 0.03 * rms(mid);
      var baseName = (file.name.replace(/\.[^.]+$/, '') || 'bai-hat').replace(/[^\w\-.]+/g, '_').slice(0, 40);

      // --- các stem xử lý trên máy ---
      setProgress(22, 'Đang tách nhạc nền, bass và phần giọng…'); await tick();
      var bassLP = lowpass(mid, 150, sr), stems = [];
      if (stereo) {
        var inst = new Float32Array(n), bass120 = lowpass(mid, 120, sr);
        for (i = 0; i < n; i++) inst[i] = side[i] * 2 + bass120[i] * 0.8;
        stems.push({ label: 'Nhạc nền (đã giảm giọng hát)', desc: 'Trừ kênh trái – phải để giảm âm thanh đặt ở giữa (thường là giọng hát); bass được giữ lại. Chất lượng phụ thuộc cách phối.', blob: wavBlob(normalize(inst), sr), filename: baseName + '-nhac-nen.wav' });
      }
      await tick();
      var bassOut = decimate(bassLP, Math.max(1, Math.floor(sr / 11025)));
      stems.push({ label: 'Bass', desc: 'Lọc lấy tần số thấp (dưới 150 Hz): bass và trống bass.', blob: wavBlob(normalize(bassOut), Math.round(sr / Math.max(1, Math.floor(sr / 11025)))), filename: baseName + '-bass.wav' });
      var voiceBand = lowpass(highpass(mid, 250, sr), 4200, sr), vf = Math.max(1, Math.floor(sr / 22050)), voiceOut = decimate(voiceBand, vf);
      stems.push({ label: 'Giọng & âm thanh ở giữa', desc: 'Phần âm thanh ở giữa trong dải 250–4200 Hz (thường là giọng hát, nhưng có thể lẫn nhạc cụ đặt giữa).', blob: wavBlob(normalize(voiceOut), Math.round(sr / vf)), filename: baseName + '-giua.wav' });
      stems.forEach(function (s) { s.url = track(URL.createObjectURL(s.blob)); addStemCard(s); });
      if (id !== runId) return;

      // --- dò nốt nhạc ---
      setProgress(40, 'Đang dò giai điệu chính…');
      var notes = await extractNotes(voiceOut, sr / vf, function (p) { if (id === runId) setProgress(40 + Math.round(p * 52), 'Đang dò giai điệu chính… ' + Math.round(p * 100) + '%'); });
      if (id !== runId) return;
      setProgress(96, 'Đang dựng kết quả…'); await tick();

      var notice = '<b>Xử lý ngay trên trình duyệt của bạn</b> — file không được gửi đi đâu. Đây là tách bằng thuật toán tần số và âm thanh nổi (không phải AI), nên chỉ mang tính tham khảo. ' +
        (stereo ? '' : '<b>File này gần như mono</b> nên không giảm được giọng hát. ') +
        'Trống, piano, guitar chưa tách riêng được' + (endpoint ? '' : '; muốn tách bằng AI cần kết nối máy chủ xử lý') + '.';
      showResults({ fileName: file.name, baseName: baseName, duration: total / sr, processed: n / sr, truncated: n < total, channels: buffer.numberOfChannels, notes: notes, noticeHTML: notice });
      setProgress(100);

      // --- máy chủ AI (nếu có cấu hình) ---
      if (endpoint) {
        el.notice.innerHTML += '<br><i>Đang gửi file tới máy chủ AI để tách chi tiết hơn…</i>';
        callServer(file).then(function (data) {
          if (id !== runId) return;
          var added = 0;
          Object.keys(data.stems).forEach(function (key) {
            var url = data.stems[key];
            if (typeof url === 'string' && /^https:\/\//i.test(url)) { addStemCard({ label: AI_LABELS[key] || (key + ' (AI)'), url: url, ai: true, filename: key + '.wav' }); added++; }
          });
          el.notice.innerHTML = el.notice.innerHTML.replace(/<br><i>.*?<\/i>/, '<br><b>' + (added ? 'Đã nhận ' + added + ' stem từ máy chủ AI (thẻ viền đen).' : 'Máy chủ AI không trả về stem nào.') + '</b>');
        }).catch(function () {
          if (id !== runId) return;
          el.notice.innerHTML = el.notice.innerHTML.replace(/<br><i>.*?<\/i>/, '<br><b>Không kết nối được máy chủ AI — đang hiển thị kết quả xử lý trên máy bạn.</b>');
        });
      }
    } catch (e) {
      if (id !== runId) return;
      var m = e && e.message;
      resetView();
      showError(m === 'decode' ? 'Không đọc được file âm thanh này. Hãy thử file MP3, WAV, M4A hoặc OGG khác.'
        : m === 'short' ? 'File quá ngắn (cần ít nhất 1 giây).'
        : m === 'unsupported' ? 'Trình duyệt này chưa hỗ trợ xử lý âm thanh. Hãy dùng Chrome, Edge, Safari hoặc Firefox bản mới.'
        : 'Có lỗi khi xử lý file. Hãy thử file khác hoặc tải lại trang.');
      if (window.console) console.error(e);
    }
  }

  /* ---------- sự kiện ---------- */
  el.drop.addEventListener('click', function () { el.input.click(); });
  el.drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.input.click(); } });
  el.drop.addEventListener('dragover', function (e) { e.preventDefault(); el.drop.classList.add('dragover'); });
  el.drop.addEventListener('dragleave', function () { el.drop.classList.remove('dragover'); });
  el.drop.addEventListener('drop', function (e) {
    e.preventDefault(); el.drop.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  el.input.addEventListener('change', function (e) { if (e.target.files && e.target.files.length) handleFile(e.target.files[0]); });
  el.again.addEventListener('click', function () { runId++; revokeUrls(); el.stems.innerHTML = ''; clearError(); resetView(); });
})();
