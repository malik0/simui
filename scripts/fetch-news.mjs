// Builds the "news" dataset: reads public RSS feeds, downloads each story's lead image and writes
// markdown notes (same format as database/) into database-news/. Run with `npm run news`.
// Only headline, short summary, image and a link back to the original are kept, never full article text.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../database-news');
const PER_FEED = 3; // stories taken from each outlet per section
const UA = 'Mozilla/5.0 (compatible; KnowledgeSpaceNews/1.0)';

const SECTIONS = {
  World: {
    tag: 'world',
    feeds: {
      BBC: 'https://feeds.bbci.co.uk/news/world/rss.xml',
      Guardian: 'https://www.theguardian.com/world/rss',
      NPR: 'https://feeds.npr.org/1004/rss.xml',
    },
  },
  Technology: {
    tag: 'tech',
    feeds: {
      BBC: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
      Guardian: 'https://www.theguardian.com/technology/rss',
      NPR: 'https://feeds.npr.org/1019/rss.xml',
    },
  },
  Business: {
    tag: 'business',
    feeds: {
      BBC: 'https://feeds.bbci.co.uk/news/business/rss.xml',
      Guardian: 'https://www.theguardian.com/business/rss',
      NPR: 'https://feeds.npr.org/1006/rss.xml',
    },
  },
  Sport: {
    tag: 'sport',
    feeds: {
      BBC: 'https://feeds.bbci.co.uk/sport/rss.xml',
      Guardian: 'https://www.theguardian.com/sport/rss',
      NPR: 'https://feeds.npr.org/1055/rss.xml',
    },
  },
  Video: {
    tag: 'video',
    feeds: {
      'Al Jazeera': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCNye-wNBqNL5ZzHSJj3l8Bg',
      DW: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCknLrEdhRCp1aegoMqRaCZg',
      Guardian: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCIRYBXDze5krPDzAEOxFGVA',
      BBC: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC16niRr50-MSBwiO3YDb3RA',
    },
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
  let url = found[0]?.url ?? null;
  if (url?.includes('ichef.bbci.co.uk')) url = url.replace(/\/standard\/\d+\//, '/standard/976/').replace(/\/news\/\d+\//, '/news/976/');
  return url;
}

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return as === 'text' ? res.text() : { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? '' };
}

// YouTube's oEmbed endpoint answers 401 for videos whose owners disabled embedding, so it doubles as a playability check
async function embeddable(id) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch { return false; }
}

async function readFeed(source, url) {
  const xml = await get(url);
  if (xml.includes('<entry>')) { // Atom (YouTube channel feeds): one note per video
    const vids = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map(([e]) => {
      const id = e.match(/<yt:videoId>([^<]+)</)?.[1];
      const thumb = e.match(/<media:thumbnail url="([^"]+)"/)?.[1] ?? null;
      return {
        source, video: id, link: `https://www.youtube.com/watch?v=${id}`,
        title: text(tagText(e, 'title')),
        summary: text(tagText(e, 'media:description').split(/\n\n|Episode credits|In this episode/)[0]).slice(0, 600),
        image: thumb?.replace('hqdefault', 'maxresdefault') ?? null, fallbackImage: thumb,
      };
    }).filter((v) => v.video);
    const ok = await Promise.all(vids.map((v) => embeddable(v.video)));
    return vids.filter((_, i) => ok[i]);
  }
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/g)].map(([item]) => ({
    source,
    title: text(tagText(item, 'title')),
    summary: text(tagText(item, 'description')),
    link: text(tagText(item, 'link')) || text(tagText(item, 'guid')),
    image: lead(item),
  })).filter((s) => s.title && s.link);
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
    const { buf, type } = await get(url, 'bin');
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[type.split(';')[0]];
    if (!ext || buf.length < 4000) return null;
    const name = `${createHash('sha1').update(url).digest('hex').slice(0, 12)}.${ext}`;
    await writeFile(path.join(OUT, 'images', name), buf);
    return name;
  } catch { return null; }
}

// ---------- shaping stories into notes ----------

