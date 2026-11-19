/**
 * AIVENTURE BLOG PRIN TELEGRAM — v1.0 · 2026-11-19
 * Publică articole pe https://aiventure.ro/blog/ direct din Telegram, fără Claude și fără laptop.
 *
 * FLUX
 *   /articol  -> începe un articol nou (șterge orice ciornă neterminată)
 *   (text)    -> se lipește textul; poate veni în oricâte mesaje, se adună în ordine
 *   /gata     -> arată titlul, adresa, numărul de caractere și de bucăți; NU publică
 *   /publica  -> publică: un singur commit în GitHub aipath512/aiventure (pagina articolului,
 *                blog/articles.json, sitemap.xml); Cloudflare Pages republică în ~1 minut
 *   /anulez   -> șterge ciorna, nu publică nimic
 *
 * REGULI DE SCRIERE
 *   Prima linie = titlul.  "## " = subtitlu, "### " = sub-subtitlu.  "- " = listă.  "1. " = listă numerotată.
 *   Un rând singur de tip "1. Întrebare?" (fără alt rând numerotat lângă) devine subtitlu.
 *   Tabel: rânduri cu "|" între coloane (sau tab); primul rând = antetul.
 *   **text** = îngroșat.  Rând care începe cu „ sau "> " = citat.
 *
 * NEVOI
 *   KV:     BLOG (namespace aiventure-blog-ciorne) — ciorna, câte o cheie pe mesaj
 *   Secret: GITHUB_TOKEN — token GitHub „fine-grained” doar pentru aipath512/aiventure, Contents: Read and write
 */
export const BLOG_VERSION = "blog v1.0 · 2026-11-19";
const REPO = "aipath512/aiventure";
const BRANCH = "main";
const SITE = "https://aiventure.ro";
const DRAFT_TTL = 7 * 24 * 3600; // ciorna expiră după 7 zile

const kState = (chat) => `stare:${chat}`;
const kPartPrefix = (chat) => `parte:${chat}:`;
const kPart = (chat, msgId) => `parte:${chat}:${String(msgId).padStart(12, "0")}`;

// ---------- intrări din index.js ----------
export async function blogCommand(env, chatId, cmd) {
  if (!env.BLOG) return "Blog: lipseste legatura KV (BLOG).";
  if (cmd === "/articol") {
    await clearDraft(env, chatId);
    await env.BLOG.put(kState(chatId), JSON.stringify({ started: Date.now() }), { expirationTtl: DRAFT_TTL });
    return "📝 Articol nou. Lipiti textul (prima linie = titlul). Poate fi in mai multe mesaje.\nCand ati terminat: /gata\nRenuntare: /anulez";
  }
  if (cmd === "/anulez") {
    const n = await clearDraft(env, chatId);
    return n ? "❌ Ciorna stearsa. Nu s-a publicat nimic." : "Nu exista nicio ciorna.";
  }
  if (cmd === "/gata") {
    const d = await loadDraft(env, chatId);
    if (!d) return "Nu exista nicio ciorna. Incepeti cu /articol.";
    if (!d.text.trim()) return "Ciorna e goala. Lipiti textul articolului, apoi /gata.";
    const meta = await planArticle(env, d.text);
    const sec = meta.headings.length ? "\nSubtitluri: " + meta.headings.length + "\n- " + meta.headings.slice(0, 12).join("\n- ") : "";
    return `👀 VERIFICARE (nu e publicat inca)\nTitlu: ${meta.title}\nAdresa: ${meta.url}\nNumar: ${meta.id}\nPrimit: ${d.parts} mesaje, ${d.text.length.toLocaleString("ro-RO")} caractere${sec}\n\nPublicare: /publica\nMai adaugati text: lipiti-l acum, apoi din nou /gata\nRenuntare: /anulez`;
  }
  if (cmd === "/publica") {
    const d = await loadDraft(env, chatId);
    if (!d || !d.text.trim()) return "Nu exista nicio ciorna de publicat. Incepeti cu /articol.";
    if (!env.GITHUB_TOKEN) return "Blog: lipseste secretul GITHUB_TOKEN in Cloudflare. Articolul NU a fost publicat (ciorna ramane).";
    try {
      const res = await publish(env, d.text);
      await clearDraft(env, chatId);
      return `✅ PUBLICAT (${res.id})\n${res.url}\nApare pe site in ~1 minut si in lista ${SITE}/blog/`;
    } catch (e) {
      return `⚠️ Publicarea a esuat: ${String(e && e.message || e).slice(0, 300)}\nCiorna ramane; puteti incerca din nou /publica.`;
    }
  }
  return null;
}

