/**
 * AIVENTURE TELEGRAM CONTROL — consola de comandă prin Telegram.   v1.3 · 2026-10-26
 *
 * v1.2 față de v1.1: ADAUGĂ /noi și /segmente [bilant] (citește D1 prin binding DB, doar SELECT).
 * v1.1 față de v1.0: ADAUGĂ /ore și /zile (restul rămâne neschimbat).
 *   /ore [H]  - rânduri citite/scrise pe ore, de la ora locală H (implicit 1 = ora 01:00 București, azi) până acum;
 *               pentru b2b-romania-db + total cont. Încearcă detaliu pe oră, apoi pe 15 minute; dacă API-ul nu
 *               oferă niciunul, spune clar și dă cifra pe zi.
 *   /zile     - ultimele 7 zile UTC: rânduri citite/scrise pe zi, ca să se vadă când a scăzut consumul.
 *
 * Worker SEPARAT de maison-anaf-daily. Nu are legătură la D1 și nu modifică nimic în producție.
 * v1.0 răspunde doar la comenzi de CITIRE:
 *   /start, /help  - lista comenzilor
 *   /ping          - confirmă că serverul răspunde (dus-întors Telegram <-> Worker)
 *   /status        - ora serverului și versiunea
 *   /costuri       - D1: rânduri citite / scrise azi, ieri, luna aceasta + cost estimat peste cota inclusă
 *   /ore [H]       - (v1.1) citiri/scrieri pe ore, de la ora locală H (implicit 01:00)
 *   /zile          - (v1.1) ultimele 7 zile
 *
 * SECURITATE
 *  - Telegram trimite fiecare mesaj la POST /telegram cu antetul X-Telegram-Bot-Api-Secret-Token; fără secretul
 *    corect (TELEGRAM_WEBHOOK_SECRET) cererea e respinsă (401).
 *  - Doar chat-ul din TELEGRAM_CHAT_ID primește răspuns. Orice alt chat e ignorat în tăcere.
 *  - Tokenul botului și tokenul de analitice nu apar niciodată în răspunsuri sau în log.
 *  - Înregistrarea webhook-ului: POST /setup cu antetul X-Setup-Key = TELEGRAM_WEBHOOK_SECRET (o singură dată).
 *
 * SECRETE (Cloudflare -> Settings -> Variables and secrets, tip Secret):
 *   TELEGRAM_BOT_TOKEN        tokenul botului (același ca la maison-anaf-daily)
 *   TELEGRAM_CHAT_ID          chat id-ul dumneavoastră (același)
 *   TELEGRAM_WEBHOOK_SECRET   parolă inventată: 20-64 caractere din A-Z a-z 0-9 _ - (fără alte simboluri)
 *   CF_ANALYTICS_TOKEN        token Cloudflare API, DOAR citire: Account -> Account Analytics -> Read
 *   CF_ACCOUNT_ID             ID-ul contului Cloudflare (32 de caractere hexazecimale)
 * OPȚIONAL: ALERT_ROWS_READ_DAY (prag de avertizare, rânduri citite pe zi; implicit 1.000.000.000)
 *
 * LIMITE ASUMATE
 *  - Cifrele vin din API-ul de analitice Cloudflare (GraphQL, dataset d1AnalyticsAdaptiveGroups) și sunt o
 *    ESTIMARE, nu factura oficială. Factura exactă rămâne în Billing.
 *  - Ziua este ziua UTC. Retenția metricilor D1: 31 de zile.
 *  - Numele câmpurilor GraphQL (rowsRead, rowsWritten) nu au putut fi rulate pe contul real înainte de livrare;
 *    dacă API-ul le respinge, /costuri arată mesajul de eroare al API-ului (fără token).
 */
