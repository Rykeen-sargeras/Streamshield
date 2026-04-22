// server.js — StreamShield backend (Gemini, section-aware)

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Gemini API key comes from Railway env var (set GEMINI_API_KEY in Variables tab).
// For local dev, put it in a .env file and use a tool like dotenv, or just export it.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// Optional YouTube cookie from Railway variables (helps with rate limiting)
const YOUTUBE_COOKIE = process.env.YOUTUBE_COOKIE || "";

app.use(express.json({ limit: "3mb" }));
app.use(express.static(path.join(__dirname, "public")));

function parseYouTubeId(url) {
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url;
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

const IT_CLIENTS = [
  {
    name: "ANDROID",
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "20.10.38",
        androidSdkVersion: 30,
        hl: "en",
        timeZone: "UTC",
      },
    },
    ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
  },
  {
    name: "WEB",
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20240101.00.00",
        hl: "en",
      },
    },
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  },
  {
    name: "TVHTML5",
    context: {
      client: {
        clientName: "TVHTML5",
        clientVersion: "7.20250120.19.00",
        hl: "en",
      },
    },
    ua: "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0)",
  },
];

function buildYouTubeHeaders(userAgent) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": userAgent,
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://www.youtube.com",
    Referer: "https://www.youtube.com/",
  };
  if (YOUTUBE_COOKIE) headers.Cookie = YOUTUBE_COOKIE;
  return headers;
}