// Note titles double as file names and [[wikilink]] targets, so keep them plain
const safeTitle = (t) => t.replace(/[\\/:*?"<>|[\]#^]/g, '').replace(/\s+/g, ' ').trim().replace(/^(.{1,72})(\s.*)?$/, '$1').trim();
const words = (t) => [...new Set(t.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [])].filter((w) => !STOP.has(w));
const overlap = (a, b) => a.filter((w) => b.includes(w)).length;
const bullets = (summary) => (summary.match(/[^.!?]+[.!?]+/g) ?? [summary]).map((s) => s.trim()).filter((s) => s.length > 25).slice(0, 3);

async function build() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, 'images'), { recursive: true });

  const sections = [];
  const seen = []; // word sets of accepted headlines, to drop the same story from another outlet
  for (const [name, def] of Object.entries(SECTIONS)) {
    const lists = await Promise.all(Object.entries(def.feeds).map(([src, url]) =>
      readFeed(src, url).then((items) => items.slice(0, 12)).catch((e) => (console.warn(`feed failed: ${e.message}`), []))));
    // interleave outlets so one source doesn't dominate
    const picked = [];
    const counts = new Map();
    for (let i = 0; i < 12; i++) {
      for (const list of lists) {
        const s = list[i];
        if (!s || (counts.get(s.source) ?? 0) >= PER_FEED) continue;
        const w = words(s.title);
        if (seen.some((o) => overlap(w, o) >= Math.max(3, Math.min(w.length, o.length) * 0.6))) continue;
        s.words = w;
        seen.push(w);
        counts.set(s.source, (counts.get(s.source) ?? 0) + 1);
        picked.push(s);
      }
    }
    await Promise.all(picked.map(async (s) => {
      const info = s.video ? { image: null, paras: [], description: '' } : await pageInfo(s.link);
      s.paras = info.paras;
      if (info.description.length > s.summary.length) s.summary = info.description;
      s.file = null;
      for (const url of [s.image, s.fallbackImage, info.image]) if (url && !s.file) s.file = await saveImage(url);
      s.words = words(`${s.title} ${s.summary}`);
      s.note = safeTitle(s.title);
    }));
    sections.push({ name, tag: def.tag, stories: picked.filter((s) => s.note) });
    console.log(`${name}: ${picked.length} stories`);
  }

  const all = sections.flatMap((s) => s.stories);
  // One picture shared by several stories is a placeholder (NPR's logo, say), not a photo: drop it so those cards get a plain look
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

  const date = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const hub = 'Todays News';
  for (const sec of sections) {
    const title = `${sec.name} News`;
    await writeFile(path.join(OUT, `${title}.md`), [
      '---', `tags: [${sec.tag}, section]`, '---', `# ${title}`, '',
      `Top ${sec.name.toLowerCase()} stories, ${date}.`, '',
      ...sec.stories.map((s) => `- [[${s.note}]]`), '', `Back to [[${hub}]].`, '',
    ].join('\n'));
    for (const s of sec.stories) {
      const lines = ['---', `tags: [${sec.tag}, ${s.source.toLowerCase()}]`, '---', `# ${s.note}`, ''];
      if (s.file) lines.push(`![${s.source}](images/${s.file})`, '');
      if (s.video) lines.push(`[video](youtube:${s.video})`, '');
      const b = bullets(s.summary);
      lines.push(...(b.length ? b.map((x) => `- ${x}`) : [s.summary ? `- ${s.summary}` : `- Read the full story at ${s.source}.`]));
      if (s.paras.length) lines.push('', '## Story', '', ...s.paras.flatMap((p) => [p, '']));
      lines.push('', `- Source: ${s.source}`);
      if (s.related.length) lines.push(`- Related: ${s.related.map((r) => `[[${r}]]`).join(', ')}`);
      lines.push('', `Back to [[${title}]].`, '');
      await writeFile(path.join(OUT, `${s.note}.md`), lines.join('\n'));
    }
  }
  await writeFile(path.join(OUT, `${hub}.md`), [
    '---', 'tags: [index]', '---', `# ${hub}`, '',
    `Headlines from BBC, The Guardian and NPR, fetched ${date}. Start here and follow the links.`, '',
    ...sections.flatMap((sec) => [`## ${sec.name}`, `- [[${sec.name} News]]`, '']),
  ].join('\n'));
  console.log(`Wrote ${all.length + sections.length + 1} notes to ${path.relative(process.cwd(), OUT)}`);
}

build().catch((e) => { console.error(e); process.exit(1); });
