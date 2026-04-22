# StreamShield

NoteGPT-style YouTube analyzer with a ToS flag scanner for streamers. Paste a YouTube URL, get a summary, timestamped notes, transcript, AI chat — plus flagged moments that could earn your stream a strike if you replay them on air.

## What's in the box

- **`server.js`** — Express backend. Fetches YouTube transcripts, runs rule-based flag scanning, optionally calls Gemini for AI-powered flag detection and summaries.
- **`public/index.html`** — Full frontend. Single file, no build step.
- **`railway.json`** — Railway deployment config.
- **`package.json`** — Dependencies.

## Deploy to Railway in 5 minutes

### 1. Put this code on GitHub

```bash
cd streamshield-backend
git init
git add .
git commit -m "Initial StreamShield commit"
```

Create a new empty repo at https://github.com/new (call it `streamshield`, keep it private if you want), then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/streamshield.git
git branch -M main
git push -u origin main
```

### 2. Create the Railway project

1. Go to https://railway.com/new and sign in with GitHub
2. Click **"Deploy from GitHub repo"**
3. Select your `streamshield` repo (you may need to grant Railway access)
4. Railway auto-detects Node.js via Nixpacks and starts building immediately

### 3. Add your Gemini API key (for AI features)

Without this key, the app still works — you just get keyword-based flag scanning instead of AI-powered detection, summaries, and chat.

1. Get a free key at https://aistudio.google.com/app/apikey (starts with `AIza...`)
2. In your Railway project dashboard, click your service
3. Click the **Variables** tab
4. Click **New Variable**
5. Name: `GEMINI_API_KEY`
6. Value: your key
7. Click **Add** — Railway will redeploy automatically

### 4. Generate a public URL

1. Click the **Settings** tab of your service
2. Scroll to the **Networking** section
3. Click **Generate Domain**
4. Railway gives you `https://streamshield-production-xxxx.up.railway.app`

That's it. Visit the URL and paste a YouTube link.

### 5. (Optional) Custom domain

In **Settings → Networking → Custom Domain**, add your domain and follow Railway's CNAME instructions. SSL is automatic.

## Run locally

```bash
cd streamshield-backend
npm install
cp .env.example .env
# Edit .env and paste your GEMINI_API_KEY
npm start
```

Open http://localhost:3000

## How the backend works

```
┌─────────────┐   POST /api/analyze   ┌──────────────────┐
│  Frontend   │ ────────────────────▶ │  Express server  │
│  (browser)  │                       │                  │
└─────────────┘                       │  1. Parse ID     │
       ▲                              │  2. Call YT      │
       │                              │     InnerTube    │
       │      JSON response           │     /player API  │
       │  (transcript, flags,         │  3. Fetch caps   │
       │   summary, metadata)         │  4. Rule scan    │
       └────────────────────────────  │  5. Gemini scan  │
                                      │  6. Merge        │
                                      └──────────────────┘
```

No third-party YouTube scrapers — the backend hits YouTube's own InnerTube API directly (the same one the Android YouTube app uses). This is way more stable than scraping HTML, which breaks every few months.

### Flag sources

- **Rule-based** (always on, free, instant) — regex patterns matched against each transcript line for 10 risk categories.
- **AI-based** (needs `GEMINI_API_KEY`) — sends the transcript to Gemini with a compliance-reviewer system prompt. Catches sarcasm, context, implied content that keyword rules miss.

Both run in parallel when AI is on. Duplicate flags on the same timestamp+category are merged.

## API reference

### `GET /api/health`
Returns `{ ok: true, ai: true|false }` — lets the frontend know if AI is enabled.

### `POST /api/analyze`
Body: `{ "url": "https://youtube.com/watch?v=..." }`

Returns:
```json
{
  "videoId": "dQw4w9WgXcQ",
  "title": "...",
  "channel": "...",
  "duration": "3:32",
  "transcript": [{ "t": 0, "text": "..." }],
  "flags": [{
    "t": 32,
    "cat": "Copyrighted Music (DMCA risk)",
    "sev": "high",
    "reason": "...",
    "quote": "...",
    "source": "ai" | "rule"
  }],
  "summary": "...",
  "aiEnabled": true
}
```

### `POST /api/chat`
Body: `{ "question": "...", "transcript": [...], "flags": [...] }`

Returns: `{ "answer": "..." }`

## Troubleshooting

**"This video has no captions available"**
The video genuinely has no captions — usually music videos, live streams, or very new uploads YouTube hasn't auto-captioned yet. Try a different video. Most talk-heavy content has auto-captions within minutes of upload.

**"Failed to reach YouTube" or "Could not fetch captions"**
YouTube is throttling the IP. Railway's default IPs normally work fine, but if you're seeing this frequently:
  - Check your Railway service logs for the specific status code
  - If 429 (rate limit), your instance is being flagged as a bot. Restart the service to get a new IP assignment, or upgrade the plan for a dedicated IP
  - As a last resort, you can pass a YouTube cookie header to bypass the throttling — grab one from your browser's devtools (the `__Secure-1PSID` cookie), add a `YOUTUBE_COOKIE` env var in Railway, and add `Cookie: process.env.YOUTUBE_COOKIE` to the request headers in `fetchPlayerData` and `fetchCaptionXml` in `server.js`

**AI flags not appearing**
Check that `GEMINI_API_KEY` is set in Railway variables and that your key has credits at https://aistudio.google.com/apikey. Check Railway logs (`View Logs` on your service) for error details.

**Chat button is disabled**
Same fix — needs `GEMINI_API_KEY`.

**Build fails on Railway**
Make sure your Node version matches — `package.json` specifies `"node": ">=20"`. Railway defaults to Node 20 via Nixpacks. If you're on an older project, go to **Settings → Deploy** and check the Nixpacks version.

## Cost estimate

- **Railway**: ~$5/mo for the included usage tier, scales with traffic
- **Gemini API**: `gemini-1.5-flash` has a generous free tier (~1500 requests/day as of early 2026). Well beyond that, it's roughly $0.01–0.02 per video analysis.

## Customizing the flag rules

Edit the `FLAG_RULES` array in `server.js` to add or remove categories. Each rule is:

```js
{
  cat: "Short category name shown in UI",
  sev: "high" | "med" | "low",
  patterns: [/regex1/i, /regex2/i, ...],
  reason: "Why this matters — shown to the user"
}
```

If you update the rules, also mirror them in the frontend if you want consistency in edge cases, but the backend is the source of truth when deployed.

## License

MIT — do whatever you want with it.
