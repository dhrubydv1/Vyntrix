# Vyntrix

Vyntrix is a browser-based security camera platform for repurposing everyday
devices. Sign in on one device as a **Camera** and on another as a **Monitor** to view live video/audio, use
push-to-talk, detect motion, save motion snapshots, trigger a siren, and review
the alert history. It is designed for reusing an old phone, tablet, laptop, or
desktop webcam as a camera.

> This is a web application, not a native Android/iOS app. It needs a modern
> browser, camera permission, and a secure connection when it is not running on
> `localhost`.

## Features

- Account-based camera and monitor pairing
- WebRTC live video and audio between signed-in devices
- Multi-camera monitor dashboard
- Browser-side motion detection with snapshot alerts
- Private, account-scoped alert images and alert deletion
- Push-to-talk audio, remote siren, digital zoom, and night-vision filter
- Responsive UI for mobile and desktop browsers

## Accounts

There is no shipped default account, and no credentials are published in this
repository. Start the server, open the app, and use **Register** to create your
own account. Every camera, monitor, alert, and snapshot is scoped to the
account that created it.

If you need a throwaway account for evaluation, register one locally and delete
it when you are done. Never reuse a password from anywhere else, and do not
create shared or well-known credentials on a deployment that is reachable from
the internet.

## Requirements

- Node.js 18 or newer (Node 20 LTS is recommended)
- npm
- A current browser with WebRTC and `getUserMedia` support
- Two devices or two separate browser sessions signed into the same account
- Internet/LAN access between devices for remote use

## Quick Installation

Git clones never run this project automatically. After cloning, explicitly run
the setup assistant for your platform. It checks Git, Node.js, npm, project
dependencies, and local configuration. It only installs system software or
project dependencies after you answer `Y` or `y`.

