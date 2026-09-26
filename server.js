/**
 * Cantina DJ — server
 * -------------------
 * Party DJ rooms ("cantinas") where a host logs in with Spotify and guests
 * join via link/QR to request and vote on tracks in real time.
 *
 * Stack: Node.js + Express + ws. No build step.
 * Room state is in-memory (a Map). For production, swap the `rooms` Map
 * (and `sessions` Map) for Redis — every access goes through small helpers
 * so the swap is mechanical.
 *
 * Spotify integration uses the Authorization Code flow; the client secret
 * never leaves this server. All Spotify Web API calls are proxied here.
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || '';
const BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';

const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
].join(' ');

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API = 'https://api.spotify.com';

const STARTING_CREDITS = 100;      // party credits each guest starts with
const BRIBE_PRESETS = [10, 25, 50];// allowed bribe amounts (credits)
const DEDICATION_MAX = 140;        // max chars for a dedication message
const POLL_MS = 5000;              // playback poll interval per room
const FETCH_TIMEOUT_MS = 15000;    // hard timeout for Spotify HTTP calls

// ---------------------------------------------------------------------------
// In-memory stores (swap for Redis in production)
// ---------------------------------------------------------------------------

/** sessionId -> { accessToken, refreshToken, expiresAt, displayName, spotifyId } */
const sessions = new Map();
/** state token -> timestamp (OAuth CSRF protection, 10 min TTL) */
const oauthStates = new Map();
/** roomCode -> room object (see createRoom) */
const rooms = new Map();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function signSessionId(id) {
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(id).digest('hex').slice(0, 32);
  return `${id}.${sig}`;
}

function verifySessionCookie(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const i = raw.lastIndexOf('.');
  if (i < 0) return null;
  const id = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(id).digest('hex').slice(0, 32);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return sessions.has(id) ? id : null;
}

function getSessionId(req) {
  return verifySessionCookie(parseCookies(req).cantina_session);
}

function newRoomCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code;
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

/** Effective ranking score of a queue item. Host boost lets the host pin tracks. */
function itemScore(item) {
  return item.votes + item.bribeCredits / 10 + (item.hostBoost || 0);
}

function sortedQueue(room) {
  return [...room.queue].sort((a, b) => {
    const d = itemScore(b) - itemScore(a);
    if (d !== 0) return d;
    return a.addedAt - b.addedAt;
  });
}

function escReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Spotify API helpers (server-side only; secret never leaves here)
// ---------------------------------------------------------------------------

/**
 * fetch() with a hard timeout, so a hanging Spotify endpoint can never
 * stall a request/WS handler forever. Throws on timeout (AbortError).
 */
function sfetch(url, opts) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

async function refreshAccessToken(sess) {
  const res = await sfetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: sess.refreshToken }),
  });
  if (!res.ok) throw new Error(`Spotify token refresh failed (HTTP ${res.status})`);
  const data = await res.json();
  sess.accessToken = data.access_token;
  sess.expiresAt = Date.now() + data.expires_in * 1000;
  if (data.refresh_token) sess.refreshToken = data.refresh_token; // rotation
}

/**
 * Call the Spotify Web API with automatic token refresh.
 * Returns the raw Response. Callers must handle 204 (no content) themselves.
 */
