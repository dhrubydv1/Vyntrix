# Vyntrix

Vyntrix turns a phone, tablet, laptop, or desktop browser into a practical
home-security camera. Sign in on one device as the **Camera Console** and use
another signed-in device as the **Web Monitor**.

Vyntrix V1 is a browser application. It does not record or store video. New
motion events are metadata-only records containing an event ID, owner, camera
name, and timestamp.

## V1 features

- Account-based camera discovery with per-user isolation
- Live peer-to-peer video and audio using WebRTC
- Front/back camera selection locally and from the monitor
- Motion detection with cooldown/reset grouping to reduce repeated alerts
- Metadata-only motion history with deletion
- Compatibility with historical alerts that already have snapshot files
- Fullscreen monitoring, digital zoom, night-vision filter, and mirror controls
- Manual monitor rotation through 0°, 90°, 180°, and 270°
- Remote siren and hold-to-talk audio
- Responsive camera and monitor layouts for phones, tablets, and desktops
- PostgreSQL-backed users, alert metadata, and login sessions

There is no default account. Register your own account after setup and use the
same account on the camera and monitor devices.

## Architecture

```text
Vercel static frontend
        │ HTTPS + authenticated Socket.IO signaling
        ▼
Render Node.js backend ─────► Neon PostgreSQL
  Express + Socket.IO          users, alert metadata, sessions
        │
        └──── WebRTC negotiation ────► peer-to-peer media between browsers
```

The backend authenticates requests, tracks currently connected cameras,
relays signaling/control messages, and stores metadata. Camera video is sent
through WebRTC and is not persisted by Vyntrix. STUN assists peer discovery;
TURN can relay media when direct peer-to-peer connectivity fails.

The active-camera registry is held in the Render process. Run one backend
instance for V1; multiple instances would require a shared Socket.IO adapter
and shared camera-presence registry.

## Requirements

- Node.js 18 or newer; Node.js 20 LTS is recommended for local development
- npm
- A Neon PostgreSQL database
- A current browser supporting WebRTC, `getUserMedia`, and secure cookies
- HTTPS in production; camera/microphone access also works on `localhost`
- Two physical devices for realistic end-to-end testing

## Local setup

1. Install dependencies and create local configuration:

   ```bash
   npm install
   cp .env.example .env.local
   ```

