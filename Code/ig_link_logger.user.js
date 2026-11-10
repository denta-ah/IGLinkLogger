// ==UserScript==
// @name         IG Link Logger (Excel)
// @namespace    ig-link-logger
// @version      1.7
// @description  Gulir postingan Instagram otomatis (tombol next), catat link + tanggal yang masuk rentang, simpan ke Excel
// @match        https://www.instagram.com/*
// @match        https://instagram.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      cdninstagram.com
// @connect      fbcdn.net
// @connect      instagram.com
// @noframes
// @run-at       document-idle
// ==/UserScript==

/* jshint esversion: 11, browser: true, devel: true */
/* global GM_getValue, GM_setValue, GM_xmlhttpRequest, AbortController, KeyboardEvent */

(function () {
  'use strict';
  if (window.top !== window.self) return;

  const VERSION = '1.7';

  function fatal(e) {
    console.error('[IG Link Logger] gagal start:', e);
    try {
      const b = document.createElement('div');
      b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;background:#7f1d1d;color:#fff;' +
        'padding:8px 12px;border-radius:8px;font:12px Arial,sans-serif;max-width:340px';
      b.textContent = 'IG Link Logger error: ' + (e && e.message ? e.message : e);
      (document.body || document.documentElement).appendChild(b);
    } catch (x) { /* abaikan */ }
  }

  function main() {
    /* =====================  UTIL TANGGAL  ===================== */
    // "nomor hari" = jumlah hari sejak 1970-01-01 (tanggal LOKAL) -> perbandingan tanggal bebas masalah jam/zona waktu
    const dnum = (y, m, d) => Math.round(Date.UTC(y, m, d) / 864e5);
    const todayNum = () => { const n = new Date(); return dnum(n.getFullYear(), n.getMonth(), n.getDate()); };
    const fromNum = n => new Date(n * 864e5);
    const pad = n => String(n).padStart(2, '0');
    const fmt = n => { const d = fromNum(n); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };
    const toISO = n => fromNum(n).toISOString().slice(0, 10);
    const toNum = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); return m ? dnum(+m[1], +m[2] - 1, +m[3]) : null; };

    const MONTHS = {
      january: 0, jan: 0, januari: 0, february: 1, feb: 1, februari: 1, march: 2, mar: 2, maret: 2,
      april: 3, apr: 3, may: 4, mei: 4, june: 5, jun: 5, juni: 5, july: 6, jul: 6, juli: 6,
      august: 7, aug: 7, agustus: 7, agu: 7, agt: 7, september: 8, sep: 8, sept: 8,
      october: 9, oct: 9, oktober: 9, okt: 9, november: 10, nov: 10, nop: 10,
      december: 11, dec: 11, desember: 11, des: 11
    };
    const UNIT = {
      second: 'second', detik: 'second', minute: 'minute', menit: 'minute', hour: 'hour', jam: 'hour',
      day: 'day', hari: 'day', week: 'week', minggu: 'week', month: 'month', bulan: 'month', year: 'year', tahun: 'year'
    };

    // Fallback: baca tanggal dari TEKS (dipakai bila atribut datetime tidak ada)
    //   "January 21, 2023" -> tanggal penuh | "April 25" -> tahun ini (atau tahun lalu bila hasilnya di masa depan)
    //   "6 days ago" -> hari ini dikurangi 6 hari (minggu/bulan/tahun bersifat perkiraan)
    function parseTextDate(raw) {
      if (!raw) return null;
      const s = String(raw).toLowerCase().replace(/\s+/g, ' ').trim();
      const today = todayNum();
      let m;
      if (/^(just now|now|baru saja)$/.test(s)) return today;
      if (/^(yesterday|kemarin)$/.test(s)) return today - 1;

      m = s.match(/^(\d+)\s*(second|minute|hour|day|week|month|year|detik|menit|jam|hari|minggu|bulan|tahun)s?\s*(ago|yang lalu|lalu)$/);
      if (m) {
        const n = +m[1], u = UNIT[m[2]];
        const d = new Date();
        if (u === 'second') d.setSeconds(d.getSeconds() - n);
        else if (u === 'minute') d.setMinutes(d.getMinutes() - n);
        else if (u === 'hour') d.setHours(d.getHours() - n);
        else if (u === 'day') d.setDate(d.getDate() - n);
        else if (u === 'week') d.setDate(d.getDate() - 7 * n);
        else if (u === 'month') d.setMonth(d.getMonth() - n);
        else if (u === 'year') d.setFullYear(d.getFullYear() - n);
        return dnum(d.getFullYear(), d.getMonth(), d.getDate());
      }

      let mon = null, day = null, year = null;
      m = s.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?$/);
      if (m && MONTHS[m[1]] !== undefined) { mon = MONTHS[m[1]]; day = +m[2]; year = m[3] ? +m[3] : null; }
      else {
        m = s.match(/^(\d{1,2})\s+([a-z]+)\.?(?:,?\s*(\d{4}))?$/);
        if (m && MONTHS[m[2]] !== undefined) { mon = MONTHS[m[2]]; day = +m[1]; year = m[3] ? +m[3] : null; }
      }
      if (mon === null) return null;
      if (year === null) {
        year = new Date().getFullYear();
        if (dnum(year, mon, day) > today + 1) year -= 1;
      }
      return dnum(year, mon, day);
    }

    /* =====================  STATE  ===================== */
    const KEY = 'igll_v1';
    const store = {
      load() { try { return JSON.parse(GM_getValue(KEY, '{}')) || {}; } catch (e) { return {}; } },
      save(o) { try { GM_setValue(KEY, JSON.stringify(o)); } catch (e) { /* abaikan */ } }
    };
    const saved = store.load();
    let rows = Array.isArray(saved.rows) ? saved.rows : [];
    const cfg = Object.assign({ start: todayNum() - 30, end: todayNum(), delay: 4, stopAfter: 3, savePhoto: true, autoGrid: true, nextWait: 2 }, saved.cfg || {});
    const persist = () => store.save({ rows, cfg });

    const seen = new Set();
    const order = [];                 // urutan postingan yang sudah dicek (untuk mendeteksi mundur/berulang)
    const idxOf = new Map();
    const seenCodes = new Set();      // kode postingan (tanpa jenis /p/ atau /reel/) untuk dicocokkan dengan thumbnail grid
    const codeOf = u => { const m = String(u).match(/\/(?:p|reel|reels|tv)\/([^/?#]+)/); return m ? m[1] : null; };
    const markSeen = url => { seen.add(url); seenCodes.add(codeOf(url)); idxOf.set(url, order.length); order.push(url); };
    const clearSeen = () => { seen.clear(); seenCodes.clear(); order.length = 0; idxOf.clear(); };
    let running = false, stopFlag = false, olderStreak = 0, failStreak = 0, looseMode = false;
    let seenStreak = 0, lastNewAt = 0, useLoose = false, prevIdx = -1, repeatBack = 0, recoverFails = 0, newSinceRecover = true;
    let lastPhotoKey = '', photoChain = Promise.resolve(), photoPending = 0, photoOk = 0, photoFail = 0;

    /* =====================  BACA HALAMAN IG  ===================== */
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const wait = async ms => { const t0 = Date.now(); while (Date.now() - t0 < ms && !stopFlag) await sleep(100); };
    const jeda = () => (cfg.delay + Math.random() * cfg.delay * 0.3) * 1000;

    function canonicalUrl() {
      const m = location.pathname.match(/\/(p|reel|reels|tv)\/([^/?#]+)/);
      if (!m) return null;
      const type = m[1] === 'reels' ? 'reel' : m[1];
      return `https://www.instagram.com/${type}/${m[2]}/`;
    }
    function shortcode() {
      const m = location.pathname.match(/\/(?:p|reel|reels|tv)\/([^/?#]+)/);
      return m ? m[1] : null;
    }
    function scopeEl() {
      const dialogs = [...document.querySelectorAll('div[role="dialog"]')];
      return dialogs.find(d => d.querySelector('time')) || document;
    }

    // kumpulkan <time>; "own" = milik postingan ini (bukan komentar / postingan sebelumnya)
    function collectTimes() {
      const code = shortcode();
      const all = [...scopeEl().querySelectorAll('time')].map(t => {
        const a = t.closest('a');
        const href = a ? (a.getAttribute('href') || '') : '';
        const own = !!(code && href.includes('/' + code + '/') && !/\/c\/\d/.test(href));
        return { own, iso: t.getAttribute('datetime'), texts: [t.getAttribute('title'), t.textContent] };
      });
      return { own: all.filter(x => x.own), all };
    }

    // ambil tanggal paling awal dari daftar <time> (komentar selalu lebih baru dari postingan)
    function pickDate(list) {
      const out = [];
      for (const it of list) {
        let day = null, src = '';
        const ms = it.iso ? Date.parse(it.iso) : NaN;
        if (!isNaN(ms)) {
          const d = new Date(ms);
          day = dnum(d.getFullYear(), d.getMonth(), d.getDate());
          src = 'datetime';
        } else {
          for (const t of it.texts) {
            const p = parseTextDate(t);
            if (p !== null) { day = p; src = 'teks'; break; }
          }
        }
        if (day !== null) out.push({ day, src });
      }
      if (!out.length) return null;
      out.sort((a, b) => a.day - b.day);
      return out[0];
    }

    async function readCurrent() {
      const t0 = Date.now();
      while (!stopFlag) {
        const { own, all } = collectTimes();
        if (own.length) { const p = pickDate(own); if (p) return p; }
        if (looseMode && all.length) { const p = pickDate(all); if (p) return p; }
        if (Date.now() - t0 > 6000) break;
        await sleep(100);
      }
      if (stopFlag) return null;
      const p = pickDate(collectTimes().all);
      if (p) { looseMode = true; log('i: tanggal dibaca mode longgar'); }
      return p;
    }

    // tombol next milik postingan (panah di luar kotak postingan, nomor 1) vs tombol next carousel foto (di dalam kotak, nomor lain)
    function findNext(loose) {
      const sel = '[aria-label="Next" i],[aria-label="Berikutnya" i],[aria-label="Selanjutnya" i]';
      const els = [...new Set([...document.querySelectorAll(sel)].map(el => el.closest('button,[role="button"]') || el))];
      const cands = els.map(el => ({ el, r: el.getBoundingClientRect() })).filter(c => c.r.width > 0 && c.r.height > 0);
      if (!cands.length) return null;
      const sc = scopeEl();
      const art = sc.querySelector('article');
      const ar = art ? art.getBoundingClientRect() : null;
      const media = [...sc.querySelectorAll('img,video')].map(m => m.getBoundingClientRect()).filter(r => r.width >= 200 && r.height >= 200);
      const cx = c => c.r.left + c.r.width / 2, cy = c => c.r.top + c.r.height / 2;
      const onMedia = c => media.some(m => cx(c) >= m.left && cx(c) <= m.right && cy(c) >= m.top && cy(c) <= m.bottom);
      let pool = cands.filter(c => !onMedia(c) && ar && ar.width > 0 && cx(c) > ar.right);   // tahap 1: di luar kotak postingan
      if (!pool.length && loose) pool = cands.filter(c => !onMedia(c));                       // tahap 2: cadangan (hanya bila diizinkan)
      if (!pool.length) return null;
      pool.sort((a, b) => b.r.left - a.r.left);
      return pool[0].el;
    }

    // --- foto postingan ---
    function findPostImage() {
      const vw = window.innerWidth;
      const cands = [...scopeEl().querySelectorAll('img')]
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(c => c.r.width >= 200 && c.r.height >= 200 && c.el.complete && c.el.naturalWidth > 0 && c.r.right > 0 && c.r.left < vw);
      if (!cands.length) return null;
      const maxA = Math.max(...cands.map(c => c.r.width * c.r.height));
      const top = cands.filter(c => c.r.width * c.r.height >= maxA * 0.9);
      top.sort((a, b) => a.r.left - b.r.left);          // carousel: slide pertama (paling kiri)
      return top[0].el;
    }
    // ambil URL resolusi terbesar dari srcset (kalau ada)
    function bestSrc(img) {
      let best = img.currentSrc || img.src, bw = 0;
      (img.getAttribute('srcset') || '').split(',').forEach(part => {
        const m = part.trim().match(/^(\S+)\s+(\d+)w$/);
        if (m && +m[2] > bw) { bw = +m[2]; best = m[1]; }
      });
      return best;
    }
    async function grabImage() {
      const t0 = Date.now();
      while (!stopFlag && Date.now() - t0 < 4000) {
        const img = findPostImage();
        if (img) {
          const url = bestSrc(img);
          const key = url.split('?')[0];
          if (url && key !== lastPhotoKey) return { url, key };   // key sama = masih foto postingan sebelumnya
        }
        await sleep(100);
      }
      return null;
    }
    async function fetchBlob(url) {
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ac ? setTimeout(() => ac.abort(), 20000) : 0;
      try {
        const r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: ac ? ac.signal : undefined });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.blob();
      } catch (e) {
        if (typeof GM_xmlhttpRequest !== 'function') throw e;
        return new Promise((res, rej) => GM_xmlhttpRequest({
          method: 'GET', url, responseType: 'blob', timeout: 30000,
          onload: r => (r.status >= 200 && r.status < 300 ? res(r.response) : rej(new Error('HTTP ' + r.status))),
          onerror: () => rej(new Error('jaringan/izin @connect ditolak')),
          ontimeout: () => rej(new Error('timeout'))
        }));
      } finally {
        clearTimeout(timer);
      }
    }
    function extOf(blob, url) {
      const t = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[blob.type];
      if (t) return t;
      const m = url.match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i);
      return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
    }
    // antrean unduhan di latar belakang, supaya pengguliran tidak menunggu unduhan
    function queuePhoto(base, url) {
      photoPending++;
      photoChain = photoChain.then(async () => {
        try {
          const blob = await fetchBlob(url);
          const name = base + '.' + extOf(blob, url);
          download(blob, name);
          photoOk++; log('📷 ' + name);
        } catch (e) {
          photoFail++; log(`✗ foto gagal ${base}: ${e.message}`);
        }
        photoPending--; updateUI();
      });
    }

    // pindah ke postingan berikutnya: sabar menunggu tombol next (Instagram kadang memuat postingan baru), tidak mengklik tombol carousel
    async function goNext(prev) {
      const t0 = Date.now();
      const wnext = cfg.nextWait * 1000;            // lama menunggu tombol Next muncul / URL berubah setelah klik
      let attempts = 0, announced = false;
      while (!stopFlag) {
        const btn = findNext(useLoose);
        if (btn) {
          attempts++;
          setStatus(attempts > 1 ? `Menggulir… (percobaan ${attempts})` : 'Menggulir…');
          btn.click();
          if (await waitPathChange(prev, wnext)) return 'ok';
          if (stopFlag) return 'stop';
          if (attempts >= (cfg.autoGrid ? 2 : 3)) return 'end';
          continue;
        }
        if (Date.now() - t0 > wnext) {
          const b2 = useLoose ? null : findNext(true);        // upaya terakhir dengan kriteria longgar
          if (b2) {
            b2.click();
            if (await waitPathChange(prev, wnext)) { useLoose = true; log('i: tombol next dikenali mode longgar'); return 'ok'; }
            if (stopFlag) return 'stop';
          }
          return 'end';
        }
        if (!announced) { announced = true; log('… menunggu tombol next muncul'); }
        setStatus('Menunggu tombol next…');
        await sleep(300);
      }
      return 'stop';
    }

    async function waitPathChange(prev, ms) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (stopFlag) return false;
        if (location.pathname !== prev) return true;
        await sleep(50);
      }
      return false;
    }

    /* =====================  EXPORT XLSX (tanpa library)  ===================== */
    const CRC_T = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
      return t;
    })();
    function crc32(u8) {
      let c = 0xFFFFFFFF;
      for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    }
    function zipStore(files) {
      const enc = new TextEncoder();
      const parts = [], central = [];
      let offset = 0;
      const le = (n, bytes) => { const a = []; for (let i = 0; i < bytes; i++) a.push((n >>> (8 * i)) & 255); return a; };
      files.forEach(f => {
        const name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
        const local = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...le(20, 2), ...le(0x0800, 2), ...le(0, 2), ...le(0, 2), ...le(0x21, 2),
          ...le(crc, 4), ...le(data.length, 4), ...le(data.length, 4), ...le(name.length, 2), ...le(0, 2)]);
        parts.push(local, name, data);
        central.push(Uint8Array.from([0x50, 0x4b, 0x01, 0x02, ...le(20, 2), ...le(20, 2), ...le(0x0800, 2), ...le(0, 2), ...le(0, 2), ...le(0x21, 2),
          ...le(crc, 4), ...le(data.length, 4), ...le(data.length, 4), ...le(name.length, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2),
          ...le(0, 4), ...le(offset, 4)]), name);
        offset += local.length + name.length + data.length;
      });
      const cdSize = central.reduce((s, a) => s + a.length, 0);
      const eocd = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...le(0, 2), ...le(0, 2), ...le(files.length, 2), ...le(files.length, 2),
        ...le(cdSize, 4), ...le(offset, 4), ...le(0, 2)]);
      const all = parts.concat(central, [eocd]);
      const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0));
      let p = 0;
      all.forEach(a => { out.set(a, p); p += a.length; });
      return out;
    }
    const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function buildXlsx(data) {
      const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
      const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
      const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
      const PNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
      const hdr = ['No', 'Tanggal Postingan', 'Link'].map((h, i) =>
        `<c r="${'ABC'[i]}1" s="1" t="inlineStr"><is><t>${h}</t></is></c>`).join('');
      let body = `<row r="1">${hdr}</row>`;
      let links = '', linkRels = '';
      data.forEach((r, i) => {
        const n = i + 2;
        body += `<row r="${n}"><c r="A${n}"><v>${i + 1}</v></c>` +
          `<c r="B${n}" s="2"><v>${r.day + 25569}</v></c>` +
          `<c r="C${n}" s="3" t="inlineStr"><is><t>${xmlEsc(r.url)}</t></is></c></row>`;
        links += `<hyperlink ref="C${n}" r:id="rId${i + 1}"/>`;
        linkRels += `<Relationship Id="rId${i + 1}" Type="${RNS}/hyperlink" Target="${xmlEsc(r.url)}" TargetMode="External"/>`;
      });
      const sheet = X + `<worksheet xmlns="${NS}" xmlns:r="${RNS}"><cols>` +
        '<col min="1" max="1" width="6" customWidth="1"/><col min="2" max="2" width="18" customWidth="1"/><col min="3" max="3" width="52" customWidth="1"/>' +
        `</cols><sheetData>${body}</sheetData>${data.length ? `<hyperlinks>${links}</hyperlinks>` : ''}</worksheet>`;
      const styles = X + `<styleSheet xmlns="${NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>` +
        '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>' +
        '<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
      return zipStore([
        { name: '[Content_Types].xml', data: X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
        { name: '_rels/.rels', data: X + `<Relationships xmlns="${PNS}"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
        { name: 'xl/workbook.xml', data: X + `<workbook xmlns="${NS}" xmlns:r="${RNS}"><sheets><sheet name="Links" sheetId="1" r:id="rId1"/></sheets></workbook>` },
        { name: 'xl/_rels/workbook.xml.rels', data: X + `<Relationships xmlns="${PNS}"><Relationship Id="rId1" Type="${RNS}/worksheet" Target="worksheets/sheet1.xml"/>` +
          `<Relationship Id="rId2" Type="${RNS}/styles" Target="styles.xml"/></Relationships>` },
        { name: 'xl/styles.xml', data: styles },
        { name: 'xl/worksheets/sheet1.xml', data: sheet },
        { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: X + `<Relationships xmlns="${PNS}">${linkRels}</Relationships>` }
      ]);
    }

    function download(blob, name) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    }
    const stamp = () => { const n = new Date(); return `${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}_${pad(n.getHours())}${pad(n.getMinutes())}`; };

    function exportExcel() {
      if (!rows.length) { log('Belum ada data untuk disimpan.'); return; }
      try {
        const bytes = buildXlsx(rows);
        download(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `instagram_links_${stamp()}.xlsx`);
        log(`Excel disimpan (${rows.length} baris).`);
      } catch (e) {
        console.error('[IG Link Logger] export xlsx gagal, pakai CSV', e);
        const csv = '\uFEFFNo,Tanggal Postingan,Link\n' + rows.map((r, i) => `${i + 1},${toISO(r.day)},${r.url}`).join('\n');
        download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `instagram_links_${stamp()}.csv`);
        log('XLSX gagal dibuat, disimpan sebagai CSV.');
      }
    }

    /* =====================  UI (tanpa innerHTML)  ===================== */
    function h(tag, attrs, ...kids) {
      const e = document.createElement(tag);
      if (attrs) for (const k in attrs) {
        if (k === 'text') e.textContent = attrs[k];
        else if (k === 'class') e.className = attrs[k];
        else e.setAttribute(k, attrs[k]);
      }
      kids.forEach(k => e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k));
      return e;
    }
    const CSS = `
      *{box-sizing:border-box;font-family:Segoe UI,Arial,sans-serif}
      .box{width:252px;background:#1c1c1e;color:#eee;border:1px solid #444;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.6);font-size:12px}
      .hd{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:#2b2b2e;border-radius:10px 10px 0 0;cursor:move;user-select:none}
      .hd span{cursor:pointer;padding:0 6px;font-size:15px}
      .bd{padding:10px;display:flex;flex-direction:column;gap:7px}
      label{display:flex;justify-content:space-between;align-items:center;gap:6px}
      input{width:118px;background:#111;color:#eee;border:1px solid #555;border-radius:5px;padding:3px 5px;font-size:12px}
      input[type=number]{width:70px}
      input[type=checkbox]{width:auto}
      .row{display:flex;gap:6px}
      button{flex:1;padding:6px 4px;border:0;border-radius:6px;background:#3b82f6;color:#fff;font-size:12px;cursor:pointer}
      button.g{background:#16a34a} button.r{background:#dc2626} button.n{background:#555}
      button:disabled{opacity:.4;cursor:not-allowed}
      .st{font-weight:600;color:#fbbf24;min-height:15px}
      .ct{color:#9ca3af}
      .lg{white-space:pre-wrap;font:11px Consolas,monospace;color:#9ca3af;max-height:110px;overflow:auto;background:#111;border-radius:5px;padding:5px;min-height:34px}
      .hint{color:#777;font-size:10.5px}`;

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;display:block;';
    const root = host.attachShadow({ mode: 'open' });
    const $ = id => root.querySelector('#' + id);

    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    root.appendChild(h('div', { class: 'box' },
      h('div', { class: 'hd', id: 'hd' }, h('b', { text: 'IG Link Logger v' + VERSION }), h('span', { id: 'mn', text: '–' })),
      h('div', { class: 'bd', id: 'bd' },
        h('label', null, 'Tanggal mulai', h('input', { type: 'date', id: 'ds' })),
        h('label', null, 'Tanggal akhir', h('input', { type: 'date', id: 'de' })),
        h('label', null, 'Jeda gulir (detik)', h('input', { type: 'number', id: 'dl', min: '0.1', step: '0.1' })),
        h('label', { title: 'Lama menunggu tombol Next muncul / berpindah sebelum dianggap macet' }, 'Tunggu tombol Next (detik)', h('input', { type: 'number', id: 'nw', min: '0.5', step: '0.5' })),
        h('label', { title: '0 = nonaktif' }, 'Stop jika lewat rentang', h('input', { type: 'number', id: 'sa', min: '0', step: '1' })),
        h('label', null, 'Simpan foto postingan', h('input', { type: 'checkbox', id: 'sp' })),
        h('label', { title: 'Saat daftar habis/berulang: tutup popup, scroll grid profil, buka postingan baru' }, 'Auto muat dari grid', h('input', { type: 'checkbox', id: 'ag' })),
        h('div', { class: 'row' }, h('button', { class: 'g', id: 'bs', text: '▶ Start' }), h('button', { class: 'r', id: 'bt', text: '■ Stop' }), h('button', { id: 'bl', text: '⏭ Lanjut' })),
        h('div', { class: 'row' }, h('button', { class: 'n', id: 'bx', text: '💾 Excel' }), h('button', { class: 'n', id: 'bc', text: '🔍 Tes' }), h('button', { class: 'n', id: 'br', text: '🗑 Reset' })),
        h('div', { class: 'st', id: 'st', text: 'Siap.' }),
        h('div', { class: 'ct', id: 'ct' }),
        h('div', { class: 'lg', id: 'lg' }),
        h('div', { class: 'hint', text: 'Biarkan tab ini tetap aktif/terlihat selama berjalan.' })
      )));
    ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'focusin']
      .forEach(ev => host.addEventListener(ev, e => e.stopPropagation()));
    document.body.appendChild(host);
    // jaga-jaga bila Instagram membuang elemen asing dari body
    setInterval(() => { if (!host.isConnected && document.body) document.body.appendChild(host); }, 2000);

    const logs = [];
    function log(m) {
      logs.push(m); if (logs.length > 10) logs.shift();
      const lg = $('lg'); lg.textContent = logs.join('\n'); lg.scrollTop = lg.scrollHeight;
    }
    const setStatus = m => { $('st').textContent = m; };

    function updateUI() {
      $('bs').disabled = running; $('bl').disabled = running; $('bt').disabled = !running; $('br').disabled = running;
      ['ds', 'de', 'dl', 'nw', 'sa', 'sp', 'ag'].forEach(id => { $(id).disabled = running; });
      $('ct').textContent = `Tercatat: ${rows.length}  |  Dicek: ${seen.size}  |  Foto: ${photoOk}${photoFail ? ' (gagal ' + photoFail + ')' : ''}`;
    }
    function fillUI() {
      $('ds').value = toISO(cfg.start); $('de').value = toISO(cfg.end);
      $('dl').value = cfg.delay; $('nw').value = cfg.nextWait; $('sa').value = cfg.stopAfter; $('sp').checked = !!cfg.savePhoto; $('ag').checked = !!cfg.autoGrid;
    }
    function readCfg() {
      const s = toNum($('ds').value), e = toNum($('de').value);
      const dl = parseFloat($('dl').value), sa = parseInt($('sa').value, 10), nw = parseFloat($('nw').value);
      if (s === null || e === null) return 'Isi tanggal mulai & akhir dulu.';
      if (s > e) return 'Tanggal mulai harus ≤ tanggal akhir.';
      cfg.start = s; cfg.end = e;
      cfg.delay = isNaN(dl) ? 4 : Math.max(0.1, dl);
      cfg.nextWait = isNaN(nw) ? 2 : Math.max(0.5, nw);
      cfg.stopAfter = sa >= 0 ? sa : 3;
      cfg.savePhoto = $('sp').checked;
      cfg.autoGrid = $('ag').checked;
      persist();
      return null;
    }

    // geser panel & minimize
    let drag = null;
    $('hd').addEventListener('mousedown', e => {
      if (e.target.id === 'mn') return;
      const r = host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!drag) return;
      host.style.left = Math.max(0, e.clientX - drag.dx) + 'px';
      host.style.top = Math.max(0, e.clientY - drag.dy) + 'px';
      host.style.bottom = 'auto';
    }, true);
    window.addEventListener('mouseup', () => { drag = null; }, true);
    $('mn').addEventListener('click', () => {
      const bd = $('bd'); const hide = bd.style.display !== 'none';
      bd.style.display = hide ? 'none' : 'flex'; $('mn').textContent = hide ? '+' : '–';
    });

    /* =====================  LOOP UTAMA  ===================== */
    // --- muat postingan baru lewat grid profil (Next di dalam popup tidak selalu memuat lebih banyak) ---
    async function waitUntil(fn, ms) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (stopFlag) return false;
        if (fn()) return true;
        await sleep(100);
      }
      return false;
    }
    function gridItems() {
      const out = [], dup = new Set();
      document.querySelectorAll('a[href*="/p/"],a[href*="/reel/"],a[href*="/reels/"],a[href*="/tv/"]').forEach(a => {
        if (a.closest('div[role="dialog"]') || !a.querySelector('img,video')) return;
        const c = codeOf(a.getAttribute('href') || '');
        if (!c || dup.has(c)) return;
        dup.add(c); out.push({ a, code: c });
      });
      return out;
    }
    // thumbnail pertama yang belum dicek setelah thumbnail terakhir yang sudah dicek
    function pickFromGrid() {
      const items = gridItems();
      let maxSeen = -1;
      items.forEach((it, i) => { if (seenCodes.has(it.code)) maxSeen = i; });
      return { items, cand: items.slice(maxSeen + 1).find(it => !seenCodes.has(it.code)) || null };
    }
    async function closeModal() {
      const gone = () => !canonicalUrl();
      for (let i = 0; i < 3 && canonicalUrl(); i++) {
        const xs = [...document.querySelectorAll('[aria-label="Close" i],[aria-label="Tutup" i]')]
          .map(el => el.closest('button,[role="button"]') || el)
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || b.getBoundingClientRect().left - a.getBoundingClientRect().left);
        if (xs.length) xs[0].click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        if (await waitUntil(gone, 3000)) return true;
        if (i === 1) history.back();                          // cadangan terakhir
      }
      return !canonicalUrl();
    }
    // 'ok' = postingan baru terbuka | 'none' = grid sudah habis | 'fail' = gagal | 'stop'
    async function recoverFromGrid() {
      const grewPast = n => () => gridItems().length > n;
      const opened = c => () => codeOf(location.pathname) === c;
      setStatus('Memuat postingan baru dari grid…');
      if (!(await closeModal())) return stopFlag ? 'stop' : 'fail';
      await sleep(600);
      for (let tries = 0; !stopFlag && tries < 6; tries++) {
        const { items, cand } = pickFromGrid();
        if (cand) {
          cand.a.scrollIntoView({ block: 'center' });
          await sleep(300);
          cand.a.click();
          if (await waitUntil(opened(cand.code), 8000)) { log(`↻ lanjut dari grid: ${cand.code}`); return 'ok'; }
          return stopFlag ? 'stop' : 'fail';
        }
        // semua thumbnail yang termuat sudah dicek -> scroll ke bawah agar Instagram memuat lebih banyak
        setStatus(`Scroll grid… (${tries + 1}/6)`);
        const before = items.length;
        if (items.length) items[items.length - 1].a.scrollIntoView({ block: 'end' });
        window.scrollTo(0, document.documentElement.scrollHeight);
        let grew = await waitUntil(grewPast(before), 6000);
        if (!grew) {
          window.scrollBy(0, -400); await sleep(300);
          window.scrollTo(0, document.documentElement.scrollHeight);
          grew = await waitUntil(grewPast(before), 4000);
        }
        if (!grew) return stopFlag ? 'stop' : 'none';
        log(`↻ grid bertambah: ${before} → ${gridItems().length}`);
      }
      return stopFlag ? 'stop' : 'none';
    }

    async function run() {
      if (running) return;
      if (!canonicalUrl()) { setStatus('Buka dulu sebuah postingan (URL /p/...).'); return; }
      running = true; stopFlag = false; seenStreak = 0; prevIdx = -1; repeatBack = 0; lastNewAt = Date.now(); updateUI();
      let endMsg = 'Dihentikan.';
      recoverFails = 0; newSinceRecover = true;
      // true = lanjutkan loop dari postingan baru di grid; false = berhenti (endMsg sudah diisi bila perlu)
      const recover = async reason => {
        if (!cfg.autoGrid || stopFlag) return false;
        if (!newSinceRecover) recoverFails++; else recoverFails = 0;
        if (recoverFails >= 2) { endMsg = 'Selesai: tidak ada postingan baru lagi dari grid.'; return false; }
        newSinceRecover = false;
        log('↻ ' + reason);
        lastNewAt = Date.now();
        const r = await recoverFromGrid();
        lastNewAt = Date.now();
        if (r === 'ok') { seenStreak = 0; repeatBack = 0; prevIdx = -1; return true; }
        if (r === 'none') { endMsg = 'Selesai: tidak ada postingan baru lagi di grid (akhir profil).'; }
        else if (r === 'fail') { endMsg = 'Berhenti: gagal menutup/membuka postingan dari grid. Data yang sudah tercatat tetap ada, klik Excel untuk menyimpan.'; }
        return false;
      };
      try {
        while (!stopFlag) {
          const url = canonicalUrl();
          if (!url) { endMsg = 'Halaman bukan postingan lagi (modal tertutup?).'; break; }
          if (Date.now() - lastNewAt > 90000) { endMsg = 'Berhenti: 90 detik tanpa postingan baru yang dicek.'; break; }

          let skipFast = false;
          if (seen.has(url)) {
            seenStreak++; skipFast = true;
            const ix = idxOf.get(url);
            const back = prevIdx >= 0 && ix < prevIdx;               // kembali ke postingan yang lebih awal dari yang barusan
            if (back) repeatBack++;
            if (seenStreak === 1 || seenStreak % 10 === 0 || back) {
              log(`⟳ ke-${ix + 1} dari ${order.length} sudah dicek${back ? ' (MUNDUR dari ke-' + (prevIdx + 1) + ')' : ''}, berturut: ${seenStreak}`);
            }
            prevIdx = ix;
            // maju berurutan = hanya "mengejar" posisi lama (wajar). Mundur lalu masih terus berulang = daftar mengulang / terbalik.
            if (repeatBack >= 3 || (repeatBack >= 1 && seenStreak >= 3) || seenStreak > order.length + 5) {
              const repMsg = `Berhenti: urutan postingan berulang (kembali ke postingan ke-${ix + 1} dari ${order.length} yang sudah dicek). Kemungkinan akhir daftar atau Instagram memuat ulang daftar.`;
              if (await recover('daftar berulang, muat dari grid')) continue;
              if (endMsg === 'Dihentikan.' && !stopFlag) endMsg = repMsg;
              break;
            }
          } else {
            seenStreak = 0;
            setStatus('Membaca tanggal…');
            const info = await readCurrent();
            if (stopFlag) break;
            if (!info) {
              failStreak++;
              log(`✗ tanggal tidak terbaca: ${url.slice(-14)}`);
              if (failStreak >= 5) { endMsg = 'Berhenti: tanggal gagal terbaca 5x berturut-turut.'; break; }
            } else {
              failStreak = 0; markSeen(url); prevIdx = order.length - 1; repeatBack = 0; newSinceRecover = true; lastNewAt = Date.now();
              if (info.day < cfg.start) {
                olderStreak++;
                log(`↓ ${fmt(info.day)} sebelum rentang (${olderStreak}/${cfg.stopAfter || '∞'})`);
              } else {
                olderStreak = 0;
                if (info.day > cfg.end) {
                  log(`↑ ${fmt(info.day)} setelah rentang, dilewati`);
                } else if (!rows.some(r => r.url === url)) {
                  rows.push({ url, day: info.day }); persist();
                  log(`✓ #${rows.length} ${fmt(info.day)} [${info.src}]`);
                  if (cfg.savePhoto) {
                    const g = await grabImage();
                    if (stopFlag) break;
                    if (g) {
                      const n = rows.filter(r => r.day === info.day).length;      // tanggal kembar -> _2, _3, dst
                      queuePhoto(fmt(info.day).replace(/\//g, '-') + (n > 1 ? '_' + n : ''), g.url);
                    } else log('✗ foto tidak ditemukan (video?)');
                  }
                }
              }
            }
            updateUI();
          }

          if (cfg.stopAfter > 0 && olderStreak >= cfg.stopAfter) {
            endMsg = 'Selesai: sudah melewati rentang tanggal.'; break;
          }

          const prev = location.pathname;
          // simpan kunci foto postingan yang akan ditinggalkan: dipakai untuk mendeteksi foto lama yang belum diganti
          const cur = cfg.savePhoto ? findPostImage() : null;
          if (cur) lastPhotoKey = bestSrc(cur).split('?')[0];
          const nav = await goNext(prev);
          if (stopFlag || nav === 'stop') break;
          if (nav === 'end') {
            if (await recover('Next tidak bergerak, muat dari grid')) continue;
            if (endMsg === 'Dihentikan.' && !stopFlag) endMsg = 'Selesai: tombol next tidak muncul / tidak ada postingan berikutnya.';
            break;
          }
          setStatus('Jeda…');
          await wait(skipFast ? 150 : jeda());
        }
      } catch (e) {
        endMsg = 'Error: ' + e.message; console.error('[IG Link Logger]', e);
      }
      if (photoPending) { setStatus('Menyelesaikan unduhan foto…'); try { await photoChain; } catch (e) { /* abaikan */ } }
      running = false; stopFlag = false;
      setStatus(endMsg); log(endMsg); updateUI();
      if (rows.length) log(`Data siap: klik 💾 Excel untuk menyimpan (${rows.length} baris).`);
    }

    // diagnosa cepat: cek apakah kode, tanggal, dan tombol next terdeteksi (tanpa menggulir)
    function selfTest() {
      const code = shortcode();
      if (!code) { log('Tes: ini bukan halaman postingan (/p/...).'); return; }
      const { own, all } = collectTimes();
      const p = pickDate(own.length ? own : all);
      const btn = findNext(false) || findNext(true);
      const strict = !!findNext(false);
      log(`Tes: kode=${code}`);
      log(`<time>: ${all.length} (milik post: ${own.length})`);
      log(p ? `tanggal: ${fmt(p.day)} [${p.src}]` : 'tanggal: TIDAK terbaca');
      if (btn) { const r = btn.getBoundingClientRect(); log(`next: ketemu${strict ? '' : ' (mode longgar)'} (x=${Math.round(r.left)}, y=${Math.round(r.top)})`); }
      else log('next: TIDAK ketemu');
      const im = findPostImage();
      log(im ? `foto: ketemu (${im.naturalWidth}x${im.naturalHeight}, unduh ${bestSrc(im).length > 0 ? 'siap' : '?'})` : 'foto: TIDAK ketemu');
    }

    /* =====================  TOMBOL  ===================== */
    $('bs').addEventListener('click', () => {
      const err = readCfg(); if (err) { setStatus(err); return; }
      if (rows.length && !confirm(`Data lama (${rows.length} link) akan dihapus. Start baru?`)) return;
      rows = []; clearSeen(); olderStreak = 0; failStreak = 0; persist();
      lastPhotoKey = ''; photoOk = 0; photoFail = 0;
      log(`Start: ${fmt(cfg.start)} s/d ${fmt(cfg.end)}`);
      run();
    });
    $('bl').addEventListener('click', () => {
      const err = readCfg(); if (err) { setStatus(err); return; }
      olderStreak = 0; failStreak = 0;
      log('Lanjut…');
      run();
    });
    $('bt').addEventListener('click', () => { stopFlag = true; setStatus('Menghentikan…'); });
    $('bx').addEventListener('click', exportExcel);
    $('bc').addEventListener('click', selfTest);
    $('br').addEventListener('click', () => {
      if (running) return;
      if (!confirm('Hapus semua data yang tercatat?')) return;
      rows = []; clearSeen(); olderStreak = 0; failStreak = 0; persist(); updateUI(); setStatus('Data direset.');
    });

    fillUI(); updateUI();
    log(rows.length ? `Data tersimpan: ${rows.length} link.` : 'Buka postingan, klik Tes, lalu Start.');
  }

  function start() {
    try { main(); console.log('[IG Link Logger] v' + VERSION + ' aktif'); } catch (e) { fatal(e); }
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
