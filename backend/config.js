const path = require('path');

// VYNTRIX_DATA_DIR is the current setting. Keep the legacy variable as a
// fallback so existing deployments continue using their current data store.
const configuredDataDir = process.env.VYNTRIX_DATA_DIR || process.env.SASTA_CCTV_DATA_DIR;

function readPositiveInteger(name, fallback, maximum) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === '') return fallback;

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

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
  ALERT_UPLOAD_WINDOW_MS
};