const VERSION = "v1.3 · 2026-10-26";
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const DB_NAMES = { "0d6de488-285f-458b-b4b0-5f9ac913c5f1": "b2b-romania-db" };
// Cote incluse în Workers Paid (D1): 25 mld citiri / lună, 50 mil scrieri / lună. Peste cotă: 1 USD / mld citiri, 1 USD / mil scrieri.
const INCLUDED_READS = 25e9, INCLUDED_WRITES = 50e6;
const USD_PER_BILLION_READS = 1, USD_PER_MILLION_WRITES = 1;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "aiventure-telegram-control", version: VERSION, timestamp: new Date().toISOString() });
    }
    if (url.pathname === "/setup") return handleSetup(request, env, url);
    if (url.pathname === "/telegram") return handleTelegram(request, env, ctx);
    return new Response("Not found", { status: 404 });
  }
};

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Înregistrează webhook-ul la Telegram (o singură dată). Cheia = secretul webhook-ului.
async function handleSetup(request, env, url) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !safeEqual(request.headers.get("X-Setup-Key") || "", secret)) return new Response("Unauthorized", { status: 401 });
  if (!env.TELEGRAM_BOT_TOKEN) return Response.json({ ok: false, error: "TELEGRAM_BOT_TOKEN lipsa" }, { status: 500 });
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) return Response.json({ ok: false, error: "TELEGRAM_WEBHOOK_SECRET are caractere nepermise (doar A-Z a-z 0-9 _ -)" }, { status: 400 });
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `${url.origin}/telegram`, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true })
    });
    const body = await res.json().catch(() => ({}));
    return Response.json({ ok: !!body.ok, telegram_status: res.status, description: String(body.description || "").slice(0, 200), webhook: `${url.origin}/telegram` }, { status: body.ok ? 200 : 502 });
  } catch (e) {
    return Response.json({ ok: false, error: `eroare ${e && e.name ? e.name : "necunoscuta"}` }, { status: 502 });
  }
}

async function handleTelegram(request, env, ctx) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", secret)) return new Response("Unauthorized", { status: 401 });
  let update;
  try { update = await request.json(); } catch (_) { return new Response("ok"); }
  const msg = update && update.message;
  const chatId = msg && msg.chat && msg.chat.id;
  // Doar chat-ul autorizat; restul se ignoră (răspuns 200 ca Telegram să nu reîncerce).
  if (!msg || chatId === undefined || String(chatId) !== String(env.TELEGRAM_CHAT_ID || "")) return new Response("ok");
  const text = String(msg.text || "").trim();
  if (!text.startsWith("/")) return new Response("ok");
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  const args = text.split(/\s+/).slice(1);
  ctx.waitUntil(answer(env, chatId, cmd, args));
  return new Response("ok");
}

async function answer(env, chatId, cmd, args) {
  let reply;
  try {
    if (cmd === "/start" || cmd === "/help") reply = helpText();
    else if (cmd === "/ping") reply = `PONG ✅ Serverul raspunde.\n${new Date().toISOString()}`;
    else if (cmd === "/status") reply = `AiVenture Control ${VERSION}\nServer activ.\nOra serverului: ${fmtLocal(Date.now())} (Bucuresti)`;
    else if (cmd === "/costuri") reply = await costReport(env);
    else if (cmd === "/ore") reply = await hoursReport(env, args && args[0]);
    else if (cmd === "/zile") reply = await daysReport(env);
    else if (cmd === "/noi") reply = await noiReport(env);
    else if (cmd === "/sonda") reply = await sondaOnrc();
    else if (cmd === "/segmente") reply = await segmenteReport(env, args && args[0]);
    else reply = "Comanda necunoscuta.\n\n" + helpText();
  } catch (e) {
    reply = "Eroare interna la procesarea comenzii.";
  }
  await send(env, chatId, reply);
}

