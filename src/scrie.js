/**
 * PAGINA DE SCRIS ARTICOLE — v1.0 · 2026-11-19
 * Înlocuiește lipirea textului în Telegram (Telegram gratuit taie textele lungi).
 *
 * FLUX
 *   Telegram: /scrie  -> botul trimite un link personal, valabil 12 ore (fără parolă; cheia e în link)
 *   Browser (telefon sau laptop): formular -> „Verifică” (ce vede Google și AI, avertismente) -> „Publică”
 *   Publicarea folosește EXACT același cod ca /publica din Telegram (publishNew din blog.js):
 *   aiventure.ro/blog/<slug>/, articles.json, sitemap, SHA-256, OpenTimestamps, IndexNow.
 *   Botul confirmă în Telegram cu linkul articolului.
 *
 * CÂMPURI OBLIGATORII: titlu, descriere (70–160 caractere), cuvinte cheie (minim 3), textul, minim 2 întrebări cu răspuns.
 * CURĂȚARE AUTOMATĂ a textului copiat din ChatGPT / Perplexity / Word:
 *   - trimiterile [1][7] se șterg
 *   - un rând scurt, fără punct la final, urmat de un paragraf -> subtitlu (##)
 *   - rândurile scurte de după un rând terminat cu „:” -> listă
 *   - blocurile de cod JSON ({ ... }) se scot (nu au loc într-un articol pentru oameni)
 * Întrebările din formular devin secțiunea vizibilă „Întrebări frecvente” + FAQPage (aceeași regulă ca subtitlurile cu „?”).
 */
import { parseArticle, publishNew, readArticlesPublic, pickIdSlugPublic } from "./blog.js";

export const SCRIE_VERSION = "scrie v1.0 · 2026-11-19";
const TTL = 12 * 3600;
const kTok = (t) => `scrie:${t}`;