async function spotify(sess, method, apiPath, body) {
  if (Date.now() > sess.expiresAt - 60_000) await refreshAccessToken(sess);
  const run = () =>
    sfetch(SPOTIFY_API + apiPath, {
      method,
      headers: { Authorization: `Bearer ${sess.accessToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let res = await run();
  if (res.status === 401) {
    await refreshAccessToken(sess); // one retry after refresh
    res = await run();
  }
  return res;
}

async function spotifyJson(sess, method, apiPath, body) {
  const res = await spotify(sess, method, apiPath, body);
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Spotify API ${method} ${apiPath} -> HTTP ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return res.json();
}

/** Normalize a Spotify track object to the slim shape we store/broadcast. */
function mapTrack(t) {
  const images = (t.album && t.album.images) || [];
  const art = images.find((i) => i.width >= 300) || images[0] || null;
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artists: (t.artists || []).map((a) => ({ id: a.id, name: a.name })),
    artistNames: (t.artists || []).map((a) => a.name).join(', '),
    album: (t.album && t.album.name) || '',
    art: art ? art.url : '',
    explicit: !!t.explicit,
    durationMs: t.duration_ms || 0,
  };
}

function premiumErrorMessage(err) {
  if (err && (err.status === 403 || err.status === 404)) {
    return 'Spotify needs Premium and an active device: open Spotify on your phone/computer and start playing anything once, then try again.';
  }
  return 'Spotify request failed. Please try again.';
}

// ---------------------------------------------------------------------------
// Room model
// ---------------------------------------------------------------------------

function createRoom(hostSessionId, hostName, name) {
  const code = newRoomCode();
  const room = {
    code,
    name: String(name || 'Untitled Cantina').slice(0, 60),
    hostSessionId,
    hostName,
    createdAt: Date.now(),
    ended: false,
    endedAt: null,
    queue: [],          // queue items (see below)
    played: [],         // finished items, oldest -> newest
    nowPlaying: null,   // { track, requestedBy, guestId, dedications, autoDj, startedAt, progressMs, isPlaying, external? }
    wantPlayback: false,
    guests: new Map(),  // guestId -> { id, name, credits, joinedAt }
    blacklistTracks: new Map(),  // spotifyTrackId -> label
    blacklistArtists: new Map(), // spotifyArtistId -> label
    vetoedTracks: new Map(),     // spotifyTrackId -> { label, count }
    explicitFilter: false,
    autoDj: true,
    clients: new Set(), // { ws, role, guestId }
    stats: {
      requests: 0,
      votes: 0,
      bribeCredits: 0,
      vetoes: 0,
      skips: 0,
      requestsByTrack: new Map(), // trackId -> { count, label }
      requestsByGuest: new Map(), // name -> count
      vetoesByTrack: new Map(),   // trackId -> { count, label }
      dedications: [],            // { track, message, from }
    },
    wrapped: null,
  };
  rooms.set(code, room);
  return room;
}

function makeQueueItem(track, { requestedBy, guestId, dedication, autoDj }) {
  const item = {
    qid: newId('q'),
    track,
    requestedBy,
    guestId: guestId || null,
    addedAt: Date.now(),
    votes: 0,
    voters: [],
    hostVoted: false,
    hostBoost: 0,
    bribeCredits: 0,
    dedications: [],
    autoDj: !!autoDj,
  };
  if (dedication) item.dedications.push(dedication);
  return item;
}

function sanitizeItem(item) {
  return {
    qid: item.qid,
    track: item.track,
    requestedBy: item.requestedBy,
    addedAt: item.addedAt,
    votes: item.votes,
    hostVoted: item.hostVoted,
    bribeCredits: item.bribeCredits,
    score: Math.round(itemScore(item) * 10) / 10,
    dedications: item.dedications,
    autoDj: item.autoDj,
    voterCount: item.voters.length,
  };
}

/** Full room snapshot sent to clients. Guests get a trimmed view. */
function stateFor(room, role, guestId) {
  const base = {
    code: room.code,
    name: room.name,
    ended: room.ended,
    explicitFilter: room.explicitFilter,
    autoDj: room.autoDj,
    joinUrl: `${BASE_URL}/c/${room.code}`,
    nowPlaying: room.nowPlaying
      ? {
          track: room.nowPlaying.track,
          requestedBy: room.nowPlaying.requestedBy,
          dedications: room.nowPlaying.dedications,
          autoDj: !!room.nowPlaying.autoDj,
          external: !!room.nowPlaying.external,
          progressMs: room.nowPlaying.progressMs || 0,
          isPlaying: !!room.nowPlaying.isPlaying,
        }
      : null,
    queue: sortedQueue(room).map(sanitizeItem),
    guestCount: room.guests.size,
    wrapped: room.wrapped,
  };
  if (role === 'guest') {
    const me = guestId ? room.guests.get(guestId) : null;
    base.you = me ? { guestId: me.id, name: me.name, credits: me.credits } : null;
    base.guests = [...room.guests.values()]
      .map((g) => ({ name: g.name, credits: g.credits }))
      .sort((a, b) => b.credits - a.credits);
    base.votedQids = guestId
      ? room.queue.filter((i) => i.voters.includes(guestId)).map((i) => i.qid)
      : [];
  }
  if (role === 'host') {
    base.guests = [...room.guests.values()].map((g) => ({
      guestId: g.id, name: g.name, credits: g.credits,
    }));
    base.blacklist = {
      tracks: [...room.blacklistTracks.entries()].map(([id, label]) => ({ id, label })),
      artists: [...room.blacklistArtists.entries()].map(([id, label]) => ({ id, label })),
    };
    base.vetoed = [...room.vetoedTracks.entries()].map(([id, v]) => ({ id, ...v }));
    base.stats = {
      requests: room.stats.requests,
      votes: room.stats.votes,
      bribeCredits: room.stats.bribeCredits,
      vetoes: room.stats.vetoes,
      skips: room.stats.skips,
      played: room.played.length,
    };
  }
  return base;
}

function broadcast(room) {
  for (const client of room.clients) {
    if (client.ws.readyState !== 1) continue; // 1 = OPEN
    try {
      client.ws.send(JSON.stringify({
        t: 'state',
        state: stateFor(room, client.role, client.guestId),
      }));
    } catch {
      /* ignore broken sockets; cleanup happens on close */
    }
  }
}

function sendError(ws, message) {
  try {
    ws.send(JSON.stringify({ t: 'error', message }));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Playback engine
// ---------------------------------------------------------------------------

function hostSessionOf(room) {
  return sessions.get(room.hostSessionId) || null;
}

async function playUri(sess, uri) {
  try {
    // With no URI, Spotify resumes the current context. With a URI, it starts that track.
    const res = await spotify(sess, 'PUT', '/v1/me/player/play', uri ? { uris: [uri] } : {});
    // 204 = started/resumed. 403/404 = no Premium or no active device.
    if (res.status !== 204 && !res.ok) {
      const e = new Error('play failed');
      e.status = res.status;
      throw e;
    }
  } catch (err) {
    throw new Error(premiumErrorMessage(err));
  }
}

async function pauseSpotify(sess) {
  const res = await spotify(sess, 'PUT', '/v1/me/player/pause');
  if (!res.ok && res.status !== 204) {
    const e = new Error('pause failed'); e.status = res.status; throw e;
  }
}

/** Move nowPlaying to history and start the top-ranked queued track. */
async function advanceQueue(room, reason) {
  const sess = hostSessionOf(room);
  if (room.nowPlaying && !room.nowPlaying.external) {
    const done = room.nowPlaying;
    room.played.push({
      track: done.track, requestedBy: done.requestedBy,
      dedications: done.dedications, autoDj: done.autoDj, playedAt: Date.now(),
    });
    if (reason === 'skip') room.stats.skips += 1;
  }
  room.nowPlaying = null;

  const next = sortedQueue(room)[0];
  if (!next) {
    room.wantPlayback = false;
    if (room.autoDj && !room.ended) await autoDjFill(room, true).catch((e) => console.error('[autodj]', e.message));
    broadcast(room);
    return;
  }
  room.queue = room.queue.filter((i) => i.qid !== next.qid);

  if (!sess) throw new Error('Host Spotify session missing. Host must log in again.');
  await playUri(sess, next.track.uri);
  room.nowPlaying = {
    track: next.track,
    requestedBy: next.requestedBy,
    guestId: next.guestId,
    dedications: next.dedications,
    autoDj: next.autoDj,
    startedAt: Date.now(),
    progressMs: 0,
    isPlaying: true,
  };
  room.wantPlayback = true;
  broadcast(room);
}

/**
 * Auto-DJ: when the queue runs dry, queue (and optionally play) a track
 * similar to what just played, using the last track's artist top-tracks.
 * The item is flagged autoDj so the UI can label it "AUTO-DJ".
 */
async function autoDjFill(room, autoplay) {
  if (!room.autoDj || room.ended) return;
  const sess = hostSessionOf(room);
  if (!sess) return;

  const recent = [...room.played].reverse().find((p) => !p.autoDj) || [...room.played].reverse()[0];
  const seedArtist = recent && recent.track.artists[0];
  if (!seedArtist || !seedArtist.id) return;

  const data = await spotifyJson(sess, 'GET', `/v1/artists/${seedArtist.id}/top-tracks?market=US`);
  const candidates = (data.tracks || [])
    .map(mapTrack)
    .filter((t) => !room.blacklistTracks.has(t.id))
    .filter((t) => !t.artists.some((a) => room.blacklistArtists.has(a.id)))
    .filter((t) => !(room.explicitFilter && t.explicit))
    .filter((t) => !room.played.slice(-20).some((p) => p.track.id === t.id))
    .filter((t) => !room.queue.some((i) => i.track.id === t.id));
  if (!candidates.length) return;

  const pick = candidates[Math.floor(Math.random() * Math.min(3, candidates.length))];
  const item = makeQueueItem(pick, { requestedBy: 'AUTO-DJ', guestId: null, autoDj: true });
  room.queue.push(item);
  room.stats.requests += 1;

  if (autoplay) {
    room.queue = room.queue.filter((i) => i.qid !== item.qid);
    await playUri(sess, pick.uri);
    room.nowPlaying = {
      track: pick, requestedBy: 'AUTO-DJ', guestId: null, dedications: [],
      autoDj: true, startedAt: Date.now(), progressMs: 0, isPlaying: true,
    };
    room.wantPlayback = true;
  }
  broadcast(room);
}

/**
 * Poll the host's Spotify playback state and keep the room in sync:
 * - track finished  -> advance the queue
 * - nothing playing -> start next queued track (if playback wanted)
 * - foreign track   -> show it as "external", don't fight the host
 */
async function syncPlayback(room) {
  if (room.ended) return;
  const sess = hostSessionOf(room);
  if (!sess) return;

  let data = null;
  try {
    const res = await spotify(sess, 'GET', '/v1/me/player/currently-playing?market=US');
    if (res.status === 200) data = await res.json();
    // 204 / empty = nothing playing
  } catch (err) {
    console.error('[poll]', room.code, err.message);
    return;
  }

  const item = data && data.item ? data.item : null;
  const np = room.nowPlaying;

  if (np && !np.external && item && item.uri === np.track.uri) {
    np.progressMs = data.progress_ms || 0;
    np.isPlaying = !!data.is_playing;
    const nearEnd = np.progressMs >= (item.duration_ms || 0) - 2500;
    if (nearEnd && np.isPlaying) {
      await advanceQueue(room, 'track-ended').catch((e) => console.error('[advance]', e.message));
    } else {
      broadcast(room);
    }
    return;
  }

  if (np && !np.external && (!item || item.uri !== np.track.uri)) {
    if (!item) {
      if (room.wantPlayback) {
        await advanceQueue(room, 'stopped').catch((e) => console.error('[advance]', e.message));
      } else {
        room.nowPlaying = null;
        broadcast(room);
      }
      return;
    }
    // Host (or someone) is playing something else — display it, don't hijack.
    room.nowPlaying = {
      track: mapTrack(item), requestedBy: 'Someone else', guestId: null,
      dedications: [], autoDj: false, external: true,
      startedAt: Date.now(), progressMs: data.progress_ms || 0, isPlaying: !!data.is_playing,
    };
    broadcast(room);
    return;
  }

  if (!np && room.wantPlayback && !room.ended) {
    if (room.queue.length) {
      await advanceQueue(room, 'resume').catch((e) => console.error('[advance]', e.message));
    } else if (room.autoDj) {
      await autoDjFill(room, true).catch((e) => console.error('[autodj]', e.message));
    }
  }
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.ended || room.clients.size === 0) continue;
    syncPlayback(room).catch((e) => console.error('[poll]', e.message));
  }
}, POLL_MS);

// ---------------------------------------------------------------------------
// Party Wrapped (end-of-night stats)
// ---------------------------------------------------------------------------

function computeWrapped(room) {
  const s = room.stats;
  const maxEntry = (map) => {
    let best = null;
    for (const [key, v] of map) {
      const count = typeof v === 'number' ? v : v.count;
      if (!best || count > best.count) best = { key, count, label: typeof v === 'object' ? v.label : key };
    }
    return best;
  };
  return {
    roomName: room.name,
    endedAt: Date.now(),
    totalTracksPlayed: room.played.length,
    totalRequests: s.requests,
    totalVotes: s.votes,
    totalBribeCredits: s.bribeCredits,
    totalVetoes: s.vetoes,
    mostRequested: maxEntry(s.requestsByTrack),
    topRequester: maxEntry(s.requestsByGuest),
    mostVetoed: maxEntry(s.vetoesByTrack),
    topDedications: s.dedications.slice(-5).reverse(),
    guestCount: room.guests.size,
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Spotify OAuth ---

app.get('/login', (req, res) => {
  if (!CLIENT_ID || !REDIRECT_URI) {
    return res.status(500).send('Server misconfigured: SPOTIFY_CLIENT_ID / SPOTIFY_REDIRECT_URI missing. See .env.example.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now());
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SPOTIFY_SCOPES,
    state,
    show_dialog: 'false',
  });
  res.redirect(`${SPOTIFY_AUTH_URL}?${params}`);
});

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Spotify login failed: ${error}`);
  const ts = oauthStates.get(state);
  oauthStates.delete(state);
  if (!ts || Date.now() - ts > 10 * 60 * 1000) {
    return res.status(400).send('Login expired or invalid. Please <a href="/login">try again</a>.');
  }
  try {
    const tokenRes = await sfetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed (HTTP ${tokenRes.status})`);
    const tok = await tokenRes.json();

    const meRes = await sfetch(`${SPOTIFY_API}/v1/me`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!meRes.ok) throw new Error('could not fetch Spotify profile');
    const me = await meRes.json();

    const sessionId = crypto.randomBytes(24).toString('hex');
    sessions.set(sessionId, {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + tok.expires_in * 1000,
      displayName: me.display_name || 'DJ',
      spotifyId: me.id,
    });
    res.setHeader(
      'Set-Cookie',
      `cantina_session=${signSessionCookie(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`
    );
    res.redirect('/host.html');
  } catch (err) {
    console.error('[oauth]', err.message);
    res.status(500).send('Spotify login failed. Please <a href="/login">try again</a>.');
  }
});

function signSessionCookie(id) {
  return signSessionId(id);
}

app.get('/logout', (req, res) => {
  const sid = getSessionId(req);
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', 'cantina_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.redirect('/');
});

// --- JSON API ---

function requireSession(req, res, next) {
  const sid = getSessionId(req);
  const sess = sid && sessions.get(sid);
  if (!sess) return res.status(401).json({ error: 'not-logged-in' });
  req.sessionId = sid;
  req.sess = sess;
  next();
}

app.get('/api/me', (req, res) => {
  const sid = getSessionId(req);
  const sess = sid && sessions.get(sid);
  if (!sess) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, displayName: sess.displayName });
});

app.post('/api/rooms', requireSession, (req, res) => {
  const room = createRoom(req.sessionId, req.sess.displayName, req.body && req.body.name);
  res.json({ code: room.code, joinUrl: `${BASE_URL}/c/${room.code}` });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'room-not-found' });
  res.json({
    exists: true,
    name: room.name,
    ended: room.ended,
    joinUrl: `${BASE_URL}/c/${room.code}`,
  });
});

/** Track search proxied through the host's Spotify token. */
app.get('/api/rooms/:code/search', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'room-not-found' });
  if (room.ended) return res.status(410).json({ error: 'room-ended' });
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ tracks: [] });
  const sess = hostSessionOf(room);
  if (!sess) return res.status(503).json({ error: 'host-offline' });
  try {
    const data = await spotifyJson(
      sess, 'GET',
      `/v1/search?${new URLSearchParams({ q, type: 'track', market: 'US', limit: '20' })}`
    );
    const tracks = ((data.tracks && data.tracks.items) || [])
      .map(mapTrack)
      .filter((t) => !room.blacklistTracks.has(t.id))
      .filter((t) => !t.artists.some((a) => room.blacklistArtists.has(a.id)))
      .filter((t) => !(room.explicitFilter && t.explicit));
    res.json({ tracks });
  } catch (err) {
    console.error('[search]', err.message);
    res.status(502).json({ error: 'spotify-search-failed' });
  }
});

/** Host's Spotify devices (so they can pick/verify an active device). */
app.get('/api/host/devices', requireSession, async (req, res) => {
  try {
    const data = await spotifyJson(req.sess, 'GET', '/v1/me/player/devices');
    res.json({ devices: data.devices || [] });
  } catch (err) {
    res.status(502).json({ error: 'spotify-devices-failed' });
  }
});

// --- Page routes ---

app.get('/c/:code', (req, res) => {
  res.redirect(`/guest.html?code=${encodeURIComponent(req.params.code.toUpperCase())}`);
});

app.get('/tv/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tv.html'));
});

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const code = (url.searchParams.get('room') || '').toUpperCase();
  const role = url.searchParams.get('role') || 'guest';
  const room = rooms.get(code);

  if (!room) {
    sendError(ws, 'Cantina not found. Check the code and try again.');
    ws.close();
    return;
  }

  const client = { ws, role: role === 'host' ? 'host' : role === 'tv' ? 'tv' : 'guest', guestId: null };
  room.clients.add(client);

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return sendError(ws, 'Bad message.');
    }
    try {
      await handleMessage(room, client, msg, req);
    } catch (err) {
      console.error('[ws]', err.message);
      sendError(ws, err.userMessage || 'Something went wrong.');
    }
  });

  ws.on('close', () => room.clients.delete(client));

  // Push current state immediately so the client renders without waiting.
  try {
    ws.send(JSON.stringify({ t: 'state', state: stateFor(room, client.role, client.guestId) }));
  } catch { /* ignore */ }
});

function fail(message) {
  const e = new Error(message);
  e.userMessage = message;
  throw e;
}

function assertHost(room, client, req) {
  const sid = getSessionId(req);
  if (client.role !== 'host' || !sid || sid !== room.hostSessionId || !sessions.has(sid)) {
    fail('Host only. Your session may have expired — log in again.');
  }
}

function getGuest(room, client, msg) {
  const guestId = msg.guestId || client.guestId;
  if (!guestId) fail('Guest identity missing. Reload and rejoin.');
  const guest = room.guests.get(guestId);
  if (!guest) fail('Guest not registered. Rejoin the cantina.');
  client.guestId = guestId;
  return guest;
}

function cleanDedication(text) {
  if (!text) return null;
  const t = String(text).trim().slice(0, DEDICATION_MAX);
  return t ? t : null;
}

function trackBlocked(room, track) {
  if (room.blacklistTracks.has(track.id)) return 'That track is banned in this cantina.';
  if (track.artists.some((a) => room.blacklistArtists.has(a.id))) return 'That artist is banned in this cantina.';
  if (room.explicitFilter && track.explicit) return 'Explicit tracks are filtered in this cantina.';
  return null;
}

function recordRequestStats(room, track, requesterName) {
  room.stats.requests += 1;
  const byTrack = room.stats.requestsByTrack.get(track.id) || { count: 0, label: `${track.name} — ${track.artistNames}` };
  byTrack.count += 1;
  room.stats.requestsByTrack.set(track.id, byTrack);
  room.stats.requestsByGuest.set(requesterName, (room.stats.requestsByGuest.get(requesterName) || 0) + 1);
}

async function handleMessage(room, client, msg, req) {
  if (room.ended && msg.t !== 'hello') fail('This cantina has ended. Thanks for partying!');

  switch (msg.t) {
    // --------------------------------------------------------------- hello
    case 'hello': {
      if (client.role === 'host') {
        assertHost(room, client, req);
        broadcast(room);
        return;
      }
      if (client.role === 'tv') return; // read-only, state already pushed
      // guest
      const guestId = String(msg.guestId || '').slice(0, 64);
      const name = String(msg.name || 'Guest').trim().slice(0, 24) || 'Guest';
      if (!guestId) fail('Guest identity missing.');
      client.guestId = guestId;
      if (!room.guests.has(guestId)) {
        room.guests.set(guestId, { id: guestId, name, credits: STARTING_CREDITS, joinedAt: Date.now() });
      } else {
        room.guests.get(guestId).name = name;
      }
      broadcast(room);
      return;
    }

    // ------------------------------------------------- guest: request track
    case 'request': {
      // The host may also queue tracks from the host deck (no guest record).
      let guest;
      if (client.role === 'host') {
        assertHost(room, client, req);
        guest = { id: 'host', name: `${room.hostName} (host)` };
      } else {
        guest = getGuest(room, client, msg);
      }
      const track = msg.track;
      if (!track || !track.id || !track.uri) fail('Pick a track from search first.');
      const blocked = trackBlocked(room, track);
      if (blocked) fail(blocked);
      const dedicationText = cleanDedication(msg.dedication);
      const dedication = dedicationText ? { from: guest.name, message: dedicationText } : null;

      // If already queued, convert into a vote (+ attach dedication).
      const existing = room.queue.find((i) => i.track.id === track.id);
      if (existing) {
        if (!existing.voters.includes(guest.id)) {
          existing.voters.push(guest.id);
          existing.votes += 1;
          room.stats.votes += 1;
        }
        if (dedication) {
          existing.dedications.push(dedication);
          room.stats.dedications.push({ track: `${track.name} — ${track.artistNames}`, ...dedication });
        }
        broadcast(room);
        return;
      }
      const item = makeQueueItem(track, { requestedBy: guest.name, guestId: guest.id, dedication, autoDj: false });
      room.queue.push(item);
      recordRequestStats(room, track, guest.name);
      if (dedication) room.stats.dedications.push({ track: `${track.name} — ${track.artistNames}`, ...dedication });
      broadcast(room);
      return;
    }

    // ----------------------------------------------------- guest: vote
    case 'vote': {
      const guest = getGuest(room, client, msg);
      const item = room.queue.find((i) => i.qid === msg.qid);
      if (!item) fail('That track is no longer in the queue.');
      const idx = item.voters.indexOf(guest.id);
      if (idx >= 0) {
        item.voters.splice(idx, 1); // toggle off
        item.votes -= 1;
        room.stats.votes -= 1;
      } else {
        item.voters.push(guest.id);
        item.votes += 1;
        room.stats.votes += 1;
      }
      broadcast(room);
      return;
    }

    // ------------------------------------------------- guest/host: bribe
    case 'bribe': {
      const guest = getGuest(room, client, msg);
      const amount = Number(msg.amount);
      if (!BRIBE_PRESETS.includes(amount)) fail('Invalid bribe amount.');
      if (guest.credits < amount) fail('Not enough party credits.');
      const item = room.queue.find((i) => i.qid === msg.qid);
      if (!item) fail('That track is no longer in the queue.');
      guest.credits -= amount;
      item.bribeCredits += amount;
      room.stats.bribeCredits += amount;
      broadcast(room);
      return;
    }

    // ------------------------------------------------------- host: vote
    case 'host_vote': {
      assertHost(room, client, req);
      const item = room.queue.find((i) => i.qid === msg.qid);
      if (!item) fail('That track is no longer in the queue.');
      if (item.hostVoted) {
        item.hostVoted = false;
        item.votes -= 10;
        room.stats.votes -= 10;
      } else {
        item.hostVoted = true;
        item.votes += 10; // host vote counts 10x
        room.stats.votes += 10;
      }
      broadcast(room);
      return;
    }

    // -------------------------------------------------- host: playback
    case 'play': {
      assertHost(room, client, req);
      const sess = hostSessionOf(room);
      if (!sess) fail('Spotify session missing. Log in again.');
      if (msg.qid) {
        const item = room.queue.find((i) => i.qid === msg.qid);
        if (!item) fail('That track is no longer in the queue.');
        room.queue = room.queue.filter((i) => i.qid !== item.qid);
        if (room.nowPlaying && !room.nowPlaying.external) {
          room.played.push({
            track: room.nowPlaying.track, requestedBy: room.nowPlaying.requestedBy,
            dedications: room.nowPlaying.dedications, autoDj: room.nowPlaying.autoDj, playedAt: Date.now(),
          });
        }
        await playUri(sess, item.track.uri);
        room.nowPlaying = {
          track: item.track, requestedBy: item.requestedBy, guestId: item.guestId,
          dedications: item.dedications, autoDj: item.autoDj,
          startedAt: Date.now(), progressMs: 0, isPlaying: true,
        };
        room.wantPlayback = true;
      } else {
        await playUri(sess, null); // resume
        room.wantPlayback = true;
        if (room.nowPlaying) room.nowPlaying.isPlaying = true;
      }
      broadcast(room);
      return;
    }

    case 'pause': {
      assertHost(room, client, req);
      const sess = hostSessionOf(room);
      if (!sess) fail('Spotify session missing. Log in again.');
      await pauseSpotify(sess);
      if (room.nowPlaying) room.nowPlaying.isPlaying = false;
      broadcast(room);
      return;
    }

    case 'skip': {
      assertHost(room, client, req);
      await advanceQueue(room, 'skip');
      return;
    }

    case 'veto': {
      assertHost(room, client, req);
      const ban = msg.ban !== false; // default: ban the track for the night
      const banTrack = (track) => {
        if (!ban) return;
        const label = `${track.name} — ${track.artistNames}`;
        room.blacklistTracks.set(track.id, label);
        const v = room.vetoedTracks.get(track.id) || { label, count: 0 };
        v.count += 1;
        room.vetoedTracks.set(track.id, v);
        const vb = room.stats.vetoesByTrack.get(track.id) || { count: 0, label };
        vb.count += 1;
        room.stats.vetoesByTrack.set(track.id, vb);
      };
      if (msg.qid === 'now') {
        // Veto whatever is currently playing.
        if (!room.nowPlaying || room.nowPlaying.external) fail('Nothing of ours is playing.');
        banTrack(room.nowPlaying.track);
        room.stats.vetoes += 1;
        await advanceQueue(room, 'veto');
        return;
      }
      const idx = room.queue.findIndex((i) => i.qid === msg.qid);
      if (idx === -1) fail('That track is no longer in the queue.');
      const [item] = room.queue.splice(idx, 1);
      banTrack(item.track);
      room.stats.vetoes += 1;
      broadcast(room);
      return;
    }

    case 'remove': {
      assertHost(room, client, req);
      room.queue = room.queue.filter((i) => i.qid !== msg.qid);
      broadcast(room);
      return;
    }

    case 'move': {
      assertHost(room, client, req);
      const item = room.queue.find((i) => i.qid === msg.qid);
      if (!item) fail('That track is no longer in the queue.');
      if (msg.to === 'top') {
        const max = Math.max(0, ...room.queue.map((i) => i.hostBoost || 0));
        item.hostBoost = max + 10;
      } else if (msg.dir === 'up') {
        item.hostBoost = (item.hostBoost || 0) + 5;
      } else if (msg.dir === 'down') {
        item.hostBoost = (item.hostBoost || 0) - 5;
      }
      broadcast(room);
      return;
    }

    // -------------------------------------------------- host: settings
    case 'set_explicit_filter': {
      assertHost(room, client, req);
      room.explicitFilter = !!msg.on;
      if (room.explicitFilter) {
        // Drop explicit tracks already queued.
        room.queue = room.queue.filter((i) => !i.track.explicit);
      }
      broadcast(room);
      return;
    }

    case 'set_autodj': {
      assertHost(room, client, req);
      room.autoDj = !!msg.on;
      broadcast(room);
      return;
    }

    case 'blacklist_add': {
      assertHost(room, client, req);
      const id = String(msg.id || '');
      const label = String(msg.label || id).slice(0, 80);
      if (!id) fail('Missing id.');
      if (msg.kind === 'artist') room.blacklistArtists.set(id, label);
      else room.blacklistTracks.set(id, label);
      // Purge matching queued items.
      room.queue = room.queue.filter((i) =>
        msg.kind === 'artist'
          ? !i.track.artists.some((a) => a.id === id)
          : i.track.id !== id
      );
      broadcast(room);
      return;
    }

    case 'blacklist_remove': {
      assertHost(room, client, req);
      if (msg.kind === 'artist') room.blacklistArtists.delete(String(msg.id));
      else room.blacklistTracks.delete(String(msg.id));
      broadcast(room);
      return;
    }

    // ------------------------------------------------------- host: end
    case 'end': {
      assertHost(room, client, req);
      room.wrapped = computeWrapped(room);
      room.ended = true;
      room.endedAt = Date.now();
      room.wantPlayback = false;
      broadcast(room); // end the party immediately in the UI…
      // …then best-effort pause on Spotify without blocking the response.
      const sess = hostSessionOf(room);
      if (sess) pauseSpotify(sess).catch(() => {});
      return;
    }

    default:
      fail('Unknown command.');
  }
}

// ---------------------------------------------------------------------------
// Dev/test hook (NOT for production)
// ---------------------------------------------------------------------------
// When CANTINA_TEST_HOOK=1, internals are exposed on globalThis so automated
// tests can create sessions/rooms without a real Spotify OAuth dance.
// Never enable this in production.
if (process.env.CANTINA_TEST_HOOK === '1') {
  globalThis.__cantinaTest = { sessions, rooms, createRoom, signSessionCookie };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Prune stale OAuth states every few minutes.
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of oauthStates) {
    if (now - ts > 10 * 60 * 1000) oauthStates.delete(k);
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`Cantina DJ listening on port ${PORT}`);
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    console.warn('[warn] SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_REDIRECT_URI are not set.');
    console.warn('[warn] Spotify login will not work until you configure .env (see .env.example).');
  }
  console.log(`[info] Base URL for join links: ${BASE_URL}`);
});
