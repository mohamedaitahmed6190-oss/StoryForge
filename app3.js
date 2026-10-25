/* StoryForge — app3.js : helpers (DOM, trademark guard, storage, image prep, libraries, download) */
(function () {
  var SF = (window.SF = window.SF || {});

  /* ---------- DOM helpers ---------- */
  SF.$ = function (s, r) { return (r || document).querySelector(s); };
  SF.$$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  SF.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  SF.slug = function (s) { return String(s || 'book').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'book'; };
  SF.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var tt;
  SF.toast = function (msg, ms) {
    var t = SF.$('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(tt); tt = setTimeout(function () { t.classList.remove('on'); }, ms || 3200);
  };
  SF.ask = function (title, msg, ok, cancel) {
    return new Promise(function (res) {
      var d = SF.$('#dlg'); SF.$('#dlgT').textContent = title; SF.$('#dlgM').innerHTML = msg;
      var b1 = SF.$('#dlgOk'), b2 = SF.$('#dlgNo');
      b1.textContent = ok || 'OK'; b2.textContent = cancel || 'Cancel'; b2.hidden = cancel === false;
      function done(v) { b1.onclick = b2.onclick = null; d.onclose = null; d.close(); res(v); }
      b1.onclick = function () { done(true); }; b2.onclick = function () { done(false); };
      d.onclose = function () { res(false); };
      d.showModal();
    });
  };

  /* ---------- trademark / IP guard (client side, same idea as PixelForge) ---------- */
  var BLOCK = ('disney,pixar,marvel,dc comics,batman,superman,spider-man,spiderman,avengers,iron man,hulk,mickey mouse,minnie mouse,donald duck,goofy,elsa,olaf,moana,lion king,simba,toy story,woody,buzz lightyear,finding nemo,shrek,minions,despicable me,kung fu panda,madagascar,toothless,pokemon,pokémon,pikachu,charizard,nintendo,super mario,mario bros,luigi,zelda,sonic the hedgehog,minecraft,roblox,fortnite,among us,angry birds,hello kitty,sanrio,peppa pig,paw patrol,bluey,cocomelon,baby shark,sesame street,elmo,cookie monster,winnie the pooh,tigger,eeyore,harry potter,hogwarts,hermione,dumbledore,voldemort,star wars,yoda,darth vader,baby yoda,mandalorian,lego,barbie,hot wheels,transformers,optimus prime,spongebob,patrick star,dora the explorer,scooby-doo,scooby doo,tom and jerry,looney tunes,bugs bunny,the simpsons,peter pan,tinker bell,tinkerbell,naruto,dragon ball,goku,one piece,demon slayer,my little pony,care bears,smurfs,garfield,snoopy,charlie brown,curious george,dr. seuss,dr seuss,cat in the hat,grinch,wimpy kid,percy jackson,narnia,lord of the rings,gandalf,hobbit,indiana jones,jurassic park,pirates of the caribbean,jack sparrow,nike,adidas,coca-cola,coca cola,mcdonald,lamborghini,ferrari,youtube,tiktok,netflix,fifa,nba,nfl,real madrid,paw patrol').split(',');
  var BRE = new RegExp('(^|[^a-z0-9])(' + BLOCK.map(function (w) { return w.trim().replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'); }).join('|') + ')($|[^a-z0-9])', 'gi');
  SF.ipHits = function (text) {
    var hits = {}, m; BRE.lastIndex = 0;
    String(text || '').toLowerCase().replace(BRE, function (all, a, w) { hits[w] = 1; return all; });
    return Object.keys(hits);
  };

  /* ---------- IndexedDB: books (json) + images (blobs) ---------- */
  var dbp;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var r = indexedDB.open('storyforge', 1);
      r.onupgradeneeded = function () { var d = r.result; d.createObjectStore('books', { keyPath: 'id' }); d.createObjectStore('imgs'); };
      r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function tx(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, mode), s = t.objectStore(store), out = fn(s);
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : undefined); }; t.onerror = function () { rej(t.error); };
      });
    });
  }
  SF.store = {
    putBook: function (b) { return tx('books', 'readwrite', function (s) { return s.put(b); }); },
    getBook: function (id) { return tx('books', 'readonly', function (s) { return s.get(id); }); },
    listBooks: function () { return tx('books', 'readonly', function (s) { return s.getAll(); }); },
    delBook: function (id) {
      return db().then(function (d) {
        return new Promise(function (res) {
          var t = d.transaction(['books', 'imgs'], 'readwrite'); t.objectStore('books').delete(id);
          var rq = t.objectStore('imgs').openCursor(IDBKeyRange.bound(id + ':', id + ':￿'));
          rq.onsuccess = function () { var c = rq.result; if (c) { c.delete(); c.continue(); } };
          t.oncomplete = res; t.onerror = res;
        });
      });
    },
    putImg: function (id, key, blob) { return tx('imgs', 'readwrite', function (s) { return s.put(blob, id + ':' + key); }); },
    getImg: function (id, key) { return tx('imgs', 'readonly', function (s) { return s.get(id + ':' + key); }); },
    delImg: function (id, key) { return tx('imgs', 'readwrite', function (s) { return s.delete(id + ':' + key); }); }
  };

  /* ---------- image processing for print ---------- */
  // Crops to the exact page shape, resamples to the pixel size that gives 300 DPI, gently sharpens, returns JPEG bytes.
  SF.prepImage = async function (blob, pxW, pxH, scrim) {
    var bmp = await createImageBitmap(blob);
    var c = document.createElement('canvas'); c.width = pxW; c.height = pxH;
    var g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    var s = Math.max(pxW / bmp.width, pxH / bmp.height), sw = pxW / s, sh = pxH / s;
    var sx = (bmp.width - sw) / 2, sy = (bmp.height - sh) / 2;
    // upscale in two steps (softer result than one big jump)
    if (s > 2) {
      var m = document.createElement('canvas'); m.width = Math.round(sw * 2); m.height = Math.round(sh * 2);
      var mg = m.getContext('2d'); mg.imageSmoothingQuality = 'high'; mg.drawImage(bmp, sx, sy, sw, sh, 0, 0, m.width, m.height);
      g.drawImage(m, 0, 0, m.width, m.height, 0, 0, pxW, pxH); m.width = m.height = 1;
    } else g.drawImage(bmp, sx, sy, sw, sh, 0, 0, pxW, pxH);
    if (bmp.close) bmp.close();
    sharpen(g, pxW, pxH, 0.45);
    if (scrim) {                          // dark fade behind the title (baked into the picture, so the PDF has no transparency)
      var t = g.createLinearGradient(0, 0, 0, pxH * 0.42); t.addColorStop(0, 'rgba(10,16,36,0.88)'); t.addColorStop(0.6, 'rgba(10,16,36,0.45)'); t.addColorStop(1, 'rgba(10,16,36,0)');
      g.fillStyle = t; g.fillRect(0, 0, pxW, pxH * 0.42);
      var u = g.createLinearGradient(0, pxH * 0.84, 0, pxH); u.addColorStop(0, 'rgba(10,16,36,0)'); u.addColorStop(1, 'rgba(10,16,36,0.75)');
      g.fillStyle = u; g.fillRect(0, pxH * 0.84, pxW, pxH * 0.16);
    }
    var out = await new Promise(function (r) { c.toBlob(r, 'image/jpeg', 0.92); });
    var buf = new Uint8Array(await out.arrayBuffer()); c.width = c.height = 1;
    return buf;
  };
  function sharpen(g, w, h, amt) {      // unsharp-style 3x3, processed in horizontal bands to keep memory low
    var band = 256;
    for (var y0 = 0; y0 < h; y0 += band) {
      var ys = Math.max(0, y0 - 1), ye = Math.min(h, y0 + band + 1);
      var img = g.getImageData(0, ys, w, ye - ys), d = img.data, src = new Uint8ClampedArray(d), W4 = w * 4;
      for (var y = 1; y < ye - ys - 1; y++) {
        if (ys + y < y0 || ys + y >= y0 + band) continue;
        for (var x = 1; x < w - 1; x++) {
          var i = y * W4 + x * 4;
          for (var k = 0; k < 3; k++) {
            var v = src[i + k], avg = (src[i + k - 4] + src[i + k + 4] + src[i + k - W4] + src[i + k + W4]) / 4;
            d[i + k] = v + (v - avg) * amt;
          }
        }
      }
      g.putImageData(img, 0, ys);
    }
  }
  SF.avgColor = async function (blob) {
    var bmp = await createImageBitmap(blob), c = document.createElement('canvas'); c.width = c.height = 8;
    var g = c.getContext('2d'); g.drawImage(bmp, 0, 0, 8, 8); var d = g.getImageData(0, 0, 8, 8).data, r = 0, gg = 0, b = 0, n = 0;
    for (var i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    r /= n; gg /= n; b /= n;
    var mix = function (v, t) { return Math.round(v * 0.6 + t * 0.4); };           // pull toward deep navy so text stays readable
    var h = function (v) { return ('0' + v.toString(16)).slice(-2); };
    return '#' + h(mix(r, 22)) + h(mix(gg, 33)) + h(mix(b, 62));
  };

  /* ---------- libraries & fonts (loaded when you export) ---------- */
  var CDN = 'https://cdn.jsdelivr.net/npm/';
  SF.FONTS = {
    'fredoka-600': CDN + '@fontsource/fredoka@5/files/fredoka-latin-600-normal.woff',
    'fredoka-700': CDN + '@fontsource/fredoka@5/files/fredoka-latin-700-normal.woff',
    'nunito-700': CDN + '@fontsource/nunito@5/files/nunito-latin-700-normal.woff',
    'nunito-400': CDN + '@fontsource/nunito@5/files/nunito-latin-400-normal.woff'
  };
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { rej(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }
  SF.loadLibs = async function () {
    if (!window.PDFLib) await loadScript(CDN + 'pdf-lib@1.17.1/dist/pdf-lib.min.js');
    if (!window.fontkit) await loadScript(CDN + '@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js');
  };
  var fcache = {};
  SF.loadFont = function (name) {
    if (!fcache[name]) fcache[name] = fetch(SF.FONTS[name]).then(function (r) {
      if (!r.ok) throw new Error('Font download failed (' + name + ')');
      return r.arrayBuffer();
    }).then(function (b) { return new Uint8Array(b); });
    return fcache[name];
  };
  SF.download = function (bytes, name, type) {
    var url = URL.createObjectURL(new Blob([bytes], { type: type || 'application/pdf' }));
    var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 60000);
    return url;
  };
})();
