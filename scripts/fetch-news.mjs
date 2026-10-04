// Builds the "news" dataset from ONE news agency: reads its public RSS feed, downloads each story's lead image and
// writes markdown notes (same format as database/) into database-news/.
//
//   npm run news              Arab News (the default)
//   npm run news -- <agency>  any agency defined in AGENCIES below
//
// Only the headline, a short summary, the first few paragraphs, the lead image and a link back to the original are kept.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../database-news');
// No custom User-Agent: Arab News sits behind Cloudflare, which challenges (403) unfamiliar agent strings but lets Node's own default through.
const HEADERS = {};
const PER_SECTION = 12; // stories per category wall
const IMAGE_WIDTH = 1280; // pictures are shrunk to this (wire photos arrive as 8000px, 9 MB originals that would swamp the browser)

// Each agency: where its stories come from, and how its own categories map to the walls shown in the app.
// `match` lists the feed's <category> values for a section; stories whose category is not listed go to the last section.
const AGENCIES = {
  arabnews: {
    name: 'Arab News',
    feeds: ['https://www.arabnews.com/rss.xml'],
    sections: [
      { name: 'World', tag: 'world', match: ['World'] },
      { name: 'Middle East', tag: 'middle east', match: ['Middle East'] },
      { name: 'Saudi Arabia', tag: 'saudi arabia', match: ['Saudi Arabia'] },
      { name: 'Business', tag: 'business', match: ['Business', 'Finance', 'Tourism & Transport'] },
      { name: 'Sport', tag: 'sport', match: ['Sport', 'Football', 'Golf', 'Tennis'] },
      { name: 'Opinion', tag: 'opinion', match: ['Opinion'] },
      { name: 'Lifestyle', tag: 'lifestyle', match: ['Lifestyle', 'Fashion'] },
    ],
    youtube: 'UCI8DegIWgK51cGakXcf1dOQ', // the agency's own YouTube channel, for the Video wall
  },
};

const STOP = new Set(('a an the and or but of to in on at for with from by as is are was were be been it its this that these those '
  + 'has have had will would could should can may after before over under into about says say said new more most than then '
  + 'not no how why what who when where which their his her they he she you we us our up out off amid against first last '
  + 'year years day days week news live latest').split(' '));

// ---------- tiny RSS helpers (no dependencies) ----------

const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'");
const text = (html) => decode(decode(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const tagText = (xml, tag) => xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? '';

function lead(item) {
  // Largest media:content / media:thumbnail / enclosure image in the feed item
  const found = [];
  for (const m of item.matchAll(/<(media:content|media:thumbnail|enclosure)\b([^>]*)>/g)) {
    const a = m[2];
    const url = a.match(/url="([^"]+)"/)?.[1];
    const type = a.match(/type="([^"]+)"/)?.[1] ?? '';
    if (!url || (type && !type.startsWith('image')) || /\.(mp3|mp4)(\?|$)/i.test(url)) continue;
    found.push({ url: decode(url), width: +(a.match(/width="(\d+)"/)?.[1] ?? 0) });
  }
  found.sort((a, b) => b.width - a.width);
  return found[0]?.url ?? null;
}

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return as === 'text' ? res.text() : { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? '' };
}

// YouTube's oEmbed endpoint answers 401 for videos whose owners disabled embedding, so it doubles as a playability check
async function embeddable(id) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch { return false; }
}

async function readArticles(url) {
  const xml = await get(url);
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/g)].map(([item]) => ({
    title: text(tagText(item, 'title')),
    summary: text(tagText(item, 'description')),
    link: text(tagText(item, 'link')) || text(tagText(item, 'guid')),
    category: text(tagText(item, 'category')),
    image: lead(item),
  })).filter((s) => s.title && s.link);
}

