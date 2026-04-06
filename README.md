# Stock Intel

Stock screening and daily intelligence platform for Jawad / Sunseeker Properties.

## Architecture

- **Frontend**: React/Babel single-page app on GitHub Pages (`index.html`)
- **Backend**: Cloudflare Worker (`worker.js`)
- **Storage**: Cloudflare KV (`STOCK_INTEL` namespace)
- **Data sources**: Finnhub, FMP (Financial Modeling Prep), SEC EDGAR, Anthropic Claude

## Setup

### 1. Cloudflare Worker

```bash
# Install wrangler
npm install

# Login to Cloudflare
npx wrangler login

# Create KV namespace
npx wrangler kv:namespace create STOCK_INTEL
# → Copy the ID into wrangler.toml

# Set secrets (API keys — never commit these)
npx wrangler secret put FINNHUB_KEY
npx wrangler secret put FMP_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GMAIL_USER
npx wrangler secret put GMAIL_APP_PASSWORD

# Deploy worker
npx wrangler deploy
```

### 2. Frontend

Update `WORKER_URL` in `index.html` with your worker URL (e.g. `https://stock-intel-worker.your-subdomain.workers.dev`).

Then deploy via app-deploy:
```bash
app-deploy stock-intel
```

## Cron schedule

| Cron (UTC)   | IST    | Action                                    |
|--------------|--------|-------------------------------------------|
| `0 23 * * *` | 04:30  | Watchlist enrichment (news + Claude filter) |
| `15 23 * * *`| 04:45  | Run all saved screens, compute diffs       |
| `30 23 * * *`| 05:00  | Compile and send digest email              |

## Versioning

Format: `vWW.HH` where WW = Worker version, HH = HTML version.  
Current: `v01.00`

## Email delivery

Uses [MailChannels](https://mailchannels.com) (free for Cloudflare Workers). No SMTP credentials needed for delivery — just set `GMAIL_USER` as the sender display address.

## API routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/screen` | Run screener |
| GET | `/api/stock/:ticker` | Full stock data |
| GET/POST | `/api/watchlist` | Get/add watchlist |
| DELETE | `/api/watchlist/:id` | Remove from watchlist |
| GET/POST | `/api/screens` | Get/save screens |
| DELETE | `/api/screens/:id` | Delete screen |
| GET/POST | `/api/criteria` | Get/save criteria config |
| GET | `/api/digest/last` | Last digest |
| POST | `/api/deepdive/:ticker` | Layer 2 SEC EDGAR analysis |
| GET | `/api/symbol-search` | Finnhub symbol autocomplete |
| GET | `/api/backtest` | Stub (v2) |
| GET | `/api/cron-status` | Cron + version status |
| POST | `/api/test-email` | Send test email |