// Mesaj text obișnuit (fără "/"): dacă există o ciornă deschisă, îl păstrează. Întoarce true dacă l-a luat.
export async function blogCollect(env, chatId, msg) {
  if (!env.BLOG) return false;
  const st = await env.BLOG.get(kState(chatId));
  if (!st) return false;
  const text = String(msg.text || "");
  if (!text) return false;
  await env.BLOG.put(kPart(chatId, msg.message_id), text, { expirationTtl: DRAFT_TTL });
  return true;
}

async function loadDraft(env, chatId) {
  const st = await env.BLOG.get(kState(chatId));
  if (!st) return null;
  const keys = await listAll(env, kPartPrefix(chatId));
  keys.sort();
  const parts = [];
  for (const k of keys) { const v = await env.BLOG.get(k); if (v) parts.push(v); }
  return { text: parts.join("\n"), parts: parts.length };
}
async function clearDraft(env, chatId) {
  const keys = await listAll(env, kPartPrefix(chatId));
  for (const k of keys) await env.BLOG.delete(k);
  const had = await env.BLOG.get(kState(chatId));
  await env.BLOG.delete(kState(chatId));
  return keys.length + (had ? 1 : 0);
}
async function listAll(env, prefix) {
  const out = []; let cursor;
  do {
    const r = await env.BLOG.list({ prefix, cursor });
    for (const k of r.keys) out.push(k.name);
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  return out;
}

// ---------- GitHub ----------
async function gh(env, path, opt = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method: opt.method || "GET",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`, "Accept": "application/vnd.github+json",
      "User-Agent": "aiventure-telegram-control", "X-GitHub-Api-Version": "2022-11-28",
      ...(opt.body ? { "Content-Type": "application/json" } : {})
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GitHub ${opt.method || "GET"} ${path.split("?")[0]} -> HTTP ${res.status} ${t.slice(0, 120)}`);
  }
  return res.json();
}
function b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}
async function readFile(env, path) {
  const j = await gh(env, `/contents/${path}?ref=${BRANCH}`);
  return b64ToUtf8(j.content);
}

async function planArticle(env, raw) {
  const parsed = parseArticle(raw);
  let list = [];
  try { list = JSON.parse(await readFile(env, "blog/articles.json")).articles || []; } catch (_) { list = []; }
  return { ...parsed, ...pickIdSlug(parsed.title, list) };
}
function pickIdSlug(title, list) {
  const used = new Set(list.map((a) => a.slug));
  const base = slugify(title) || "articol";
  let slug = base, i = 2;
  while (used.has(slug)) slug = `${base}-${i++}`;
  const max = list.reduce((m, a) => Math.max(m, Number(String(a.id || "").replace(/\D/g, "")) || 0), 0);
  const id = "ART-" + String(max + 1).padStart(6, "0");
  return { slug, id, url: `${SITE}/blog/${slug}/` };
}

