const { log } = require('./_log');

const VIDEO_ID_PATTERNS = [
  /(?:youtube\.com\/watch\?.*v=|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
];

function extractVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  for (const pattern of VIDEO_ID_PATTERNS) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractPlayerResponse(html) {
  const marker = 'var ytInitialPlayerResponse = ';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  let i = start + marker.length;
  if (html[i] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let j = i; j < html.length; j++) {
    const ch = html[j];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(i, j + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

class YouTubeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'YouTubeError';
    this.code = code;
  }
}

async function fetchCaptions(videoId) {
  const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const resp = await fetch(pageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!resp.ok) {
    if (resp.status === 404) throw new YouTubeError('Video not found', 'NOT_FOUND');
    throw new YouTubeError(`YouTube returned ${resp.status}`, 'FETCH_ERROR');
  }

  const html = await resp.text();

  // Check for unavailable video
  if (html.includes('"playabilityStatus":{"status":"ERROR"') ||
      html.includes('"playabilityStatus":{"status":"UNPLAYABLE"')) {
    throw new YouTubeError('Video is private, removed, or region-blocked', 'UNAVAILABLE');
  }

  if (html.includes('"playabilityStatus":{"status":"LOGIN_REQUIRED"')) {
    throw new YouTubeError('Video requires login (age-restricted or private)', 'UNAVAILABLE');
  }

  // Extract player response and caption tracks
  const playerResponse = extractPlayerResponse(html);
  const title = playerResponse?.videoDetails?.title || 'Untitled';
  const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captionTracks || captionTracks.length === 0) {
    log('info', 'youtube_no_captions', { videoId });
    return null;
  }

  // Prefer English, fall back to first available
  let track = captionTracks.find(t => t.languageCode === 'en' || t.languageCode === 'en-US');
  if (!track) track = captionTracks.find(t => t.languageCode?.startsWith('en'));
  if (!track) track = captionTracks[0];

  const language = track.languageCode || 'unknown';
  let baseUrl = track.baseUrl;
  if (!baseUrl) return null;

  // Request JSON3 format for easier parsing
  if (!baseUrl.includes('fmt=')) {
    baseUrl += (baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
  }

  const captionResp = await fetch(baseUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  if (!captionResp.ok) {
    log('warn', 'youtube_caption_fetch_error', { videoId, status: captionResp.status });
    return null;
  }

  const contentType = captionResp.headers.get('content-type') || '';
  const body = await captionResp.text();

  let transcript;
  if (contentType.includes('json') || body.trimStart().startsWith('{')) {
    transcript = parseJson3Captions(body);
  } else {
    transcript = parseXmlCaptions(body);
  }

  if (!transcript || transcript.trim().length === 0) return null;

  return { transcript, title, language };
}

function parseJson3Captions(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return parseXmlCaptions(body);
  }

  const events = data.events;
  if (!events || !Array.isArray(events)) return null;

  const parts = [];
  let lastMarkerTime = -30;

  for (const event of events) {
    const startMs = event.tStartMs || 0;
    const startSec = startMs / 1000;

    // Insert timestamp marker every 30 seconds
    if (startSec - lastMarkerTime >= 30) {
      const mins = Math.floor(startSec / 60);
      const secs = Math.floor(startSec % 60);
      parts.push(`[${mins}:${secs.toString().padStart(2, '0')}] `);
      lastMarkerTime = startSec;
    }

    if (event.segs) {
      for (const seg of event.segs) {
        if (seg.utf8 && seg.utf8.trim() !== '') {
          parts.push(seg.utf8);
        }
      }
    }
  }

  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function parseXmlCaptions(body) {
  const parts = [];
  let lastMarkerTime = -30;

  const regex = /<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const startSec = parseFloat(match[1]);
    let text = match[2];

    // Decode HTML entities
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");

    if (startSec - lastMarkerTime >= 30) {
      const mins = Math.floor(startSec / 60);
      const secs = Math.floor(startSec % 60);
      parts.push(`[${mins}:${secs.toString().padStart(2, '0')}] `);
      lastMarkerTime = startSec;
    }

    parts.push(text + ' ');
  }

  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { extractVideoId, fetchCaptions, YouTubeError };
