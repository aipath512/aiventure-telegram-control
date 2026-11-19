/**
 * AIVENTURE BLOG PRIN TELEGRAM — v1.1 · 2026-11-19
 * Publică și modifică articole pe https://aiventure.ro/blog/ direct din Telegram, fără Claude și fără laptop.
 *
 * v1.1 față de v1.0:
 *   - linia de versiune completă pe pagină: ID · vX.Y · publicat ZZ.LL.AAAA HH:MM (București) · modificat … · categorie
 *   - OpenTimestamps automat: amprenta SHA-256 a conținutului (article.txt) e trimisă la 3 calendare OTS;
 *     dovada se salvează lângă articol (article.txt.ots), verificabilă pe https://opentimestamps.org
 *   - /editez ART-000033: textul nou devine v1.1 (v1.2 …) la aceeași adresă; versiunea veche rămâne la /blog/<slug>/v1.0/
 *
 * FLUX ARTICOL NOU:   /articol  -> lipiți textul (oricâte mesaje) -> /gata (verificare) -> /publica
 * FLUX MODIFICARE:    /editez ART-000033 -> lipiți textul complet nou -> /gata -> /publica
 * RENUNȚARE:          /anulez
 *
 * REGULI DE SCRIERE
 *   Prima linie = titlul. Opțional a doua linie "Categorie: ...".  "## " = subtitlu, "### " = sub-subtitlu.
 *   "- " = listă.  "1. " = listă numerotată.  Rând singur "1. Întrebare?" = subtitlu.
 *   Tabel: coloane separate cu "|" (sau tab); primul rând = antet.  **text** = îngroșat.  Rând „…” sau "> " = citat.
 *
 * FIȘIERE PE ARTICOL (repo aipath512/aiventure, folderul blog/<slug>/):
 *   index.html, article.json, article.txt (conținutul amprentat), article.txt.ots (dovada OpenTimestamps),
 *   v1.0/ … (versiunile anterioare, la modificare)
 *
 * NEVOI: KV BLOG (aiventure-blog-ciorne); secret GITHUB_TOKEN (doar aipath512/aiventure, Contents: Read and write)
 */
export const BLOG_VERSION = "blog v1.1 · 2026-11-19";
const REPO = "aipath512/aiventure";
const BRANCH = "main";
const SITE = "https://aiventure.ro";
const DRAFT_TTL = 7 * 24 * 3600;
const OTS_CALENDARS = ["https://a.pool.opentimestamps.org", "https://b.pool.opentimestamps.org", "https://a.pool.eternitywall.com"];

const kState = (chat) => `stare:${chat}`;
const kPartPrefix = (chat) => `parte:${chat}:`;
const kPart = (chat, msgId) => `parte:${chat}:${String(msgId).padStart(12, "0")}`;

