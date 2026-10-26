/* StoryForge — app4.js : Kindle eBook (fixed-layout EPUB + 1600 x 2560 cover JPG) and the small zip writer it needs */
(function () {
  'use strict';
  var SF = window.SF;
  var E = SF.EBOOK;

  /* ---------- zip (store only: EPUB needs "mimetype" first and uncompressed, pictures are JPEG already) ---------- */
  var CRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { var c = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  var enc = new TextEncoder();
  SF.zipStore = function (files) {
    var now = new Date(), dt = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(), tm = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    var parts = [], cen = [], off = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
      var h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034B50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, tm, true); h.setUint16(12, dt, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014B50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, tm, true); c.setUint16(14, dt, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      parts.push(new Uint8Array(h.buffer), name, data); cen.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + data.length;
    });
    var cenLen = cen.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054B50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cenLen, true); end.setUint32(16, off, true);
    var all = parts.concat(cen, [new Uint8Array(end.buffer)]), len = all.reduce(function (a, b) { return a + b.length; }, 0), out = new Uint8Array(len), p = 0;
    all.forEach(function (b) { out.set(b, p); p += b.length; });
    return out;
  };

  /* ---------- helpers ---------- */
  function x(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  var LANG = { English: 'en', French: 'fr', Spanish: 'es', German: 'de', Italian: 'it', Portuguese: 'pt' };
  function jpegBytes(canvas, q) {
    return new Promise(function (res, rej) { canvas.toBlob(function (b) { b ? b.arrayBuffer().then(function (a) { res(new Uint8Array(a)); }, rej) : rej(new Error('Could not make the picture.')); }, 'image/jpeg', q || 0.92); });
  }
  var fontDone = {};
  async function canvasFont() {                // Fredoka for the title written on the cover (falls back to a system font if the download fails)
    if (fontDone.f) return fontDone.f;
    try { var ff = new FontFace('SFFredoka', 'url(' + SF.FONTS['fredoka-700'] + ')', { weight: '700' }); await ff.load(); document.fonts.add(ff); fontDone.f = '"SFFredoka", "Trebuchet MS", sans-serif'; }
    catch (e) { fontDone.f = '"Trebuchet MS", Arial, sans-serif'; }
    return fontDone.f;
  }
  function wrapCanvas(g, text, maxW) {
    var words = String(text).split(/\s+/).filter(Boolean), lines = [], cur = '';
    words.forEach(function (w) { var t = cur ? cur + ' ' + w : w; if (g.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; } });
    if (cur) lines.push(cur); return lines;
  }
  function outlinedText(g, text, cx, y, size, fill, stroke) {
    g.lineJoin = 'round'; g.lineWidth = Math.max(6, size * 0.14); g.strokeStyle = stroke || '#101830'; g.strokeText(text, cx, y); g.fillStyle = fill; g.fillText(text, cx, y);
  }

  /* ---------- cover: 1600 x 2560 JPG ---------- */
  // deps: { getBlob(key) -> Blob|null }
  SF.buildEbookCover = async function (book, deps) {
    var W = E.coverW, H = E.coverH, blob = deps.getBlob('cover'), c;
    var scrim = !book.coverHasTitle ? true : (book.coverFixAuthor ? 'author' : false);
    if (blob) c = await SF.prepCanvas(blob, W, H, scrim, 'contain');
    else { c = document.createElement('canvas'); c.width = W; c.height = H; var g0 = c.getContext('2d'); g0.fillStyle = '#3A86FF'; g0.fillRect(0, 0, W, H); }
    var g = c.getContext('2d'), font = await canvasFont(), name = SF.niceName(book.author);
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    // where the picture sits (so text goes on the picture, not on the blurred extension)
    var ar = 1, top = 0, picH = H;
    if (blob) { var bm = await createImageBitmap(blob); ar = bm.width / bm.height; if (bm.close) bm.close(); }
    if (blob && Math.abs(ar / (W / H) - 1) > 0.04) { picH = Math.min(H, W / ar); top = (H - picH) / 2; }
    if (!book.coverHasTitle) {
      var size = 190, lines;
      for (; size >= 90; size -= 6) { g.font = '700 ' + size + 'px ' + font; lines = wrapCanvas(g, book.title || 'Untitled', W - 240); if (lines.length <= 3) break; }
      var y = top + 150 + size;
      lines.forEach(function (ln) { outlinedText(g, ln, W / 2, y, size, '#FFFFFF'); y += size * 1.08; });
      if (book.subtitle) { g.font = '700 70px ' + font; wrapCanvas(g, book.subtitle, W - 300).slice(0, 2).forEach(function (ln) { y += 12; outlinedText(g, ln, W / 2, y + 60, 70, '#FFD27A'); y += 74; }); }
    }
    if (name && (!book.coverHasTitle || book.coverFixAuthor)) { g.textAlign = 'right'; g.font = '700 56px ' + font; outlinedText(g, name, W - 90, top + picH - 80, 56, '#FFFFFF'); g.textAlign = 'center'; }
    var bytes = await jpegBytes(c, 0.93); c.width = c.height = 1;
    return bytes;
  };

  /* ---------- the book: fixed-layout EPUB 3 ---------- */
  var CSS = 'html,body{margin:0;padding:0;width:' + E.coverW + 'px;height:' + E.coverH + 'px;overflow:hidden;background:#FFF9EE}' +
    '.pg{position:relative;width:' + E.coverW + 'px;height:' + E.coverH + 'px;background:#FFF9EE;font-family:"Trebuchet MS",Arial,Helvetica,sans-serif;color:#16213E}' +
    '.pic{display:block;width:' + E.picW + 'px;height:' + E.picH + 'px}' +
    '.tx{position:absolute;left:110px;width:1380px;text-align:center}' +
    '.tx p{margin:0 0 .5em 0;font-weight:bold}.tx h2{margin:0 0 .35em 0;font-weight:bold}' +
    '.mid{position:absolute;left:120px;width:1360px;text-align:center}.mid h1{margin:0;font-weight:bold}.mid p{margin:.5em 0}' +
    '.rule{width:240px;height:6px;margin:40px auto;background:#E63946}' +
    '.ln{text-align:left}.ln p{font-weight:normal;margin:0 0 .4em 0}.ln h3{margin:.7em 0 .2em 0;font-weight:bold}.lab{font-weight:bold;letter-spacing:.06em;margin:0 0 .4em 0}' +
    '.full{display:block;width:' + E.coverW + 'px;height:' + E.coverH + 'px}';
  function head(title, lang) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="' + lang + '" xml:lang="' + lang + '">\n<head><meta charset="utf-8"/><title>' + x(title) + '</title>' +
      '<meta name="viewport" content="width=' + E.coverW + ', height=' + E.coverH + '"/><link rel="stylesheet" type="text/css" href="style.css"/></head>\n<body>';
  }
  var TAIL = '</body>\n</html>';
  // largest font size (px) whose lines fit the box; rough width of a bold character = 0.56 × size
  function fitSize(paras, boxW, boxH, headLines, maxS, minS) {
    for (var s = maxS; s >= minS; s -= 2) {
      var cpl = Math.max(8, Math.floor(boxW / (s * 0.56))), lines = 0;
      paras.forEach(function (p) { lines += Math.max(1, Math.ceil(p.length / cpl)); });
      var h = lines * s * 1.36 + Math.max(0, paras.length - 1) * s * 0.5 + (headLines ? headLines * s * 1.25 * 1.2 + s * 0.4 : 0);
      if (h <= boxH) return s;
    }
    return minS;
  }

  // deps: { getBlob(key) -> Blob|null, onProgress(i, n) }
  SF.buildEpub = async function (book, deps) {
    book = Object.assign({}, book, { author: SF.niceName(book.author) });
    var plan = SF.makePlan(book), n = plan.total, lang = LANG[book.lang] || 'en', title = book.title || 'Untitled';
    var files = [], items = [], spine = [], toc = [], uid = 'urn:uuid:' + (crypto.randomUUID ? crypto.randomUUID() : 'sf-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2));
    function page(id, name, html, extra) { files.push({ name: 'OEBPS/' + name, data: html }); items.push('<item id="' + id + '" href="' + name + '" media-type="application/xhtml+xml"' + (extra || '') + '/>'); spine.push('<itemref idref="' + id + '"/>'); }

    // cover
    if (deps.onProgress) deps.onProgress(0, n + 2);
    var coverBytes = await SF.buildEbookCover(book, deps);
    files.push({ name: 'OEBPS/images/cover.jpg', data: coverBytes });
    items.push('<item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>');
    page('cover', 'cover.xhtml', head(title, lang) + '<div class="pg"><img class="full" src="images/cover.jpg" alt="Cover of ' + x(title) + '"/></div>' + TAIL);

    var tocPages = {}; plan.tocs.forEach(function (t) { tocPages[t.story] = t.page; });
    var firstBody = null;
    for (var i = 0; i < n; i++) {
      var d = plan.pages[i], id = 'p' + String(i + 1).padStart(3, '0'), name = id + '.xhtml';
      if (deps.onProgress) deps.onProgress(i + 1, n + 2);
      if (d.t === 'title') {
        var ts = title.length > 36 ? 120 : title.length > 22 ? 150 : 180;
        page(id, name, head(title, lang) + '<div class="pg"><div class="mid" style="top:760px"><h1 style="font-size:' + ts + 'px;line-height:1.1">' + x(title) + '</h1><div class="rule"></div>' +
          (book.subtitle ? '<p style="font-size:64px;color:#5B6275">' + x(book.subtitle) + '</p>' : '') +
          (book.dedication ? '<p style="font-size:46px;color:#5B6275;margin-top:140px;font-weight:normal">' + x(book.dedication) + '</p>' : '') +
          (book.author ? '<p style="font-size:70px;margin-top:140px">' + x(book.author) + '</p>' : '') + '</div></div>' + TAIL);
      } else if (d.t === 'copyright') {
        var yr = book.year || new Date().getFullYear();
        var lines = [title, 'Text and illustrations © ' + yr + ' ' + (book.author || ''), 'All rights reserved. No part of this book may be reproduced, stored or transmitted in any form without written permission from the author, except for brief quotations in reviews.',
          SF.isLearn(book) ? 'The people and situations in the dialogues are fictional. Any resemblance to real persons is coincidental.' : 'This is a work of fiction. Names, characters, places and events are products of the imagination.', book.aiNotice ? 'Created with the help of AI tools and curated, edited and arranged by the author.' : '', 'First edition ' + yr + '. Published through Amazon KDP.'].filter(Boolean);
        page(id, name, head(title, lang) + '<div class="pg"><div class="mid" style="top:700px">' + lines.map(function (t, k) { return '<p style="font-size:' + (k === 0 ? 62 : 40) + 'px;' + (k === 0 ? 'font-weight:bold;margin-bottom:1em' : 'color:#5B6275;font-weight:normal') + '">' + x(t) + '</p>'; }).join('') + '</div></div>' + TAIL);
      } else if (d.t === 'ebeat') {
        var story = book.stories[d.s], beat = story.beats[d.b], paras = String(beat.text || '').split(/\n+/).map(function (p) { return p.trim(); }).filter(Boolean);
        var learn = SF.isLearn(book), pic = d.pic !== false;
        var lab = learn ? (beat.label || SF.learnLabels(story.beats.length)[d.b] || '') : '';
        var hasHead = d.b === 0, headText = hasHead ? (d.s + 1) + '  ' + (story.title || '') : '';
        var topY = pic ? E.picH + 70 : 150, boxH = E.coverH - topY - 80;
        var headLines = (hasHead ? Math.max(1, Math.ceil(headText.length * 62 * 0.56 / 1380)) : 0) + (lab ? 1 : 0);
        var fs = fitSize(paras, 1380, boxH, headLines, learn ? 52 : 62, 30), col = SF.storyColor(d.s);
        var imgTag = '';
        if (pic) {
          var blob = deps.getBlob(d.key), img;
          if (blob) img = await SF.prepImage(blob, E.picW, E.picH, false);
          else { var cv = document.createElement('canvas'); cv.width = E.picW; cv.height = E.picH; var cg = cv.getContext('2d'); cg.fillStyle = '#EEF1F6'; cg.fillRect(0, 0, cv.width, cv.height); img = await jpegBytes(cv, 0.8); }
          files.push({ name: 'OEBPS/images/' + d.key + '.jpg', data: img }); items.push('<item id="im-' + d.key + '" href="images/' + d.key + '.jpg" media-type="image/jpeg"/>');
          imgTag = '<img class="pic" src="images/' + d.key + '.jpg" alt=""/>';
        }
        var body = '<div class="pg">' + imgTag + '<div class="tx' + (learn ? ' ln' : '') + '" style="top:' + topY + 'px;font-size:' + fs + 'px;line-height:1.36">' +
          (hasHead ? '<h2 style="font-size:' + Math.round(fs * 1.2) + 'px;line-height:1.25;color:' + col + '">' + x(headText) + '</h2>' : '') +
          (lab ? '<div class="lab" style="font-size:' + Math.round(fs * 0.62) + 'px;color:' + col + '">' + x(lab.toUpperCase()) + '</div>' : '') +
          paras.map(function (p) { return '<p>' + x(p) + '</p>'; }).join('') + '</div></div>';
        page(id, name, head(title + ' — ' + (story.title || ''), lang) + body + TAIL);
        if (!firstBody) firstBody = name;
        if (hasHead) toc.push({ href: name, text: (d.s + 1) + ' ' + (story.title || 'Story ' + (d.s + 1)) });
      } else if (d.t === 'answers') {
        var blocks = d.items.map(function (si) { return { si: si, title: (si + 1) + '  ' + (book.stories[si].title || ''), lines: SF.answerLines(book.stories[si]) }; });
        var afs = 28;
        for (var sz = 46; sz >= 28; sz -= 2) {
          var cpl = Math.max(8, Math.floor(1380 / (sz * 0.56))), hh = d.first ? 150 : 0;
          blocks.forEach(function (bk) { hh += sz * 1.3 * 1.25 + sz * 0.9; bk.lines.forEach(function (ln) { hh += Math.max(1, Math.ceil(ln.length / cpl)) * sz * 1.36; }); });
          if (hh <= E.coverH - 300) { afs = sz; break; }
        }
        page(id, name, head(title + ' — Answer key', lang) + '<div class="pg"><div class="tx ln" style="top:150px;font-size:' + afs + 'px;line-height:1.36">' +
          (d.first ? '<h2 style="font-size:80px;margin-bottom:.5em">Answer key</h2>' : '') +
          blocks.map(function (bk) { return '<h3 style="font-size:' + Math.round(afs * 1.1) + 'px;color:' + SF.storyColor(bk.si) + '">' + x(bk.title) + '</h3>' + bk.lines.map(function (ln) { return '<p>' + x(ln) + '</p>'; }).join(''); }).join('') + '</div></div>' + TAIL);
        if (d.first) toc.push({ href: name, text: 'Answer key' });
      } else if (d.t === 'end') {
        page(id, name, head(title, lang) + '<div class="pg"><div class="mid" style="top:900px"><h1 style="font-size:190px">' + (SF.isLearn(book) ? 'Well done!' : 'The End') + '</h1><div class="rule"></div><p style="font-size:68px;color:#5B6275">' + (SF.isLearn(book) ? 'Keep practising a little every day.' : 'New adventures are waiting...') + '</p></div></div>' + TAIL);
      }
    }

    // navigation + package
    var nav = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="' + lang + '" xml:lang="' + lang + '">\n<head><meta charset="utf-8"/><title>Contents</title></head>\n<body>' +
      '<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>' + toc.map(function (t) { return '<li><a href="' + t.href + '">' + x(t.text) + '</a></li>'; }).join('') + '</ol></nav>' +
      '<nav epub:type="landmarks" hidden="hidden"><ol><li><a epub:type="cover" href="cover.xhtml">Cover</a></li>' + (firstBody ? '<li><a epub:type="bodymatter" href="' + firstBody + '">Start of the book</a></li>' : '') + '</ol></nav></body>\n</html>';
    files.push({ name: 'OEBPS/nav.xhtml', data: nav });
    files.push({ name: 'OEBPS/style.css', data: CSS });
    var stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    var opf = '<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="' + lang + '">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<dc:identifier id="bookid">' + uid + '</dc:identifier><dc:title>' + x(title) + '</dc:title>' + (book.author ? '<dc:creator>' + x(book.author) + '</dc:creator>' : '') + '<dc:language>' + lang + '</dc:language>' +
      '<meta property="dcterms:modified">' + stamp + '</meta><meta property="rendition:layout">pre-paginated</meta><meta property="rendition:orientation">portrait</meta><meta property="rendition:spread">none</meta>' +
      '<meta name="cover" content="cover-image"/><meta name="fixed-layout" content="true"/><meta name="original-resolution" content="' + E.coverW + 'x' + E.coverH + '"/><meta name="book-type" content="children"/>' +
      '<meta name="primary-writing-mode" content="horizontal-lr"/><meta name="zero-gutter" content="true"/><meta name="zero-margin" content="true"/><meta name="RegionMagnification" content="false"/></metadata>\n' +
      '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>' + items.join('') + '</manifest>\n<spine>' + spine.join('') + '</spine>\n</package>';
    files.unshift({ name: 'OEBPS/content.opf', data: opf });
    files.unshift({ name: 'META-INF/container.xml', data: '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' });
    files.unshift({ name: 'mimetype', data: 'application/epub+zip' });
    if (deps.onProgress) deps.onProgress(n + 1, n + 2);
    return { epub: SF.zipStore(files), cover: coverBytes };
  };
})();