async function readVideos(channel) {
  const xml = await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`);
  const vids = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map(([e]) => {
    const id = e.match(/<yt:videoId>([^<]+)</)?.[1];
    const thumb = e.match(/<media:thumbnail url="([^"]+)"/)?.[1] ?? null;
    return {
      video: id, link: `https://www.youtube.com/watch?v=${id}`,
      title: text(tagText(e, 'title')),
      summary: text(tagText(e, 'media:description').split(/\n\n|Episode credits|In this episode/)[0]).slice(0, 600),
      image: thumb?.replace('hqdefault', 'maxresdefault') ?? null, fallbackImage: thumb,
    };
  }).filter((v) => v.video);
  const ok = await Promise.all(vids.map((v) => embeddable(v.video)));
  return vids.filter((_, i) => ok[i]);
}

// One request per article: lead image fallback plus a short readable excerpt (first few real paragraphs)
async function pageInfo(link) {
  try {
    const html = (await get(link)).slice(0, 400000);
    const meta = (p) => decode((html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)["']`, 'i'))
      ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${p}["']`, 'i')))?.[1] ?? '');
    const body = html.replace(/<(script|style|nav|header|footer|aside|figure)[\s\S]*?<\/\1>/gi, '');
    const paras = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => text(m[1]))
      .filter((p) => p.length > 90 && !/cookie|subscribe|sign up|newsletter|all rights reserved|javascript/i.test(p));
    return { image: meta('og:image') || null, description: meta('og:description'), paras: paras.slice(0, 4) };
  } catch { return { image: null, description: '', paras: [] }; }
}

async function saveImage(url) {
  try {
    const { buf } = await get(url, 'bin');
    if (buf.length < 4000) return null;
    // every picture becomes a modest JPEG: card-sized, sRGB, no metadata
    const out = await sharp(buf, { limitInputPixels: false }).rotate()
      .resize({ width: IMAGE_WIDTH, height: IMAGE_WIDTH, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#101428' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    const name = `${createHash('sha1').update(url).digest('hex').slice(0, 12)}.jpg`;
    await writeFile(path.join(OUT, 'images', name), out);
    return name;
  } catch { return null; }
}

// ---------- shaping stories into notes ----------

// Note titles double as file names and [[wikilink]] targets, so keep them plain (and URL-safe: no %, #, ?)
const safeTitle = (t) => t.replace(/\s*%/g, ' percent').replace(/[\\/:*?"<>|[\]#^]/g, '').replace(/\s+/g, ' ').trim().replace(/^(.{1,72})(\s.*)?$/, '$1').trim();
const words = (t) => [...new Set(t.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [])].filter((w) => !STOP.has(w));
const overlap = (a, b) => a.filter((w) => b.includes(w)).length;
const bullets = (summary) => (summary.match(/[^.!?]+[.!?]+/g) ?? [summary]).map((s) => s.trim()).filter((s) => s.length > 25).slice(0, 3);

async function build(agencyKey) {
  const agency = AGENCIES[agencyKey];
  if (!agency) throw new Error(`Unknown agency "${agencyKey}". Known: ${Object.keys(AGENCIES).join(', ')}`);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, 'images'), { recursive: true });

  // 1. read the feeds and sort the stories into sections by the agency's own category
  const stories = [];
  const seenLinks = new Set();
  for (const url of agency.feeds) {
    for (const s of await readArticles(url).catch((e) => (console.warn(`feed failed: ${e.message}`), []))) {
      if (!seenLinks.has(s.link)) { seenLinks.add(s.link); stories.push(s); }
    }
  }
  const sections = agency.sections.map((def) => ({ ...def, stories: [] }));
  const fallback = sections[sections.length - 1];
  for (const s of stories) {
    const sec = sections.find((d) => d.match.some((m) => m.toLowerCase() === s.category.toLowerCase())) ?? fallback;
    if (sec.stories.length < PER_SECTION) sec.stories.push(s);
  }
  if (agency.youtube) {
    const videos = await readVideos(agency.youtube).catch((e) => (console.warn(`video feed failed: ${e.message}`), []));
    if (videos.length) sections.push({ name: 'Video', tag: 'video', stories: videos.slice(0, PER_SECTION) });
  }

  // 2. fetch each story's page and picture
  for (const sec of sections) {
    await Promise.all(sec.stories.map(async (s) => {
      s.source = agency.name;
      const info = s.video ? { image: null, paras: [], description: '' } : await pageInfo(s.link);
      s.paras = info.paras;
      if (info.description.length > s.summary.length) s.summary = info.description;
      s.file = null;
      for (const url of [s.image, s.fallbackImage, info.image]) if (url && !s.file) s.file = await saveImage(url);
      s.words = words(`${s.title} ${s.summary}`);
      s.note = safeTitle(s.title);
    }));
    sec.stories = sec.stories.filter((s) => s.note);
    console.log(`${sec.name}: ${sec.stories.length} stories`);
  }
  const live = sections.filter((s) => s.stories.length);
  const all = live.flatMap((s) => s.stories);

  // One picture shared by several stories is a placeholder logo, not a photo: drop it so those cards get a plain look
  const uses = new Map();
  for (const s of all) if (s.file) uses.set(s.file, (uses.get(s.file) ?? 0) + 1);
  for (const [file, n] of uses) {
    if (n < 3) continue;
    await rm(path.join(OUT, 'images', file), { force: true });
    for (const s of all) if (s.file === file) s.file = null;
    console.log(`dropped placeholder image used by ${n} stories`);
  }

  // Cross-links between stories that share enough distinctive words (strongest few per story)
  for (const s of all) {
    s.related = all.filter((o) => o !== s && o.note !== s.note)
      .map((o) => ({ o, score: overlap(s.words, o.words) })).filter((r) => r.score >= 3)
      .sort((a, b) => b.score - a.score).slice(0, 3).map((r) => r.o.note);
  }

  // 3. write the notes: one hub, one note per section, one per story
  const date = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const hub = safeTitle(agency.name);
  for (const sec of live) {
    await writeFile(path.join(OUT, `${sec.name}.md`), [
      '---', `tags: [${sec.tag}, section]`, '---', `# ${sec.name}`, '',
      `${agency.name}: ${sec.name.toLowerCase()} stories, ${date}.`, '',
      ...sec.stories.map((s) => `- [[${s.note}]]`), '', `Back to [[${hub}]].`, '',
    ].join('\n'));
    for (const s of sec.stories) {
      const lines = ['---', `tags: [${sec.tag}, ${agency.name.toLowerCase()}]`, '---', `# ${s.note}`, ''];
      if (s.file) lines.push(`![${agency.name}](images/${s.file})`, '');
      if (s.video) lines.push(`[video](youtube:${s.video})`, '');
      const b = bullets(s.summary);
      lines.push(...(b.length ? b.map((x) => `- ${x}`) : [s.summary ? `- ${s.summary}` : `- Read the full story at ${agency.name}.`]));
      if (s.paras.length) lines.push('', '## Story', '', ...s.paras.flatMap((p) => [p, '']));
      lines.push('', `- Source: ${agency.name}`);
      if (s.related.length) lines.push(`- Related: ${s.related.map((r) => `[[${r}]]`).join(', ')}`);
      lines.push('', `Back to [[${sec.name}]].`, '');
      await writeFile(path.join(OUT, `${s.note}.md`), lines.join('\n'));
    }
  }
  await writeFile(path.join(OUT, `${hub}.md`), [
    '---', 'tags: [index]', '---', `# ${hub}`, '',
    `Latest headlines from ${agency.name}, fetched ${date}. Start here and follow the links.`, '',
    ...live.flatMap((sec) => [`## ${sec.name}`, `- [[${sec.name}]]`, '']),
  ].join('\n'));
  console.log(`Wrote ${all.length + live.length + 1} notes to ${path.relative(process.cwd(), OUT)}`);
}

build(process.argv[2] ?? 'arabnews').catch((e) => { console.error(e); process.exit(1); });
