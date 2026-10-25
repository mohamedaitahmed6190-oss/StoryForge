/* StoryForge — app2.js : KDP rules, page planner, PDF engine (interior + cover) */
(function () {
  var SF = (window.SF = window.SF || {});
  var IN = 72;

  /* ---------- KDP constants (checked against KDP help, Oct 2026) ---------- */
  SF.TRIMS = [
    { id: '8.5x8.5',   w: 8.5,  h: 8.5,  label: '8.5 × 8.5 in — square (best for AI art)' },
    { id: '8.25x8.25', w: 8.25, h: 8.25, label: '8.25 × 8.25 in — square' },
    { id: '8x10',      w: 8,    h: 10,   label: '8 × 10 in — portrait' },
    { id: '8.5x11',    w: 8.5,  h: 11,   label: '8.5 × 11 in — portrait' }
  ];
  SF.PAPERS = [
    { id: 'premium',  label: 'Premium color',  k: 0.002347, minPages: 24 },
    { id: 'standard', label: 'Standard color', k: 0.002252, minPages: 72 }
  ];
  SF.BLEED = 0.125;
  SF.DPI = 300;
  SF.COLORS = ['#E63946', '#F77F00', '#B8860B', '#2A9D8F', '#3A86FF', '#8E44AD', '#2E9E5B', '#D6336C', '#1D7874', '#5C6BC0', '#D35400', '#6D4C41'];

  SF.gutterIn = function (pages) {
    return pages <= 150 ? 0.375 : pages <= 300 ? 0.5 : pages <= 500 ? 0.625 : pages <= 700 ? 0.75 : 0.875;
  };
  SF.trim = function (id) { return SF.TRIMS.filter(function (t) { return t.id === id; })[0] || SF.TRIMS[0]; };
  SF.paper = function (id) { return SF.PAPERS.filter(function (t) { return t.id === id; })[0] || SF.PAPERS[0]; };
  SF.spineIn = function (pages, paperId) { return pages * SF.paper(paperId).k; };
  SF.storyColor = function (i) { return SF.COLORS[i % SF.COLORS.length]; };

  /* ---------- page planner ---------- */
  // pages[i] (0-based) -> physical page i+1. Odd = right-hand page (recto), even = left-hand (verso).
  // Every story beat = text page on the left + its picture on the right, so each spread reads naturally.
  SF.makePlan = function (book) {
    var pages = [];
    pages.push({ t: 'title' }, { t: 'copyright' }, { t: 'toc' });
    var tocs = [];
    (book.stories || []).forEach(function (s, si) {
      (s.beats || []).forEach(function (b, bi) {
        if (bi === 0) tocs.push({ story: si, page: pages.length + 1 });
        pages.push({ t: 'text', s: si, b: bi }, { t: 'image', key: 's' + si + 'b' + bi, s: si, b: bi });
      });
    });
    var base = pages.length + 2;                 // + The End + closing page
    var min = Math.max(24, SF.paper(book.paper).minPages);
    var f = Math.max(0, min - base);
    if ((base + f) % 2) f++;
    pages.push({ t: 'end' });
    for (var i = 0; i < f; i++) pages.push({ t: i % 2 ? 'notes' : 'draw' });
    pages.push({ t: 'thanks' });
    return { pages: pages, total: pages.length, tocs: tocs, fillers: f, gutter: SF.gutterIn(pages.length) };
  };

  /* ---------- geometry ---------- */
  SF.geom = function (book, total, pageNo) {
    var t = SF.trim(book.trim), bl = book.bleed === false ? 0 : SF.BLEED;
    var tw = t.w * IN, th = t.h * IN, b = bl * IN;
    var odd = pageNo % 2 === 1;
    var x0 = odd ? 0 : b;                         // outer bleed: right side on odd pages, left side on even pages
    var g = SF.gutterIn(total) * IN + 0.25 * IN;  // gutter margin + breathing room
    var o = 0.6 * IN;                             // outside margin (KDP minimum with bleed is 0.375 in)
    var left = odd ? g : o, right = odd ? o : g;
    return {
      pw: tw + b, ph: th + 2 * b, tw: tw, th: th, b: b, x0: x0, y0: b, odd: odd,
      bx: x0 + left, by: b + o, bw: tw - left - right, bh: th - 2 * o      // safe text box
    };
  };

  /* ---------- helpers ---------- */
  function hex(P, h) {
    h = h.replace('#', '');
    return P.rgb(parseInt(h.substr(0, 2), 16) / 255, parseInt(h.substr(2, 2), 16) / 255, parseInt(h.substr(4, 2), 16) / 255);
  }
  function lum(h) {
    h = h.replace('#', '');
    var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  function wrap(font, size, text, maxW) {
    var words = String(text).split(/\s+/).filter(Boolean), lines = [], cur = '';
    words.forEach(function (w) {
      var t = cur ? cur + ' ' + w : w;
      if (font.widthOfTextAtSize(t, size) <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    return lines;
  }
  function layoutParas(font, paras, size, maxW, lh) {
    var out = [], h = 0;
    paras.forEach(function (p, i) {
      var ls = wrap(font, size, p, maxW);
      out.push(ls); h += ls.length * size * lh + (i < paras.length - 1 ? size * 0.55 : 0);
    });
    return { paras: out, h: h };
  }
  function fit(font, paras, maxW, maxH, maxS, minS, lh) {
    for (var s = maxS; s >= minS; s -= 0.5) {
      var L = layoutParas(font, paras, s, maxW, lh);
      if (L.h <= maxH) return { size: s, L: L, over: false };
    }
    return { size: minS, L: layoutParas(font, paras, minS, maxW, lh), over: true };
  }
  function drawCentered(P, page, font, text, size, cx, y, color) {
    page.drawText(text, { x: cx - font.widthOfTextAtSize(text, size) / 2, y: y, size: size, font: font, color: color });
  }
  function shrinkLines(font, text, maxW, maxS, minS) {   // title that must fit on <= 2 lines
    for (var s = maxS; s >= minS; s -= 1) {
      var ls = wrap(font, s, text, maxW);
      if (ls.length <= 2) return { size: s, lines: ls };
    }
    return { size: minS, lines: wrap(font, minS, text, maxW) };
  }
  function ornament(P, page, cx, y, color, w) {
    page.drawLine({ start: { x: cx - w / 2, y: y }, end: { x: cx - 10, y: y }, thickness: 1.2, color: color });
    page.drawLine({ start: { x: cx + 10, y: y }, end: { x: cx + w / 2, y: y }, thickness: 1.2, color: color });
    page.drawSvgPath('M0,-7 L2,-2 L7,0 L2,2 L0,7 L-2,2 L-7,0 L-2,-2 Z', { x: cx, y: y, scale: 1, color: color });
  }
  var INK = '#16213E', SOFT = '#5B6275', PAPER_TINT = '#FFF9EE';

  /* ---------- interior ---------- */
  // deps: { PDFLib, fontkit, loadFont(name)->Promise<Uint8Array>, getImage(key,pxW,pxH)->Promise<Uint8Array|null>, onProgress(i,n) }
  SF.buildInterior = async function (book, deps) {
    var P = deps.PDFLib, plan = SF.makePlan(book), n = plan.total;
    var doc = await P.PDFDocument.create();
    doc.registerFontkit(deps.fontkit);
    var disp = await doc.embedFont(await deps.loadFont('fredoka-600'), { subset: true });
    var dispB = await doc.embedFont(await deps.loadFont('fredoka-700'), { subset: true });
    var body = await doc.embedFont(await deps.loadFont('nunito-700'), { subset: true });
    var light = await doc.embedFont(await deps.loadFont('nunito-400'), { subset: true });
    doc.setTitle(book.title || 'Untitled'); doc.setAuthor(book.author || ''); doc.setProducer('StoryForge'); doc.setCreator('StoryForge');
    var ink = hex(P, INK), soft = hex(P, SOFT);
    var ageMax = { '3-5': 30, '6-8': 24, '9-12': 20, '6-12': 22 }[book.age] || 24;
    var tocMap = {}; plan.tocs.forEach(function (t) { tocMap[t.story] = t.page; });

    for (var i = 0; i < n; i++) {
      var d = plan.pages[i], no = i + 1, G = SF.geom(book, n, no);
      var page = doc.addPage([G.pw, G.ph]);
      var cx = G.bx + G.bw / 2;
      if (deps.onProgress) deps.onProgress(i, n);

      if (d.t === 'image') {
        var pxW = Math.min(4400, Math.ceil(G.pw / IN * SF.DPI)), pxH = Math.min(4400, Math.ceil(G.ph / IN * SF.DPI));
        var jb = await deps.getImage(d.key, pxW, pxH);
        if (jb) {
          var im = await doc.embedJpg(jb);
          page.drawImage(im, { x: 0, y: 0, width: G.pw, height: G.ph });
        } else {
          page.drawRectangle({ x: 0, y: 0, width: G.pw, height: G.ph, color: hex(P, '#EEF1F6') });
          drawCentered(P, page, disp, 'Picture missing', 22, G.x0 + G.tw / 2, G.ph / 2, soft);
        }
        continue;
      }

      if (d.t === 'title') {
        var tt = shrinkLines(dispB, book.title || 'Untitled', G.bw, 54, 26);
        var y = G.y0 + G.th * 0.66;
        tt.lines.forEach(function (ln) { drawCentered(P, page, dispB, ln, tt.size, cx, y, ink); y -= tt.size * 1.15; });
        y -= 8; ornament(P, page, cx, y, hex(P, SF.storyColor(0)), 150); y -= 40;
        if (book.subtitle) {
          var st = wrap(body, 19, book.subtitle, G.bw);
          st.forEach(function (ln) { drawCentered(P, page, body, ln, 19, cx, y, soft); y -= 25; });
        }
        if (book.dedication) {
          var dl = wrap(light, 14, book.dedication, G.bw * 0.8), dy = G.y0 + G.th * 0.25;
          dl.forEach(function (ln) { drawCentered(P, page, light, ln, 14, cx, dy, soft); dy -= 19; });
        }
        if (book.author) drawCentered(P, page, disp, book.author, 20, cx, G.y0 + G.th * 0.12, ink);
        continue;
      }

      if (d.t === 'copyright') {
        var lines = [
          book.title || '',
          'Text and illustrations © ' + (book.year || new Date().getFullYear()) + ' ' + (book.author || ''),
          'All rights reserved. No part of this book may be reproduced, stored or transmitted in any form without written permission from the author, except for brief quotations in reviews.',
          'This is a work of fiction. Names, characters, places and events are products of the imagination.',
          book.aiNotice ? 'Created with the help of AI tools and curated, edited and arranged by the author.' : '',
          'First edition ' + (book.year || new Date().getFullYear()) + '. Published through Amazon KDP.'
        ].filter(Boolean);
        var cy = G.y0 + G.th * 0.42;
        lines.forEach(function (t, k) {
          var f = k === 0 ? disp : light, s = k === 0 ? 16 : 11;
          wrap(f, s, t, G.bw).forEach(function (ln) { drawCentered(P, page, f, ln, s, cx, cy, k === 0 ? ink : soft); cy -= s * 1.5; });
          cy -= k === 0 ? 10 : 7;
        });
        continue;
      }

      if (d.t === 'toc') {
        drawCentered(P, page, dispB, 'Table of Contents', 34, cx, G.y0 + G.th - 1.5 * IN, ink);
        ornament(P, page, cx, G.y0 + G.th - 1.5 * IN - 22, ink, 150);
        var ss = book.stories || [], rows = ss.length, avail = G.bh - 2.2 * IN;
        var rowH = Math.min(36, Math.max(22, avail / Math.max(1, rows))), fs = rowH >= 30 ? 18 : 15;
        var ry = G.y0 + G.th - 2.6 * IN;
        ss.forEach(function (s, k) {
          var col = hex(P, SF.storyColor(k)), left = G.bx, right = G.bx + G.bw;
          var label = (k + 1) + '   ' + (s.title || 'Story ' + (k + 1)), pg = String(tocMap[k] || '');
          var wp = body.widthOfTextAtSize(pg, fs), maxLab = G.bw - wp - 30;
          while (body.widthOfTextAtSize(label, fs) > maxLab && label.length > 4) label = label.slice(0, -2);
          page.drawText(label, { x: left, y: ry, size: fs, font: body, color: ink });
          page.drawText(pg, { x: right - wp, y: ry, size: fs, font: body, color: col });
          for (var dx = left + body.widthOfTextAtSize(label, fs) + 8; dx < right - wp - 8; dx += 6) page.drawCircle({ x: dx, y: ry + 2, size: 0.8, color: soft });
          ry -= rowH;
        });
        continue;
      }

      if (d.t === 'text') {
        var story = book.stories[d.s], beat = story.beats[d.b], col = hex(P, SF.storyColor(d.s));
        var paras = String(beat.text || '').split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean);
        var head = d.b === 0 ? (d.s + 1) + '  ' + (story.title || '') : '';
        var hh = 0, hs = 0, hlines = [];
        if (head) { var hf = shrinkLines(dispB, head, G.bw, 36, 20); hs = hf.size; hlines = hf.lines; hh = hlines.length * hs * 1.2 + 26; }
        var F = fit(body, paras, G.bw, G.bh - hh - 30, ageMax, 13, 1.38);
        var total = hh + F.L.h, ty = G.by + G.bh / 2 + total / 2;
        hlines.forEach(function (ln) { ty -= hs; drawCentered(P, page, dispB, ln, hs, cx, ty, col); ty -= hs * 0.2; });
        if (head) { ty -= 10; ornament(P, page, cx, ty, col, 90); ty -= 16; }
        F.L.paras.forEach(function (ls, pi) {
          ls.forEach(function (ln) { ty -= F.size * 1.38; drawCentered(P, page, body, ln, F.size, cx, ty + F.size * 0.38, ink); });
          ty -= F.size * 0.55;
        });
        drawCentered(P, page, light, String(no), 11, cx, G.y0 + 0.4 * IN, soft);
        continue;
      }

      if (d.t === 'end') {
        var ec = hex(P, SF.storyColor(0));
        drawCentered(P, page, dispB, 'The End', 60, cx, G.y0 + G.th * 0.55, ink);
        ornament(P, page, cx, G.y0 + G.th * 0.55 - 26, ec, 180);
        drawCentered(P, page, body, 'New adventures are waiting...', 20, cx, G.y0 + G.th * 0.55 - 70, soft);
        continue;
      }

      if (d.t === 'draw') {
        drawCentered(P, page, dispB, 'Draw your favorite scene!', 28, cx, G.y0 + G.th - 1.4 * IN, ink);
        page.drawRectangle({ x: G.bx, y: G.by + 0.5 * IN, width: G.bw, height: G.bh - 1.8 * IN, borderColor: soft, borderWidth: 2, borderDashArray: [8, 7] });
        drawCentered(P, page, light, 'Who was with you? Where were you?', 13, cx, G.by + 0.1 * IN, soft);
        continue;
      }

      if (d.t === 'notes') {
        drawCentered(P, page, dispB, 'My adventure notes', 28, cx, G.y0 + G.th - 1.4 * IN, ink);
        var ly = G.y0 + G.th - 2.2 * IN;
        while (ly > G.by + 0.2 * IN) { page.drawLine({ start: { x: G.bx, y: ly }, end: { x: G.bx + G.bw, y: ly }, thickness: 0.8, color: hex(P, '#B9C0D0') }); ly -= 30; }
        continue;
      }

      if (d.t === 'thanks') {
        drawCentered(P, page, dispB, 'Thank you for reading!', 34, cx, G.y0 + G.th * 0.55, ink);
        ornament(P, page, cx, G.y0 + G.th * 0.55 - 26, hex(P, SF.storyColor(1)), 160);
        drawCentered(P, page, body, 'Keep exploring. The next map is waiting for you.', 16, cx, G.y0 + G.th * 0.55 - 62, soft);
        continue;
      }
    }
    if (deps.onProgress) deps.onProgress(n, n);
    return await doc.save();
  };

  /* ---------- cover (full wrap: back + spine + front, with bleed) ---------- */
  SF.coverInfo = function (book, total) {
    var t = SF.trim(book.trim), sp = SF.spineIn(total, book.paper), b = SF.BLEED;
    return { spine: sp, width: b + t.w + sp + t.w + b, height: b + t.h + b, hasSpineText: total > 79 };
  };
  SF.buildCover = async function (book, deps) {
    var P = deps.PDFLib, plan = SF.makePlan(book), total = plan.total, ci = SF.coverInfo(book, total);
    var t = SF.trim(book.trim), b = SF.BLEED * IN, tw = t.w * IN, sp = ci.spine * IN;
    var W = ci.width * IN, H = ci.height * IN;
    var doc = await P.PDFDocument.create(); doc.registerFontkit(deps.fontkit);
    var dispB = await doc.embedFont(await deps.loadFont('fredoka-700'), { subset: true });
    var body = await doc.embedFont(await deps.loadFont('nunito-700'), { subset: true });
    var light = await doc.embedFont(await deps.loadFont('nunito-400'), { subset: true });
    doc.setTitle((book.title || 'Untitled') + ' - cover'); doc.setProducer('StoryForge');
    var page = doc.addPage([W, H]);
    var back = book.backColor || '#16213E', navy = hex(P, '#16213E'), white = hex(P, '#FFFFFF');
    var frontX = b + tw + sp;                          // front panel starts here (trim edge on the spine side)
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hex(P, back) });

    // front art covers the whole front panel plus its three bleed edges
    var fw = W - frontX, fh = H;
    var jb = await deps.getImage('cover', Math.min(4400, Math.ceil(fw / IN * SF.DPI)), Math.min(4400, Math.ceil(fh / IN * SF.DPI)));
    if (jb) page.drawImage(await doc.embedJpg(jb), { x: frontX, y: 0, width: fw, height: fh });
    else page.drawRectangle({ x: frontX, y: 0, width: fw, height: fh, color: hex(P, '#3A86FF') });

    if (!book.coverHasTitle) {
    // title band on the front
    var fcx = frontX + (tw + b) / 2 - 0 , safeW = tw - 1.0 * IN, bandH = Math.min(3.0 * IN, fh * 0.34);
    page.drawRectangle({ x: frontX, y: H - bandH - 0, width: fw, height: bandH, color: navy });
    var tt = shrinkLines(dispB, book.title || 'Untitled', safeW, 58, 24), ty = H - b - 0.45 * IN;
    tt.lines.forEach(function (ln) { ty -= tt.size; drawCentered(P, page, dispB, ln, tt.size, frontX + tw / 2, ty, white); ty -= tt.size * 0.18; });
    if (book.subtitle) {
      var sl = wrap(body, 17, book.subtitle, safeW).slice(0, 2);
      ty -= 8; sl.forEach(function (ln) { ty -= 20; drawCentered(P, page, body, ln, 17, frontX + tw / 2, ty, hex(P, '#FFD27A')); });
    }
    if (book.author) {
      page.drawRectangle({ x: frontX, y: 0, width: fw, height: b + 0.8 * IN, color: navy });
      drawCentered(P, page, dispB, book.author, 22, frontX + tw / 2, b + 0.3 * IN, white);
    }
    }

    // back cover
    var light_bg = lum(back) > 0.6, tc = light_bg ? navy : white, bx = b + 0.6 * IN, bw = tw - 1.2 * IN;
    if (book.backCover) {
      var paras = String(book.backCover).split(/\n+/);
      var F = fit(body, paras, bw, H * 0.5, 17, 11, 1.4), by = H - b - 1.0 * IN;
      F.L.paras.forEach(function (ls) { ls.forEach(function (ln) { by -= F.size * 1.4; page.drawText(ln, { x: bx, y: by, size: F.size, font: body, color: tc }); }); by -= F.size * 0.6; });
    }
    var bcW = 2 * IN, bcH = 1.2 * IN;                  // KDP prints its barcode here; keep it clean
    page.drawRectangle({ x: b + tw - 0.35 * IN - bcW, y: b + 0.35 * IN, width: bcW, height: bcH, color: white });

    // spine
    if (ci.hasSpineText && sp > 0) {
      var sx = b + tw, sc = sx + sp / 2, ss = Math.min(sp * 0.5 / IN * IN, 20);
      page.drawText(book.title || '', { x: sc - ss * 0.35, y: H - b - 0.6 * IN, size: Math.max(10, ss), font: dispB, color: tc, rotate: P.degrees(-90) });
    }
    return { bytes: await doc.save(), info: ci, pages: total };
  };

  /* ---------- KDP checklist ---------- */
  // stats: { images:{have,need}, minPxDpi, srcPx, maxFont, overflow, ipHits:[...] }
  SF.runChecks = function (book, stats) {
    var plan = SF.makePlan(book), n = plan.total, t = SF.trim(book.trim), pp = SF.paper(book.paper), out = [];
    function add(level, text) { out.push({ level: level, text: text }); }
    add(n >= 24 ? 'ok' : 'fail', 'Page count ' + n + (n >= 24 ? ' — meets the 24-page minimum' : ' — KDP needs at least 24'));
    if (n < pp.minPages) add('fail', pp.label + ' needs at least ' + pp.minPages + ' pages');
    add(n % 2 === 0 ? 'ok' : 'warn', n % 2 === 0 ? 'Even page count (clean spreads)' : 'Odd page count — add one page');
    if (plan.fillers > 6) add('warn', plan.fillers + ' of ' + n + ' pages are activity filler. Add more stories or more text pages per story for a fuller book.');
    else if (plan.fillers) add('ok', plan.fillers + ' activity page' + (plan.fillers > 1 ? 's' : '') + ' added to reach ' + n + ' pages');
    var bl = book.bleed === false ? 0 : SF.BLEED;
    add('ok', 'Trim ' + t.w + ' × ' + t.h + ' in; PDF page ' + (t.w + bl).toFixed(3) + ' × ' + (t.h + 2 * bl).toFixed(3) + ' in' + (bl ? ' (0.125 in bleed on outer, top and bottom edges)' : ' (no bleed)'));
    add('ok', 'Gutter margin ' + SF.gutterIn(n) + ' in minimum for ' + n + ' pages; text kept 0.6 in from the outer edges');
    add('ok', 'Fonts are embedded (subset) in the PDF; no transparency, crop marks, comments or watermarks');
    add(t.w >= 4 && t.w <= 8.5 && t.h >= 6 && t.h <= 11.69 ? 'ok' : 'fail', 'Trim size ' + t.w + ' × ' + t.h + ' in is accepted by KDP paperbacks (width 4–8.5 in, height 6–11.69 in)');
    add('ok', 'Odd pages on the right, even pages on the left; outside margin 0.6 in (KDP needs 0.375 in with bleed)');
    add('ok', 'Smallest text in the PDF is 11 pt (KDP minimum is 7 pt)');
    add('ok', 'Cover: ' + (SF.coverInfo(book, n).width).toFixed(3) + ' × ' + (SF.coverInfo(book, n).height).toFixed(3) + ' in = bleed + back + spine (' + SF.spineIn(n, book.paper).toFixed(4) + ' in) + front + bleed; white 2 × 1.2 in barcode area on the back');
    if (stats && stats.images) {
      var miss = stats.images.need - stats.images.have;
      add(miss === 0 ? 'ok' : 'fail', miss === 0 ? 'All ' + stats.images.need + ' pictures are ready' : miss + ' of ' + stats.images.need + ' pictures are still missing');
    }
    if (stats && stats.srcPx) {
      var eff = Math.round(stats.srcPx / ((t.w + bl) || 1));
      add('warn', 'AI pictures are ' + stats.srcPx + ' px wide, about ' + eff + ' real DPI at print size. The PDF is upsampled to 300 DPI (KDP minimum), but fine detail stays soft — check the KDP Print Previewer.');
    }
    if (stats && stats.overflow) add('warn', stats.overflow + ' text page(s) use very small type — shorten the text or use a bigger trim size');
    if (stats && stats.ipHits && stats.ipHits.length) add('fail', 'Trademark risk in your text: ' + stats.ipHits.join(', '));
    add(book.title && book.title.length <= 200 ? 'ok' : 'fail', 'Title length ' + (book.title || '').length + '/200');
    add(book.author ? 'ok' : 'warn', book.author ? 'Author name set' : 'Set the author name (title page and cover)');
    add('info', 'In KDP > Content, answer "Yes" to AI-generated text and AI-generated images (KDP requires this disclosure for every title).');
    add('info', 'KDP limits how many new titles you can create and submit each week per format. The limits reset every Sunday at 00:00 UTC.');
    add('info', 'KDP > Content, in this order: (1) get a free KDP ISBN, (2) ' + pp.label + ', (3) trim ' + t.w + ' × ' + t.h + ' in, (4) Bleed (PDF only), (5) upload the INTERIOR first, then the cover (the cover size depends on the page count), (6) leave "my cover has a barcode" unchecked, (7) Launch Previewer, then Approve.');
    add('info', 'AI disclosure: Texts = entire work with minimal or no editing; Images = many AI-generated images with minimal or no editing. Name the real tools you used.');
    add('info', 'Do not tick "Low-content book" or "Large-print book". Pick reading age to match your story, and 2–3 categories that really fit.');
    if (n <= 79) add('info', 'KDP prints spine text only on books with more than 79 pages; the cover uses a plain spine.');
    return out;
  };
})();