function helpText() {
  return "Comenzi disponibile:\n/ping - test dus-intors\n/status - starea serverului\n/costuri - D1: randuri citite/scrise si cost estimat\n/ore [H] - citiri/scrieri pe ore, de la ora H (implicit 1)\n/zile - ultimele 7 zile\n/noi - firme noi pe luna + diferenta fata de luna precedenta\n/segmente - firme pe vechime (sub 1 an, 1-2, 2-3, peste 3)\n/segmente bilant - la fel, plus peste 3 ani cu bilant (~17 s, ~7,5 mil. citiri)\n/sonda - test acces data.gov.ro din Cloudflare (temporar)\n/help - aceasta lista";
}

async function send(env, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900), disable_web_page_preview: true })
    });
  } catch (_) { /* nu logăm nimic: URL-ul conține tokenul */ }
}

function fmtLocal(ms) {
  try { return new Date(ms).toLocaleString("ro-RO", { timeZone: "Europe/Bucharest", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch (_) { return new Date(ms).toISOString(); }
}
function fmtInt(n) { return Math.round(Number(n) || 0).toLocaleString("ro-RO"); }
function fmtBig(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} mld`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} mil`;
  return fmtInt(n);
}
function usd(x) { return `$${x.toFixed(2)}`; }
function dayStr(d) { return d.toISOString().slice(0, 10); }
function dbLabel(id) { return DB_NAMES[id] || String(id || "?").slice(0, 8); }

const GQL = `query D1Costs($accountTag: string!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(filter: { date_geq: $start, date_leq: $end }, limit: 10000, orderBy: [date_DESC]) {
        sum { rowsRead rowsWritten readQueries writeQueries }
        dimensions { date databaseId }
      }
    }
  }
}`;

async function costReport(env) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return "Costuri: lipsesc secretele CF_ANALYTICS_TOKEN / CF_ACCOUNT_ID.";
  const now = new Date();
  const today = dayStr(now);
  const yesterday = dayStr(new Date(now.getTime() - 86400000));
  const monthStart = today.slice(0, 8) + "01";
  let data;
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.CF_ANALYTICS_TOKEN}` },
      body: JSON.stringify({ query: GQL, variables: { accountTag: env.CF_ACCOUNT_ID, start: monthStart, end: today } })
    });
    if (!res.ok) return `Costuri: API-ul de analitice a raspuns HTTP ${res.status}. Verificati tokenul (Account Analytics: Read) si CF_ACCOUNT_ID.`;
    data = await res.json();
  } catch (e) {
    return `Costuri: eroare la apelul API-ului de analitice (${e && e.name ? e.name : "necunoscuta"}).`;
  }
  if (data && Array.isArray(data.errors) && data.errors.length) {
    return `Costuri: API-ul de analitice a returnat eroare: ${String(data.errors[0].message || "necunoscuta").slice(0, 200)}`;
  }
  const rows = data && data.data && data.data.viewer && data.data.viewer.accounts && data.data.viewer.accounts[0]
    && data.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups;
  if (!Array.isArray(rows)) return "Costuri: raspuns neasteptat de la API-ul de analitice.";

  const agg = () => ({ r: 0, w: 0 });
  const t = { today: agg(), yday: agg(), month: agg() };
  const byDbToday = new Map();
  for (const x of rows) {
    const d = x.dimensions && x.dimensions.date;
    const r = Number(x.sum && x.sum.rowsRead) || 0, w = Number(x.sum && x.sum.rowsWritten) || 0;
    t.month.r += r; t.month.w += w;
    if (d === today) { t.today.r += r; t.today.w += w; const k = dbLabel(x.dimensions.databaseId); byDbToday.set(k, (byDbToday.get(k) || 0) + r); }
    if (d === yesterday) { t.yday.r += r; t.yday.w += w; }
  }
  const extraReads = Math.max(0, t.month.r - INCLUDED_READS);
  const extraWrites = Math.max(0, t.month.w - INCLUDED_WRITES);
  const costReads = (extraReads / 1e9) * USD_PER_BILLION_READS;
  const costWrites = (extraWrites / 1e6) * USD_PER_MILLION_WRITES;
  const threshold = Number(env.ALERT_ROWS_READ_DAY) > 0 ? Number(env.ALERT_ROWS_READ_DAY) : 1e9;

  const lines = [];
  lines.push("COSTURI D1 (estimare din analitice, zi UTC)");
  lines.push(`Azi ${today}: citite ${fmtBig(t.today.r)}, scrise ${fmtBig(t.today.w)}`);
  lines.push(`Ieri ${yesterday}: citite ${fmtBig(t.yday.r)}, scrise ${fmtBig(t.yday.w)}`);
  lines.push(`Luna aceasta (de la ${monthStart}): citite ${fmtBig(t.month.r)}, scrise ${fmtBig(t.month.w)}`);
  lines.push(`Cota lunara inclusa: 25 mld citiri, 50 mil scrieri.`);
  lines.push(`Cost estimat peste cota (luna aceasta): citiri ${usd(costReads)} + scrieri ${usd(costWrites)} = ${usd(costReads + costWrites)}`);
  if (byDbToday.size) {
    const top = [...byDbToday.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${fmtBig(v)}`).join("; ");
    lines.push(`Azi pe baze (citiri): ${top}`);
  }
  if (t.yday.r > threshold || t.today.r > threshold) lines.push(`⚠️ ATENTIE: citiri peste pragul de ${fmtBig(threshold)} pe zi.`);
  lines.push("Factura exacta: Cloudflare -> Billing.");
  return lines.join("\n");
}