async function fetchPlayerData(videoId) {
  let lastErr;
  for (const client of IT_CLIENTS) {
    try {
      const resp = await fetch(IT_ENDPOINT, {
        method: "POST",
        headers: buildYouTubeHeaders(client.ua),
        body: JSON.stringify({ context: client.context, videoId }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        lastErr = new Error(
          `${client.name} returned ${resp.status}${body ? `: ${body.slice(0, 300)}` : ""}`
        );
        console.error(`[YT player] ${client.name} failed`, {
          status: resp.status,
          hasCookie: !!YOUTUBE_COOKIE,
          body: body.slice(0, 300),
        });
        continue;
      }
      const data = await resp.json();
      if (data?.playabilityStatus?.status === "ERROR") {
        throw new Error(data.playabilityStatus.reason || "Video unavailable");
      }
      return { data, client };
    } catch (e) {
      lastErr = e;
      console.error(`[YT player] ${client.name} exception:`, e.message);
    }
  }
  throw lastErr || new Error("Failed to reach YouTube");
}

function pickCaptionTrack(tracks, preferredLang = "en") {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  return (
    tracks.find((t) => t.languageCode === preferredLang && t.kind !== "asr") ||
    tracks.find((t) => t.languageCode === preferredLang) ||
    tracks.find((t) => t.vssId && t.vssId.includes(`.${preferredLang}`)) ||
    tracks.find((t) => t.kind === "asr") ||
    tracks[0]
  );
}

async function fetchCaptionXml(baseUrl, userAgent) {
  const urls = [baseUrl + "&fmt=srv3", baseUrl];
  let lastStatus = null;
  let lastBody = "";
  for (const url of urls) {
    const r = await fetch(url, {
      headers: {
        "User-Agent": userAgent,
        "Accept-Language": "en-US,en;q=0.9",
        ...(YOUTUBE_COOKIE ? { Cookie: YOUTUBE_COOKIE } : {}),
        Origin: "https://www.youtube.com",
        Referer: "https://www.youtube.com/",
      },
    });
    lastStatus = r.status;
    const body = await r.text();
    lastBody = body.slice(0, 300);
    if (r.ok) {
      if (body.startsWith("<html") || body.startsWith("<!DOCTYPE")) continue;
      if (body.length > 0) return body;
    }
  }
  throw new Error(
    `Caption fetch failed (last status ${lastStatus}). ${lastBody ? `Response: ${lastBody}` : ""}`
  );
}

function parseCaptionXml(xml) {
  const out = [];
  let m;
  const pRe = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  while ((m = pRe.exec(xml)) !== null) {
    const start = parseInt(m[1], 10) / 1000;
    const inner = m[3];
    let text = "";
    const sRe = /<s[^>]*>([^<]*)<\/s>/g;
    let sm;
    while ((sm = sRe.exec(inner)) !== null) text += sm[1];
    if (!text) text = inner.replace(/<[^>]+>/g, "");
    text = decodeEntities(text).replace(/\s+/g, " ").trim();
    if (text) out.push({ t: Math.floor(start), text });
  }
  if (out.length > 0) return out;

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
  {
    cat: "Copyrighted Music (DMCA risk)",
    sev: "high",
    patterns: [
      /\b(drake|taylor swift|kanye|beyonc|the weeknd|ariana|bad bunny|bts|billie eilish|post malone|kendrick|sza|olivia rodrigo|dua lipa|ed sheeran|justin bieber|rihanna|eminem)\b/i,
      /\b(copyrighted|copyright) (music|song|track|audio)\b/i,
      /\b(full (song|track|album)|whole soundtrack|plays? the (entire|full|whole) song)\b/i,
    ],
    reason:
      "Reference to named major-label artists or full-track playback. Broadcasting copyrighted music on stream is a DMCA/ContentID trigger.",
  },
  {
    cat: "Copyrighted Video Content (DMCA risk)",
    sev: "high",
    patterns: [
      /\b(breaking bad|game of thrones|marvel movie|netflix|disney|hbo|hulu|paramount|peacock)\b/i,
      /\b(full (episode|scene|clip)|whole ending|entire episode)\b/i,
      /\b(screener|leaked (clip|episode|movie|screener))\b/i,
    ],
    reason:
      "Reference to full episodes/scenes from copyrighted TV/film. Rebroadcasting is a takedown trigger.",
  },
  {
    cat: "Piracy / Illegal Streaming Links",
    sev: "high",
    patterns: [
      /\b(sketchy|illegal|pirat|free stream(ing)?) (site|link|website)\b/i,
      /\b(link in (the )?description|dm me for (the )?link|leaked.*link)\b/i,
      /\b(just don'?t tell (netflix|disney|hbo|the studio))\b/i,
    ],
    reason:
      "Promotion of piracy or off-platform sharing of infringing content. Direct ToS violation on every major stream platform.",
  },
  {
    cat: "Slurs / Hate Speech",
    sev: "high",
    patterns: [
      /\b(slurs?) (were used|thrown around|dropped|said)\b/i,
      /\bracial slur\b/i,
      /\b(n-word|r-word|f-word used as slur)\b/i,
      /\b(said some (stuff|things) i can'?t repeat)\b/i,
    ],
    reason:
      "Indication that slurs occur in this segment. Even reacting/quoting can trigger a channel-level strike.",
  },
  {
    cat: "Harmful / Dangerous Content",
    sev: "high",
    patterns: [
      /\b(bleach|drinking bleach|eating tide pods?|choking (game|challenge))\b.*\b(cure|heal|fix|help|work)\b/i,
      /\b(suicide|self[- ]harm) (method|how to|guide|tutorial)\b/i,
      /\bfaked (his|her|their) (own )?death\b/i,
      /\b(dangerous|lethal|toxic|poisonous)\b.*\b(don'?t try|do not do this|genuinely disturbing)\b/i,
    ],
    reason:
      "Potentially unsafe medical misinformation or dangerous-act content. Rebroadcast risks a strike for harmful/dangerous acts.",
  },
  {
    cat: "Gambling Promo (regional restriction)",
    sev: "med",
    patterns: [
      /\b(online )?casino\b/i,
      /\b(bet|betting|gambling) (site|platform|sponsor)\b/i,
      /\b(promo|bonus) code\b.*\b(cash|win|deposit|casino|bet)\b/i,
      /\b(easy money|guaranteed (win|return|payout))\b/i,
    ],
    reason:
      "Gambling sponsor promotion. Twitch has category restrictions, and YouTube requires age-gating + regional disclosure.",
  },
  {
    cat: "Doxxing / Private Info",
    sev: "high",
    patterns: [
      /\b(doxx?ed|doxx?ing)\b/i,
      /\b(home |street )?address (was )?(read out|leaked|shown|revealed)\b/i,
      /\b(personal (info|information|details)) (leaked|exposed|shown)\b/i,
      /\b(phone number|social security) (leaked|shown|read)\b/i,
    ],
    reason:
      "Reference to revealing private information. Any re-broadcast of doxxing content is an instant-strike category.",
  },
  {
    cat: "Election / Political Misinfo",
    sev: "med",
    patterns: [
      /\b(rigged|stolen|fraudulent) election\b/i,
      /\b(unverified|unproven) (claim|allegation)s?\b/i,
      /\b(conspiracy|qanon|deep state)\b/i,
    ],
    reason:
      "Election integrity claims are under elevated moderation. Unchallenged rebroadcasts can be flagged as misinformation.",
  },
  {
    cat: "Graphic Violence / Shock",
    sev: "med",
    patterns: [
      /\b(gore|graphic|violent|brutal) (footage|clip|video|scene)\b/i,
      /\b(disturbing|genuinely disturbing|not safe for work|nsfw)\b/i,
      /\b(death on stream|murder|killed (live|on stream))\b/i,
    ],
    reason:
      "Graphic or shock content. Rebroadcast may trigger age restriction, demonetization, or a Violent Content strike.",
  },
  {
    cat: "Adult / Sexual Content",
    sev: "med",
    patterns: [
      /\b(nude|nudity|sexual (content|act)|porn|pornograph)\b/i,
      /\b(onlyfans|adult content)\b/i,
      /\bnsfw\b/i,
    ],
    reason:
      "Adult content reference. Rebroadcast would violate sexual content policies across all major platforms.",
  },
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
// Section building — scales chunk size with video length so a
// 2-hour stream doesn't produce 200 tiny sections
// ──────────────────────────────────────────────────────────
function buildSections(transcript) {
  if (!transcript.length) return [];
  // Aim for 20–35 sections total regardless of video length
  const targetSections = 28;
  const chunkSize = Math.max(8, Math.min(40, Math.ceil(transcript.length / targetSections)));

  const sections = [];
  for (let i = 0; i < transcript.length; i += chunkSize) {
    const chunk = transcript.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const start = chunk[0].t;
    const end = chunk[chunk.length - 1].t;
    const text = chunk.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
    let label = text.replace(/^(and|but|so|then|okay|ok|well|like|you know)\s+/i, "").trim();
    if (label.length > 180) label = label.slice(0, 177).trimEnd() + "...";
    sections.push({ start, end, text, label: label || "Transcript section" });
  }
  return sections;
}

function buildFallbackSummary(transcript, flags, sections) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return "No transcript text was available to summarize.";
  }
  const durationSeconds = transcript[transcript.length - 1]?.t || 0;
  const duration = fmtDuration(durationSeconds);
  const sectionPreview = (sections || []).slice(0, 4).map((s) => s.label).join(" ");
  const shortPreview =
    sectionPreview.length > 320 ? sectionPreview.slice(0, 317).trimEnd() + "..." : sectionPreview;

  const high = flags.filter((f) => f.sev === "high").length;
  const med = flags.filter((f) => f.sev === "med").length;
  const low = flags.filter((f) => f.sev === "low").length;

  if (flags.length === 0) {
    return `This stream runs about ${duration}. Based on the transcript, it appears to cover: ${shortPreview || "general spoken commentary"}. No obvious rebroadcast-risk categories were triggered by the scanner, so it appears relatively safe to replay based on transcript content alone.`;
  }
  const topCats = [...new Set(flags.map((f) => f.cat))].slice(0, 3).join(", ");
  return `This stream runs about ${duration}. Based on the transcript, it appears to cover: ${shortPreview || "general spoken commentary"}. The scanner found ${flags.length} potentially relevant moment${flags.length === 1 ? "" : "s"} (${high} high, ${med} medium, ${low} low), mainly around ${topCats}.`;
}

// ──────────────────────────────────────────────────────────
// Gemini helpers
// ──────────────────────────────────────────────────────────
async function callGemini(prompt, responseMimeType = "text/plain") {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType },
      }),
    }
  );
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || `Gemini returned ${resp.status}`);
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// Extracts JSON out of whatever Gemini returned — handles raw JSON, code
// fences, or JSON embedded in prose
function extractJson(text) {
  let t = String(text || "").trim();
  // Strip markdown code fences if present
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  try {
    return JSON.parse(t);
  } catch {
    const match = t.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No parseable JSON found in Gemini response");
    return JSON.parse(match[0]);
  }
}