```bash
# macOS or Linux
bash scripts/setup.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

Run a read-only environment report at any time:

```bash
npm run doctor
```

The exact command to start Vyntrix is:

```bash
npm start
```

## Quick start

```bash
npm install
npm start
```

Open [http://localhost:3050](http://localhost:3050) and select **Register** to
create an account.

### Use it as a camera

1. On the device that will act as the camera, open **Camera Console**.
2. Give it a useful name, such as `Front Door`.
3. Select **Start Camera** and allow the browser to use the camera and
   microphone.
4. Leave that tab open and keep the device awake/connected.

### Use it as a monitor

1. On another device or browser session, log in with the same account.
2. Open **Web Monitor**.
3. Select the online camera; a single online camera is selected automatically.
4. Use the zoom, night-vision, siren, alert history, and push-to-talk controls
   as needed.

For a realistic test, use two physical devices. A single device generally
cannot use its camera and reliably monitor the same live stream at once.

## Configuration

### Local development

The server listens on port `3050` by default.

```bash
PORT=8080 SESSION_SECRET='replace-with-a-long-random-secret' npm start
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3050` | HTTP port for the application. |
| `SESSION_SECRET` | development fallback | Secret used to sign login sessions. It is required when `NODE_ENV=production`. |
| `NODE_ENV` | unset | Set to `production` behind HTTPS so session cookies are marked secure. |
| `VYNTRIX_DATA_DIR` | `./data` | Optional directory for runtime JSON data, alert images, and sessions. |
| `VYNTRIX_ALERT_MAX_IMAGE_BYTES` | `2097152` | Maximum decoded alert image size; maximum supported value is 2 MB. |
| `VYNTRIX_MAX_ALERTS_PER_USER` | `100` | Maximum retained alerts per user; oldest alerts are removed when the limit is reached. |
| `VYNTRIX_ALERT_UPLOAD_LIMIT` | `60` | Maximum alert uploads per user during the configured window. |
| `VYNTRIX_ALERT_UPLOAD_WINDOW_MS` | `900000` | Alert upload rate-limit window in milliseconds (15 minutes). |

Copy `.env.example` to `.env.local` when you need to customize the port or
session secret or move runtime data to another directory; it is loaded
automatically at startup. Existing deployments may continue using the
deprecated `SASTA_CCTV_DATA_DIR`, which is used when `VYNTRIX_DATA_DIR` is not
set. Never commit `.env.local` or any credentials.

## Architecture

### Local mode (`npm start`)

```
browser → Express + Socket.IO → data/database.json + data/alerts/
```

## Project layout

```
backend/server.js         Local Express + Socket.IO dev server
backend/db.js             Local JSON file persistence
public/                   Browser pages, styles, and client-side code
public/js/auth.js         Session management
public/js/monitor.js      Monitor logic (WebRTC, alerts)
public/js/camera.js       Camera logic (streaming, motion detection)
test/db.test.js           Database unit tests (24 tests)
test/api.test.js          API integration tests (26 tests)
scripts/clean-test-data.js Utility to purge test data from local database
data/database.json        Local user/alert metadata (dev only)
data/alerts/              Local alert image files (dev only)
```

## Testing

Run the full test suite:

```bash
npm test
```

This runs Node's built-in test runner across `test/db.test.js` (23 unit tests)
and `test/api.test.js` (26 integration tests).

### Test coverage

| Area | Tests | What's tested |
|------|-------|---------------|
| `db.js` | 24 | User CRUD, password hashing, alert CRUD, file path resolution, input validation |
| API routes | 26 | Auth flow (register, login, logout, session), 401 enforcement, alert upload/list/delete, security headers |

### Cleaning test data

Test runs create temporary users in `data/database.json`. Clean them with:

```bash
node scripts/clean-test-data.js
```

## Networking and remote viewing

Live media is peer-to-peer WebRTC. The included public STUN servers work on
many home and office networks, but not all of them. Remote streams can fail on
carrier-grade NAT, restrictive corporate Wi-Fi, or firewalls that block WebRTC.

For reliable public/production remote viewing, configure your own authenticated
TURN server and replace the `iceServers` settings in:

- `public/js/camera.js`
- `public/js/monitor.js`

The application server only handles login, device discovery, alerts, and WebRTC
signalling; it does not relay the video stream by itself.

## Device and browser compatibility

| Device | Supported browsers | Notes |
| --- | --- | --- |
| Android phones/tablets | Current Chrome, Edge, Firefox | Good camera/monitor option. Keep the browser in the foreground. |
| iPhone/iPad | Current Safari | Safari may pause background tabs and requires user permission. |
| Windows/macOS/Linux | Current Chrome, Edge, Firefox, Safari on macOS | Works with built-in or USB webcams. |
| Chromebooks | Current Chrome | Works when device camera/mic is available. |
| Older browsers, feature phones, smart-TV browsers | Not supported | Usually lack required WebRTC or camera APIs. |

Camera and microphone access requires `http://localhost` during development or
HTTPS in production. Browsers block access on plain `http://` public addresses.

## Development commands

```bash
npm start       # start the local server
npm run dev     # restart automatically when backend files change
npm test        # run the test suite
npm audit       # check dependency advisories
```

## Security notes

- Passwords are hashed with bcrypt.
- Cameras, monitors, alerts, and snapshot images are scoped to the signed-in account.
- Alert images are stored outside the public directory and served only through authenticated API endpoints.
- Sessions use HTTP-only cookies.
- All frontend API calls include `credentials: 'same-origin'` for reliable session handling.
- Never reuse the development `SESSION_SECRET` fallback in production.

## Deployment status

The app can run on a single long-running Node.js server with HTTPS and a
persistent writable disk mounted for `data/`. It is not compatible with
serverless hosts, and its JSON database and file-backed session store do not
support multiple application instances. Configure an authenticated TURN server
before relying on remote viewing across restrictive networks.

## Current limitations / roadmap

- Native Android/iOS application and background recording
- Web push notifications when the monitor is closed
- Continuous video recording and cloud backup
- Motion schedules, zones, and person/pet detection
- Camera selection, torch, optical zoom, and device-specific controls
- TURN configuration UI and production deployment automation

## License

No license has been specified for this repository yet. Add one before sharing
or redistributing the project.