function randomToken() {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Apelat din Telegram (/scrie): creează linkul personal.
export async function scrieLink(env, chatId, origin) {
  if (!env.BLOG) return "Pagina de scris: lipseste legatura KV (BLOG).";
  const t = randomToken();
  await env.BLOG.put(kTok(t), JSON.stringify({ chatId: String(chatId), created: Date.now() }), { expirationTtl: TTL });
  return `✍️ Pagina de scris (valabila 12 ore, doar pentru dumneavoastra):\n${origin}/scrie?t=${t}\n\nNu trimiteti linkul altcuiva: cine il are poate publica pe blog.`;
}

async function checkToken(env, t) {
  if (!t || !/^[0-9a-f]{48}$/.test(t)) return null;
  const v = await env.BLOG.get(kTok(t));
  return v ? JSON.parse(v) : null;
}

// ---------- curățarea textului lipit ----------
export function cleanPaste(raw) {
  let s = String(raw || "").replace(/\r/g, "").replace(/ /g, " ");
  s = s.replace(/(\s?\[\d{1,3}\])+/g, "");                 // [2][7]
  let L = s.split("\n").map((l) => l.replace(/\s+$/, ""));
  // blocuri JSON/cod lipite rând cu rând: de la „{” singur până la „}” care închide
  const out = [];
  for (let i = 0; i < L.length; i++) {
    const t = L[i].trim();
    if (t === "{" || t === "[") {
      let depth = 0, j = i;
      for (; j < L.length; j++) {
        const u = L[j].trim();
        depth += (u.match(/[{[]/g) || []).length - (u.match(/[}\]]/g) || []).length;
        if (depth <= 0 && j > i) break;
      }
      if (j < L.length && j - i >= 2) { i = j; continue; }
    }
    out.push(L[i]);
  }
  L = out;
  const isPlain = (t) => t && !/^(#|[-*•]\s|\d+[.)]\s|>|\||„)/.test(t);
  const res = [];
  for (let i = 0; i < L.length; i++) {
    const t = L[i].trim();
    if (!t) { res.push(""); continue; }
    const prev = (L[i - 1] || "").trim(), next = (L[i + 1] || "").trim();
    // listă: rânduri scurte consecutive după un rând terminat cu „:”
    if (/:\s*$/.test(prev) && isPlain(t) && t.length <= 160 && isPlain(next) && next.length <= 160 && next) {
      while (i < L.length && L[i].trim() && isPlain(L[i].trim()) && L[i].trim().length <= 160 && !/:\s*$/.test(L[i].trim())) {
        res.push("- " + L[i].trim()); i++;
      }
      i--; continue;
    }
    // subtitlu: rând scurt fără punctuație finală, urmat de un paragraf mai lung
    if (isPlain(t) && t.length <= 90 && !/[.;,:!”"»)]$/.test(t) && next && next.length > t.length + 20 && res.length) {
      if (res.length && res[res.length - 1] !== "") res.push("");
      res.push("## " + t); res.push(""); continue;
    }
    res.push(L[i]);
  }
  return res.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Construiește textul complet pentru parseArticle din câmpurile formularului.
function compose(f) {
  const kw = String(f.keywords || "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  const faq = (f.faq || []).map((x) => ({ q: String(x.q || "").trim(), a: String(x.a || "").trim() })).filter((x) => x.q && x.a);
  const lines = [String(f.title || "").trim()];
  if (f.category) lines.push(`Categorie: ${String(f.category).trim()}`);
  if (f.description) lines.push(`Descriere: ${String(f.description).trim().replace(/\s+/g, " ")}`);
  if (kw.length) lines.push(`Cuvinte cheie: ${kw.join(", ")}`);
  lines.push("", cleanPaste(f.text));
  if (faq.length) {
    lines.push("", "## Întrebări frecvente", "");
    for (const x of faq) lines.push(`### ${x.q.endsWith("?") ? x.q : x.q + "?"}`, "", x.a.replace(/\s*\n+\s*/g, " "), "");
  }
  return { raw: lines.join("\n"), kw, faq };
}

function validate(f, kw, faq) {
  const err = [], warn = [];
  const title = String(f.title || "").trim(), desc = String(f.description || "").trim(), text = String(f.text || "").trim();
  if (!title) err.push("Lipsește titlul.");
  else if (title.length > 90) err.push(`Titlul are ${title.length} caractere; maxim 90 (ideal sub 60).`);
  if (!desc) err.push("Lipsește descrierea pentru Google.");
  else if (desc.length < 70 || desc.length > 160) err.push(`Descrierea are ${desc.length} caractere; trebuie între 70 și 160.`);
  if (kw.length < 3) err.push("Puneți cel puțin 3 cuvinte cheie, separate prin virgulă.");
  if (text.length < 600) err.push(`Textul are doar ${text.length} caractere; minim 600 (aprox. 100 de cuvinte).`);
  if (faq.length < 2) err.push("Puneți cel puțin 2 întrebări, fiecare cu răspunsul ei.");
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 300) warn.push(`Articol scurt (${words} cuvinte). Peste 300 de cuvinte e mai bine pentru Google și AI.`);
  if (title.length > 60) warn.push(`Titlul are ${title.length} caractere; Google afișează aproximativ 60.`);
  return { err, warn, words };
}

async function preview(env, f) {
  const { raw, kw, faq } = compose(f);
  const v = validate(f, kw, faq);
  const parsed = parseArticle(raw);
  const list = (await readArticlesPublic(env)).articles || [];
  const p = pickIdSlugPublic(parsed.slug || parsed.title, list);
  const h2 = (parsed.body.match(/<h2>/g) || []).length;
  if (h2 < 2) v.warn.push("Textul are mai puțin de 2 subtitluri. Puneți subtitluri pe rânduri separate sau începeți-le cu ##.");
  return { ok: !v.err.length, errors: v.err, warnings: v.warn, words: v.words, id: p.id, url: p.url, title: parsed.title, seoTitle: parsed.seoTitle,
    description: parsed.desc, keywords: parsed.keywords, faq: parsed.faq.map((x) => x.q), headings: parsed.headings, body: parsed.body, raw };
}

async function notify(env, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900), disable_web_page_preview: true })
    });
  } catch (_) { /* fără log: URL-ul conține tokenul */ }
}