// ---------- intrări din index.js ----------
export async function blogCommand(env, chatId, cmd, args = []) {
  if (!env.BLOG) return "Blog: lipseste legatura KV (BLOG).";
  if (cmd === "/articol") {
    await clearDraft(env, chatId);
    await env.BLOG.put(kState(chatId), JSON.stringify({ mode: "nou", started: Date.now() }), { expirationTtl: DRAFT_TTL });
    return "📝 Articol nou. Lipiti textul (prima linie = titlul). Poate fi in mai multe mesaje.\nCand ati terminat: /gata\nRenuntare: /anulez";
  }
  if (cmd === "/editez") {
    const id = normId(args[0]);
    if (!id) return "Folosire: /editez ART-000033 (sau /editez 33)";
    if (!env.GITHUB_TOKEN) return "Blog: lipseste secretul GITHUB_TOKEN.";
    const list = (await readArticles(env)).articles || [];
    const a = list.find((x) => x.id === id);
    if (!a) return `Nu exista articolul ${id}.`;
    await clearDraft(env, chatId);
    await env.BLOG.put(kState(chatId), JSON.stringify({ mode: "edit", id, started: Date.now() }), { expirationTtl: DRAFT_TTL });
    return `✏️ Modificare ${id} (acum v${a.version || "1.0"}): ${a.title}\n${a.canonical}\nLipiti TEXTUL COMPLET nou (prima linie = titlul). Devine v${bump(a.version)}; v${a.version || "1.0"} ramane in istoric.\nCand ati terminat: /gata   Renuntare: /anulez`;
  }
  if (cmd === "/anulez") {
    const n = await clearDraft(env, chatId);
    return n ? "❌ Ciorna stearsa. Nu s-a publicat nimic." : "Nu exista nicio ciorna.";
  }
  if (cmd === "/gata") {
    const d = await loadDraft(env, chatId);
    if (!d) return "Nu exista nicio ciorna. Incepeti cu /articol sau /editez ART-...";
    if (!d.text.trim()) return "Ciorna e goala. Lipiti textul, apoi /gata.";
    const parsed = parseArticle(d.text);
    const list = (await readArticles(env)).articles || [];
    let head;
    if (d.state.mode === "edit") {
      const a = list.find((x) => x.id === d.state.id);
      if (!a) return `Articolul ${d.state.id} nu mai exista.`;
      head = `👀 VERIFICARE MODIFICARE (nu e publicat inca)\n${a.id}: v${a.version || "1.0"} -> v${bump(a.version)}\nTitlu nou: ${parsed.title}\nAdresa (aceeasi): ${a.canonical}`;
    } else {
      const p = pickIdSlug(parsed.title, list);
      head = `👀 VERIFICARE (nu e publicat inca)\nTitlu: ${parsed.title}\nAdresa: ${p.url}\nNumar: ${p.id} · v1.0`;
    }
    const sec = parsed.headings.length ? "\nSubtitluri: " + parsed.headings.length + "\n- " + parsed.headings.slice(0, 12).join("\n- ") : "";
    return `${head}\nPrimit: ${d.parts} mesaje, ${d.text.length.toLocaleString("ro-RO")} caractere${sec}\n\nPublicare: /publica\nMai adaugati text: lipiti-l acum, apoi din nou /gata\nRenuntare: /anulez`;
  }
  if (cmd === "/publica") {
    const d = await loadDraft(env, chatId);
    if (!d || !d.text.trim()) return "Nu exista nicio ciorna de publicat. Incepeti cu /articol sau /editez ART-...";
    if (!env.GITHUB_TOKEN) return "Blog: lipseste secretul GITHUB_TOKEN. Nimic publicat (ciorna ramane).";
    try {
      const r = d.state.mode === "edit" ? await publishEdit(env, d.state.id, d.text) : await publishNew(env, d.text);
      await clearDraft(env, chatId);
      const ots = r.ots ? `OpenTimestamps: trimis la ${r.ots} calendare (confirmare Bitcoin in cateva ore)` : "OpenTimestamps: calendarele nu au raspuns (articolul e publicat oricum)";
      return `✅ PUBLICAT ${r.id} · v${r.version}\n${r.url}\nSHA-256: ${r.sha}\n${ots}\nApare pe site in ~1 minut.`;
    } catch (e) {
      return `⚠️ Publicarea a esuat: ${String(e && e.message || e).slice(0, 300)}\nCiorna ramane; puteti incerca din nou /publica.`;
    }
  }
  return null;
}

export async function blogCollect(env, chatId, msg) {
  if (!env.BLOG) return false;
  const st = await env.BLOG.get(kState(chatId));
  if (!st) return false;
  const text = String(msg.text || "");
  if (!text) return false;
  await env.BLOG.put(kPart(chatId, msg.message_id), text, { expirationTtl: DRAFT_TTL });
  return true;
}

function normId(x) {
  const n = String(x || "").replace(/\D/g, "");
  return n ? "ART-" + n.padStart(6, "0") : "";
}
export function bump(v) {
  const [maj, min] = String(v || "1.0").split(".").map((x) => Number(x) || 0);
  return `${maj || 1}.${min + 1}`;
}

