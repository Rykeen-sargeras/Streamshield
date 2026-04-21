// server.js — StreamShield backend
//
// Fetches YouTube transcripts by hitting YouTube's own InnerTube player API
// directly (same API the Android YouTube app uses). This is WAY more reliable
// than the scraped/third-party packages, which break every few months when
// YouTube tweaks their HTML.
//
// Flow on /api/analyze:
//   1. Parse video ID
//   2. POST to InnerTube /player endpoint to get metadata + caption track URLs
//   3. Fetch the caption XML
//   4. Parse into { t, text } segments
//   5. Run rule-based flag scanner
//   6. (Optional) Run Claude-based AI flag scanner in parallel
//   7. Merge + return JSON

const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ──────────────────────────────────────────────────────────
// Small helpers
// ──────────────────────────────────────────────────────────
function parseYouTubeId(url) {
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url; // already an ID
  const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function fmtDuration(seconds) {
  seconds = parseInt(seconds, 10) || 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

// ──────────────────────────────────────────────────────────
// YouTube InnerTube fetch
// ──────────────────────────────────────────────────────────
const IT_ENDPOINT = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

// Try a handful of client contexts — if one gets rate-limited or rejected,
// try the next. Android client works best for caption retrieval.
const IT_CLIENTS = [
  {
    name: "ANDROID",
    context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en", timeZone: "UTC" } },
    ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
  },
  {
    name: "WEB",
    context: { client: { clientName: "WEB", clientVersion: "2.20240101.00.00", hl: "en" } },
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  },
];

async function fetchPlayerData(videoId) {
  let lastErr;
  for (const client of IT_CLIENTS) {
    try {
      const resp = await fetch(IT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": client.ua },
        body: JSON.stringify({ ...client.context, videoId }),
      });
      if (!resp.ok) { lastErr = new Error(`${client.name} returned ${resp.status}`); continue; }
      const data = await resp.json();
      if (data?.playabilityStatus?.status === "ERROR") {
        throw new Error(data.playabilityStatus.reason || "Video unavailable");
      }
      return { data, client };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Failed to reach YouTube");
}

function pickCaptionTrack(tracks, preferredLang = "en") {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  // Prefer user-preferred language, then any non-auto English, then first available
  return (
    tracks.find(t => t.languageCode === preferredLang && t.kind !== "asr") ||
    tracks.find(t => t.languageCode === preferredLang) ||
    tracks.find(t => t.kind !== "asr") ||
    tracks[0]
  );
}

async function fetchCaptionXml(baseUrl, userAgent) {
  // Try srv3 (XML with timing info), then the default srv1
  const urls = [baseUrl + "&fmt=srv3", baseUrl];
  let lastStatus;
  for (const url of urls) {
    const r = await fetch(url, {
      headers: { "User-Agent": userAgent, "Accept-Language": "en-US,en;q=0.9" },
    });
    lastStatus = r.status;
    if (r.ok) {
      const body = await r.text();
      // If we got an HTML error page back, reject it
      if (body.startsWith("<html") || body.startsWith("<!DOCTYPE")) continue;
      if (body.length > 0) return body;
    }
  }
  throw new Error(`Caption fetch failed (last status ${lastStatus}). YouTube may be throttling this IP.`);
}

function parseCaptionXml(xml) {
  const out = [];
  // srv3 format: <p t="millis" d="millis">text</p> or nested <s>
  let m;
  const pRe = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  while ((m = pRe.exec(xml)) !== null) {
    const start = parseInt(m[1], 10) / 1000;
    const inner = m[3];
    // Prefer <s> children, else raw
    let text = "";
    const sRe = /<s[^>]*>([^<]*)<\/s>/g;
    let sm;
    while ((sm = sRe.exec(inner)) !== null) text += sm[1];
    if (!text) text = inner.replace(/<[^>]+>/g, "");
    text = decodeEntities(text).replace(/\s+/g, " ").trim();
    if (text) out.push({ t: Math.floor(start), text });
  }
  if (out.length > 0) return out;

  // Legacy srv1 format: <text start="secs" dur="secs">text</text>
  const tRe = /<text start="([\d.]+)"(?: dur="[\d.]+")?[^>]*>([\s\S]*?)<\/text>/g;
  while ((m = tRe.exec(xml)) !== null) {
    const start = parseFloat(m[1]);
    const text = decodeEntities(m[2]).replace(/\s+/g, " ").trim();
    if (text) out.push({ t: Math.floor(start), text });
  }
  return out;
}

// ──────────────────────────────────────────────────────────
// Rule-based flag scanner
// ──────────────────────────────────────────────────────────
const FLAG_RULES = [
  { cat: "Copyrighted Music (DMCA risk)", sev: "high",
    patterns: [
      /\b(drake|taylor swift|kanye|beyonc|the weeknd|ariana|bad bunny|bts|billie eilish|post malone|kendrick|sza|olivia rodrigo|dua lipa|ed sheeran|justin bieber|rihanna|eminem)\b/i,
      /\b(copyrighted|copyright) (music|song|track|audio)\b/i,
      /\b(full (song|track|album)|whole soundtrack|plays? the (entire|full|whole) song)\b/i,
    ],
    reason: "Reference to named major-label artists or full-track playback. Broadcasting copyrighted music on stream is a DMCA/ContentID trigger." },

  { cat: "Copyrighted Video Content (DMCA risk)", sev: "high",
    patterns: [
      /\b(breaking bad|game of thrones|marvel movie|netflix|disney|hbo|hulu|paramount|peacock)\b/i,
      /\b(full (episode|scene|clip)|whole ending|entire episode)\b/i,
      /\b(screener|leaked (clip|episode|movie|screener))\b/i,
    ],
    reason: "Reference to full episodes/scenes from copyrighted TV/film. Rebroadcasting is a takedown trigger." },

  { cat: "Piracy / Illegal Streaming Links", sev: "high",
    patterns: [
      /\b(sketchy|illegal|pirat|free stream(ing)?) (site|link|website)\b/i,
      /\b(link in (the )?description|dm me for (the )?link|leaked.*link)\b/i,
      /\b(just don'?t tell (netflix|disney|hbo|the studio))\b/i,
    ],
    reason: "Promotion of piracy or off-platform sharing of infringing content. Direct ToS violation on every major stream platform." },

  { cat: "Slurs / Hate Speech", sev: "high",
    patterns: [
      /\b(slurs?) (were used|thrown around|dropped|said)\b/i,
      /\bracial slur\b/i,
      /\b(n-word|r-word|f-word used as slur)\b/i,
      /\b(said some (stuff|things) i can'?t repeat)\b/i,
    ],
    reason: "Indication that slurs occur in this segment. Even reacting/quoting can trigger a channel-level strike." },

  { cat: "Harmful / Dangerous Content", sev: "high",
    patterns: [
      /\b(bleach|drinking bleach|eating tide pods?|choking (game|challenge))\b.*\b(cure|heal|fix|help|work)\b/i,
      /\b(suicide|self[- ]harm) (method|how to|guide|tutorial)\b/i,
      /\bfaked (his|her|their) (own )?death\b/i,
      /\b(dangerous|lethal|toxic|poisonous)\b.*\b(don'?t try|do not do this|genuinely disturbing)\b/i,
    ],
    reason: "Potentially unsafe medical misinformation or dangerous-act content. Rebroadcast risks a strike for harmful/dangerous acts." },

  { cat: "Gambling Promo (regional restriction)", sev: "med",
    patterns: [
      /\b(online )?casino\b/i,
      /\b(bet|betting|gambling) (site|platform|sponsor)\b/i,
      /\b(promo|bonus) code\b.*\b(cash|win|deposit|casino|bet)\b/i,
      /\b(easy money|guaranteed (win|return|payout))\b/i,
    ],
    reason: "Gambling sponsor promotion. Twitch has category restrictions, and YouTube requires age-gating + regional disclosure." },

  { cat: "Doxxing / Private Info", sev: "high",
    patterns: [
      /\b(doxx?ed|doxx?ing)\b/i,
      /\b(home |street )?address (was )?(read out|leaked|shown|revealed)\b/i,
      /\b(personal (info|information|details)) (leaked|exposed|shown)\b/i,
      /\b(phone number|social security) (leaked|shown|read)\b/i,
    ],
    reason: "Reference to revealing private information. Any re-broadcast of doxxing content is an instant-strike category." },

  { cat: "Election / Political Misinfo", sev: "med",
    patterns: [
      /\b(rigged|stolen|fraudulent) election\b/i,
      /\b(unverified|unproven) (claim|allegation)s?\b/i,
      /\b(conspiracy|qanon|deep state)\b/i,
    ],
    reason: "Election integrity claims are under elevated moderation. Unchallenged rebroadcasts can be flagged as misinformation." },

  { cat: "Graphic Violence / Shock", sev: "med",
    patterns: [
      /\b(gore|graphic|violent|brutal) (footage|clip|video|scene)\b/i,
      /\b(disturbing|genuinely disturbing|not safe for work|nsfw)\b/i,
      /\b(death on stream|murder|killed (live|on stream))\b/i,
    ],
    reason: "Graphic or shock content. Rebroadcast may trigger age restriction, demonetization, or a Violent Content strike." },

  { cat: "Adult / Sexual Content", sev: "med",
    patterns: [
      /\b(nude|nudity|sexual (content|act)|porn|pornograph)\b/i,
      /\b(onlyfans|adult content)\b/i,
      /\bnsfw\b/i,
    ],
    reason: "Adult content reference. Rebroadcast would violate sexual content policies across all major platforms." },
];

function ruleBasedScan(transcript) {
  const flags = [];
  for (const line of transcript) {
    for (const rule of FLAG_RULES) {
      for (const pat of rule.patterns) {
        const m = line.text.match(pat);
        if (m) {
          flags.push({
            t: line.t,
            cat: rule.cat,
            sev: rule.sev,
            reason: rule.reason,
            quote: line.text,
            match: m[0],
            source: "rule",
          });
          break;
        }
      }
    }
  }
  return flags;
}

// ──────────────────────────────────────────────────────────
// AI flag scanner (Claude)
// ──────────────────────────────────────────────────────────
async function aiScan(transcript) {
  if (!anthropic) return { flags: [], summary: null };

  const joined = transcript
    .map(l => `[${l.t}] ${l.text}`)
    .join("\n")
    .slice(0, 40000);

  const systemPrompt = `You are a YouTube/Twitch compliance reviewer helping a streamer decide whether they can safely replay a YouTube video on their live stream without earning a Terms of Service violation, DMCA strike, or demonetization.

Analyze the transcript and return flagged moments in strict JSON. Focus on content that would cause problems if REBROADCAST on a livestream:
- Copyrighted music/video (DMCA ContentID)
- Slurs, hate speech, harassment
- Doxxing or private info reveals
- Harmful/dangerous content (medical misinfo, self-harm, dangerous challenges)
- Gambling, adult, or drug promotion
- Graphic violence or shock content
- Misinformation (election, medical, etc.)
- Copyright piracy promotion

Output ONLY valid JSON in this exact shape, no prose:
{
  "summary": "2-3 sentence overview of the video and its overall rebroadcast risk",
  "flags": [
    {
      "t": <seconds as integer>,
      "cat": "<short category name>",
      "sev": "high|med|low",
      "reason": "<1 sentence explaining the risk>",
      "quote": "<the transcript line that triggered this>"
    }
  ]
}

Only flag real risks. Do not flag mild language, standard reaction-channel filler, or routine commentary. Err on the side of fewer, higher-confidence flags.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: "user", content: `Transcript:\n\n${joined}` }],
    });
    const text = response.content[0].text.trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(cleaned);
    const flags = (parsed.flags || []).map(f => ({ ...f, source: "ai" }));
    return { flags, summary: parsed.summary || null };
  } catch (err) {
    console.error("AI scan failed:", err.message);
    return { flags: [], summary: null };
  }
}

function mergeFlags(ruleFlags, aiFlags) {
  const seen = new Set();
  const out = [];
  for (const f of [...aiFlags, ...ruleFlags]) {
    const key = `${Math.floor(f.t / 10)}_${f.cat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out.sort((a, b) => a.t - b.t);
}

// ──────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ ok: true, ai: !!anthropic, timestamp: new Date().toISOString() });
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { url, lang = "en" } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing url" });

    const videoId = parseYouTubeId(url);
    if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });

    // 1. Get player data (captions + metadata in one call)
    let playerData, client;
    try {
      ({ data: playerData, client } = await fetchPlayerData(videoId));
    } catch (err) {
      return res.status(502).json({ error: "Failed to reach YouTube", detail: err.message });
    }

    // 2. Extract metadata
    const vd = playerData?.videoDetails || {};
    const title = vd.title || "Untitled";
    const channel = vd.author || "Unknown";
    const duration = fmtDuration(vd.lengthSeconds);

    // 3. Find caption track
    const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) {
      return res.status(404).json({
        error: "This video has no captions available. YouTube can't auto-generate them (music videos, some live streams), or the creator disabled them.",
      });
    }
    const track = pickCaptionTrack(tracks, lang);

    // 4. Fetch + parse transcript
    let transcript;
    try {
      const xml = await fetchCaptionXml(track.baseUrl, client.ua);
      transcript = parseCaptionXml(xml);
      if (transcript.length === 0) throw new Error("Caption file was empty or unparseable");
    } catch (err) {
      return res.status(502).json({ error: "Could not fetch captions", detail: err.message });
    }

    // 5. Scan flags — rule-based always, AI in parallel if enabled
    const [ruleFlags, aiResult] = await Promise.all([
      Promise.resolve(ruleBasedScan(transcript)),
      aiScan(transcript),
    ]);
    const flags = mergeFlags(ruleFlags, aiResult.flags);

    res.json({
      videoId,
      title,
      channel,
      duration,
      transcript,
      flags,
      summary: aiResult.summary,
      aiEnabled: !!anthropic,
      captionLang: track.languageCode,
      captionKind: track.kind || "manual",
    });
  } catch (err) {
    console.error("Analyze error:", err);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

// Run AI scan against a client-provided transcript (used by paste mode)
app.post("/api/ai-scan", async (req, res) => {
  try {
    const { transcript } = req.body || {};
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res.status(400).json({ error: "Missing or empty transcript" });
    }
    if (!anthropic) return res.json({ flags: [], summary: null, aiEnabled: false });
    const { flags, summary } = await aiScan(transcript);
    res.json({ flags, summary, aiEnabled: true });
  } catch (err) {
    console.error("AI scan route error:", err);
    res.status(500).json({ error: "AI scan failed", detail: err.message });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { question, transcript, flags } = req.body || {};
    if (!question || !transcript) return res.status(400).json({ error: "Missing question or transcript" });
    if (!anthropic) return res.json({ answer: "AI chat is disabled — set ANTHROPIC_API_KEY in Railway variables to enable it." });

    const joined = transcript.map(l => `[${l.t}] ${l.text}`).join("\n").slice(0, 40000);
    const flagSummary = flags && flags.length
      ? `\n\nDetected flags:\n${flags.map(f => `- [${f.t}s] ${f.cat} (${f.sev}): ${f.quote}`).join("\n")}`
      : "";

    const response = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 1000,
      system: "You are a helpful assistant answering questions about a YouTube video transcript. Be concise. When referencing moments, include the timestamp in [MM:SS] format.",
      messages: [{ role: "user", content: `Transcript:\n${joined}${flagSummary}\n\nQuestion: ${question}` }],
    });
    res.json({ answer: response.content[0].text });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Chat failed", detail: err.message });
  }
});

// SPA fallback — anything not matched returns the frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🛡  StreamShield running on port ${PORT}`);
  console.log(`   AI: ${anthropic ? "enabled" : "disabled (set ANTHROPIC_API_KEY to enable)"}`);
});