async function summarizeSections(sections, flags, durationText) {
  if (!GEMINI_API_KEY) return null;
  const outline = sections
    .slice(0, 24)
    .map((s) => `- [${fmtDuration(s.start)}-${fmtDuration(s.end)}] ${s.label}`)
    .join("\n");
  const flagText = flags.length
    ? flags.map((f) => `- [${fmtDuration(f.t)}] ${f.cat} (${f.sev})`).join("\n")
    : "- No flags detected";

  const prompt = `You are summarizing a livestream transcript for a streamer who wants to know what the stream is actually about.

Write a clean 2-4 sentence summary in plain English.
Do not talk about yourself.
Do not say "based on the transcript".
Do not just repeat that flags were found.
Focus first on the real subject matter of the stream, then mention whether any risky moments were detected.
Keep it readable and natural.

Stream length: ${durationText}

Timestamped outline:
${outline}

Flagged moments:
${flagText}`;

  const text = await callGemini(prompt, "text/plain");
  return text?.trim() || null;
}

async function labelSectionsWithGemini(sections) {
  if (!GEMINI_API_KEY || !sections.length) return sections;
  const limited = sections.slice(0, 30);
  const prompt = `Rewrite each transcript chunk into a short clickable timestamp summary.

Return ONLY valid JSON as:
{
  "sections": [
    { "index": 0, "label": "short summary" }
  ]
}

Rules:
- 6 to 14 words each
- describe what happens in that chunk
- do not use quotes
- do not say transcript section
- keep them clear enough that a user knows what they are clicking

Chunks:
${limited.map((s, i) => `${i}: [${fmtDuration(s.start)}-${fmtDuration(s.end)}] ${s.text.slice(0, 400)}`).join("\n")}`;

  try {
    const text = await callGemini(prompt, "application/json");
    const parsed = extractJson(text);
    const mapped = new Map(
      Array.isArray(parsed.sections)
        ? parsed.sections
            .filter((x) => typeof x?.index === "number" && typeof x?.label === "string")
            .map((x) => [x.index, x.label.trim()])
        : []
    );
    return sections.map((s, i) => ({ ...s, label: mapped.get(i) || s.label }));
  } catch (err) {
    console.error("Gemini section labeling failed:", err.message);
    return sections;
  }
}

