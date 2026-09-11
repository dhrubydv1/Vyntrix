const path = require('path');

const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302'
];

// VYNTRIX_DATA_DIR is the current setting. Keep the legacy variable as a
// fallback so existing deployments continue using their current data store.
const configuredDataDir = process.env.VYNTRIX_DATA_DIR || process.env.SASTA_CCTV_DATA_DIR;

function readFrontendOrigin() {
  const value = (process.env.VYNTRIX_FRONTEND_ORIGIN || '').trim();
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw new Error('VYNTRIX_FRONTEND_ORIGIN must be a valid http(s) origin');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value.replace(/\/$/, '')) {
    throw new Error('VYNTRIX_FRONTEND_ORIGIN must be a valid http(s) origin without a path');
  }
  return parsed.origin;
}

const FRONTEND_ORIGIN = readFrontendOrigin();

function readPositiveInteger(name, fallback, maximum) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === '') return fallback;

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function readIceUrls(name, fallback, protocols) {
  const rawValue = process.env[name];
  if (typeof rawValue !== 'string') return fallback;
  if (rawValue === undefined || rawValue.trim() === '') return fallback;

  const urls = rawValue.split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
  if (!urls.length || urls.some(url => !protocols.some(protocol => url.startsWith(protocol)))) {
    throw new Error(`${name} must contain valid ${protocols.join(' or ')} URLs`);
  }
  return [...new Set(urls)];
}

const STUN_URLS = readIceUrls('VYNTRIX_STUN_URLS', DEFAULT_STUN_URLS, ['stun:']);
const TURN_URLS = readIceUrls('VYNTRIX_TURN_URLS', [], ['turn:', 'turns:']);
const TURN_USERNAME = (process.env.VYNTRIX_TURN_USERNAME || '').trim();
const TURN_CREDENTIAL = process.env.VYNTRIX_TURN_CREDENTIAL || '';

if ((TURN_USERNAME && !TURN_CREDENTIAL) || (!TURN_USERNAME && TURN_CREDENTIAL)) {
  throw new Error('VYNTRIX_TURN_USERNAME and VYNTRIX_TURN_CREDENTIAL must be configured together');
}
if (TURN_URLS.length && (!TURN_USERNAME || !TURN_CREDENTIAL)) {
  throw new Error('VYNTRIX_TURN_USERNAME and VYNTRIX_TURN_CREDENTIAL are required when VYNTRIX_TURN_URLS is configured');
}

const ICE_SERVERS = [
  { urls: STUN_URLS },
  ...(TURN_URLS.length ? [{ urls: TURN_URLS, username: TURN_USERNAME, credential: TURN_CREDENTIAL }] : [])
];

const DATA_DIR = configuredDataDir
  ? path.resolve(configuredDataDir)
  : path.join(__dirname, '..', 'data');

const MAX_ALERT_IMAGE_BYTES = readPositiveInteger(
  'VYNTRIX_ALERT_MAX_IMAGE_BYTES',
  2 * 1024 * 1024,
  2 * 1024 * 1024
);
const MAX_ALERTS_PER_USER = readPositiveInteger(
  'VYNTRIX_MAX_ALERTS_PER_USER',
  100,
  10000
);
const ALERT_UPLOAD_LIMIT = readPositiveInteger(
  'VYNTRIX_ALERT_UPLOAD_LIMIT',
  60,
  10000
);
const ALERT_UPLOAD_WINDOW_MS = readPositiveInteger(
  'VYNTRIX_ALERT_UPLOAD_WINDOW_MS',
  15 * 60 * 1000,
  24 * 60 * 60 * 1000
);

module.exports = {
  DATA_DIR,
  MAX_ALERT_IMAGE_BYTES,
  MAX_ALERTS_PER_USER,
  ALERT_UPLOAD_LIMIT,
  ALERT_UPLOAD_WINDOW_MS,
  ICE_SERVERS,
  FRONTEND_ORIGIN
};
