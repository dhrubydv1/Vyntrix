#!/usr/bin/env node

/*
 * Read-only local environment diagnostics for Vyntrix.
 * This script intentionally does not install, create, edit, or delete files.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
let requiredProblems = 0;
let warnings = 0;

function status(symbol, message) {
  console.log(`${symbol} ${message}`);
}

function ok(message) {
  status('✓', message);
}

function warn(message) {
  warnings += 1;
  status('⚠', message);
}

function fail(message) {
  requiredProblems += 1;
  status('✗', message);
}

function commandVersion(command, args = ['--version']) {
  try {
    return execFileSync(command, args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (_) {
    return null;
  }
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function hasConfiguredValue(value) {
  return Boolean(value && !/replace-with|change-me|example|your[-_ ]/i.test(value));
}

function section(title) {
  console.log(`\n${title}`);
}

function validateDatabaseShape(candidate) {
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    && Array.isArray(candidate.users) && Array.isArray(candidate.alerts)
    && candidate.users.every(user => user && typeof user.id === 'string'
      && typeof user.username === 'string' && typeof user.passwordHash === 'string')
    && candidate.alerts.every(alert => alert && typeof alert.id === 'string'
      && typeof alert.userId === 'string' && typeof alert.timestamp === 'string');
}

function checkDirectory(directory, label) {
  if (!fs.existsSync(directory)) {
    warn(`${label} is missing and will be created on startup: ${directory}`);
    return;
  }
  try {
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    ok(`${label} is readable and writable: ${directory}`);
  } catch (_) {
    fail(`${label} is not readable and writable: ${directory}`);
  }
}

console.log('Vyntrix environment doctor');
console.log(`Project: ${projectRoot}`);

section('System');
const platformNames = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
const platformName = platformNames[process.platform] || process.platform;
if (['darwin', 'linux', 'win32'].includes(process.platform)) {
  ok(`Operating system: ${platformName} (${process.arch})`);
} else {
  warn(`Operating system: ${platformName}; setup scripts are tested for macOS, Linux, and Windows only`);
}

const gitVersion = commandVersion('git');
gitVersion ? ok(`Git: ${gitVersion}`) : fail('Git is not installed. It is required to clone and manage this repository.');

const nodeVersion = process.version;
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor >= 18) {
  ok(`Node.js: ${nodeVersion}${nodeMajor === 20 ? ' (recommended LTS line)' : ' (Node 20 LTS recommended)'}`);
} else {
  fail(`Node.js ${nodeVersion} is too old. Vyntrix requires Node.js 18 or newer; Node 20 LTS is recommended.`);
}

const npmVersion = commandVersion(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']);
npmVersion ? ok(`npm: ${npmVersion}`) : fail('npm is not available. It is normally installed with Node.js.');

section('Project dependencies');
const packagePath = path.join(projectRoot, 'package.json');
const lockPath = path.join(projectRoot, 'package-lock.json');
const nodeModulesPath = path.join(projectRoot, 'node_modules');

if (!fs.existsSync(packagePath)) {
  fail('package.json is missing; this does not appear to be a complete Vyntrix checkout.');
} else {
  ok('package.json found.');
}

if (fs.existsSync(lockPath)) {
  ok('package-lock.json found.');
} else {
  warn('package-lock.json is missing. Run npm install to create a reproducible lockfile.');
}

if (!fs.existsSync(nodeModulesPath)) {
  fail('node_modules is missing. Run npm install (or the platform setup assistant).');
} else {
  const requiredPackages = ['bcryptjs', 'connect-pg-simple', 'dotenv', 'express', 'express-rate-limit', 'express-session', 'session-file-store', 'socket.io'];
  const missingPackages = requiredPackages.filter((name) => !fs.existsSync(path.join(nodeModulesPath, name, 'package.json')));
  if (missingPackages.length) {
    fail(`Missing installed dependencies: ${missingPackages.join(', ')}. Run npm install.`);
  } else {
    ok('Project npm dependencies are installed.');
  }
}

section('Configuration');
const envLocalPath = path.join(projectRoot, '.env.local');
const envPath = path.join(projectRoot, '.env');
const fileEnv = readEnvFile(envLocalPath);
const effectiveEnv = { ...fileEnv, ...process.env };

if (fs.existsSync(envLocalPath)) {
  ok('.env.local found (this is the environment file loaded by the application).');
} else {
  warn('.env.local is not present. Local development can use defaults; copy .env.example to .env.local before customizing configuration.');
}

if (fs.existsSync(envPath)) {
  warn('.env exists, but the current application loads .env.local. Move required values to .env.local or export them in your shell.');
} else {
  ok('.env is not used by the current application; .env.local is the supported local configuration file.');
}

if (effectiveEnv.NODE_ENV === 'production') {
  if (hasConfiguredValue(effectiveEnv.SESSION_SECRET) && effectiveEnv.SESSION_SECRET.length >= 32) {
    ok('SESSION_SECRET is configured for production.');
  } else {
    fail('SESSION_SECRET is required when NODE_ENV=production. Set a unique random value of at least 32 characters.');
  }
} else if (hasConfiguredValue(effectiveEnv.SESSION_SECRET)) {
  ok('SESSION_SECRET is configured for local development.');
} else {
  warn('SESSION_SECRET is using the local development fallback. Set it before production deployment.');
}

if (effectiveEnv.NODE_ENV === 'production') {
  try {
    const configuredFrontendOrigin = (effectiveEnv.VYNTRIX_FRONTEND_ORIGIN || '').trim().replace(/\/$/, '');
    const frontendOrigin = new URL(configuredFrontendOrigin);
    if (frontendOrigin.protocol === 'https:' && frontendOrigin.origin === configuredFrontendOrigin) {
      ok('VYNTRIX_FRONTEND_ORIGIN is a production HTTPS origin.');
    } else {
      fail('VYNTRIX_FRONTEND_ORIGIN must be an HTTPS origin without a path in production.');
    }
  } catch (_) {
    fail('VYNTRIX_FRONTEND_ORIGIN must be configured as an HTTPS origin in production.');
  }
}

if (effectiveEnv.PORT) {
  ok(`PORT is configured: ${effectiveEnv.PORT}`);
} else {
  ok('PORT is not set; the application will use 3050.');
}

const configuredDataDir = effectiveEnv.VYNTRIX_DATA_DIR || effectiveEnv.SASTA_CCTV_DATA_DIR;
if (effectiveEnv.VYNTRIX_DATA_DIR) {
  ok(`VYNTRIX_DATA_DIR is configured: ${effectiveEnv.VYNTRIX_DATA_DIR}`);
} else if (effectiveEnv.SASTA_CCTV_DATA_DIR) {
  warn(`SASTA_CCTV_DATA_DIR is configured for compatibility: ${effectiveEnv.SASTA_CCTV_DATA_DIR}. Prefer VYNTRIX_DATA_DIR for new deployments.`);
} else {
  ok('Runtime data will use the default ./data directory.');
}

const usesJsonCompatibilityMode = effectiveEnv.NODE_ENV !== 'production'
  && effectiveEnv.VYNTRIX_DATABASE_MODE === 'json';
if (usesJsonCompatibilityMode) {
  ok('JSON compatibility mode is enabled for local testing; file-backed sessions will be used.');
} else if (hasConfiguredValue(effectiveEnv.DATABASE_URL)) {
  ok('DATABASE_URL is configured for PostgreSQL data and sessions.');
} else {
  fail('DATABASE_URL is required for PostgreSQL data and sessions.');
}

for (const legacyVariable of ['BLOB_READ_WRITE_TOKEN', 'ABLY_API_KEY']) {
  if (effectiveEnv[legacyVariable]) {
    warn(`${legacyVariable} is set but is not used by the current local-only codebase.`);
  } else {
    ok(`${legacyVariable} is not required by the current codebase.`);
  }
}

section('Runtime directories');
const dataDirectory = configuredDataDir
  ? path.resolve(projectRoot, configuredDataDir)
  : path.join(projectRoot, 'data');
if (fs.existsSync(dataDirectory)) {
  try {
    fs.accessSync(dataDirectory, fs.constants.W_OK);
    ok(`Runtime data directory is writable: ${dataDirectory}`);
  } catch (_) {
    fail(`Runtime data directory is not writable: ${dataDirectory}`);
  }
} else {
  warn(`Runtime data directory will be created on first start: ${dataDirectory}`);
}

if (fs.existsSync(dataDirectory)) {
  checkDirectory(path.join(dataDirectory, 'alerts'), 'Alert image directory');
  if (usesJsonCompatibilityMode) {
    checkDirectory(path.join(dataDirectory, 'sessions'), 'Test session directory');
  } else {
    ok('PostgreSQL session storage is enabled; the local session directory is not used.');
  }

  if (usesJsonCompatibilityMode) {
    const databasePath = path.join(dataDirectory, 'database.json');
    const temporaryDatabasePath = `${databasePath}.tmp`;
    if (fs.existsSync(temporaryDatabasePath)) {
      warn(`Stale database temporary file found; inspect before starting: ${temporaryDatabasePath}`);
    }
    if (!fs.existsSync(databasePath)) {
      warn(`database.json is missing and will be initialized on startup: ${databasePath}`);
    } else {
      try {
        const parsed = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
        if (validateDatabaseShape(parsed)) {
          ok('database.json is valid and has the required users and alerts collections.');
        } else {
          fail('database.json has an invalid structure; no data was modified.');
        }
      } catch (_) {
        fail('database.json is malformed; no data was modified.');
      }
    }
  }
}

section('Summary');
if (requiredProblems) {
  fail(`${requiredProblems} required problem${requiredProblems === 1 ? '' : 's'} found. Fix the items above before starting Vyntrix.`);
} else {
  ok('No required setup problems found.');
}
if (warnings) warn(`${warnings} optional configuration warning${warnings === 1 ? '' : 's'} found.`);
console.log('\nStart Vyntrix with: npm start');

process.exitCode = requiredProblems ? 1 : 0;
