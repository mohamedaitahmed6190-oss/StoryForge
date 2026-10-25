/* StoryForge — app1.js : app state, story writing, pictures, export UI */
(function () {
  'use strict';
  var SF = window.SF, $ = SF.$, $$ = SF.$$, esc = SF.esc;
  var DAILY_LIMIT = 150;                       // keep in step with your Cloudflare budget (PixelForge uses the same pool)
  var STYLES = {
    '3d': { label: '3D animated movie look', p: 'High-quality 3D animated children\'s film style illustration, soft cinematic lighting, rich colours, expressive friendly faces' },
    'water': { label: 'Soft watercolor storybook', p: 'Soft watercolor children\'s picture-book illustration, hand-painted paper texture, gentle warm colours' },
    'flat': { label: 'Bright flat vector', p: 'Clean flat vector children\'s book illustration, bold simple shapes, bright limited colour palette' },
    'gouache': { label: 'Cozy gouache painting', p: 'Cozy gouache picture-book painting, visible brush strokes, warm glowing light' },
    'comic': { label: 'Fun cartoon with ink lines', p: 'Fun cartoon illustration for kids, clean ink outlines, vivid flat colours, dynamic poses' }
  };
  var EXAMPLES = [
    'Three kids find a glowing map in their grandfather\'s attic and sail to hidden islands.',
    'A shy robot and a clumsy dragon open a bakery at the top of a mountain.',
    'Two sisters and their dog shrink to the size of ants and explore the garden kingdom.',
    'A moon-lit train that visits one sleepy animal town every night.'
  ];
  var B = null, IM = {}, RF = {}, step = 1, BUSY = {}, genStop = false, picStop = false, picRun = false, saveT, ipT;

  /* ---------- book model ---------- */
  function newBook() {
    return { id: 'b' + Date.now().toString(36), idea: '', age: '6-8', nStories: 7, beats: 2, lang: 'English', style: '3d', trim: '8.5x8.5', paper: 'premium',
      bleed: true, aiNotice: true, author: '', cast: '', year: new Date().getFullYear(), title: '', subtitle: '', tagline: '', dedication: '',
      characters: [], stories: [], cover: { prompt: '' }, listing: null, backColor: '#16213E', seeds: {}, srcPx: 1024, upPx: {}, upFit: 'fill' };
  }
  function sfBook() {                          // the shape app2.js expects
    var b = Object.assign({}, B); b.backCover = B.listing && B.listing.back_cover || ''; return b;
  }
  function imageKeys() {
    var k = ['cover'];
    B.stories.forEach(function (s, i) { (s.beats || []).forEach(function (_, j) { k.push('s' + i + 'b' + j); }); });
    return k;
  }
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(function () {
      SF.store.putBook({ id: B.id, name: B.title || (B.idea || '').slice(0, 40) || 'Untitled book', updated: Date.now(), data: B }).catch(function () {});
      try { localStorage.setItem('sf_last', B.id); } catch (e) {}
    }, 500);
  }
  function loadImages() {
    Object.keys(IM).forEach(function (k) { URL.revokeObjectURL(IM[k].url); }); IM = {};
    Object.keys(RF).forEach(function (k) { URL.revokeObjectURL(RF[k].url); }); RF = {};
    var rk = B.characters.map(function (_, i) { return 'ref' + i; });
    return Promise.all(rk.map(function (k, i) {
      return SF.store.getImg(B.id, k).then(function (bl) { if (bl) RF[i] = { blob: bl, url: URL.createObjectURL(bl) }; }).catch(function () {});
    }).concat(imageKeys().map(function (k) {
      return SF.store.getImg(B.id, k).then(function (bl) { if (bl) IM[k] = { blob: bl, url: URL.createObjectURL(bl) }; }).catch(function () {});
    })));
  }
  async function wipeImages() {
    var ks = imageKeys().concat(B.characters.map(function (_, i) { return 'ref' + i; }));
    await Promise.all(ks.map(function (k) { return SF.store.delImg(B.id, k).catch(function () {}); }));
    Object.keys(RF).forEach(function (k) { URL.revokeObjectURL(RF[k].url); }); RF = {}; IM = {};
  }

  /* ---------- daily counter ---------- */
  function today() { return new Date().toISOString().slice(0, 10); }
  function count() { try { return parseInt(localStorage.getItem('sf_n_' + today()) || '0', 10); } catch (e) { return 0; } }
  function bump() { try { localStorage.setItem('sf_n_' + today(), String(count() + 1)); } catch (e) {} paintCounter(); }
  function paintCounter() { var c = $('#counter'); c.textContent = count() + ' / ' + DAILY_LIMIT; c.title = 'Pictures made today (daily limit ' + DAILY_LIMIT + ')'; }

  /* ---------- API ---------- */
  function apiErr(r, j) {
    if (r.status === 429) return 'Daily limit reached on the server. Try again tomorrow.';
    var m = (j && (j.error || j.message)) || '';
    if (/binding/i.test(m)) return 'Workers AI is not connected. In Cloudflare Pages open Settings, Bindings, add Workers AI with the variable name AI, then redeploy.';
    return 'The AI did not answer (' + (m || r.status) + ').';
  }
  async function api(action, payload, tries) {
    var last;
    for (var a = 1; a <= (tries || 3); a++) {
      if (genStop) throw new Error('stopped');
      try {
        var r = await fetch('/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ action: action }, payload)) });
        var j = null; try { j = await r.json(); } catch (e) {}
        if (r.status === 429 || r.status === 500 && j && /binding/i.test(j.error || '')) throw Object.assign(new Error(apiErr(r, j)), { fatal: true });
        if (!r.ok || !j || !j.ok || !j.data) throw new Error(apiErr(r, j));
        return j.data;
      } catch (e) { last = e; if (e.fatal) throw e; await SF.sleep(1200 * a); }
    }
    throw last;
  }
  function clip(s, n) { return String(s == null ? '' : s).trim().slice(0, n); }
  function cleanText(t) {
    return String(t || '').replace(/\\n/g, '\n').replace(/^\s*(page|beat)\s*\d+\s*[:.-]\s*/i, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ---------- step 1: idea ---------- */
  function fillSelects() {
    $('#style').innerHTML = Object.keys(STYLES).map(function (k) { return '<option value="' + k + '">' + esc(STYLES[k].label) + '</option>'; }).join('');
    $('#trim').innerHTML = SF.TRIMS.map(function (t) { return '<option value="' + t.id + '">' + esc(t.label) + '</option>'; }).join('');
    $('#paper').innerHTML = SF.PAPERS.map(function (p) { return '<option value="' + p.id + '">' + esc(p.label) + '</option>'; }).join('');
    $('#chips').innerHTML = EXAMPLES.map(function (e, i) { return '<button type="button" class="chip" data-i="' + i + '">' + esc(e) + '</button>'; }).join('');
  }
  var FIELDS = { idea: 'idea', cast: 'cast', nStories: 'nStories', beats: 'beats', lang: 'lang', style: 'style', trim: 'trim', paper: 'paper', author: 'author' };
  function fillIdea() {
    Object.keys(FIELDS).forEach(function (id) { $('#' + id).value = B[FIELDS[id]]; });
    $('#bleed').checked = B.bleed !== false; $('#aiNotice').checked = !!B.aiNotice;
    $$('input[name=age]').forEach(function (r) { r.checked = r.value === B.age; });
    setAspect(); estimate();
  }
  function readIdea(e) {
    var id = e && e.target && e.target.id;
    if (id && FIELDS[id]) B[FIELDS[id]] = ['nStories', 'beats'].indexOf(id) >= 0 ? Math.max(1, Math.min(id === 'nStories' ? 12 : 4, parseInt(e.target.value, 10) || 1)) : e.target.value;
    if (id === 'bleed') B.bleed = e.target.checked;
    if (id === 'aiNotice') B.aiNotice = e.target.checked;
    if (e && e.target.name === 'age') B.age = e.target.value;
    setAspect(); estimate(); save();
  }
  function setAspect() {
    var t = SF.trim(B.trim), bl = B.bleed === false ? 0 : SF.BLEED;
    document.documentElement.style.setProperty('--ar', (t.w + bl) + '/' + (t.h + 2 * bl));
  }
  function estimate() {
    var n = B.nStories, bt = B.beats, fake = { paper: B.paper, stories: [] };
    for (var i = 0; i < n; i++) { var o = { beats: [] }; for (var j = 0; j < bt; j++) o.beats.push({}); fake.stories.push(o); }
    var pl = SF.makePlan(fake);
    $('#estimate').textContent = 'About ' + pl.total + ' pages and ' + (n * bt + 1) + ' pictures (the cover included). ' + (pl.fillers ? pl.fillers + ' activity page' + (pl.fillers > 1 ? 's are' : ' is') + ' added to reach the KDP minimum. ' : '');
  }

  async function writeBook() {
    var idea = (B.idea || '').trim();
    if (idea.length < 12) { SF.toast('Describe your idea in a full sentence first.'); $('#idea').focus(); return; }
    var hits = SF.ipHits(idea);
    if (hits.length && !(await SF.ask('Protected names in your idea', 'Your idea mentions <b>' + esc(hits.join(', ')) + '</b>. KDP can reject books that use trademarked characters or brands. Use your own original names instead.', 'Write anyway', 'Edit idea'))) { $('#idea').focus(); return; }
    if (B.stories.some(function (s) { return s.beats && s.beats.length; })) {
      if (!(await SF.ask('Replace the current story?', 'This writes a new book and deletes the pictures you already made for this one.', 'Replace it', 'Keep it'))) return;
      await wipeImages();
    }
    goto(2); await runGen();
  }

  function copyText(t, msg) {
    function fb() {
      var ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} ta.remove();
      SF.toast(ok ? msg : 'Could not copy. Select the text and copy it by hand.');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { SF.toast(msg); }, fb); else fb();
  }
  function wantPrompt() { try { return localStorage.getItem('sf_cp') !== '0'; } catch (e) { return true; } }
  function sizeLine() {                          // only the KDP picture size, no scene or characters
    var P = pageSize(), t = SF.trim(B.trim), bl = B.bleed === false ? 0 : SF.BLEED;
    return 'PICTURE SIZE: aspect ratio ' + P.ratio.toFixed(3) + ':1, which is ' + (t.w + bl).toFixed(3) + ' x ' + (t.h + 2 * bl).toFixed(3) + ' inches (' + P.W + ' x ' + P.H + ' px at 300 DPI) for Amazon KDP';
  }
  function copyPage(i, j) {
    var t = beatText(i, j), on = wantPrompt();
    copyText(on ? t + '\n\n' + sizeLine() : t, on ? 'Page text and picture size copied.' : 'Page text copied.');
  }
  function beatText(i, j) { return String(B.stories[i].beats[j].text || '').trim(); }
  function showGen(on, text, frac) {
    var g = $('#gen'); g.classList.toggle('on', on);
    if (text) $('#genT').textContent = text;
    if (frac != null) $('#genB').style.width = Math.round(frac * 100) + '%';
  }
  function enforceCast(o, cast) {                // if the AI still renamed the characters, put the author's names back
    var want = String(cast || '').split(/,|&|\band\b|\+|;/i).map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 4);
    if (!want.length || !o || !Array.isArray(o.characters)) return o;
    var have = o.characters.map(function (c) { return String(c && c.name || '').trim(); });
    var json = JSON.stringify(o);
    want.forEach(function (w, i) {
      if (have.some(function (h) { return h.toLowerCase() === w.toLowerCase(); }) || !have[i]) return;
      json = json.replace(new RegExp('\\b' + escRe(have[i]) + '\\b', 'g'), w.replace(/"/g, ''));
    });
    try { return JSON.parse(json); } catch (e) { return o; }
  }
  async function runGen() {
    genStop = false; $('#btnWrite').disabled = true;
    try {
      showGen(true, 'Planning your book…', 0.03);
      var o, avoid = SF.ipHits(B.idea);
      for (var t = 0; t < 3; t++) {
        o = await api('outline', { idea: B.idea, cast: B.cast, age: B.age, lang: B.lang, stories: B.nStories, avoid: avoid });
        var oh = SF.ipHits(JSON.stringify(o)).filter(function (w) { return SF.ipHits(B.idea).indexOf(w) < 0; });
        if (!oh.length) break; avoid = avoid.concat(oh);
      }
      o = enforceCast(o, B.cast);
      var chars = (o.characters || []).filter(function (c) { return c && c.name; }).slice(0, 4).map(function (c) { return { name: clip(c.name, 30), role: clip(c.role, 80), look: clip(c.look, 260) }; });
      var sts = (o.stories || []).filter(function (s) { return s && s.title; }).slice(0, B.nStories);
      if (!chars.length || !sts.length) throw new Error('The AI returned an incomplete plan. Try again.');
      B.title = clip(o.title, 200) || 'Untitled'; B.subtitle = clip(o.subtitle, 200); B.tagline = clip(o.tagline, 200); B.dedication = clip(o.dedication, 160);
      B.characters = chars; B.listing = null; B.cover = { prompt: '' }; B.seeds = {}; B.nStories = sts.length;
      B.stories = sts.map(function (s) { return { title: clip(s.title, 80), summary: clip(s.summary, 300), setting: clip(s.setting, 160), lesson: clip(s.lesson, 90), beats: [] }; });
      renderStory(); save();
      for (var i = 0; i < B.stories.length; i++) {
        if (genStop) break;
        showGen(true, 'Writing story ' + (i + 1) + ' of ' + B.stories.length + ': ' + B.stories[i].title, 0.08 + 0.8 * i / B.stories.length);
        try { await writeStory(i); renderStory(); save(); } catch (e) { if (e.fatal) throw e; if (e.message === 'stopped') break; SF.toast('Story ' + (i + 1) + ' failed. Use "Write this story" to retry.'); }
      }
      if (!genStop) { showGen(true, 'Writing the listing text…', 0.92); try { await makeListing(); } catch (e) { /* optional */ } }
      showGen(false); renderAll();
      SF.toast(genStop ? 'Stopped. You can finish the missing stories one by one.' : 'Your story is ready. Read it, then make the pictures.', 4200);
    } catch (e) {
      showGen(false); renderAll();
      await SF.ask('Could not write the book', esc(e.message || 'Unknown error'), 'OK', false);
    }
    $('#btnWrite').disabled = false;
  }
  async function writeStory(i) {
    var bible = { title: B.title, characters: B.characters, stories: B.stories.map(function (s) { return { title: s.title, summary: s.summary, setting: s.setting, lesson: s.lesson }; }) };
    var d, pg, avoid = [];
    for (var t = 0; t < 3; t++) {
      d = await api('story', { bible: bible, index: i, beats: B.beats, age: B.age, lang: B.lang, prevSummary: i ? B.stories[i - 1].summary : '', avoid: avoid });
      pg = (d.pages || []).filter(function (p) { return p && cleanText(p.text); }).slice(0, B.beats);
      var hits = SF.ipHits(pg.map(function (p) { return p.text + ' ' + p.scene; }).join(' '));
      if (!hits.length) break; avoid = avoid.concat(hits);
    }
    if (!pg.length) throw new Error('empty story');
    while (pg.length < B.beats) pg.push({ text: pg[pg.length - 1].text, scene: pg[pg.length - 1].scene });
    B.stories[i].beats = pg.map(function (p) { return { text: cleanText(p.text), scene: clip(p.scene, 400) || (B.stories[i].setting + '. ' + B.stories[i].title) }; });
  }
  async function makeListing() {
    var d = await api('listing', { bible: { title: B.title, subtitle: B.subtitle, characters: B.characters, stories: B.stories }, age: B.age, lang: B.lang }, 2);
    var kw = (d.keywords || []).map(function (k) { return clip(k, 50); }).filter(Boolean).slice(0, 7); while (kw.length < 7) kw.push('');
    var ra = d.reading_age || {};
    B.listing = { title: clip(d.title || B.title, 200), subtitle: clip(d.subtitle || B.subtitle, 200), description: clip(d.description, 4000), back_cover: clip(d.back_cover, 700),
      keywords: kw, categories: (d.categories || []).map(function (c) { return clip(c, 120); }).slice(0, 3), reading_age: { min: parseInt(ra.min, 10) || 6, max: parseInt(ra.max, 10) || 9 }, cover_prompt: clip(d.cover_prompt, 500) };
    if (!B.cover.prompt) B.cover.prompt = B.listing.cover_prompt || ('The main characters ' + B.characters.map(function (c) { return c.name; }).join(', ') + ' on an adventure, ' + B.title);
    save();
  }
  function coverFallback() {
    if (!B.cover.prompt) B.cover.prompt = 'The main characters ' + B.characters.map(function (c) { return c.name; }).join(', ') + ' on an exciting adventure. ' + (B.title || '');
  }

  /* ---------- story editor ---------- */
  function renderStory() {
    var has = B.stories.length > 0;
    $('#bookForm').hidden = !has; $('#storyEmpty').hidden = has;
    $('#bTitle').value = B.title; $('#bSub').value = B.subtitle; $('#bDed').value = B.dedication;
    $('#chars').innerHTML = B.characters.map(function (c, i) {
      return '<div class="c"><button type="button" class="ref" data-act="ref" data-c="' + i + '" aria-label="Reference image for ' + esc(c.name) + '">' + (RF[i] ? '<img alt="" src="' + RF[i].url + '">' : 'Add reference image') + '</button>' +
        '<input type="text" data-c="' + i + '" data-f="name" value="' + esc(c.name) + '" aria-label="Character name" maxlength="30">' +
        '<textarea rows="3" data-c="' + i + '" data-f="look" aria-label="How ' + esc(c.name) + ' looks" maxlength="260">' + esc(c.look) + '</textarea>' +
        (RF[i] ? '<div class="acts"><button type="button" class="btn sm ghost" data-act="ref" data-c="' + i + '">Change image</button><button type="button" class="btn sm" data-act="cleanref" data-c="' + i + '">Make a clean reference</button><button type="button" class="btn sm ghost danger" data-act="refdel" data-c="' + i + '">Remove image</button></div>' : '') + '</div>';
    }).join('');
    $('#stories').innerHTML = B.stories.map(function (s, i) {
      var beats = (s.beats || []).map(function (b, j) {
        return '<div class="beat"><small>Page text ' + (j + 1) + '</small><textarea data-s="' + i + '" data-b="' + j + '" data-f="text">' + esc(b.text) + '</textarea>' +
          '<button type="button" class="btn sm ghost" data-act="copybeat" data-s="' + i + '" data-b="' + j + '">Copy this page text</button>' +
          '<small>What the picture shows</small><textarea class="sc" data-s="' + i + '" data-b="' + j + '" data-f="scene">' + esc(b.scene) + '</textarea></div>';
      }).join('');
      return '<div class="story" style="--c:' + SF.storyColor(i) + '"><div class="sh"><input type="text" data-s="' + i + '" data-f="title" value="' + esc(s.title) + '" aria-label="Story ' + (i + 1) + ' title" maxlength="80"></div>' +
        '<p class="sum">' + esc(s.summary) + '</p>' + (beats || '<p class="hint" style="margin-left:8px">This story has no text yet.</p>') +
        '<div class="sp-a"><button class="btn sm ghost" data-act="rewrite" data-s="' + i + '">' + (beats ? 'Rewrite this story' : 'Write this story') + '</button>' + (beats ? '<button class="btn sm ghost" data-act="copystory" data-s="' + i + '">Copy the whole story</button>' : '') + '</div></div>';
    }).join('');
    paintIp();
  }
  function allText() {
    var t = [B.idea, B.title, B.subtitle, B.dedication, B.author];
    B.characters.forEach(function (c) { t.push(c.name, c.role, c.look); });
    B.stories.forEach(function (s) { t.push(s.title, s.summary); (s.beats || []).forEach(function (b) { t.push(b.text, b.scene); }); });
    if (B.listing) t.push(B.listing.title, B.listing.subtitle, B.listing.description, B.listing.back_cover, (B.listing.keywords || []).join(' '));
    return t.join(' \n ');
  }
  function paintIp() {
    var h = SF.ipHits(allText());
    $('#ipBox').innerHTML = h.length ? '<div class="warnbox"><b>Possible trademarked names:</b> ' + esc(h.join(', ')) + '.<br>Replace them with original names before publishing. KDP can reject titles that use protected characters or brands.</div>' : '';
    return h;
  }
  function onStoryInput(e) {
    var t = e.target, f = t.dataset.f; if (!f && !t.id) return;
    if (t.id === 'bTitle') B.title = t.value; else if (t.id === 'bSub') B.subtitle = t.value; else if (t.id === 'bDed') B.dedication = t.value;
    else if (t.dataset.c != null) B.characters[+t.dataset.c][f] = t.value;
    else if (t.dataset.s != null && t.dataset.b != null) B.stories[+t.dataset.s].beats[+t.dataset.b][f] = t.value;
    else if (t.dataset.s != null) B.stories[+t.dataset.s][f] = t.value;
    else return;
    save(); clearTimeout(ipT); ipT = setTimeout(paintIp, 600);
  }
  async function rewrite(i) {
    if (B.stories[i].beats.length && !(await SF.ask('Rewrite story ' + (i + 1) + '?', 'The current text of this story is replaced. Its pictures stay, so check they still match.', 'Rewrite', 'Cancel'))) return;
    genStop = false; showGen(true, 'Writing story ' + (i + 1) + '…', 0.4);
    try { await writeStory(i); renderStory(); save(); SF.toast('Story ' + (i + 1) + ' rewritten.'); }
    catch (e) { SF.toast(e.message || 'Could not write it. Try again.', 5000); }
    showGen(false);
  }

  /* ---------- reference image for a character (used directly by the picture model) ---------- */
  var refFor = -1, refIn;
  function shrink(file) {                        // the picture model wants each reference under 512 x 512
    return new Promise(function (res, rej) {
      var im = new Image(), u = URL.createObjectURL(file);
      im.onload = function () {
        var k = Math.min(1, 480 / Math.max(im.width, im.height)), c = document.createElement('canvas');
        c.width = Math.max(64, Math.round(im.width * k)); c.height = Math.max(64, Math.round(im.height * k));
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(u);
        c.toBlob(function (bl) { bl ? res(bl) : rej(new Error('Could not read the image.')); }, 'image/jpeg', 0.9);
      };
      im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('This file is not a picture.')); };
      im.src = u;
    });
  }
  async function setRef(file) {
    var i = refFor, ch = B.characters[i]; if (!file || !ch) return;
    try {
      var bl = await shrink(file);
      if (RF[i]) URL.revokeObjectURL(RF[i].url);
      RF[i] = { blob: bl, url: URL.createObjectURL(bl) };
      await SF.store.putImg(B.id, 'ref' + i, bl); renderStory();
      SF.toast(ch.name + ' will be drawn from your image. Make the pictures again to see it.', 4800);
    } catch (e) { SF.toast(e.message || 'Could not use this image.', 5000); }
  }
  async function cleanRef(i) {                   // turn the uploaded picture into a clean full-body model sheet, then use that as the reference
    var ch = B.characters[i]; if (!ch || !RF[i]) return;
    var btn = $('#chars [data-act=cleanref][data-c="' + i + '"]'); if (btn) { btn.disabled = true; btn.textContent = 'Painting…'; }
    try {
      if (count() >= DAILY_LIMIT) throw new Error('Daily picture limit reached.');
      var st = STYLES[B.style] || STYLES['3d'], fd = new FormData();
      fd.append('prompt', 'Character model sheet for a children\'s picture book. Draw ONLY the character ' + ch.name + ' from image 0: full body, standing straight, facing the camera with a gentle smile, relaxed arms, plain light-grey background, soft even lighting. Keep exactly the same face, hair, skin tone, age and outfit as image 0. ' + ch.look + '. STYLE: ' + st.p + '. One character only, no other people, no text, no watermark.');
      fd.append('width', '768'); fd.append('height', '1024'); fd.append('seed', String(1 + Math.floor(Math.random() * 2000000000)));
      fd.append('input_image_0', RF[i].blob, 'ref.jpg');
      var r = await fetch('/api/ai?mode=ref', { method: 'POST', body: fd });
      var ct = r.headers.get('content-type') || '';
      if (!r.ok || ct.indexOf('image') < 0) { var j = null; try { j = await r.json(); } catch (e) {} throw new Error(apiErr(r, j)); }
      var bl = await shrink(await r.blob()); bump();
      URL.revokeObjectURL(RF[i].url); RF[i] = { blob: bl, url: URL.createObjectURL(bl) };
      await SF.store.putImg(B.id, 'ref' + i, bl); renderStory();
      SF.toast(ch.name + ' now has a clean reference. Not happy? Press it again or add another image.', 5200);
    } catch (e) { if (btn) { btn.disabled = false; btn.textContent = 'Make a clean reference'; } SF.toast(e.message || 'Could not make the reference.', 5000); }
  }
  async function delRef(i) {
    if (RF[i]) URL.revokeObjectURL(RF[i].url); delete RF[i];
    await SF.store.delImg(B.id, 'ref' + i).catch(function () {}); renderStory();
  }

  /* ---------- step 3: pictures ---------- */
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  var GROUP = /\b(kids|children|friends|trio|three|explorers|team|everyone|together|all of them|they)\b/i;
  function buildFor(key) {
    var st = STYLES[B.style] || STYLES['3d'], scene, cast, extra, hay;
    if (key === 'cover') { scene = B.cover.prompt; hay = scene; extra = 'Book cover illustration, dramatic inviting composition, open sky or calm area in the upper third, no title text.'; }
    else {
      var m = /^s(\d+)b(\d+)$/.exec(key), b = B.stories[+m[1]].beats[+m[2]];
      scene = b.scene; hay = b.scene + ' ' + b.text; extra = 'Wide composition with the main subject centered and calm margins around it.';
    }
    cast = B.characters.map(function (c, i) { return { c: c, i: i }; }).filter(function (x) { return x.c.name && new RegExp('\\b' + escRe(x.c.name) + '\\b', 'i').test(hay); });
    if ((!cast.length || GROUP.test(scene)) && B.characters.length) cast = B.characters.slice(0, 3).map(function (c, i) { return { c: c, i: i }; });
    var withRef = cast.filter(function (x) { return RF[x.i]; }).slice(0, 4), noRef = cast.filter(function (x) { return !RF[x.i]; });
    var tail = ' SCENE: ' + scene + ' STYLE: ' + st.p + '. ' + extra + ' No text, no letters, no logos, no watermark, no frame.', lock = '';
    if (withRef.length) {
      lock = withRef.map(function (x, k) { return 'Image ' + k + ' is the character ' + x.c.name; }).join('. ') + '. Draw these characters in the scene exactly like their reference images: same face, same hair, same skin tone, same age, same height and body proportions, same outfit and colours, never change clothes. All children are 8 to 10 years old with natural child proportions, not chibi or baby-like. ';
    }
    var looks = noRef.map(function (x) { return x.c.name + ' = ' + x.c.look + '.'; }).join(' ');
    if (looks) lock += 'CHARACTERS (identical in every picture: same face, same hair, same exact outfit and colours): ' + looks + ' ';
    return { prompt: (lock + tail).slice(0, 1700), refs: withRef.map(function (x) { return RF[x.i].blob; }) };
  }
  function promptFor(key) { return buildFor(key).prompt; }
  function seedFor(key) {                       // one shared seed per book keeps faces and outfits consistent; "New picture" sets its own
    if (B.seeds[key]) return B.seeds[key];
    if (!B.seeds.base) B.seeds.base = 1 + Math.floor(Math.random() * 2000000000);
    return B.seeds.base;
  }
  function paintImage(key) {
    $$('[data-img="' + key + '"]').forEach(function (el) {
      el.classList.toggle('busy', !!BUSY[key]);
      el.innerHTML = (IM[key] ? '<img alt="" src="' + IM[key].url + '">' : '<div class="ph">' + (BUSY[key] ? 'Painting…' : 'No picture yet') + '</div>') +
        (IM[key] && !BUSY[key] ? '<button type="button" class="regen" data-act="gen" data-key="' + key + '">↻ Not good? Make a new one</button>' : '');
    });
  }
  function renderPics() {
    var keys = imageKeys(), have = keys.filter(function (k) { return IM[k]; }).length;
    $$('input[name=upfit]').forEach(function (r) { r.checked = r.value === (B.upFit || 'fill'); });
    coverFallback(); $('#coverPrompt').value = B.cover.prompt; $('#coverDel').disabled = !IM.cover;
    $('#picInfo').textContent = B.stories.length ? have + ' of ' + keys.length + ' pictures ready. Each picture takes about 10 seconds. Left page is the text, right page is the picture. You can also upload your own picture for any page (only use pictures you have the right to use).' : 'Write your story first (step 1).';
    $('#btnAllPics').disabled = !B.stories.length;
    $('#spreads').innerHTML = B.stories.map(function (s, i) {
      return '<div class="sp-h" style="--c:' + SF.storyColor(i) + '"><h3>' + (i + 1) + '  ' + esc(s.title) + '</h3></div>' + (s.beats || []).map(function (b, j) {
        var key = 's' + i + 'b' + j;
        return '<div class="spread"><div class="pg"><p>' + esc(b.text) + '</p></div><div class="im" data-img="' + key + '"></div></div>' +
          '<div class="sp-a"><button class="btn sm" data-act="gen" data-key="' + key + '">' + (IM[key] ? 'New picture' : 'Make picture') + '</button>' +
          '<button class="btn sm ghost" data-act="up" data-key="' + key + '">Upload my picture</button>' +
          '<button class="btn sm ghost" data-act="copy" data-s="' + i + '" data-b="' + j + '">Copy text</button>' +
          '<button class="btn sm ghost" data-act="dl" data-key="' + key + '"' + (IM[key] ? '' : ' disabled') + '>Save image</button>' +
          '<button class="btn sm ghost danger" data-act="del" data-key="' + key + '"' + (IM[key] ? '' : ' disabled') + '>Delete picture</button></div>' +
          '<details style="margin:-6px 0 8px"><summary class="hint" style="cursor:pointer">Edit the scene</summary><textarea class="sc" rows="3" data-s="' + i + '" data-b="' + j + '" data-f="scene" style="margin-top:6px">' + esc(b.scene) + '</textarea></details>';
      }).join('');
    }).join('');
    keys.forEach(paintImage);
    barStatus();
  }
  function missing() { return imageKeys().filter(function (k) { return !IM[k]; }); }
  function pgen(on, text, frac) { $('#pgen').classList.toggle('on', on); if (text) $('#pgenT').textContent = text; if (frac != null) $('#pgenB').style.width = Math.round(frac * 100) + '%'; }
  async function oneImage(key) {
    var bf = buildFor(key), url = '/api/ai?prompt=' + encodeURIComponent(bf.prompt) + '&seed=' + seedFor(key), init;
    if (bf.refs.length) {
      var sz = SF.trim(B.trim), bl2 = B.bleed === false ? 0 : SF.BLEED, w = sz.w + bl2, h = sz.h + 2 * bl2, kk = 1280 / Math.max(w, h), fd = new FormData();
      fd.append('prompt', bf.prompt); fd.append('seed', String(seedFor(key)));
      fd.append('width', String(Math.round(w * kk / 16) * 16)); fd.append('height', String(Math.round(h * kk / 16) * 16));
      bf.refs.forEach(function (r, k) { fd.append('input_image_' + k, r, 'ref' + k + '.jpg'); });
      url = '/api/ai?mode=ref'; init = { method: 'POST', body: fd };
    }
    for (var a = 1; a <= 3 && !picStop; a++) {
      if (count() >= DAILY_LIMIT) throw Object.assign(new Error('Daily picture limit reached (' + DAILY_LIMIT + '). It resets tomorrow.'), { fatal: true });
      try {
        var r = await fetch(url, init);
        if (r.status === 429) throw Object.assign(new Error('Daily limit reached on the server. Try again tomorrow.'), { fatal: true });
        var ct = r.headers.get('content-type') || '';
        if (!r.ok || ct.indexOf('image') < 0) { var j = null; try { j = await r.json(); } catch (e) {} throw new Error(apiErr(r, j)); }
        var bl = await r.blob();
        if (IM[key]) URL.revokeObjectURL(IM[key].url);
        IM[key] = { blob: bl, url: URL.createObjectURL(bl) };
        await SF.store.putImg(B.id, key, bl); bump();
        if (key === 'cover') { try { B.backColor = await SF.avgColor(bl); } catch (e) {} }
        try { var bm = await createImageBitmap(bl); B.srcPx = bm.width; if (B.upPx) delete B.upPx[key]; } catch (e) {}
        save(); return;
      } catch (e) { if (e.fatal) throw e; if (a === 3) throw e; await SF.sleep(1500 * a); }
    }
  }
  async function delPic(key) {
    if (!IM[key]) return;
    if (!(await SF.ask('Delete this picture?', 'The picture is removed from this page. You can make a new one or upload your own.', 'Delete', 'Keep'))) return;
    URL.revokeObjectURL(IM[key].url); delete IM[key]; if (B.upPx) delete B.upPx[key];
    await SF.store.delImg(B.id, key).catch(function () {}); save(); renderPics(); SF.toast('Picture deleted.');
  }
  var upKey = '', upIn;
  function pageSize() {                          // exact KDP page (with bleed) in 300 DPI pixels
    var t = SF.trim(B.trim), bl = B.bleed === false ? 0 : SF.BLEED, w = t.w + bl, h = t.h + 2 * bl, k = Math.min(1, 3500 / (Math.max(w, h) * SF.DPI));
    return { W: Math.round(w * SF.DPI * k), H: Math.round(h * SF.DPI * k), ratio: w / h };
  }
  async function useUpload(file) {
    var key = upKey; if (!file || !key) return;
    try {
      var bm = await createImageBitmap(file), P = pageSize(), c = document.createElement('canvas'), x = c.getContext('2d'), eff;
      c.width = P.W; c.height = P.H;
      if ((B.upFit || 'fill') === 'whole') {       // whole picture on top of a soft blurred copy of itself
        var kb = Math.max(P.W / bm.width, P.H / bm.height), bw = bm.width * kb, bh = bm.height * kb;
        try { x.filter = 'blur(40px)'; } catch (e) {}
        x.drawImage(bm, (P.W - bw) / 2, (P.H - bh) / 2, bw, bh); x.filter = 'none';
        x.fillStyle = 'rgba(0,0,0,.18)'; x.fillRect(0, 0, P.W, P.H);
        var kf = Math.min(P.W / bm.width, P.H / bm.height), fw = bm.width * kf, fh = bm.height * kf;
        x.drawImage(bm, (P.W - fw) / 2, (P.H - fh) / 2, fw, fh); eff = Math.round(bm.width * P.W / fw);
      } else {                                      // fill the page: crop to the page shape, keep the upper-middle of the picture
        var sw = bm.width, sh = bm.height, sx = 0, sy = 0;
        if (sw / sh > P.ratio) { sw = Math.round(sh * P.ratio); sx = Math.round((bm.width - sw) / 2); }
        else { sh = Math.round(sw / P.ratio); sy = Math.round((bm.height - sh) * 0.4); }
        x.drawImage(bm, sx, sy, sw, sh, 0, 0, P.W, P.H); eff = sw;
      }
      var bl = await new Promise(function (res, rej) { c.toBlob(function (b) { b ? res(b) : rej(new Error('Could not read the picture.')); }, 'image/jpeg', 0.92); });
      if (IM[key]) URL.revokeObjectURL(IM[key].url);
      IM[key] = { blob: bl, url: URL.createObjectURL(bl) };
      await SF.store.putImg(B.id, key, bl);
      B.upPx = B.upPx || {}; B.upPx[key] = eff;
      if (key === 'cover') { try { B.backColor = await SF.avgColor(bl); } catch (e) {} }
      save(); renderPics();
      SF.toast(eff < 1500 ? 'Picture fitted to the page, but the original is small (' + eff + ' px). It may look soft in print.' : 'Picture fitted to the KDP page size (' + P.W + ' × ' + P.H + ' px).', 4800);
    } catch (e) { SF.toast(e.message || 'This file is not a picture.', 5000); }
  }
  function pickUpload(key) {
    upKey = key;
    if (!upIn) { upIn = document.createElement('input'); upIn.type = 'file'; upIn.accept = 'image/*'; upIn.onchange = function () { var f = upIn.files[0]; upIn.value = ''; useUpload(f); }; }
    upIn.click();
  }
  async function runPics(keys) {
    if (picRun || !keys.length) return;
    picRun = true; picStop = false; $('#btnStopPics').hidden = false; $('#btnAllPics').disabled = true;
    var done = 0, total = keys.length, i = 0, err = null;
    pgen(true, 'Making pictures… 0 of ' + total, 0.02);
    async function worker() {
      while (!picStop && !err) {
        var k = keys[i++]; if (!k) return;
        BUSY[k] = 1; paintImage(k);
        try { await oneImage(k); done++; } catch (e) { err = e; }
        BUSY[k] = 0; paintImage(k); pgen(true, 'Making pictures… ' + done + ' of ' + total, done / total);
      }
    }
    await Promise.all([worker(), worker()]);
    picRun = false; $('#btnStopPics').hidden = true; pgen(false); renderPics();
    if (err) await SF.ask('Picture stopped', esc(err.message || 'Unknown error') + (done ? '<br><br>' + done + ' picture' + (done > 1 ? 's were' : ' was') + ' saved.' : ''), 'OK', false);
    else SF.toast(picStop ? 'Stopped.' : 'Pictures done. Open the Export step.', 4000);
  }

  /* ---------- step 4: export ---------- */
  function renderExport() {
    var sb = sfBook(), pl = SF.makePlan(sb), ci = SF.coverInfo(sb, pl.total), keys = imageKeys();
    var have = keys.filter(function (k) { return IM[k]; }).length;
    $('#sumLine').innerHTML = '<span>' + pl.total + '<small>pages</small></span><span>' + have + '/' + keys.length + '<small>pictures</small></span><span>' + ci.spine.toFixed(3) + ' in<small>spine</small></span><span>' + ci.width.toFixed(3) + ' × ' + ci.height.toFixed(3) + ' in<small>cover with bleed</small></span>';
    var stats = { images: { have: have, need: keys.length }, srcPx: have ? Math.min.apply(null, [B.srcPx].concat(Object.keys(B.upPx || {}).filter(function (k) { return IM[k]; }).map(function (k) { return B.upPx[k]; }))) : 0, ipHits: SF.ipHits(allText()) };
    var ic = { ok: '✓', warn: '!', fail: '✕', info: 'i' };
    $('#checks').innerHTML = SF.runChecks(sb, stats).map(function (c) { return '<li><span class="i ' + c.level + '">' + ic[c.level] + '</span><span>' + esc(c.text) + '</span></li>'; }).join('');
    renderListing(); barStatus();
  }
  function renderListing() {
    var L = B.listing, el = $('#listing');
    if (!L) { el.innerHTML = '<p class="hint">Not written yet. Press "Write listing text".</p>'; return; }
    function fld(label, id, val, max, tag, extra) {
      var inner = tag === 'ta' ? '<textarea id="' + id + '" data-l="' + extra + '" rows="' + (max > 500 ? 8 : 3) + '">' + esc(val) + '</textarea>' : '<input type="text" id="' + id + '" data-l="' + extra + '" value="' + esc(val) + '">';
      return '<div class="f"><div class="h"><label for="' + id + '">' + label + '</label><span><span class="cnt" data-cnt="' + id + '" data-max="' + max + '"></span> <button class="btn ghost sm" data-act="copy" data-for="' + id + '">Copy</button></span></div>' + inner + '</div>';
    }
    var h = fld('Title', 'l_title', L.title, 200, 'in', 'title') + fld('Subtitle', 'l_sub', L.subtitle, 200, 'in', 'subtitle') + fld('Description', 'l_desc', L.description, 4000, 'ta', 'description') +
      fld('Back cover text', 'l_back', L.back_cover, 700, 'ta', 'back_cover');
    L.keywords.forEach(function (k, i) { h += fld('Keyword ' + (i + 1), 'l_kw' + i, k, 50, 'in', 'kw' + i); });
    (L.categories || []).forEach(function (c, i) { h += fld('Category ' + (i + 1), 'l_cat' + i, c, 120, 'in', 'cat' + i); });
    h += '<p class="hint">Reading age: ' + L.reading_age.min + ' to ' + L.reading_age.max + ' years. Check category names against the list KDP shows you.</p>';
    el.innerHTML = h; $$('[data-cnt]', el).forEach(updCnt);
  }
  function updCnt(span) {
    var inp = $('#' + span.dataset.cnt), max = +span.dataset.max, n = inp.value.length;
    span.textContent = n + '/' + max; span.classList.toggle('bad', n > max);
  }
  function onListingInput(e) {
    var f = e.target.dataset.l; if (!f || !B.listing) return; var L = B.listing, v = e.target.value;
    if (/^kw\d$/.test(f)) L.keywords[+f[2]] = v; else if (/^cat\d$/.test(f)) L.categories[+f[3]] = v; else L[f] = v;
    var s = $('[data-cnt="' + e.target.id + '"]'); if (s) updCnt(s); save();
  }
  function xgen(on, text, frac) { $('#xgen').classList.toggle('on', on); if (text) $('#xgenT').textContent = text; if (frac != null) $('#xgenB').style.width = Math.round(frac * 100) + '%'; }
  var exporting = false;
  async function exportPdf(kind) {
    if (exporting) return;
    var miss = kind === 'cover' ? (IM.cover ? [] : ['cover']) : missing().filter(function (k) { return k !== 'cover'; });
    if (miss.length && !(await SF.ask(kind === 'cover' ? 'Cover picture missing' : miss.length + ' pictures missing', 'Missing pictures print as grey placeholders. Make them first in step 3, or export anyway.', 'Export anyway', 'Go back'))) return;
    exporting = true; $('#btnInterior').disabled = $('#btnCover').disabled = true;
    try {
      xgen(true, 'Loading tools…', 0.03); await SF.loadLibs();
      var deps = { PDFLib: window.PDFLib, fontkit: window.fontkit, loadFont: SF.loadFont,
        getImage: function (key, w, h) { return IM[key] ? SF.prepImage(IM[key].blob, w, h) : Promise.resolve(null); },
        onProgress: function (i, n) { xgen(true, 'Building page ' + Math.min(i + 1, n) + ' of ' + n + '…', 0.05 + 0.9 * i / n); } };
      var sb = sfBook(), name = SF.slug(B.title);
      if (kind === 'cover') {
        xgen(true, 'Building the cover…', 0.3);
        var r = await SF.buildCover(sb, deps); SF.download(r.bytes, name + '-cover.pdf');
        SF.toast('Cover PDF ready: ' + r.info.width.toFixed(3) + ' × ' + r.info.height.toFixed(3) + ' in.', 5000);
      } else {
        var bytes = await SF.buildInterior(sb, deps);
        if (bytes.length > 650 * 1048576) throw new Error('The interior PDF is ' + (bytes.length / 1048576).toFixed(0) + ' MB. KDP accepts files up to 650 MB. Use fewer pages or smaller pictures.');
        SF.download(bytes, name + '-interior.pdf');
        SF.toast('Interior PDF ready (' + (bytes.length / 1048576).toFixed(1) + ' MB).', 5000);
      }
    } catch (e) { await SF.ask('Export failed', esc(e.message || String(e)), 'OK', false); }
    xgen(false); exporting = false; $('#btnInterior').disabled = $('#btnCover').disabled = false;
  }

  /* ---------- navigation ---------- */
  function barStatus() {
    var st = $('#barSt'), keys = B.stories.length ? imageKeys() : [];
    var t = { 1: '', 2: B.stories.length ? B.stories.length + ' stories' : '', 3: keys.length ? keys.filter(function (k) { return IM[k]; }).length + ' / ' + keys.length + ' pictures' : '', 4: B.stories.length ? SF.makePlan(sfBook()).total + ' pages' : '' };
    st.textContent = t[step] || '';
  }
  function goto(n) {
    step = n;
    $$('.panel').forEach(function (p, i) { p.classList.toggle('on', i + 1 === n); });
    $$('#steps button').forEach(function (b) { var s = +b.dataset.step; b.toggleAttribute('aria-current', false); if (s === n) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); b.disabled = s > 2 && !B.stories.length; b.classList.toggle('done', s < n && (s < 3 || !!B.stories.length)); });
    $('#btnBack').style.visibility = n === 1 ? 'hidden' : 'visible';
    var nx = $('#btnNext'); nx.style.visibility = n === 4 ? 'hidden' : 'visible';
    nx.textContent = { 1: B.stories.length ? 'Open story' : 'Write my book', 2: 'Make pictures', 3: 'Export' }[n] || '';
    nx.className = 'btn' + (n === 2 || n === 3 ? ' red' : '');
    if (n === 2) renderStory(); if (n === 3) renderPics(); if (n === 4) renderExport();
    barStatus(); window.scrollTo(0, 0);
  }
  function renderAll() { fillIdea(); renderStory(); if (step === 3) renderPics(); if (step === 4) renderExport(); paintCounter(); goto(step); }

  /* ---------- my books ---------- */
  async function showBooks() {
    var list = (await SF.store.listBooks()).sort(function (a, b) { return b.updated - a.updated; });
    $('#booksList').innerHTML = list.length ? list.map(function (b) {
      return '<div class="bk"><div class="n"><b>' + esc(b.name) + '</b><small>' + new Date(b.updated).toLocaleDateString() + (b.id === B.id ? ' · open now' : '') + '</small></div>' +
        '<button class="btn sm" data-act="open" data-id="' + b.id + '">Open</button><button class="btn sm ghost" data-act="del" data-id="' + b.id + '" aria-label="Delete ' + esc(b.name) + '">Delete</button></div>';
    }).join('') : '<p class="hint">No saved books yet.</p>';
    var d = $('#booksDlg'); if (!d.open) d.showModal();
  }
  async function openBook(id) {
    var rec = await SF.store.getBook(id); if (!rec) return;
    B = Object.assign(newBook(), rec.data); await loadImages(); $('#booksDlg').close();
    try { localStorage.setItem('sf_last', B.id); } catch (e) {}
    step = B.stories.length ? 2 : 1; renderAll();
  }
  async function startOver() {
    if (!(await SF.ask('Delete everything and start over?', 'The story, the pictures, the reference images and the listing text of this book are deleted from this device. This cannot be undone.', 'Delete all', 'Keep it'))) return;
    var old = B.id;
    await wipeImages();
    await SF.store.delBook(old).catch(function () {});
    B = newBook(); step = 1; try { localStorage.setItem('sf_last', B.id); } catch (e) {}
    renderAll(); save(); SF.toast('Clean slate. Describe your new book.');
  }
  async function importBook(obj) {
    var d = obj && obj.format === 'storyforge-book' && obj.data;
    if (!d || !Array.isArray(d.stories) || !Array.isArray(d.characters)) throw new Error('This is not a StoryForge book file.');
    if (B.stories.length || B.idea) save();
    var refs = d.refsB64 || []; d = Object.assign({}, d); delete d.refsB64;
    B = Object.assign(newBook(), d, { id: 'b' + Date.now().toString(36) });
    for (var i = 0; i < refs.length && i < B.characters.length; i++) {          // reference images that travel with the book file
      try { var bin = atob(refs[i]), u8 = new Uint8Array(bin.length); for (var j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j); await SF.store.putImg(B.id, 'ref' + i, new Blob([u8], { type: 'image/jpeg' })); } catch (e) {}
    }
    await loadImages(); save(); $('#booksDlg').close(); step = 2; renderAll();
    SF.toast(refs.length ? 'Book loaded with the three character reference images. Make the pictures.' : 'Book loaded. Add reference images if you like, then make the pictures.', 5200);
  }
  var impIn;
  async function newOne() {
    if (B.stories.length || B.idea) save();
    B = newBook(); IM = {}; Object.keys(RF).forEach(function (k) { URL.revokeObjectURL(RF[k].url); }); RF = {}; $('#booksDlg').close(); step = 1; renderAll(); save();
  }

  /* ---------- wiring ---------- */
  function bind() {
    $('#p1').addEventListener('input', readIdea); $('#p1').addEventListener('change', readIdea);
    $('#chips').addEventListener('click', function (e) { var c = e.target.closest('.chip'); if (!c) return; B.idea = EXAMPLES[+c.dataset.i]; $('#idea').value = B.idea; save(); });
    $('#btnWrite').onclick = writeBook;
    $('#genStop').onclick = function () { genStop = true; $('#genT').textContent = 'Stopping…'; };
    $('#bookForm').addEventListener('input', onStoryInput);
    $('#p2').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act=rewrite]'); if (b) rewrite(+b.dataset.s);
      var cb = e.target.closest('[data-act=copybeat]'); if (cb) copyPage(+cb.dataset.s, +cb.dataset.b);
      var cs = e.target.closest('[data-act=copystory]'); if (cs) { var si = +cs.dataset.s; copyText(B.stories[si].title + '\n\n' + B.stories[si].beats.map(function (x, j) { return beatText(si, j); }).join('\n\n'), 'Story copied.'); }
      var p = e.target.closest('[data-act=ref]'), d = e.target.closest('[data-act=refdel]');
      if (d) delRef(+d.dataset.c);
      var cr = e.target.closest('[data-act=cleanref]'); if (cr) cleanRef(+cr.dataset.c);
      if (p) { refFor = +p.dataset.c; if (!refIn) { refIn = document.createElement('input'); refIn.type = 'file'; refIn.accept = 'image/*'; refIn.onchange = function () { var f = refIn.files[0]; refIn.value = ''; setRef(f); }; } refIn.click(); }
    });
    $('#spreads').addEventListener('input', onStoryInput);
    $('#spreads').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return; var k = b.dataset.key;
      if (b.dataset.act === 'gen') { B.seeds[k] = 1 + Math.floor(Math.random() * 2000000000); runPics([k]).then(renderPics); }
      if (b.dataset.act === 'copy') copyPage(+b.dataset.s, +b.dataset.b);
      if (b.dataset.act === 'up') pickUpload(k);
      if (b.dataset.act === 'del') delPic(k);
      if (b.dataset.act === 'dl' && IM[k]) SF.download(IM[k].blob, SF.slug(B.title) + '-' + k + '.jpg', 'image/jpeg');
    });
    $$('.cpOpt').forEach(function (c) { c.checked = wantPrompt(); c.onchange = function () { try { localStorage.setItem('sf_cp', c.checked ? '1' : '0'); } catch (e) {} $$('.cpOpt').forEach(function (o) { o.checked = c.checked; }); }; });
    $$('input[name=upfit]').forEach(function (r) { r.onchange = function () { B.upFit = r.value; save(); }; });
    $('#btnAllPics').onclick = function () { runPics(missing()); };
    $('#btnStopPics').onclick = function () { picStop = true; };
    $('#coverPrompt').addEventListener('input', function (e) { B.cover.prompt = e.target.value; save(); });
    $('#coverIm').addEventListener('click', function (e) { if (e.target.closest('.regen')) { B.seeds.cover = 1 + Math.floor(Math.random() * 2000000000); runPics(['cover']).then(renderPics); } });
    $('#coverDel').onclick = function () { delPic('cover'); };
    $('#coverUp').onclick = function () { pickUpload('cover'); };
    $('#coverGo').onclick = function () { B.seeds.cover = 1 + Math.floor(Math.random() * 2000000000); runPics(['cover']).then(renderPics); };
    $('#btnInterior').onclick = function () { exportPdf('interior'); };
    $('#btnCover').onclick = function () { exportPdf('cover'); };
    $('#btnListing').onclick = async function () {
      if (!B.stories.length) return SF.toast('Write your story first.');
      var b = $('#btnListing'); b.disabled = true; b.textContent = 'Writing…'; genStop = false;
      try { await makeListing(); renderExport(); } catch (e) { SF.toast(e.message || 'Could not write the listing.', 5000); }
      b.disabled = false; b.textContent = 'Write listing text';
    };
    $('#listing').addEventListener('input', onListingInput);
    $('#listing').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act=copy]'); if (!b) return; var v = $('#' + b.dataset.for).value;
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(function () { SF.toast('Copied.'); }, function () { $('#' + b.dataset.for).select(); SF.toast('Select and copy.'); });
    });
    $$('#steps button').forEach(function (b) { b.onclick = function () { goto(+b.dataset.step); }; });
    $('#btnBack').onclick = function () { goto(step - 1); };
    $('#btnNext').onclick = function () { if (step === 1 && !B.stories.length) writeBook(); else goto(step + 1); };
    $('#booksImport').onclick = function () {
      if (!impIn) { impIn = document.createElement('input'); impIn.type = 'file'; impIn.accept = '.json,application/json'; impIn.onchange = function () { var f = impIn.files[0]; impIn.value = ''; if (!f) return; f.text().then(function (t) { return importBook(JSON.parse(t)); }).catch(function (e) { SF.toast(e.message || 'Could not read this file.', 5000); }); }; }
      impIn.click();
    };
    $('#booksBook2').onclick = function () {
      fetch('books/the-moonlight-map.json').then(function (r) { if (!r.ok) throw new Error('Book file not found.'); return r.json(); }).then(importBook).catch(function (e) { SF.toast(e.message || 'Could not load the book.', 5000); });
    };
    $('#btnBooks').onclick = showBooks; $('#btnReset').onclick = startOver; $('#btnReset2').onclick = startOver; $('#booksClose').onclick = function () { $('#booksDlg').close(); }; $('#booksNew').onclick = newOne;
    $('#booksList').addEventListener('click', async function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'open') openBook(b.dataset.id);
      if (b.dataset.act === 'del' && await SF.ask('Delete this book?', 'The text and all pictures are removed from this device.', 'Delete', 'Keep')) {
        await SF.store.delBook(b.dataset.id); if (b.dataset.id === B.id) { B = newBook(); IM = {}; RF = {}; renderAll(); } showBooks();
      }
    });
    window.addEventListener('beforeunload', function () { if (B) SF.store.putBook({ id: B.id, name: B.title || (B.idea || '').slice(0, 40) || 'Untitled book', updated: Date.now(), data: B }); });
  }

  async function init() {
    fillSelects(); bind();
    var last = null; try { last = localStorage.getItem('sf_last'); } catch (e) {}
    var rec = last ? await SF.store.getBook(last).catch(function () { return null; }) : null;
    B = rec ? Object.assign(newBook(), rec.data) : newBook();
    await loadImages(); step = B.stories.length ? 2 : 1; renderAll();
  }
  SF.app = { get B() { return B; }, get IM() { return IM; }, goto: goto, runPics: runPics };
  init();
})();