// ---------------- v1.1: /ore și /zile ----------------
async function gqlCall(env, query, variables) {
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.CF_ANALYTICS_TOKEN}` },
      body: JSON.stringify({ query, variables })
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data && Array.isArray(data.errors) && data.errors.length) return { error: String(data.errors[0].message || "eroare necunoscuta").slice(0, 160) };
    const rows = data && data.data && data.data.viewer && data.data.viewer.accounts && data.data.viewer.accounts[0]
      && data.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups;
    if (!Array.isArray(rows)) return { error: "raspuns neasteptat" };
    return { rows };
  } catch (e) {
    return { error: `eroare ${e && e.name ? e.name : "necunoscuta"}` };
  }
}

// Decalajul (ms) al fusului Europe/Bucharest față de UTC la momentul dat (include ora de vară).
function tzOffsetMs(utcMs) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Bucharest", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const g = (t) => Number(parts.find(x => x.type === t).value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(utcMs / 1000) * 1000;
}
// Momentul UTC (ms) pentru ora locală h:00 din ziua locală curentă (București).
function localTodayHourUtc(nowMs, h) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Bucharest", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowMs));
  const g = (t) => Number(parts.find(x => x.type === t).value);
  const guess = Date.UTC(g("year"), g("month") - 1, g("day"), h, 0, 0);
  let t = guess - tzOffsetMs(guess);
  t = guess - tzOffsetMs(t);
  return t;
}
function fmtHourLocal(ms) {
  try { return new Date(ms).toLocaleString("ro-RO", { timeZone: "Europe/Bucharest", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch (_) { return new Date(ms).toISOString().slice(0, 13) + ":00Z"; }
}

function hoursQuery(dim) {
  return `query D1Hours($accountTag: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    d1AnalyticsAdaptiveGroups(filter: { datetime_geq: $start, datetime_leq: $end }, limit: 10000, orderBy: [${dim}_ASC]) {
      sum { rowsRead rowsWritten }
      dimensions { ${dim} databaseId }
    }
  } }
}`;
}

async function hoursReport(env, arg) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return "Ore: lipsesc secretele CF_ANALYTICS_TOKEN / CF_ACCOUNT_ID.";
  let h = 1;
  if (arg !== undefined && arg !== "") {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 0 || n > 23) return "Folosire: /ore sau /ore 6 (ora locala de start, 0-23).";
    h = n;
  }
  const nowMs = Date.now();
  let startMs = localTodayHourUtc(nowMs, h);
  if (startMs > nowMs) startMs -= 86400000; // ora de start e în viitor azi: se ia ziua precedentă
  const start = new Date(startMs).toISOString(), end = new Date(nowMs).toISOString();

  const errors = [];
  let rows = null, dimUsed = "";
  for (const dim of ["datetimeHour", "datetimeFifteenMinutes"]) {
    const r = await gqlCall(env, hoursQuery(dim), { accountTag: env.CF_ACCOUNT_ID, start, end });
    if (r.rows) { rows = r.rows; dimUsed = dim; break; }
    errors.push(`${dim}: ${r.error}`);
  }
  if (!rows) {
    // Detaliul pe oră nu e disponibil: cădem pe cifra pe zi.
    const day = await daysReport(env, 2);
    return `ORE: API-ul de analitice nu ofera detaliu pe ora (${errors.join("; ")}).\nCifra pe zi (UTC):\n${day}`;
  }
  const buckets = new Map(); // cheie: ora UTC "YYYY-MM-DDTHH"
  for (const x of rows) {
    const t = x.dimensions && x.dimensions[dimUsed];
    if (!t) continue;
    const key = String(t).slice(0, 13);
    const isB2b = x.dimensions.databaseId in DB_NAMES;
    const b = buckets.get(key) || { r: 0, w: 0, tr: 0, tw: 0 };
    const r = Number(x.sum && x.sum.rowsRead) || 0, w = Number(x.sum && x.sum.rowsWritten) || 0;
    b.tr += r; b.tw += w;
    if (isB2b) { b.r += r; b.w += w; }
    buckets.set(key, b);
  }
  const keys = [...buckets.keys()].sort();
  let sr = 0, sw = 0, tr = 0, tw = 0;
  const lines = [`CITIRI/SCRIERI pe ora (b2b-romania-db), de la ${fmtHourLocal(startMs)} (detaliu: ${dimUsed === "datetimeHour" ? "pe ora" : "din sferturi de ora"})`];
  for (const k of keys) {
    const b = buckets.get(k);
    sr += b.r; sw += b.w; tr += b.tr; tw += b.tw;
    const label = fmtHourLocal(Date.parse(k + ":00:00Z")).split(", ").pop();
    lines.push(`${label}  citite ${fmtBig(b.r)}, scrise ${fmtBig(b.w)}`);
  }
  if (!keys.length) lines.push("(nicio activitate inregistrata in interval)");
  lines.push(`TOTAL b2b-romania-db: citite ${fmtBig(sr)}, scrise ${fmtBig(sw)}`);
  lines.push(`TOTAL cont (toate bazele): citite ${fmtBig(tr)}, scrise ${fmtBig(tw)}`);
  lines.push("Ora = ora Bucuresti; ultima ora e partiala. Datele pot intarzia cateva minute.");
  return lines.join("\n");
}

const DAYS_GQL = `query D1Days($accountTag: string!, $start: Date!, $end: Date!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    d1AnalyticsAdaptiveGroups(filter: { date_geq: $start, date_leq: $end }, limit: 10000, orderBy: [date_ASC]) {
      sum { rowsRead rowsWritten }
      dimensions { date databaseId }
    }
  } }
}`;

async function daysReport(env, nDays) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return "Zile: lipsesc secretele CF_ANALYTICS_TOKEN / CF_ACCOUNT_ID.";
  const n = nDays || 7;
  const now = Date.now();
  const start = dayStr(new Date(now - (n - 1) * 86400000)), end = dayStr(new Date(now));
  const r = await gqlCall(env, DAYS_GQL, { accountTag: env.CF_ACCOUNT_ID, start, end });
  if (!r.rows) return `Zile: eroare API: ${r.error}`;
  const byDay = new Map();
  for (const x of r.rows) {
    const d = x.dimensions && x.dimensions.date;
    if (!d) continue;
    const b = byDay.get(d) || { r: 0, w: 0, br: 0 };
    const rr = Number(x.sum && x.sum.rowsRead) || 0, ww = Number(x.sum && x.sum.rowsWritten) || 0;
    b.r += rr; b.w += ww;
    if (x.dimensions.databaseId in DB_NAMES) b.br += rr;
    byDay.set(d, b);
  }
  const lines = [`ULTIMELE ${n} ZILE (zi UTC, tot contul)`];
  for (const d of [...byDay.keys()].sort()) {
    const b = byDay.get(d);
    lines.push(`${d}: citite ${fmtBig(b.r)} (b2b-romania-db ${fmtBig(b.br)}), scrise ${fmtBig(b.w)}`);
  }
  if (byDay.size === 0) lines.push("(nicio activitate inregistrata)");
  lines.push("Ziua curenta este partiala. Estimare din analitice, nu factura.");
  return lines.join("\n");
}


// ---------------- v1.2: /noi și /segmente (D1, doar SELECT) ----------------
function isoToday() { return new Date().toISOString().slice(0, 10); }
function isoMinusYears(n) {
  const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
}
function pct(a, b) {
  if (!b) return "n/a";
  const p = (a - b) / b * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

async function noiReport(env) {
  if (!env.DB) return "Noi: lipseste legatura DB (binding) la baza b2b-romania-db.";
  try {
    const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 13);
    const start = d.toISOString().slice(0, 10);
    const rows = (await env.DB.prepare(
      "SELECT substr(data_inmatriculare,1,7) AS luna, COUNT(*) AS n, SUM(persoana_fizica) AS pfa FROM onrc_firme WHERE data_inmatriculare >= ? GROUP BY 1 ORDER BY 1"
    ).bind(start).all()).results || [];
    const mx = await env.DB.prepare("SELECT MAX(data_inmatriculare) AS m FROM onrc_firme").first();
    const maxDate = mx && mx.m ? String(mx.m) : "";
    const lines = ["FIRME NOI pe luna inmatricularii (ONRC)"];
    let prev = null;
    for (const r of rows) {
      const partial = maxDate && String(r.luna) === maxDate.slice(0, 7);
      lines.push(`${r.luna}: ${fmtInt(r.n)} (PFA ${fmtInt(r.pfa)})${prev !== null ? "  " + pct(r.n, prev) : ""}${partial ? "  [luna partiala]" : ""}`);
      prev = r.n;
    }
    lines.push(`Date ONRC pana la: ${maxDate || "?"}. Ultimele 1-2 luni pot fi incomplete.`);
    return lines.join("\n");
  } catch (e) {
    return `Noi: eroare la interogarea bazei (${e && e.message ? String(e.message).slice(0, 120) : "necunoscuta"}).`;
  }
}

async function segmenteReport(env, mode) {
  if (!env.DB) return "Segmente: lipseste legatura DB (binding) la baza b2b-romania-db.";
  const withBilant = String(mode || "").toLowerCase().startsWith("bilan");
  const c1 = isoMinusYears(1), c2 = isoMinusYears(2), c3 = isoMinusYears(3);
  try {
    const r = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM onrc_firme WHERE data_inmatriculare > ?1) AS s1, " +
      "(SELECT COUNT(*) FROM onrc_firme WHERE data_inmatriculare > ?2 AND data_inmatriculare <= ?1) AS s2, " +
      "(SELECT COUNT(*) FROM onrc_firme WHERE data_inmatriculare > ?3 AND data_inmatriculare <= ?2) AS s3, " +
      "(SELECT COUNT(*) FROM onrc_firme WHERE data_inmatriculare <= ?3) AS s4"
    ).bind(c1, c2, c3).first();
    const tot = r.s1 + r.s2 + r.s3 + r.s4;
    const lines = [`SEGMENTE dupa vechime, la ${isoToday()} (total ${fmtInt(tot)})`];
    lines.push(`Sub 1 an (dupa ${c1}): ${fmtInt(r.s1)}`);
    lines.push(`1-2 ani: ${fmtInt(r.s2)}`);
    lines.push(`2-3 ani: ${fmtInt(r.s3)}`);
    lines.push(`Peste 3 ani (pana la ${c3}): ${fmtInt(r.s4)}`);
    if (withBilant) {
      const b = await env.DB.prepare(
        "WITH b AS (SELECT cui, MAX(ca) AS ca FROM (SELECT cui, cifra_afaceri AS ca FROM mf_bilant_2023 UNION ALL SELECT cui, cifra_afaceri FROM mf_bilant_2024 UNION ALL SELECT cui, cifra_afaceri FROM mf_bilant_2025) GROUP BY cui) " +
        "SELECT COUNT(*) AS cu_bilant, SUM(CASE WHEN b.ca > 0 THEN 1 ELSE 0 END) AS cu_ca FROM b JOIN onrc_firme o ON o.cui = b.cui WHERE o.data_inmatriculare <= ?"
      ).bind(c3).first();
      lines.push(`Peste 3 ani cu bilant depus (2023-2025): ${fmtInt(b.cu_bilant)}`);
      lines.push(`Peste 3 ani cu bilant si cifra de afaceri > 0: ${fmtInt(b.cu_ca)}`);
    } else {
      lines.push("Pentru 'peste 3 ani cu bilant': /segmente bilant (~17 s, ~7,5 mil. citiri, sub $0,01).");
    }
    lines.push("Include PFA. Date ONRC cu intarziere; vezi /noi.");
    return lines.join("\n");
  } catch (e) {
    return `Segmente: eroare la interogarea bazei (${e && e.message ? String(e.message).slice(0, 120) : "necunoscuta"}).`;
  }
}


// ---------------- v1.3: /sonda (temporar) - poate Cloudflare sa citeasca data.gov.ro? ----------------
async function fetchT(url, opt, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, Object.assign({ signal: c.signal, headers: { "User-Agent": "AiVenture-ONRC-sonda/1.0 (+contact@5thelement.ai)" } }, opt || {})); }
  finally { clearTimeout(t); }
}
async function sondaOnrc() {
  const out = ["SONDA data.gov.ro (din Cloudflare)"];
  const t0 = Date.now();
  try {
    const r = await fetchT("https://data.gov.ro/api/3/action/package_show?id=firme-19-10-2026", {}, 20000);
    out.push(`package_show: HTTP ${r.status} in ${Date.now() - t0} ms`);
    if (r.ok) {
      const j = await r.json();
      const res = (j.result && j.result.resources) || [];
      out.push(`Set: ${String(j.result && j.result.title || "?").slice(0, 70)} | resurse: ${res.length}`);
      for (const x of res) out.push(`- ${String(x.name || "?").slice(0, 40)} | ${x.size || "?"} B`);
      const f = res.find((x) => /OD_FIRME/i.test(x.name || ""));
      if (f && f.url) {
        const t1 = Date.now();
        const r2 = await fetchT(f.url, { headers: { "User-Agent": "AiVenture-ONRC-sonda/1.0", "Range": "bytes=0-1023" } }, 25000);
        const b = new Uint8Array(await r2.arrayBuffer());
        const txt = new TextDecoder("utf-8").decode(b.slice(0, 300));
        out.push(`OD_FIRME: HTTP ${r2.status} in ${Date.now() - t1} ms | tip ${r2.headers.get("content-type")} | lungime ${r2.headers.get("content-length") || r2.headers.get("content-range") || "?"}`);
        out.push(`primii octeti: ${b[0]},${b[1]} ${b[0] === 80 && b[1] === 75 ? "(ZIP)" : "(text)"}`);
        out.push("antet: " + txt.split(/\r?\n/)[0].slice(0, 220));
      }
    }
  } catch (e) {
    out.push(`EROARE: ${e && e.name ? e.name : "necunoscuta"} dupa ${Date.now() - t0} ms`);
  }
  return out.join("\n");
}