async function loadDraft(env, chatId) {
  const st = await env.BLOG.get(kState(chatId));
  if (!st) return null;
  let state; try { state = JSON.parse(st); } catch (_) { state = { mode: "nou" }; }
  const keys = await listAll(env, kPartPrefix(chatId));
  keys.sort();
  const parts = [];
  for (const k of keys) { const v = await env.BLOG.get(k); if (v) parts.push(v); }
  return { state, text: parts.join("\n"), parts: parts.length };
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
  if (opt.allow404 && res.status === 404) return null;
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
function bytesToB64(u8) {
  let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
async function readFile(env, path) {
  const j = await gh(env, `/contents/${path}?ref=${BRANCH}`);
  return b64ToUtf8(j.content);
}
async function readArticles(env) {
  try { return JSON.parse(await readFile(env, "blog/articles.json")); } catch (_) { return { articles: [] }; }
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

// Un singur commit cu toate fișierele (text sau binar).  files: [{path, text} | {path, bytes} | {path, sha}]
async function commitFiles(env, message, files) {
  const ref = await gh(env, `/git/ref/heads/${BRANCH}`);
  const headSha = ref.object.sha;
  const commit = await gh(env, `/git/commits/${headSha}`);
  const tree = [];
  for (const f of files) {
    if (f.sha) tree.push({ path: f.path, mode: "100644", type: "blob", sha: f.sha });
    else if (f.bytes) {
      const b = await gh(env, "/git/blobs", { method: "POST", body: { content: bytesToB64(f.bytes), encoding: "base64" } });
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: b.sha });
    } else tree.push({ path: f.path, mode: "100644", type: "blob", content: f.text });
  }
  const t = await gh(env, "/git/trees", { method: "POST", body: { base_tree: commit.tree.sha, tree } });
  const nc = await gh(env, "/git/commits", { method: "POST", body: { message, tree: t.sha, parents: [headSha] } });
  await gh(env, `/git/refs/heads/${BRANCH}`, { method: "PATCH", body: { sha: nc.sha, force: false } });
}

// ---------- OpenTimestamps ----------
const OTS_MAGIC = [0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94];
// Trimite amprenta la calendare și construiește fișierul .ots (format standard, verificabil cu `ots verify`).
export async function otsStamp(digest) {
  const res = await Promise.all(OTS_CALENDARS.map(async (c) => {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
      const r = await fetch(`${c}/digest`, { method: "POST", body: digest, signal: ctl.signal,
        headers: { "Accept": "application/vnd.opentimestamps.v1", "User-Agent": "aiventure-telegram-control" } });
      clearTimeout(t);
      if (!r.ok) return null;
      const b = new Uint8Array(await r.arrayBuffer());
      return b.length ? b : null;
    } catch (_) { return null; }
  }));
  const ok = res.filter(Boolean);
  if (!ok.length) return null;
  const parts = [...OTS_MAGIC, 0x01, 0x08, ...digest];
  ok.forEach((b, i) => { if (i < ok.length - 1) parts.push(0xff); parts.push(...b); });
  return { bytes: new Uint8Array(parts), calendars: ok.length };
}

