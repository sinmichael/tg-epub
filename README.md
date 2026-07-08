# TG-EPUB — Telegram EPUB Bot

## Overview
A Telegram bot that scrapes EPUB books from multiple sources and delivers them to users via Telegram. Deployed with Docker on Oracle Cloud Free Tier.

---

## Sources

| Source | Search | Download | Status |
|--------|--------|----------|--------|
| Project Gutenberg (Gutendex API) | ✅ | ✅ | Direct HTTP |
| LibGen (6 mirrors: li, bz, gl, is, rs, st) | ✅ | ✅ | Via Tor SOCKS5 |
| Anna's Archive (annas-archive.gl / .pk) | ✅ | ❌ (DDoS-Guard) | Falls back to LibGen MD5 |

### Source Priority (dedup)
1. LibGen (3)
2. Anna's Archive (2)
3. Gutenberg (1)

---

## Architecture

### Core Loop
1. User sends `/search <query>`
2. Bot runs all active sources in parallel (`Promise.allSettled`)
3. Results are sorted by priority, deduplicated by normalized title+author
4. User sees inline keyboard with results (title, author, source, size)
5. On tap, bot downloads EPUB (with queue concurrency limit), caches it, sends as document

### Caching
- **Search cache**: SQLite (`search_cache`), 24h TTL, SHA-256 hash of query. Empty results are NOT cached.
- **File cache**: SQLite + flat files in `{dataDir}/file-cache/`, keyed by `{source}:{id}`.
- **Admin command**: `/purgecache` clears both.

### Geo-blocking Mitigation
- LibGen returns 503 from Oracle Cloud IPs (geo-block).
- Tor sidecar (`dperson/torproxy`) routes all LibGen and AA traffic through SOCKS5 (`socks5://tor:9050`).
- **Transport layer** (`src/transport.ts`): single axios wrapper that auto-configures `SocksProxyAgent` when `PROXY_URL` is set.
- LibGen source detects 3 consecutive 503s and aborts early instead of waiting for timeouts.

---

## Commands

| Command | Access | Description |
|---------|--------|-------------|
| `/search <query>` | All | Search books across all sources |
| `/source [name]` | All | View/change active sources |
| `/language [code]` | All | Preferred language filter |
| `/favorites` | All | List saved books |
| `/history` | All | Recent downloads |
| `/stats` | Admin | User count, favorites, downloads |
| `/health` | Admin | Database connectivity check |
| `/broadcast <msg>` | Admin | Send message to all users |
| `/ban <id>` | Admin | Ban a user |
| `/unban <id>` | Admin | Unban a user |
| `/purgecache` | Admin | Clear search + file cache |

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js 20 (Alpine) |
| Language | TypeScript |
| Bot Framework | Telegraf |
| Scraping | axios + cheerio |
| Database | better-sqlite3 |
| Queue | p-limit |
| Logging | pino |
| Proxy | socks-proxy-agent + Tor (dperson/torproxy) |

---

## File Structure

```
tg-epub/
├── src/
│   ├── bot/
│   │   ├── index.ts           # Bot setup & all commands
│   │   ├── middleware.ts       # Rate limit, error handler
│   │   └── keyboards.ts       # Inline keyboard builders
│   ├── scraper/
│   │   ├── types.ts           # BookResult, Source interfaces
│   │   ├── registry.ts        # Source registry, dedup, priority
│   │   └── sources/
│   │       ├── gutenberg.ts   # Gutendex API source
│   │       ├── libgen.ts      # Multi-mirror LibGen with geo-block detect
│   │       └── anna.ts        # Anna's Archive with LibGen download fallback
│   ├── transport.ts           # Proxy-aware axios instance
│   ├── cache.ts               # Search + file cache (SQLite)
│   ├── db.ts                  # SQLite schema & connection
│   ├── preferences.ts         # User preferences (sources, language)
│   ├── queue.ts               # Download concurrency limiter
│   ├── storage.ts             # Temp file management
│   ├── config.ts              # Environment config
│   ├── logger.ts              # Pino logger
│   └── index.ts               # Entry point
├── data/                      # SQLite DB, file cache (Docker volume)
├── Dockerfile                 # Multi-stage build
├── docker-compose.yml         # App + Tor sidecar
├── .env.example
├── tsconfig.json
├── package.json
└── PLAN.md
```

---

## Deployment

```bash
# Initial (Oracle Cloud)
ssh opc@<ip>
sudo dnf install -y docker docker-compose-plugin git
git clone https://github.com/sinmichael/tg-epub /opt/tg-epub
cd /opt/tg-epub
cp .env.example .env   # edit BOT_TOKEN
docker compose up -d --build

# Update
cd /opt/tg-epub
sudo git pull --rebase
sudo docker compose up -d --build
```

### Docker Services
- **tg-epub**: Node.js bot (depends on tor)
- **tg-epub-tor**: dperson/torproxy SOCKS5 proxy (port 9050)

### Environment Variables
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOT_TOKEN` | ✅ | — | Telegram bot token |
| `ADMIN_IDS` | ✅ | — | Comma-separated Telegram user IDs |
| `DATA_DIR` | | `/app/data` | Persistent data directory |
| `PROXY_URL` | | `socks5://tor:9050` | SOCKS5 proxy for LibGen/AA |

---

## Known Issues
- LibGen is geo-blocked from Oracle Cloud; Tor works but is slower.
- Anna's Archive download endpoints behind DDoS-Guard; falls back to LibGen MD5.
- No inline mode yet.
- No format conversion yet.
