// StoryForge — Cloudflare Pages Function: /api/ai
//
//   GET  /api/ai?prompt=...&seed=123   -> image/jpeg  (Workers AI, flux-1-schnell)
//   POST /api/ai  {action, ...}        -> JSON        (Workers AI, Llama)
//        action = "outline" | "story" | "listing"
//
// Pages project -> Settings -> Bindings:
//   AI      (required)  Workers AI
//   LIMITS  (optional)  KV namespace, per-IP daily limits
// Optional variables: TEXT_MODEL, DAILY_IMAGES (default 200), DAILY_TEXT (default 150)

const IMG_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const TEXT_MODELS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'];

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// ---------- per-IP daily counter (only if a LIMITS KV is bound) ----------
async function bump(env, request, kind, max) {
  if (!env.LIMITS) return true;
  const ip = request.headers.get('cf-connecting-ip') || 'x';
  const key = `${kind}:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const n = parseInt((await env.LIMITS.get(key)) || '0', 10);
  if (n >= max) return false;
  await env.LIMITS.put(key, String(n + 1), { expirationTtl: 172800 });
  return true;
}

// ---------- tolerant JSON parsing of LLM output ----------
function parseLooseJSON(text) {
  if (text && typeof text === 'object') return text;
  let s = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON found');
  s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (e) { /* repair below */ }
  // escape raw newlines/tabs that appear inside strings, normalise smart quotes used as delimiters
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') continue;
      if (ch === '\t') { out += ' '; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  out = out.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(out);
}

// ---------- text generation with model fallback ----------
async function chat(env, system, user, maxTokens) {
  const models = env.TEXT_MODEL ? [env.TEXT_MODEL, ...TEXT_MODELS] : TEXT_MODELS;
  let lastErr;
  for (const model of models) {
    try {
      const r = await env.AI.run(model, {
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: maxTokens,
        temperature: 0.8,
      });
      const raw = r && (r.response ?? r.result?.response ?? r.choices?.[0]?.message?.content);
      if (raw == null || raw === '') throw new Error('empty response');
      return parseLooseJSON(raw);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('text model failed');
}

const SYS = 'You are an award-winning children\'s picture-book author and a Kindle Direct Publishing expert. ' +
  'You reply with ONE valid JSON object and nothing else: no markdown, no comments, no text before or after it. ' +
  'All content is original and child-safe: no trademarked or licensed characters, brands, franchises, songs or real people.';

const AGE = {
  '3-5':  { words: '25-40',  note: 'very simple words, short sentences, repetition and gentle sounds' },
  '6-8':  { words: '45-70',  note: 'simple sentences, lively dialogue, small cliffhangers between beats' },
  '9-12': { words: '70-110', note: 'richer vocabulary, humour, stronger suspense and emotion' },
};

const clip = (v, n) => String(v ?? '').slice(0, n);
const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, parseInt(v, 10) || d));

const IP_RULE = `Originality rule: use ONLY original, invented names for characters, places, creatures, objects and the book title. Never use or imitate any trademarked, copyrighted or famous name, brand, film, game, cartoon, book, song, catchphrase or celebrity (for example no Disney, Pixar, Marvel, Pokemon, Nintendo, Harry Potter, Star Wars, Lego, Barbie, Minecraft, Paw Patrol, Dr. Seuss, no real brands or sports teams). Do not copy plots of famous stories. Everything must feel new and original.`;
const avoidLine = b => (Array.isArray(b.avoid) && b.avoid.length) ? `\nDo NOT use these words or anything like them: ${b.avoid.slice(0, 12).map(w => clip(w, 30)).join(', ')}.` : '';

function outlinePrompt(b) {
  const n = num(b.stories, 7, 1, 12), a = AGE[b.age] || AGE['6-8'];
  return `Create the plan for an illustrated children's story book.
Book idea from the author: """${clip(b.idea, 900)}"""
Reader age: ${b.age || '6-8'} (${a.note}). Language of all text: ${clip(b.lang, 30) || 'English'}.
The book has exactly ${n} short stories. Each story continues the same cast so the whole book feels like one journey.

Return this JSON shape:
{
 "title": "catchy book title (max 60 chars)",
 "subtitle": "subtitle that says what the book is (max 90 chars)",
 "tagline": "one-line hook",
 "dedication": "short warm dedication line",
 "characters": [ { "name": "first name only", "role": "who they are", "look": "FIXED visual description for the illustrator, the same in every picture: age, skin tone, hair colour and style, ONE specific outfit (top, bottoms, shoes, each with a colour) that never changes, one accessory (max 35 words)" } ],
 "stories": [ { "title": "story title", "summary": "2 sentences: what happens and how it ends", "setting": "where it happens, visually", "lesson": "gentle lesson in 5-8 words" } ]
}
Rules: 2 to 4 characters, each with a DIFFERENT first name; "stories" has exactly ${n} items; use character names exactly as written in "characters" everywhere; never invent extra named characters inside "stories".
${IP_RULE}${avoidLine(b)}`;
}

function storyPrompt(b) {
  const a = AGE[b.age] || AGE['6-8'];
  const beats = num(b.beats, 2, 1, 4);
  const chars = (b.bible?.characters || []).map(c => `- ${clip(c.name, 30)}: ${clip(c.role, 80)}; looks: ${clip(c.look, 200)}`).join('\n');
  const all = (b.bible?.stories || []).map((s, i) => `${i + 1}. ${clip(s.title, 80)} - ${clip(s.summary, 200)}`).join('\n');
  const i = num(b.index, 0, 0, 20);
  const cur = b.bible?.stories?.[i] || {};
  return `Write story ${i + 1} of the picture book "${clip(b.bible?.title, 80)}".
Reader age: ${b.age || '6-8'} (${a.note}). Language: ${clip(b.lang, 30) || 'English'}.
Cast (use these exact names, nobody else is named):
${chars}
Whole book plan:
${all}
${b.prevSummary ? `Previous story ended with: ${clip(b.prevSummary, 300)}\n` : ''}This story: "${clip(cur.title, 80)}" - ${clip(cur.summary, 300)} Setting: ${clip(cur.setting, 150)}. Lesson: ${clip(cur.lesson, 80)}.
Write exactly ${beats} page-beats. Each beat is the text of ONE book page, ${a.words} words, with at least one line of spoken dialogue in double quotes placed on its own line. Beat 1 opens with a hook; the last beat resolves the story warmly (and may hint at the next adventure).

Return this JSON shape:
{ "pages": [ { "text": "page text; separate paragraphs with \\n", "scene": "what the illustration shows: place, action, which characters by name, lighting, camera angle (25-45 words, no text or letters in the picture). Never describe or change the characters' clothes or hair, their looks are added automatically" } ] }
"pages" has exactly ${beats} items.
${IP_RULE}${avoidLine(b)}`;
}

function listingPrompt(b) {
  const titles = (b.bible?.stories || []).map(s => clip(s.title, 80)).join('; ');
  return `Prepare the Amazon KDP listing for this illustrated children's paperback.
Title: "${clip(b.bible?.title, 80)}". Subtitle: "${clip(b.bible?.subtitle, 100)}". Reader age: ${b.age || '6-8'}. Language: ${clip(b.lang, 30) || 'English'}.
Stories inside: ${titles}.
Cast: ${(b.bible?.characters || []).map(c => clip(c.name, 30) + ' (' + clip(c.role, 60) + ')').join(', ')}.
Return this JSON shape:
{
 "title": "title for KDP (max 120 chars)",
 "subtitle": "subtitle for KDP (max 120 chars, includes the number of stories and the reader age)",
 "description": "book description for the Amazon page, 120-200 words, plain text with paragraphs separated by \\n, no trademarks, no promises of sales or awards",
 "back_cover": "back-cover blurb, 50-80 words, plain text",
 "keywords": ["exactly 7 search phrases, each max 50 characters, no trademarked names, no repeating words from the title"],
 "categories": ["3 KDP category paths such as Children's Books > Action & Adventure"],
 "reading_age": { "min": 6, "max": 9 },
 "cover_prompt": "illustration brief for the FRONT COVER picture: main characters by name in one dramatic scene, 30-50 words, no text or letters"
}
${IP_RULE}${avoidLine(b)}`;
}

// ---------- reference photo -> written "look" (images are never stored) ----------
const VISION = '@cf/meta/llama-3.2-11b-vision-instruct';
const DESCRIBE = 'This is a reference picture for a character in a children\'s picture book. Describe how an illustrator should draw this character as a friendly cartoon: approximate age, skin tone, hair colour and style, the outfit (each piece with its colour), and one accessory if there is one. Write ONE sentence of 30-40 words. No names, do not guess who the person is, no background, no commentary.';
async function describeImage(env, bytes) {
  const run = () => env.AI.run(VISION, { image: bytes, prompt: DESCRIBE, max_tokens: 140 });
  let r;
  try { r = await run(); }
  catch (e) {
    if (!/agree|licen|5016|terms/i.test(String(e && e.message || e))) throw e;
    await env.AI.run(VISION, { prompt: 'agree' });          // one-time licence acceptance for the Llama vision model
    r = await run();
  }
  const raw = r && (r.response ?? r.result?.response ?? r.description);
  const t = String(raw || '').replace(/["\n\r]+/g, ' ').replace(/^\s*(this|the)\s+(character|image|picture)[^,.:]*[:,]\s*/i, '').replace(/\s+/g, ' ').trim();
  if (t.length < 15) throw new Error('empty description');
  return t.slice(0, 260);
}

// ---------- handlers ----------
export async function onRequestPost({ request, env }) {
  if (!env.AI) return json({ error: 'Workers AI binding "AI" is missing' }, 500);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: 'Bad request body' }, 400); }
  if (!(await bump(env, request, 'txt', parseInt(env.DAILY_TEXT, 10) || 150))) return json({ error: 'daily_limit' }, 429);
  try {
    if (b.action === 'describe') {
      const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image || ''));
      if (!m || m[1].length > 1200000) return json({ error: 'Bad or too large image' }, 400);
      const bin = atob(m[1]), bytes = new Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return json({ ok: true, data: { look: await describeImage(env, bytes) } });
    }
    if (b.action === 'outline') {
      if (!clip(b.idea, 900).trim()) return json({ error: 'Missing idea' }, 400);
      return json({ ok: true, data: await chat(env, SYS, outlinePrompt(b), 1800) });
    }
    if (b.action === 'story') {
      if (!b.bible) return json({ error: 'Missing bible' }, 400);
      return json({ ok: true, data: await chat(env, SYS, storyPrompt(b), 1800) });
    }
    if (b.action === 'listing') {
      if (!b.bible) return json({ error: 'Missing bible' }, 400);
      return json({ ok: true, data: await chat(env, SYS, listingPrompt(b), 1500) });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: 'ai_failed', message: String(e && e.message || e).slice(0, 200) }, 502);
  }
}

export async function onRequestGet({ request, env }) {
  if (!env.AI) return json({ error: 'Workers AI binding "AI" is missing' }, 500);
  const u = new URL(request.url);
  const prompt = (u.searchParams.get('prompt') || '').slice(0, 1200);
  if (!prompt) return json({ error: 'Missing prompt' }, 400);
  const seed = (parseInt(u.searchParams.get('seed') || '0', 10) || 0) % 2147483647;
  if (!(await bump(env, request, 'img', parseInt(env.DAILY_IMAGES, 10) || 200))) return json({ error: 'daily_limit' }, 429);
  let r;
  try {
    try { r = await env.AI.run(IMG_MODEL, { prompt, steps: 4, seed }); }
    catch (e) { r = await env.AI.run(IMG_MODEL, { prompt, steps: 4 }); }   // some model versions reject "seed"
    const b64 = r && (r.image || r.result?.image);
    if (!b64) throw new Error('no image returned');
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return new Response(bin, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } });
  } catch (e) {
    return json({ error: 'ai_failed', message: String(e && e.message || e).slice(0, 200) }, 502);
  }
}
