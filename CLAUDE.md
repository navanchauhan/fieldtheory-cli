# CLAUDE.md

This is the Field Theory CLI — a standalone tool for syncing and querying X/Twitter and Instagram bookmarks locally.

## Commands

```bash
npm run build        # Compile TypeScript to dist/
npm run dev          # Run via tsx directly
npm run test         # Run tests
npm run start        # Run compiled dist/cli.js
```

## Architecture

Single CLI application built with Commander.js. All data stored in `~/.ft-bookmarks/`.

### Key files

| File | Purpose |
|------|---------|
| `src/cli.ts` | Command definitions, progress bar, first-run UX |
| `src/paths.ts` | Data directory resolution (`~/.ft-bookmarks/`) |
| `src/graphql-bookmarks.ts` | GraphQL sync engine (Chrome session cookies) |
| `src/bookmarks.ts` | OAuth API sync |
| `src/bookmarks-db.ts` | SQLite FTS5 index, search, list, stats |
| `src/bookmark-classify.ts` | Regex-based category classifier |
| `src/bookmark-classify-llm.ts` | Optional LLM classifier |
| `src/bookmarks-viz.ts` | ANSI terminal dashboard |
| `src/chrome-cookies.ts` | Chrome cookie extraction (macOS Keychain) |
| `src/xauth.ts` | OAuth 2.0 flow |
| `src/db.ts` | WASM SQLite layer (sql.js-fts5) |
| `src/instagram-types.ts` | Instagram saved post types |
| `src/instagram-cookies.ts` | Instagram cookie extraction from Chrome |
| `src/instagram-api.ts` | Instagram saved posts sync engine |
| `src/instagram-db.ts` | Instagram SQLite FTS5 index, search, list, stats |
| `src/instagram-media.ts` | Instagram media downloader (images, video, audio) |

### Data flow

#### Twitter/X
```
Chrome cookies → GraphQL API → JSONL cache → SQLite FTS5 index
                                    ↓
                           Regex classification
                                    ↓
                         Search / List / Viz
```

#### Instagram
```
Chrome cookies → Instagram API → JSONL cache → SQLite FTS5 index
                                      ↓
                              Media download
                        (images, video, audio)
                                      ↓
                         Search / List / Stats
```

### Dependencies

All pure JavaScript/WASM — no native bindings:
- `commander` — CLI framework
- `sql.js` + `sql.js-fts5` — SQLite in WebAssembly
- `zod` — schema validation
- `dotenv` — .env file loading
