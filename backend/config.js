const path = require('path');

// VYNTRIX_DATA_DIR is the current setting. Keep the legacy variable as a
// fallback so existing deployments continue using their current data store.
const configuredDataDir = process.env.VYNTRIX_DATA_DIR || process.env.SASTA_CCTV_DATA_DIR;

const DATA_DIR = configuredDataDir
  ? path.resolve(configuredDataDir)
  : path.join(__dirname, '..', 'data');

module.exports = { DATA_DIR };