async function publish(env, raw) {
  const parsed = parseArticle(raw);
  if (!parsed.title) throw new Error("lipseste titlul (prima linie)");
  const ref = await gh(env, `/git/ref/heads/${BRANCH}`);
  const headSha = ref.object.sha;
  const commit = await gh(env, `/git/commits/${headSha}`);
  const articles = JSON.parse(await readFile(env, "blog/articles.json"));
  const sitemap = await readFile(env, "sitemap.xml");
  const { slug, id, url } = pickIdSlug(parsed.title, articles.articles || []);
  const date = new Date().toISOString().slice(0, 10);
  const sha = await sha256(parsed.body);
  const meta = { id, title: parsed.title, slug, category: parsed.category, author: "AiVenture", published: date, version: "1.0", status: "published", canonical: url, sha256: sha, ots_status: "NOT_TIMESTAMPED", source: "telegram" };
  articles.articles = [...(articles.articles || []), meta];
  articles.updated = date;
  const page = renderPage({ ...parsed, id, url, date, sha });
  const newSitemap = sitemap.includes(`<loc>${url}</loc>`) ? sitemap
    : sitemap.replace("</urlset>", `<url><loc>${url}</loc><lastmod>${date}</lastmod></url>\n</urlset>`);
  const tree = await gh(env, "/git/trees", { method: "POST", body: {
    base_tree: commit.tree.sha,
    tree: [
      { path: `blog/${slug}/index.html`, mode: "100644", type: "blob", content: page },
      { path: `blog/${slug}/article.json`, mode: "100644", type: "blob", content: JSON.stringify(meta, null, 2) + "\n" },
      { path: "blog/articles.json", mode: "100644", type: "blob", content: JSON.stringify(articles, null, 2) + "\n" },
      { path: "sitemap.xml", mode: "100644", type: "blob", content: newSitemap }
    ]
  } });
  const nc = await gh(env, "/git/commits", { method: "POST", body: { message: `Blog: ${id} ${parsed.title} (Telegram)`, tree: tree.sha, parents: [headSha] } });
  await gh(env, `/git/refs/heads/${BRANCH}`, { method: "PATCH", body: { sha: nc.sha, force: false } });
  return { id, url };
}

