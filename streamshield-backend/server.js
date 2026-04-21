// server.js — StreamShield backend (Gemini hard-coded, frontend-compatible)

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Hard-coded Gemini key for testing
const GEMINI_API_KEY = "AIzaSyAgSl0CZoPbOzXup1VyDgm6syOgWOM3o2k";

// Optional YouTube cookie from Railway variables
const YOUTUBE_COOKIE = process.env.YOUTUBE_COOKIE || "";

app.use(express.json({ limit: "2mb" }));
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

  if (YOUTUBE_COOKIE) {
    headers.Cookie = YOUTUBE_COOKIE;
  }

  return headers;
}

async function fetchPlayerData(videoId) {
  let lastErr;

  for (const client of IT_CLIENTS) {
    try {
      const resp = await fetch(IT_ENDPOINT, {
        method: "POST",
        headers: buildYouTubeHeaders(client.ua),
        body: JSON.stringify({
          context: client.context,
          videoId,
        }),
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
      if (body.startsWith("<html") || body.startsWith("<!DOCTYPE")) {
        continue;
      }
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

function buildFallbackSummary(transcript, flags) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return "No transcript text was available to summarize.";
  }

  const durationSeconds = transcript[transcript.length - 1]?.t || 0;
  const duration = fmtDuration(durationSeconds);

  const opening = transcript
    .slice(0, 8)
    .map((l) => l.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const shortOpening =
    opening.length > 260 ? opening.slice(0, 257).trimEnd() + "..." : opening;

  const high = flags.filter((f) => f.sev === "high").length;
  const med = flags.filter((f) => f.sev === "med").length;
  const low = flags.filter((f) => f.sev === "low").length;

  if (flags.length === 0) {
    return `This video runs about ${duration}. The opening portion suggests the video focuses on: ${shortOpening || "general spoken commentary"}. No obvious rebroadcast-risk categories were triggered by the current scanner, so it appears relatively safe for replay based on the transcript alone.`;
  }

  const topCats = [...new Set(flags.map((f) => f.cat))].slice(0, 3).join(", ");

  return `This video runs about ${duration}. The transcript suggests it focuses on: ${shortOpening || "general spoken commentary"}. The scanner found ${flags.length} potentially relevant moment${flags.length === 1 ? "" : "s"} (${high} high, ${med} medium, ${low} low), mainly around ${topCats}.`;
}

async function callGemini(prompt, responseMimeType = "application/json") {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType,
        },
      }),
    }
  );

  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(data?.error?.message || `Gemini returned ${resp.status}`);
  }

  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function aiScan(transcript, ruleFlags = []) {
  if (!GEMINI_API_KEY) {
    return { flags: [], summary: buildFallbackSummary(transcript, ruleFlags) };
  }

  const joined = transcript
    .map((l) => `[${l.t}] ${l.text}`)
    .join("\n")
    .slice(0, 30000);

  const prompt = `You are a YouTube/Twitch compliance reviewer helping a streamer decide whether they can safely replay a YouTube video on their live stream.

Return ONLY valid JSON.
Do not use markdown fences.
Do not include explanation before or after the JSON.

Use exactly this schema:
{
  "summary": "2-3 sentence overview of the video and its rebroadcast risk",
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
- "summary" must always be present and non-empty
- Use only sev values: "high", "med", or "low"
- If there are no additional risks, return an empty flags array
- Keep the summary concise and useful
- Mention the actual subject matter of the video, not just the risk level

Transcript:
${joined}`;

  try {
    const text = await callGemini(prompt, "application/json");
    if (!text) throw new Error("Gemini returned empty text");

    let parsed;
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Gemini did not return parseable JSON");
      parsed = JSON.parse(match[0]);
    }

    return {
      flags: Array.isArray(parsed.flags)
        ? parsed.flags.map((f) => ({ ...f, source: "ai" }))
        : [],
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : buildFallbackSummary(transcript, ruleFlags),
    };
  } catch (err) {
    console.error("Gemini scan failed:", err.message);
    return {
      flags: [],
      summary: buildFallbackSummary(transcript, ruleFlags),
    };
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

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    ai: true,
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
      return res.status(502).json({
        error: "Failed to reach YouTube",
        detail: err.message,
      });
    }

    const vd = playerData?.videoDetails || {};
    const title = vd.title || "Untitled";
    const channel = vd.author || "Unknown";
    const duration = fmtDuration(vd.lengthSeconds);

    const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) {
      return res.status(404).json({
        error: "This video has no captions available.",
        detail:
          "YouTube returned no caption tracks for this video. Try another video, or test a talk-heavy upload with known subtitles.",
      });
    }

    const track = pickCaptionTrack(tracks, lang);
    if (!track?.baseUrl) {
      return res.status(404).json({
        error: "No usable caption track found.",
      });
    }

    let transcript;
    try {
      const xml = await fetchCaptionXml(track.baseUrl, client.ua);
      transcript = parseCaptionXml(xml);
      if (transcript.length === 0) throw new Error("Caption file was empty or unparseable");
    } catch (err) {
      return res.status(502).json({
        error: "Could not fetch captions",
        detail: err.message,
      });
    }

    const ruleFlags = ruleBasedScan(transcript);
    const aiResult = await aiScan(transcript, ruleFlags);
    const flags = mergeFlags(ruleFlags, aiResult.flags);

    res.json({
      videoId,
      title,
      channel,
      duration,
      transcript,
      flags,
      summary: aiResult.summary,
      aiEnabled: true,
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
    const { flags, summary } = await aiScan(transcript, ruleFlags);
    res.json({ flags, summary, aiEnabled: true });
  } catch (err) {
    console.error("AI scan route error:", err);
    res.status(500).json({ error: "AI scan failed", detail: err.message });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { question, transcript, flags } = req.body || {};
    if (!question || !Array.isArray(transcript)) {
      return res.status(400).json({ error: "Missing question or transcript" });
    }

    const joined = transcript.map((l) => `[${l.t}] ${l.text}`).join("\n").slice(0, 40000);
    const flagSummary =
      Array.isArray(flags) && flags.length
        ? `\n\nDetected flags:\n${flags
            .map((f) => `- [${f.t}s] ${f.cat} (${f.sev}): ${f.quote}`)
            .join("\n")}`
        : "";

    const prompt = `You are a helpful assistant answering questions about a YouTube video transcript.
Be concise.
When referencing moments, include timestamps like [MM:SS].

Transcript:
${joined}${flagSummary}

Question:
${question}`;

    const answer = await callGemini(prompt, "text/plain");
    res.json({ answer: answer || "No response" });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Chat failed", detail: err.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🛡 StreamShield running on port ${PORT}`);
  console.log("AI: enabled (Gemini hard-coded)");
  console.log(`YouTube cookie: ${YOUTUBE_COOKIE ? "set" : "not set"}`);
});
