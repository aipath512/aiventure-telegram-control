# aiventure-telegram-control
Worker Cloudflare: consola de comandă prin Telegram (/ping /status /costuri /ore /zile) + publicare blog aiventure.ro (/articol /editez /gata /publica), optimizat Google + AI, autor cu pagina proprie, IndexNow automat (v1.8).
Cod: `src/index.js`. Fiecare push pe `main` îl publică automat (GitHub Actions + wrangler).
Secrete în Cloudflare (nu în repo): CF_ACCOUNT_ID, CF_ANALYTICS_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET.
Secrete în GitHub: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