async function sha256Bytes(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---------- publicare ----------
async function publishNew(env, raw) {
  const parsed = parseArticle(raw);
  if (!parsed.title) throw new Error("lipseste titlul (prima linie)");
  const articles = await readArticles(env);
  const sitemap = await readFile(env, "sitemap.xml");
  const { slug, id, url } = pickIdSlug(parsed.title, articles.articles || []);
  const now = new Date().toISOString();
  const digest = await sha256Bytes(parsed.body), sha = hex(digest);
  const ots = await otsStamp(digest);
  const meta = { id, title: parsed.title, slug, category: parsed.category, author: "AiVenture", published: now.slice(0, 10), published_at: now,
    version: "1.0", status: "published", canonical: url, sha256: sha, ots_status: ots ? "PENDING" : "NOT_TIMESTAMPED", source: "telegram",
    versions: [{ version: "1.0", at: now, sha256: sha, path: `/blog/${slug}/` }] };
  articles.articles = [...(articles.articles || []), meta];
  articles.updated = now.slice(0, 10);
  const page = renderPage({ ...parsed, id, url, version: "1.0", publishedAt: now, sha, ots: !!ots, history: [] });
  const newSitemap = sitemap.includes(`<loc>${url}</loc>`) ? sitemap
    : sitemap.replace("</urlset>", `<url><loc>${url}</loc><lastmod>${now.slice(0, 10)}</lastmod></url>\n</urlset>`);
  const files = [
    { path: `blog/${slug}/index.html`, text: page },
    { path: `blog/${slug}/article.txt`, text: parsed.body },
    { path: `blog/${slug}/article.json`, text: JSON.stringify(meta, null, 2) + "\n" },
    { path: "blog/articles.json", text: JSON.stringify(articles, null, 2) + "\n" },
    { path: "sitemap.xml", text: newSitemap }
  ];
  if (ots) files.push({ path: `blog/${slug}/article.txt.ots`, bytes: ots.bytes });
  await commitFiles(env, `Blog: ${id} v1.0 ${parsed.title} (Telegram)`, files);
  return { id, url, version: "1.0", sha, ots: ots && ots.calendars };
}

async function publishEdit(env, id, raw) {
  const parsed = parseArticle(raw);
  if (!parsed.title) throw new Error("lipseste titlul (prima linie)");
  const articles = await readArticles(env);
  const list = articles.articles || [];
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) throw new Error(`nu exista ${id}`);
  const old = list[idx];
  const oldV = old.version || "1.0", newV = bump(oldV);
  const slug = old.slug, url = old.canonical || `${SITE}/blog/${slug}/`;
  // versiunea veche se mută (prin referință, fără copiere de conținut) în blog/<slug>/v<old>/
  const dir = (await gh(env, `/contents/blog/${slug}?ref=${BRANCH}`)) || [];
  const files = [];
  for (const f of dir) if (f.type === "file") files.push({ path: `blog/${slug}/v${oldV}/${f.name}`, sha: f.sha });
  const now = new Date().toISOString();
  const digest = await sha256Bytes(parsed.body), sha = hex(digest);
  const ots = await otsStamp(digest);
  const publishedAt = old.published_at || old.published || now;
  const prevVersions = old.versions && old.versions.length ? old.versions
    : [{ version: oldV, at: publishedAt, sha256: old.sha256 || "", path: `/blog/${slug}/` }];
  const versions = prevVersions.map((v) => v.version === oldV ? { ...v, path: `/blog/${slug}/v${oldV}/` } : v)
    .concat([{ version: newV, at: now, sha256: sha, path: `/blog/${slug}/` }]);
  const meta = { ...old, title: parsed.title, category: parsed.category !== "Articol" ? parsed.category : (old.category || "Articol"),
    version: newV, updated_at: now, sha256: sha, ots_status: ots ? "PENDING" : "NOT_TIMESTAMPED", versions };
  list[idx] = meta; articles.updated = now.slice(0, 10);
  const page = renderPage({ ...parsed, category: meta.category, id, url, version: newV, publishedAt, updatedAt: now, sha, ots: !!ots,
    history: versions.filter((v) => v.version !== newV) });
  files.push(
    { path: `blog/${slug}/index.html`, text: page },
    { path: `blog/${slug}/article.txt`, text: parsed.body },
    { path: `blog/${slug}/article.json`, text: JSON.stringify(meta, null, 2) + "\n" },
    { path: "blog/articles.json", text: JSON.stringify(articles, null, 2) + "\n" }
  );
  if (ots) files.push({ path: `blog/${slug}/article.txt.ots`, bytes: ots.bytes });
  await commitFiles(env, `Blog: ${id} v${newV} ${parsed.title} (Telegram, modificare)`, files);
  return { id, url, version: newV, sha, ots: ots && ots.calendars };
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


const CSS = "*{box-sizing:border-box}body{margin:0;background:#090b10;color:#f5f5f5;font:17px/1.7 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:820px;margin:auto;padding:26px 18px 80px}a{color:#e7c86e;text-decoration:none}.crumb,.meta{font-size:13px;color:#999}h1{font-size:clamp(34px,7vw,58px);line-height:1.06;margin:28px 0 12px}h2{margin-top:44px;line-height:1.2}h3{margin-top:28px;color:#e7c86e}blockquote{margin:14px 0;padding:10px 16px;border-left:3px solid #e7c86e;background:#11141b}.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:15px}th,td{border:1px solid #292d36;padding:8px 10px;text-align:left;vertical-align:top}th{background:#11141b}.hash{word-break:break-all;font:12px ui-monospace,monospace;color:#9298a4;border-top:1px solid #292d36;margin-top:50px;padding-top:18px}.hash a{color:#9298a4;text-decoration:underline}";

export function fmtRo(iso) {
  const s = String(iso || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.split("-").reverse().join(".");
  try {
    return new Date(s).toLocaleString("ro-RO", { timeZone: "Europe/Bucharest", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", "") + " (București)";
  } catch (_) { return s; }
}

// a: {title, desc, category, body, id, url, version, publishedAt, updatedAt?, sha, ots, history:[{version, at, path}]}
export function renderPage(a) {
  const ld = { "@context": "https://schema.org", "@type": "BlogPosting", headline: a.title, description: a.desc, inLanguage: "ro",
    datePublished: a.publishedAt, ...(a.updatedAt ? { dateModified: a.updatedAt } : {}), version: a.version,
    author: { "@type": "Organization", name: "AiVenture S.R.L." }, publisher: { "@type": "Organization", name: "AiVenture S.R.L." }, mainEntityOfPage: a.url };
  const line = [a.id, `v${a.version}`, `publicat ${fmtRo(a.publishedAt)}`, a.updatedAt ? `modificat ${fmtRo(a.updatedAt)}` : "", esc(a.category)].filter(Boolean).join(" · ");
  const hist = a.history && a.history.length ? `<br>Versiuni anterioare: ${a.history.map((v) => `<a href="${v.path}">v${v.version}</a> (${fmtRo(v.at)})`).join(", ")}` : "";
  const ots = a.ots
    ? `OpenTimestamps: dovadă trimisă la calendare (confirmare în Bitcoin în câteva ore) · <a href="article.txt">article.txt</a> · <a href="article.txt.ots">article.txt.ots</a> · verificare: <a href="https://opentimestamps.org">opentimestamps.org</a>`
    : `OpenTimestamps: neefectuat`;
  return `<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(a.title)} | AiVenture</title><meta name="description" content="${esc(a.desc)}"><link rel="canonical" href="${a.url}"><meta property="og:type" content="article"><meta property="og:title" content="${esc(a.title)}"><meta property="og:description" content="${esc(a.desc)}"><meta property="og:url" content="${a.url}"><meta property="article:published_time" content="${a.publishedAt}">${a.updatedAt ? `<meta property="article:modified_time" content="${a.updatedAt}">` : ""}<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script><style>${CSS}</style></head><body><main><div class="crumb"><a href="/">AiVenture</a> / <a href="/blog/">Blog</a> / ${a.id}</div><article><h1>${esc(a.title)}</h1><div class="meta">${line}</div>\n${a.body}\n</article><div class="hash">${a.id} · v${a.version} · SHA-256 conținut (article.txt): ${a.sha}<br>${ots}${hist}</div><p><a href="/blog/">← Toate articolele</a></p></main></body></html>\n`;
}