// ---------- rute HTTP ----------
export async function handleScrie(request, env, url) {
  if (!env.BLOG) return new Response("KV lipsă", { status: 500 });
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  if (request.method === "GET" && url.pathname === "/scrie") {
    const ok = await checkToken(env, url.searchParams.get("t"));
    return new Response(ok ? PAGE : EXPIRED, { status: ok ? 200 : 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" } });
  }
  if (request.method === "POST" && (url.pathname === "/scrie/verifica" || url.pathname === "/scrie/publica")) {
    let f; try { f = await request.json(); } catch (_) { return json({ ok: false, errors: ["Date invalide."] }, 400); }
    const tok = await checkToken(env, f.t);
    if (!tok) return json({ ok: false, errors: ["Linkul a expirat. Cereți altul în Telegram cu /scrie."] }, 403);
    try {
      const pv = await preview(env, f);
      if (url.pathname === "/scrie/verifica" || !pv.ok) return json(pv);
      if (!env.GITHUB_TOKEN) return json({ ok: false, errors: ["Lipsește secretul GITHUB_TOKEN în Cloudflare."] });
      const r = await publishNew(env, pv.raw, "pagina-de-scris");
      const ots = r.ots ? `OpenTimestamps: trimis la ${r.ots} calendare` : "OpenTimestamps: calendarele nu au răspuns";
      await notify(env, tok.chatId, `✅ PUBLICAT din pagina de scris: ${r.id} · v${r.version} — ${r.when}\n${r.url}\nIntrebari pentru AI: ${r.faq}\n${ots}\nIndexNow: ${r.idx}`);
      return json({ ok: true, published: true, id: r.id, url: r.url, when: r.when, faq: r.faq, sha: r.sha });
    } catch (e) {
      return json({ ok: false, errors: ["Eroare: " + String(e && e.message || e).slice(0, 300)] });
    }
  }
  return new Response("Not found", { status: 404 });
}

const EXPIRED = `<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Link expirat</title><style>body{background:#090b10;color:#f5f5f5;font:17px/1.6 system-ui,sans-serif;padding:30px}</style></head><body><h1>Linkul a expirat</h1><p>Cereți un link nou în Telegram: trimiteți <b>/scrie</b> botului.</p></body></html>`;

const PAGE = `<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Scrie un articol · AiVenture</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#090b10;color:#f5f5f5;font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:860px;margin:auto;padding:18px 16px 80px}h1{font-size:26px;margin:6px 0 2px}.sub{color:#9298a4;font-size:14px;margin:0 0 18px}
label{display:block;font-weight:600;margin:18px 0 6px}label small{font-weight:400;color:#9298a4}
input,textarea{width:100%;padding:11px 12px;border-radius:10px;border:1px solid #2b303a;background:#0d1016;color:#f5f5f5;font:16px system-ui,sans-serif}
textarea{min-height:110px;resize:vertical}#text{min-height:340px}.cnt{font-size:13px;color:#9298a4;margin-top:4px}.cnt.bad{color:#ff8a80}
.qa{border:1px solid #2b303a;border-radius:10px;padding:10px;margin:10px 0;background:#0b0e14}.qa input{margin-bottom:8px}
.btns{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0}button{padding:13px 20px;border-radius:10px;border:1px solid #e7c86e;background:transparent;color:#e7c86e;font:700 16px system-ui,sans-serif;cursor:pointer}
button.p{background:#e7c86e;color:#090b10}button:disabled{opacity:.45;cursor:not-allowed}
#res{margin-top:10px}.box{border:1px solid #2b303a;border-radius:12px;padding:14px 16px;margin:12px 0;background:#0d1016}.err{border-color:#ff8a80}.err li{color:#ff8a80}.warn li{color:#ffd180}.ok{border-color:#8fd19e}
.box h3{margin:0 0 8px;font-size:16px}.box ul{margin:4px 0;padding-left:20px}.prev{background:#fff;color:#111;border-radius:10px;padding:14px 18px;max-height:480px;overflow:auto}.prev h2{font-size:20px}.prev h3{font-size:17px}
a{color:#e7c86e}.help{font-size:14px;color:#b8bcc6}
</style></head><body><main>
<h1>✍️ Scrie un articol pentru aiventure.ro/blog</h1>
<p class="sub">Autor: Dan Ionescu · publicat de AiVenture S.R.L. — București, România · CUI 51415878. Articolul apare pe <a href="https://aiventure.ro/blog/" target="_blank">aiventure.ro/blog</a>, lângă celelalte. Nimic nu se publică până nu apăsați „Publică”.</p>

<label for="title">1. Titlul articolului <small>(obligatoriu · ideal sub 60 de caractere)</small></label>
<input id="title" maxlength="120" placeholder="Ex.: Cum ajunge site-ul firmei în Google și în ChatGPT"><div class="cnt" id="c-title"></div>

<label for="description">2. Descrierea pentru Google <small>(obligatoriu · 70–160 de caractere · o frază care spune clar despre ce e articolul)</small></label>
<textarea id="description" maxlength="200" style="min-height:70px" placeholder="Ex.: Ce se întâmplă de la publicarea unei pagini până când Google și ChatGPT o pot găsi și cita, pas cu pas."></textarea><div class="cnt" id="c-description"></div>

<label for="keywords">3. Cuvinte cheie <small>(obligatoriu · minim 3, separate prin virgulă)</small></label>
<input id="keywords" placeholder="Ex.: indexare Google, IndexNow, ChatGPT, AI Overviews"><div class="cnt" id="c-keywords"></div>

<label for="category">4. Categoria <small>(opțional)</small></label>
<input id="category" placeholder="Ex.: SEO · GEO">

<label for="text">5. Textul articolului <small>(obligatoriu · lipiți tot, oricât de lung)</small></label>
<p class="help">Puteți lipi direct din ChatGPT, Perplexity sau Word. Subtitlurile, listele și trimiterile de tip [2][7] se curăță automat. Pentru un subtitlu sigur, începeți rândul cu <b>##</b>.</p>
<textarea id="text" placeholder="Lipiți aici textul articolului…"></textarea><div class="cnt" id="c-text"></div>

<label>6. Întrebări frecvente <small>(obligatoriu · minim 2 · întrebări pe care le-ar pune un client, cu răspunsul luat din articol)</small></label>
<div id="faq"></div>
<button type="button" id="addq">+ Încă o întrebare</button>

<div class="btns"><button type="button" id="ver">🔎 Verifică</button><button type="button" class="p" id="pub" disabled>✅ Publică</button></div>
<div id="res" aria-live="polite"></div>
</main>
<script>
(function(){
var T=new URLSearchParams(location.search).get('t')||'';
var $=function(id){return document.getElementById(id)};
var KEY='aiv-scrie-'+T.slice(0,8);
function esc(s){return String(s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function qa(q,a){var d=document.createElement('div');d.className='qa';d.innerHTML='<input class="q" placeholder="Întrebarea (ex.: Cât durează indexarea în Google?)" value="'+esc(q)+'"><textarea class="a" style="min-height:70px" placeholder="Răspunsul, în 1–3 fraze">'+esc(a)+'</textarea>';$('faq').appendChild(d);d.addEventListener('input',save);}
function data(){return {t:T,title:$('title').value,description:$('description').value,keywords:$('keywords').value,category:$('category').value,text:$('text').value,
  faq:[].map.call(document.querySelectorAll('.qa'),function(x){return {q:x.querySelector('.q').value,a:x.querySelector('.a').value}})}}
function counts(){var t=$('title').value.length,d=$('description').value.trim().length,k=$('keywords').value.split(/[,;]/).filter(function(x){return x.trim()}).length,w=$('text').value.trim().split(/\\s+/).filter(Boolean).length;
  $('c-title').textContent=t+' caractere';$('c-title').className='cnt'+(t>60?' bad':'');
  $('c-description').textContent=d+' caractere (70–160)';$('c-description').className='cnt'+(d&&(d<70||d>160)?' bad':'');
  $('c-keywords').textContent=k+' cuvinte cheie (minim 3)';$('c-keywords').className='cnt'+(k<3?' bad':'');
  $('c-text').textContent=$('text').value.length.toLocaleString('ro-RO')+' caractere · '+w+' cuvinte';}
function save(){counts();$('pub').disabled=true;try{localStorage.setItem(KEY,JSON.stringify(data()))}catch(e){}}
try{var s=JSON.parse(localStorage.getItem(KEY)||'null');if(s){['title','description','keywords','category','text'].forEach(function(k){$(k).value=s[k]||''});(s.faq||[]).forEach(function(x){qa(x.q,x.a)})}}catch(e){}
while(document.querySelectorAll('.qa').length<3)qa('','');
['title','description','keywords','category','text'].forEach(function(k){$(k).addEventListener('input',save)});
$('addq').onclick=function(){qa('','')};counts();
function list(cls,h,arr){return arr&&arr.length?'<div class="box '+cls+'"><h3>'+h+'</h3><ul>'+arr.map(function(x){return '<li>'+esc(x)+'</li>'}).join('')+'</ul></div>':''}
function send(path,cb){$('res').innerHTML='<div class="box">Se lucrează…</div>';
  fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data())}).then(function(r){return r.json()}).then(cb).catch(function(e){$('res').innerHTML='<div class="box err">Eroare de rețea: '+esc(e)+'</div>'})}
$('ver').onclick=function(){send('/scrie/verifica',function(r){
  var h=list('err','❌ De corectat înainte de publicare',r.errors)+list('warn','⚠️ Atenție',r.warnings);
  if(r.url){h+='<div class="box '+(r.ok?'ok':'')+'"><h3>'+(r.ok?'✅ Gata de publicat':'Previzualizare')+'</h3><ul><li><b>Adresa:</b> '+esc(r.url)+'</li><li><b>Număr:</b> '+esc(r.id)+' · v1.0</li><li><b>Titlu în Google:</b> '+esc(r.seoTitle)+'</li><li><b>Descriere:</b> '+esc(r.description)+'</li><li><b>Cuvinte cheie:</b> '+esc((r.keywords||[]).join(', '))+'</li><li><b>Subtitluri:</b> '+(r.headings||[]).length+'</li><li><b>Întrebări pentru AI:</b> '+(r.faq||[]).length+'</li><li><b>Cuvinte:</b> '+r.words+'</li></ul></div>';
    h+='<div class="box"><h3>Cum va arăta textul</h3><div class="prev">'+(r.body||'')+'</div></div>';}
  $('res').innerHTML=h;$('pub').disabled=!r.ok;})};
$('pub').onclick=function(){if(!confirm('Publicați articolul pe aiventure.ro/blog?'))return;$('pub').disabled=true;send('/scrie/publica',function(r){
  if(r.published){$('res').innerHTML='<div class="box ok"><h3>✅ Publicat: '+esc(r.id)+'</h3><p>'+esc(r.when)+'</p><p><a href="'+esc(r.url)+'" target="_blank">'+esc(r.url)+'</a></p><p>Apare pe site în aproximativ 1 minut. Confirmarea a fost trimisă și în Telegram.</p></div>';try{localStorage.removeItem(KEY)}catch(e){}}
  else{$('res').innerHTML=list('err','❌ Nu s-a publicat',r.errors||['Eroare necunoscută'])+list('warn','⚠️ Atenție',r.warnings);}})};
})();
</script></body></html>`;
