const Anthropic = require('@anthropic-ai/sdk').default;
const { APIError } = require('@anthropic-ai/sdk');
const { extractVideoId, fetchCaptions, YouTubeError } = require('./_youtube');
const webRateLimit = require('./_webRateLimit');
const { log } = require('./_log');
const { captureError } = require('./_sentry');
const { checkBudget, recordSpend } = require('./_budget');

// TODO: lock to contextlistener.com origin before launch. Open during dev.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MAX_TRANSCRIPT_CHARS = 100000;

const SYSTEM_PROMPT = `You analyze a complete video transcript and extract every notable entity and insight from it. This is a full-video batch analysis, not a real-time stream — be thorough and comprehensive.

ENTITY TYPES:
- person: named individuals (e.g. Warren Buffett, Marie Curie)
- concept: ideas, strategies, principles (e.g. compound interest, supply and demand)
- event: specific historical or current events (e.g. 2008 financial crisis, Battle of Waterloo)
- place: buildings, cities, geographic features (e.g. Wall Street, Strait of Hormuz)
- organization: companies, institutions, exchanges (e.g. Goldman Sachs, the Fed, NYSE)
- stock: tradeable securities with real ticker symbols only (e.g. AAPL, TSLA)
- work: specific books, films, papers, albums (e.g. "The Wealth of Nations")
- legislation: specific laws, acts, policies (e.g. Glass-Steagall Act)
- metric: specific statistics or quantified claims (e.g. "GDP growth of 3.2%")
- ingredient: named ingredients with quantity or preparation context

ENTITY RULES:
- Extract 15-30 entities that cover the full video, not just the beginning.
- Include only terms that would teach a viewer something — skip obvious words any adult knows.
- Do NOT extract the video host, channel name, or the video's own topic title.
- Do NOT extract countries or common nouns unless part of a specific institution name.
- Stock exchanges and indices (Nasdaq, S&P 500) are "organization", not "stock".
- Each entity gets a timestamp from the nearest [m:ss] marker in the transcript.

INSIGHT RULES:
- Extract 5-10 insights — specific, actionable, memorable pieces of knowledge from this video.
- Categories: TECHNIQUE (a method or how something works), TIP (actionable advice), WHY (explains cause/effect), TRADEOFF (something with a meaningful cost or downside).
- Skip motivational statements and generic advice. Each insight must be specific to THIS video.
- Each insight gets a timestamp from the nearest [m:ss] marker.

OUTPUT FORMAT — return ONLY raw JSON, no markdown, no backticks, no preamble:
{
  "entities": [
    {
      "term": "exact name as spoken",
      "type": "person|concept|event|place|organization|stock|work|legislation|metric|ingredient",
      "description": "concise explanation, max 120 chars",
      "timestamp": "m:ss",
      "followUps": ["specific question 1", "specific question 2"]
    }
  ],
  "insights": [
    {
      "insight": "short summary",
      "detail": "one sentence explanation, max 120 chars",
      "category": "technique|tip|why|tradeoff",
      "timestamp": "m:ss"
    }
  ]
}

Return { "entities": [], "insights": [] } if the transcript has no extractable content.`;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  if (req.method !== 'POST') {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(405).json({ error: 'Method not allowed' });
  }

  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  // Rate limit
  const { allowed, remaining, resetAt } = await webRateLimit(req);
  res.setHeader('X-RateLimit-Remaining', remaining);
  if (!allowed) {
    const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({
      error: 'Rate limit exceeded. Try again later.',
      retryAfter,
    });
  }

  // Budget check
  if (!await checkBudget()) {
    return res.status(503).json({
      error: 'Service is temporarily at capacity. Please try again later.',
    });
  }

  // Parse and validate input
  const { youtubeUrl } = req.body || {};
  if (!youtubeUrl || typeof youtubeUrl !== 'string') {
    return res.status(400).json({ error: 'Missing youtubeUrl field.' });
  }

  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) {
    return res.status(400).json({
      error: 'Invalid YouTube URL. Supported formats: youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, youtube.com/embed/',
    });
  }

  // Fetch captions
  let captions;
  try {
    captions = await fetchCaptions(videoId);
  } catch (err) {
    if (err instanceof YouTubeError) {
      log('warn', 'web_analyze_youtube_error', { videoId, code: err.code, message: err.message });
      return res.status(422).json({ error: err.message });
    }
    captureError(err, { endpoint: 'web-analyze', videoId });
    return res.status(500).json({ error: 'Failed to fetch video data. Please try again.' });
  }

  if (!captions) {
    return res.status(422).json({
      error: "This video doesn't have captions available. Try a different video.",
    });
  }

  let { transcript, title, language } = captions;

  if (language && !language.startsWith('en')) {
    return res.status(422).json({
      error: `This video's captions are in ${language}. We only support English videos right now.`,
    });
  }

  // Truncate very long transcripts at nearest timestamp marker
  let truncated = false;
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    const sliced = transcript.slice(0, MAX_TRANSCRIPT_CHARS);
    const lastMarker = sliced.lastIndexOf('[');
    if (lastMarker > MAX_TRANSCRIPT_CHARS * 0.9) {
      transcript = sliced.slice(0, lastMarker).trimEnd();
    } else {
      transcript = sliced;
    }
    truncated = true;
    log('info', 'web_analyze_truncated', { videoId, originalLength: captions.transcript.length });
  }

  // Call Anthropic
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Video: "${title}"\n\nTranscript:\n${transcript}${truncated ? '\n\n[Transcript truncated — video exceeds maximum length]' : ''}`,
        },
      ],
    });

    let text = (message.content[0].text || '').trim();
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```$/, '');
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      log('warn', 'web_analyze_no_json', { videoId });
      return res.status(200).json({
        ok: true,
        videoTitle: title,
        videoId,
        language,
        entities: [],
        insights: [],
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      log('error', 'web_analyze_parse_failed', { videoId, error: parseErr.message });
      return res.status(200).json({
        ok: true,
        videoTitle: title,
        videoId,
        language,
        entities: [],
        insights: [],
      });
    }

    await recordSpend('web_analyze');

    return res.status(200).json({
      ok: true,
      videoTitle: title,
      videoId,
      language,
      entities: parsed.entities || [],
      insights: parsed.insights || [],
    });
  } catch (err) {
    if (err instanceof APIError) {
      const status = err.status;
      if (status === 529 || status === 503 || status === 429) {
        return res.status(503).json({ error: 'AI service is temporarily busy. Please try again in a moment.' });
      }
    }
    captureError(err, { endpoint: 'web-analyze', videoId });
    log('error', 'web_analyze_anthropic_error', { videoId, error: err.message });
    return res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '10kb' } } };