function mergeFlags(ruleFlags, aiFlags) {
  const seen = new Set();
  const out = [];
  for (const f of [...aiFlags, ...ruleFlags]) {
    const key = `${Math.floor((f.t || 0) / 10)}_${f.cat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out.sort((a, b) => a.t - b.t);
}

async function aiFlagScanFromSections(sections, ruleFlags) {
  if (!GEMINI_API_KEY) return [];
  const outline = sections
    .slice(0, 28)
    .map((s) => `[${fmtDuration(s.start)}-${fmtDuration(s.end)}] ${s.text.slice(0, 350)}`)
    .join("\n");

  const prompt = `You are a YouTube/Twitch compliance reviewer.

Return ONLY valid JSON in this exact format:
{
  "flags": [
    {
      "t": 12,
      "cat": "Short category",
      "sev": "high",
      "reason": "Short reason",
      "quote": "Transcript quote"
    }
  ]
}

Rules:
- Only include additional high-confidence flags not already obvious from the text
- Use only sev values high, med, or low
- Keep quote short
- If there are no additional risks, return an empty array

Transcript outline:
${outline}

Existing rule-based categories:
${[...new Set(ruleFlags.map((f) => f.cat))].join(", ") || "none"}`;

  try {
    const text = await callGemini(prompt, "application/json");
    const parsed = extractJson(text);
    return Array.isArray(parsed.flags) ? parsed.flags.map((f) => ({ ...f, source: "ai" })) : [];
  } catch (err) {
    console.error("Gemini AI flag scan failed:", err.message);
    return [];
  }
}

// ──────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    ai: !!GEMINI_API_KEY, // honest: only true if we have a key
    youtubeCookie: !!YOUTUBE_COOKIE,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { url, lang = "en" } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing url" });

    const videoId = parseYouTubeId(url);
    if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });

    let playerData, client;
    try {
      ({ data: playerData, client } = await fetchPlayerData(videoId));
    } catch (err) {
      return res.status(502).json({ error: "Failed to reach YouTube", detail: err.message });
    }

    const vd = playerData?.videoDetails || {};
    const title = vd.title || "Untitled";
    const channel = vd.author || "Unknown";
    const duration = fmtDuration(vd.lengthSeconds);

    const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) {
      return res.status(404).json({
        error: "This video has no captions available.",
        detail: "YouTube returned no caption tracks for this video.",
      });
    }
    const track = pickCaptionTrack(tracks, lang);
    if (!track?.baseUrl) return res.status(404).json({ error: "No usable caption track found." });

    let transcript;
    try {
      const xml = await fetchCaptionXml(track.baseUrl, client.ua);
      transcript = parseCaptionXml(xml);
      if (transcript.length === 0) throw new Error("Caption file was empty or unparseable");
    } catch (err) {
      return res.status(502).json({ error: "Could not fetch captions", detail: err.message });
    }

    const ruleFlags = ruleBasedScan(transcript);
    let sections = buildSections(transcript);
    sections = await labelSectionsWithGemini(sections);

    const aiFlags = await aiFlagScanFromSections(sections, ruleFlags);
    const flags = mergeFlags(ruleFlags, aiFlags);

    let summary = null;
    try {
      summary = await summarizeSections(sections, flags, duration);
    } catch (err) {
      console.error("Gemini summary failed:", err.message);
    }
    if (!summary) summary = buildFallbackSummary(transcript, flags, sections);

    res.json({
      videoId,
      title,
      channel,
      duration,
      transcript,
      flags,
      summary,
      sections,
      aiEnabled: !!GEMINI_API_KEY,
      captionLang: track.languageCode,
      captionKind: track.kind || "manual",
    });
  } catch (err) {
    console.error("Analyze error:", err);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

app.post("/api/ai-scan", async (req, res) => {
  try {
    const { transcript } = req.body || {};
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res.status(400).json({ error: "Missing or empty transcript" });
    }

    const ruleFlags = ruleBasedScan(transcript);
    let sections = buildSections(transcript);
    sections = await labelSectionsWithGemini(sections);

    const aiFlags = await aiFlagScanFromSections(sections, ruleFlags);
    const flags = mergeFlags(ruleFlags, aiFlags);

    let summary = null;
    try {
      summary = await summarizeSections(
        sections,
        flags,
        fmtDuration(transcript[transcript.length - 1]?.t || 0)
      );
    } catch (err) {
      console.error("Gemini summary failed:", err.message);
    }
    if (!summary) summary = buildFallbackSummary(transcript, flags, sections);

    res.json({ flags, summary, sections, aiEnabled: !!GEMINI_API_KEY });
  } catch (err) {
    console.error("AI scan route error:", err);
    res.status(500).json({ error: "AI scan failed", detail: err.message });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { question, transcript, flags, sections } = req.body || {};
    if (!question || !Array.isArray(transcript)) {
      return res.status(400).json({ error: "Missing question or transcript" });
    }

    const safeSections =
      Array.isArray(sections) && sections.length ? sections : buildSections(transcript);

    const outline = safeSections
      .slice(0, 28)
      .map((s) => `- [${fmtDuration(s.start)}-${fmtDuration(s.end)}] ${s.label}`)
      .join("\n");

    const flagSummary =
      Array.isArray(flags) && flags.length
        ? flags.slice(0, 20).map((f) => `- [${fmtDuration(f.t)}] ${f.cat} (${f.sev})`).join("\n")
        : "- No flags detected";

    const prompt = `You are answering questions about a livestream transcript.

Use the outline below to answer clearly.
If possible, mention timestamps like [MM:SS].
If the answer is not fully certain, say so briefly.
Keep answers concise but useful.

Outline:
${outline}

Flags:
${flagSummary}

User question:
${question}`;

    let answer = null;
    try {
      answer = await callGemini(prompt, "text/plain");
    } catch (err) {
      console.error("Chat Gemini call failed:", err.message);
    }

    if (!answer || !answer.trim()) {
      const fallbackFirst = safeSections
        .slice(0, 3)
        .map((s) => `[${fmtDuration(s.start)}] ${s.label}`)
        .join(" ");
      answer = `I could not generate a full AI answer right now. From the transcript outline, the stream appears to cover: ${fallbackFirst || "general spoken commentary"}.`;
    }

    res.json({ answer: answer.trim() });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Chat failed", detail: err.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🛡  StreamShield running on port ${PORT}`);
  console.log(`   AI: ${GEMINI_API_KEY ? "enabled (Gemini)" : "disabled (set GEMINI_API_KEY)"}`);
  console.log(`   YouTube cookie: ${YOUTUBE_COOKIE ? "set" : "not set"}`);
});