async function sha256(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- text -> HTML ----------
export function slugify(s) {
  const t = String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (t.length <= 70) return t;
  return t.slice(0, 70).replace(/-[^-]*$/, "");
}
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function inline(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"); }
function strip(s) { return String(s).replace(/\*\*/g, ""); }

const reUl = /^\s*[-*•]\s+/;
const reOl = /^\s*\d+[.)]\s+/;
const isTableRow = (l) => l.includes("\t") || /^\s*\|.*\|\s*$/.test(l) || (l.split("|").length >= 3);
const cells = (l) => {
  const parts = l.includes("\t") ? l.split("\t") : l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|");
  return parts.map((c) => c.trim());
};

export function parseArticle(raw) {
  const lines = String(raw).replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const title = strip((lines[i] || "").replace(/^#+\s*/, "").trim());
  i++;
  let category = "Articol";
  const m = /^\s*categorie\s*:\s*(.+)$/i.exec(lines[i] || "");
  if (m) { category = m[1].trim(); i++; }
  const rest = lines.slice(i);
  const out = [], headings = [];
  let firstPara = "";
  const isBlank = (k) => k < 0 || k >= rest.length || !rest[k].trim();
  let j = 0;
  while (j < rest.length) {
    const line = rest[j], t = line.trim();
    if (!t) { j++; continue; }
    let h = /^(#{2,4})\s+(.*)$/.exec(t);
    if (h || /^#\s+/.test(t)) {
      const lvl = h && h[1].length >= 3 ? 3 : 2;
      const txt = (h ? h[2] : t.replace(/^#\s+/, "")).trim();
      out.push(`<h${lvl}>${inline(txt)}</h${lvl}>`); if (lvl === 2) headings.push(strip(txt)); j++; continue;
    }
    // rând numerotat singur, scurt, fără ; sau . la final -> subtitlu
    if (reOl.test(t)) {
      const prevOl = j > 0 && reOl.test(rest[j - 1].trim());
      const nextOl = j + 1 < rest.length && reOl.test(rest[j + 1].trim());
      if (!prevOl && !nextOl && t.length < 120 && !/[;.,:]$/.test(t)) {
        out.push(`<h2>${inline(t)}</h2>`); headings.push(strip(t)); j++; continue;
      }
    }
    if (isTableRow(t) && j + 1 < rest.length && isTableRow(rest[j + 1].trim())) {
      const rows = [];
      while (j < rest.length && rest[j].trim() && isTableRow(rest[j].trim())) { rows.push(rest[j].trim()); j++; }
      const data = rows.filter((r) => !/^\|?\s*:?-{2,}/.test(r)).map(cells);
      const head = data.shift() || [];
      out.push(`<div class="tw"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${data.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (reUl.test(t) || reOl.test(t)) {
      const ordered = reOl.test(t), re = ordered ? reOl : reUl, items = [];
      while (j < rest.length) {
        const u = rest[j].trim();
        if (re.test(u)) { items.push(u.replace(re, "")); j++; continue; }
        if (!u && j + 1 < rest.length && re.test(rest[j + 1].trim())) { j++; continue; }
        break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (/^>\s?/.test(t) || /^[„"“]/.test(t) && /[”"“]\s*$/.test(t)) {
      out.push(`<blockquote>${inline(t.replace(/^>\s?/, ""))}</blockquote>`); j++; continue;
    }
    // rând scurt singur, fără punctuație finală -> sub-subtitlu
    if (isBlank(j - 1) && isBlank(j + 1) && t.length <= 70 && !t.includes("→") && !/[.;:,!?”"]$/.test(t) && out.length) {
      out.push(`<h3>${inline(t)}</h3>`); j++; continue;
    }
    if (!firstPara) firstPara = strip(t);
    out.push(`<p>${inline(t)}</p>`); j++;
  }
  let desc = firstPara || title;
  if (desc.length > 160) desc = desc.slice(0, 157).replace(/\s+\S*$/, "") + "…";
  return { title, category, desc, body: out.join("\n"), headings };
}

const CSS = "*{box-sizing:border-box}body{margin:0;background:#090b10;color:#f5f5f5;font:17px/1.7 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:820px;margin:auto;padding:26px 18px 80px}a{color:#e7c86e;text-decoration:none}.crumb,.meta{font-size:13px;color:#999}h1{font-size:clamp(34px,7vw,58px);line-height:1.06;margin:28px 0 12px}h2{margin-top:44px;line-height:1.2}h3{margin-top:28px;color:#e7c86e}blockquote{margin:14px 0;padding:10px 16px;border-left:3px solid #e7c86e;background:#11141b}.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:15px}th,td{border:1px solid #292d36;padding:8px 10px;text-align:left;vertical-align:top}th{background:#11141b}.hash{word-break:break-all;font:12px ui-monospace,monospace;color:#9298a4;border-top:1px solid #292d36;margin-top:50px;padding-top:18px}";

function renderPage(a) {
  const ld = { "@context": "https://schema.org", "@type": "BlogPosting", headline: a.title, description: a.desc, inLanguage: "ro", datePublished: a.date,
    author: { "@type": "Organization", name: "AiVenture S.R.L." }, publisher: { "@type": "Organization", name: "AiVenture S.R.L." }, mainEntityOfPage: a.url };
  const d = a.date.split("-").reverse().join(".");
  return `<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(a.title)} | AiVenture</title><meta name="description" content="${esc(a.desc)}"><link rel="canonical" href="${a.url}"><meta property="og:type" content="article"><meta property="og:title" content="${esc(a.title)}"><meta property="og:description" content="${esc(a.desc)}"><meta property="og:url" content="${a.url}"><script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script><style>${CSS}</style></head><body><main><div class="crumb"><a href="/">AiVenture</a> / <a href="/blog/">Blog</a> / ${a.id}</div><article><h1>${esc(a.title)}</h1><div class="meta">${a.id} · ${esc(a.category)} · ${d} · v1.0</div>\n${a.body}\n</article><div class="hash">SHA-256 conținut: ${a.sha}</div><p><a href="/blog/">← Toate articolele</a></p></main></body></html>\n`;
}
