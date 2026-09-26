# Cantina DJ

A party DJ web app. The **host** logs in with Spotify and opens a *cantina*
(a party room). **Guests** join via link or QR code — no login needed — and
request tracks, vote, and bribe songs up the queue in real time. The host
keeps a 10x vote and an absolute veto.

**Stack:** Node.js + Express + `ws` WebSockets on the backend, vanilla
HTML/CSS/JS on the frontend. No build step, no frameworks.

## Features

- **Spotify login** (Authorization Code flow; secret stays server-side, refresh handled automatically)
- **Host dashboard** — create a cantina, shareable join link + QR code, live queue management
- **Guest view** — search Spotify (proxied through the host's token), request tracks, vote (one per guest per track, toggleable), attach dedications
- **Live queue** ranked by votes, real-time updates to every client via WebSocket
- **Host controls** — play / pause / skip, 10x host vote, pin-to-top / boost / demote, remove, veto (skip + ban for the night)
- **Bribe the DJ** — guests spend party credits (100 each, simulated) to boost a track; every 10 credits = +1 rank point
- **Dedications** — short messages attached to requests, shown on the now-playing card
- **Auto-DJ** — when the queue runs dry, the server queues a similar track (artist top-tracks of the last played song), labeled `AUTO-DJ`
- **Explicit filter** — host toggle; filters search results and purges explicit tracks from the queue
- **Blacklist** — ban tracks or artists; banned items can't be searched or requested
- **TV mode** (`/tv/:code`) — big-screen view: giant now-playing art, up-next list, join QR + code
- **Party Wrapped** — "End cantina" generates end-of-night stats (most requested, top requester, most vetoed, totals, top dedications)

## Spotify app setup

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in.
2. **Create app** — give it a name like "Cantina DJ", accept the terms.
3. In the app's **Settings**, add a **Redirect URI**. It must match `SPOTIFY_REDIRECT_URI` in your `.env` *exactly*:
   - Local dev: `http://127.0.0.1:3000/callback`
   - Deployed: `https://your-app.up.railway.app/callback` (or your Render URL + `/callback`)
4. Copy the **Client ID** and **Client secret** into your `.env`.

> **Note:** new Spotify apps start in *Development mode*, which restricts login
> to users you add under *User Management* in the dashboard. Add your guests'
> Spotify accounts there — or request an extension/quota increase from Spotify.
> Only the **host** needs a Spotify account (Premium, see below); guests never log in.

## Local run

```bash
cd cantina-dj
cp .env.example .env
# edit .env: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET,
#            SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/callback
#            BASE_URL=http://127.0.0.1:3000
npm install
npm start
```

Open http://127.0.0.1:3000, click **Start your cantina**, log in with Spotify.

**Host requirements:** Spotify **Premium** and the Spotify app open on at least
one device (phone/desktop). The app controls playback on your *active* Spotify
device via the Web API — it does not play audio itself. If controls fail, open
Spotify, play anything once, then retry.

## Deploy

### Railway

1. Push this folder to a GitHub repo.
2. Railway → **New Project** → **Deploy from GitHub repo**.
3. Add variables (Settings → Variables): `SPOTIFY_CLIENT_ID`,
   `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`
   (`https://<your-app>.up.railway.app/callback`), `BASE_URL`
   (`https://<your-app>.up.railway.app`), `SESSION_SECRET` (long random string).
   Railway provides `PORT` automatically.
4. In the Spotify dashboard, add the `https://<your-app>.up.railway.app/callback`
   redirect URI.
5. Deploy. Start command: `npm start`.

### Render

1. Push to GitHub. Render → **New** → **Web Service** → select the repo.
2. Build command: `npm install`. Start command: `npm start`.
3. Add the same environment variables as above (Render provides `PORT`).
4. Add `https://<your-app>.onrender.com/callback` to the Spotify app's redirect URIs.

## Project layout

```
cantina-dj/
├── server.js            # Express + WebSocket server, Spotify OAuth, room engine
├── package.json         # express, ws, dotenv
├── .env.example         # required env vars
├── public/
│   ├── index.html       # landing: start / join
│   ├── host.html        # host dashboard
│   ├── guest.html       # guest view
│   ├── tv.html          # big-screen TV mode
│   ├── css/style.css    # helmet-HUD theme (dark only)
│   ├── js/common.js     # shared helpers (WS client, QR, icons, toast)
│   └── vendor/
│       └── qrcode.min.js# vendored QR encoder (built from the `qrcode` npm
│                          package with esbuild; no runtime dependency)
└── README.md
```

## API / protocol sketch

- `GET /login`, `GET /callback` — Spotify OAuth
- `POST /api/rooms` (host) — create cantina → `{ code, joinUrl }`
- `GET /api/rooms/:code` — public room info
- `GET /api/rooms/:code/search?q=` — Spotify track search via host token
- `GET /api/host/devices` (host) — Spotify devices
- `GET /c/:code` → guest join link · `GET /tv/:code` → TV mode
- `WS /ws?room=CODE&role=host|guest|tv` — JSON messages (`hello`, `request`,
  `vote`, `bribe`, `host_vote`, `play`, `pause`, `skip`, `veto`, `remove`,
  `move`, `set_explicit_filter`, `set_autodj`, `blacklist_add/remove`, `end`);
  server pushes `{ t: 'state', state }` snapshots and `{ t: 'error', message }`.

## Honest limitations

- **In-memory rooms.** Restarting the server wipes rooms, sessions, and guest
  credits. For production, swap the `sessions`/`rooms` Maps in `server.js`
  for Redis (every access is already funneled through small helpers).
- **Host needs Spotify Premium** and an active device; the Web API refuses
  playback control otherwise (the UI surfaces this).
- **No audio in the browser.** Playback happens on the host's Spotify device;
  this app is a remote control + voting layer.
- **One data center.** Real-time sync is per-server-instance; sticky sessions
  or an external pub/sub are needed for multi-instance deploys.
- **Spotify Development mode** restricts which Spotify accounts can log in
  until you add them in the dashboard or get a quota extension.
- Spotify scopes requested: `streaming user-read-email user-read-private
  user-read-playback-state user-modify-playback-state user-read-currently-playing
  playlist-read-private`.

## Dev test hook

Setting `CANTINA_TEST_HOOK=1` exposes `{ sessions, rooms, createRoom,
signSessionCookie }` on `globalThis.__cantinaTest` so integration tests can
seed state without OAuth. **Never enable in production.**