2. Create the PostgreSQL tables described in [Neon PostgreSQL setup](#neon-postgresql-setup).
3. Set `DATABASE_URL` and a local `SESSION_SECRET` in `.env.local`.
4. Keep the default local port `3050`, then validate and start:

   ```bash
   npm run doctor
   npm start
   ```

5. Open [http://localhost:3050](http://localhost:3050), register, and sign in.

The browser configuration expects `http://localhost:3050` during local use.
Changing `PORT` also requires updating the local backend URL in
`public/js/frontend-config.js`.

Optional guided setup scripts are available:

```bash
# macOS/Linux
bash scripts/setup.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

`VYNTRIX_DATABASE_MODE=json` exists only as a local test/legacy compatibility
mode. Production always requires PostgreSQL and will not fall back to JSON.

## Neon PostgreSQL setup

Create a Neon project and use the Neon SQL Editor to run the following schema.
The Render application may use a pooled Neon connection string. Use a direct
connection for manual migrations, dumps, and other session-level admin work.

```sql
CREATE TABLE IF NOT EXISTS public.users (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.alerts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  camera_name text NOT NULL,
  captured_at timestamptz NOT NULL,
  image_file text,
  image_path text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alerts_user_id
  ON public.alerts (user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_user_captured_at
  ON public.alerts (user_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS public.user_sessions (
  sid varchar PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expire
  ON public.user_sessions (expire);
```

Older Vyntrix databases may still enforce an image requirement. Apply
`migrations/20260915_allow_metadata_only_alerts.sql` once to remove it. Do not
delete the nullable `image_file` or `image_path` columns; they preserve
compatibility with historical snapshot-backed alerts.

For a legacy JSON installation, back up `data/` and then run the included
one-time importer after creating the PostgreSQL schema:

```bash
node scripts/migrate-json-to-postgres.js
```

The importer migrates users and alert records. It does not make old local image
files durable on Render.

## Production deployment

Deploy the backend first so its HTTPS URL is available, configure the frontend
to use that URL, and then verify both sides together.

### Render backend

Create a Render **Web Service** from this repository with:

- Runtime: Node.js
- Build command: `npm ci`
- Start command: `npm start`
- Instance count: one for V1

Configure these environment variables in Render:

```text
NODE_ENV=production
DATABASE_URL=<Neon pooled connection string>
SESSION_SECRET=<unique random value of at least 32 characters>
VYNTRIX_FRONTEND_ORIGIN=https://<stable-vercel-production-domain>
```

`VYNTRIX_FRONTEND_ORIGIN` must be the exact HTTPS origin with no path. Keep
`SESSION_SECRET` stable across restarts or existing sessions will become
invalid. Render supplies `PORT`; do not expose database or session secrets to
the frontend.

Optional production ICE/TURN variables are documented below. After deployment,
`GET /api/auth/session` should return a JSON logged-out response rather than a
proxy error or HTML error page.

### Vercel frontend

1. Import the repository into Vercel.
2. Use the repository root and the **Other** framework preset.
3. Serve `public/` as the static output. No backend secrets belong in Vercel.
4. Set the non-local `window.VYNTRIX_BACKEND_URL` in
   `public/js/frontend-config.js` to the Render HTTPS origin.
5. Deploy and use a stable production/custom domain.
6. Set Render's `VYNTRIX_FRONTEND_ORIGIN` to that exact Vercel origin and
   redeploy Render if the origin changed.

Vercel preview URLs are different origins. They will be rejected unless the
backend is deliberately configured for that exact preview origin. V1 accepts
one configured frontend origin at a time.

### Production verification

- Register, log in, log out, and reload an authenticated page.
- Restart/redeploy Render and confirm the PostgreSQL-backed session survives.
- Connect a camera and monitor under the same account.
- Confirm a second account cannot see or control the first account's camera or
  alerts.
- Test WebRTC from different networks, including a restrictive mobile network.
- Trigger motion and confirm only metadata appears and no new image is required.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection for users, alerts, and sessions. Prefer a pooled Neon URL for normal app traffic. |
| `SESSION_SECRET` | Production | Signs session cookies; production requires at least 32 characters. |
| `VYNTRIX_FRONTEND_ORIGIN` | Production | Exact HTTPS Vercel origin allowed by HTTP CORS and Socket.IO. |
| `NODE_ENV` | Production | Set to `production` for proxy trust, secure cookies, and production safeguards. |
| `PORT` | No | Backend port; defaults to `3050` locally and is supplied by Render. |
| `VYNTRIX_STUN_URLS` | No | Comma/space-separated `stun:` URLs; public Google STUN servers are the default. |
| `VYNTRIX_TURN_URLS` | No | Comma/space-separated `turn:` or `turns:` relay URLs. |
| `VYNTRIX_TURN_USERNAME` | With TURN | TURN username. |
| `VYNTRIX_TURN_CREDENTIAL` | With TURN | TURN credential; keep it backend-only. |
| `VYNTRIX_MAX_ALERTS_PER_USER` | No | Retained alert limit; default `100`. |
| `VYNTRIX_ALERT_UPLOAD_LIMIT` | No | Per-user alert-create limit per window; default `60`. |
| `VYNTRIX_ALERT_UPLOAD_WINDOW_MS` | No | Rate-limit window; default `900000` ms. |
| `VYNTRIX_ALERT_MAX_IMAGE_BYTES` | No | Maximum optional legacy image payload; capped at 2 MB. |
| `VYNTRIX_DATA_DIR` | No | Local location for legacy image files and development compatibility data. |
| `VYNTRIX_DATABASE_MODE` | Tests only | Set to `json` only for local compatibility tests; ignored in production. |

See `.env.example` for a safe template. Never commit `.env.local`, Neon URLs,
session secrets, or TURN credentials.

## Using Vyntrix

### Camera Console

1. Enter a camera name and start the camera.
2. Grant camera and microphone permissions.
3. Select Front or Back when the device exposes multiple cameras.
4. Enable motion detection and adjust sensitivity if needed.
5. Leave the page visible and keep the device awake.

Mirror Preview changes only the on-screen preview. It does not flip WebRTC
media, motion coordinates, or stored event data.

### Web Monitor

1. Sign in with the same account and select the online camera.
2. Use Front/Back to request a remote camera change.
3. Use Rotate when a mobile browser supplies a sideways feed.
4. Use mirror, zoom, night vision, fullscreen, siren, and hold-to-talk as
   needed.

Rotation, mirror, zoom, and night vision are display effects only. Default 1×
view uses `object-fit: contain` so the complete surveillance frame remains
visible.

## Browser and device limitations

- Camera enumeration, facing labels, resolution, and orientation vary by
  browser and device. Some phones expose only one camera or incomplete labels.
- iOS Safari and mobile browsers may pause camera/audio when backgrounded or
  when the device locks. Keep the Camera Console foregrounded and awake.
- Fullscreen APIs and exit controls differ across desktop Safari, iOS, Android,
  and installed web apps.
- Talk requires monitor microphone permission and may be affected by autoplay
  or audio-routing policies.
- STUN alone cannot traverse every carrier-grade NAT, corporate firewall, or
  restrictive Wi-Fi network. Configure TURN for reliable remote use.
- Browsers or privacy tools that block cross-site cookies can prevent sessions
  when Vercel and Render use unrelated domains.

Recommended targets are current Chrome/Edge/Firefox on Android and desktop,
and current Safari on iPhone/iPad/macOS. Smart-TV browsers, feature phones, and
older browsers are not supported.

## Security notes

- Passwords are hashed with bcrypt and password hashes are not returned to the
  browser.
- HTTP APIs, alert access/deletion, Socket.IO signaling, and remote controls
  enforce the authenticated account owner.
- Production cookies are HTTP-only, Secure, and configured for the split
  Vercel/Render deployment.
- Production CORS uses one exact configured frontend origin, not a wildcard.
- Sessions are stored in PostgreSQL and expired rows are pruned periodically.
- New motion events contain metadata only. Vyntrix does not record video or
  automatically save new motion photos.
- Historical image files are served through an ownership-checked API and are
  never intended to be public static files.
- TURN credentials must stay in backend environment variables. Authenticated
  browsers receive ICE credentials because WebRTC needs them; prefer
  short-lived credentials when the TURN provider supports them.

## Testing

```bash
npm run doctor       # configuration and dependency diagnostics
npm test             # unit and real-server integration tests
npm audit            # dependency advisory scan
git diff --check     # whitespace/error check before release
```

The suite covers authentication, session rotation/persistence, metadata-only
alerts, ownership enforcement, alert deletion, Socket.IO authentication,
cross-user signaling/control isolation, camera reconnect registration, and
configuration safeguards. Camera hardware, browser permissions, media routing,
fullscreen, and real NAT traversal still require manual device testing.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Server exits with `DATABASE_URL is required` | Add a valid Neon connection string to `.env.local` or Render. |
| Server rejects production configuration | Confirm `SESSION_SECRET` is 32+ characters and `VYNTRIX_FRONTEND_ORIGIN` is an exact HTTPS origin. |
| Login works locally but not on Vercel | Check Render CORS origin, HTTPS, cookie/privacy settings, and that frontend requests include credentials. |
| No cameras appear | Both devices must use the same account; keep Camera Console open and confirm Socket.IO is connected. |
| Front/back switch is unavailable | Grant permission first; the browser may expose only one input or omit usable facing information. |
| Video connects on Wi-Fi but not remotely | Configure authenticated TURN and test from separate networks. |
| Video is sideways | Use the monitor's manual Rotate control; rotation is remembered only for the current view lifecycle. |
| Talk is disabled or silent | Grant microphone permission on the monitor and check browser autoplay/audio-output restrictions. |
| Motion events repeat too often | Continuous motion is grouped, but a new event is allowed after the reset period or cooldown. Review sensitivity and scene movement. |
| Historical alert image is missing | Old images were local files and may not survive an ephemeral backend deployment; metadata remains usable. |
| Render restart disconnects video | WebRTC peers must reconnect after backend signaling restarts; login sessions remain in PostgreSQL. |

## V1 limitations

- No video recording, playback, cloud video storage, or automatic motion-photo
  capture
- No native Android/iOS application or reliable background camera operation
- No web push notifications when the monitor is closed
- No person/pet recognition, motion zones, or schedules
- No torch, optical zoom, or device-specific hardware controls
- One configured frontend origin and one backend instance
- Historical snapshot files require separate durable local storage to survive
  backend replacement; new events do not use images
- Real camera choice, orientation, fullscreen, and audio behavior remain
  browser/device dependent

## Project layout

```text
backend/                         Express, Socket.IO, PostgreSQL access
public/                          Static pages, CSS, and browser clients
migrations/                      PostgreSQL compatibility migration
scripts/doctor.js                Read-only environment diagnostics
scripts/migrate-json-to-postgres.js  Legacy JSON importer
test/                            Unit, security, persistence, and integration tests
```

## License

No license file is currently included. Add an explicit license before public
redistribution.
