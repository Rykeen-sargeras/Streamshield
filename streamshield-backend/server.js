// server.js — StreamShield backend (GEMINI HARD-CODED VERSION)

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// 🔴 HARD CODED GEMINI KEY (YOU ASKED FOR THIS)
const GEMINI_API_KEY = "AIzaSyAgSl0CZoPbOzXup1VyDgm6syOgWOM3o2k";

// OPTIONAL YOUTUBE COOKIE
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
      },
    },
    ua: "com.google.android.youtube/20.10.38",
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
    ua: "Mozilla/5.0",
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
        console.error(`[YT player] ${client.name} failed`, resp.status);
        continue;
      }

      const data = await resp.json();
      return { data, client };
    } catch (e) {
      console.error(`[YT player] ${client.name} error`, e.message);
    }
  }

  throw new Error("YouTube fetch failed");
}

function pickCaptionTrack(tracks) {
  return tracks?.[0] || null;
}

async function fetchCaptionXml(baseUrl, userAgent) {
  const r = await fetch(baseUrl, {
    headers: {
      "User-Agent": userAgent,
      ...(YOUTUBE_COOKIE ? { Cookie: YOUTUBE_COOKIE } : {}),
    },
  });

  if (!r.ok) throw new Error("Caption fetch failed");

  return await r.text();
}

function parseCaptionXml(xml) {
  const out = [];
  const re = /<text start="([\d.]+)".*?>(.*?)<\/text>/g;

  let m;
  while ((m = re.exec(xml))) {
    out.push({
      t: Math.floor(parseFloat(m[1])),
      text: decodeEntities(m[2]),
    });
  }

  return out;
}

async function aiScan(transcript) {
  const joined = transcript.map((l) => `[${l.t}] ${l.text}`).join("\n").slice(0, 40000);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Summarize and flag risks:\n${joined}` }] }],
      }),
    }
  );

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  return { flags: [], summary: text };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    ai: true,
    youtubeCookie: !!YOUTUBE_COOKIE,
  });
});

app.post("/api/analyze", async (req, res) => {
  try {
    const videoId = parseYouTubeId(req.body.url);

    const { data, client } = await fetchPlayerData(videoId);

    const tracks =
      data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

    const track = pickCaptionTrack(tracks);

    const xml = await fetchCaptionXml(track.baseUrl, client.ua);
    const transcript = parseCaptionXml(xml);

    const ai = await aiScan(transcript);

    res.json({
      transcript,
      summary: ai.summary,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { question, transcript } = req.body;

  const joined = transcript.map((l) => `[${l.t}] ${l.text}`).join("\n");

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Transcript:\n${joined}\n\nQuestion: ${question}`,
              },
            ],
          },
        ],
      }),
    }
  );

  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response";

  res.json({ answer: text });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Running on ${PORT}`);
});
