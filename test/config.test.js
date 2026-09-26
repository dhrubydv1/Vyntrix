const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const projectRoot = path.join(__dirname, '..');
const configExpression = "process.stdout.write(require('./backend/config').DATA_DIR)";
const iceExpression = "process.stdout.write(JSON.stringify(require('./backend/config').ICE_SERVERS))";
const frontendOriginExpression = "process.stdout.write(String(require('./backend/config').FRONTEND_ORIGIN))";
const recordingLimitExpression = "process.stdout.write(String(require('./backend/config').MAX_RECORDING_UPLOAD_BYTES))";
const databaseModuleExpression = "require('./backend/db'); process.stdout.write('loaded')";
const serverModuleExpression = "require('./backend/server'); process.stdout.write('loaded')";

function resolveDataDir(extraEnvironment = {}) {
  const environment = { ...process.env };
  delete environment.VYNTRIX_DATA_DIR;
  delete environment.SASTA_CCTV_DATA_DIR;
  Object.assign(environment, extraEnvironment);

  return execFileSync(process.execPath, ['-e', configExpression], {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8'
  });
}

function resolveIceServers(extraEnvironment = {}) {
  const environment = { ...process.env };
  delete environment.VYNTRIX_STUN_URLS;
  delete environment.VYNTRIX_TURN_URLS;
  delete environment.VYNTRIX_TURN_USERNAME;
  delete environment.VYNTRIX_TURN_CREDENTIAL;
  Object.assign(environment, extraEnvironment);

  return JSON.parse(execFileSync(process.execPath, ['-e', iceExpression], {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8'
  }));
}

function resolveFrontendOrigin(extraEnvironment = {}) {
  const environment = { ...process.env };
  delete environment.VYNTRIX_FRONTEND_ORIGIN;
  Object.assign(environment, extraEnvironment);
  return execFileSync(process.execPath, ['-e', frontendOriginExpression], {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8'
  });
}

function resolveRecordingLimit(extraEnvironment = {}) {
  const environment = { ...process.env };
  delete environment.VYNTRIX_RECORDING_MAX_BYTES;
  Object.assign(environment, extraEnvironment);
  return Number(execFileSync(process.execPath, ['-e', recordingLimitExpression], {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8'
  }));
}

describe('Data directory configuration', () => {
  it('prefers VYNTRIX_DATA_DIR when both variables are set', () => {
    assert.strictEqual(
      resolveDataDir({
        VYNTRIX_DATA_DIR: '/tmp/vyntrix-data',
        SASTA_CCTV_DATA_DIR: '/tmp/legacy-data'
      }),
      '/tmp/vyntrix-data'
    );
  });

  it('falls back to SASTA_CCTV_DATA_DIR for existing deployments', () => {
    assert.strictEqual(
      resolveDataDir({ SASTA_CCTV_DATA_DIR: '/tmp/legacy-data' }),
      '/tmp/legacy-data'
    );
  });

  it('uses the repository data directory when neither variable is set', () => {
    assert.strictEqual(
      resolveDataDir(),
      path.join(projectRoot, 'data')
    );
  });
});

describe('Production database selection', () => {
  it('does not allow the JSON compatibility store in production', () => {
    const environment = { ...process.env, NODE_ENV: 'production', VYNTRIX_DATABASE_MODE: 'json' };
    delete environment.DATABASE_URL;
    assert.throws(() => execFileSync(process.execPath, ['-e', databaseModuleExpression], {
      cwd: projectRoot,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }));
  });
});

describe('Recording upload configuration', () => {
  it('uses a 50 MB default and accepts a bounded override', () => {
    assert.strictEqual(resolveRecordingLimit(), 50 * 1024 * 1024);
    assert.strictEqual(resolveRecordingLimit({ VYNTRIX_RECORDING_MAX_BYTES: '1048576' }), 1048576);
  });

  it('rejects invalid and excessive recording limits', () => {
    assert.throws(() => resolveRecordingLimit({ VYNTRIX_RECORDING_MAX_BYTES: '0' }));
    assert.throws(() => resolveRecordingLimit({ VYNTRIX_RECORDING_MAX_BYTES: '524288001' }));
  });
});

describe('Production runtime safeguards', () => {
  function loadProductionServer(overrides) {
    const environment = {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
      SESSION_SECRET: 'a-secure-test-session-secret-at-least-32-characters',
      VYNTRIX_FRONTEND_ORIGIN: 'https://vyntrix.example',
      ...overrides
    };
    return execFileSync(process.execPath, ['-e', serverModuleExpression], {
      cwd: projectRoot,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  it('rejects short production session secrets', () => {
    assert.throws(() => loadProductionServer({ SESSION_SECRET: 'too-short' }));
  });

  it('requires an HTTPS production frontend origin', () => {
    assert.throws(() => loadProductionServer({ VYNTRIX_FRONTEND_ORIGIN: '' }));
    assert.throws(() => loadProductionServer({ VYNTRIX_FRONTEND_ORIGIN: 'http://vyntrix.example' }));
  });
});

describe('WebRTC ICE configuration', () => {
  it('uses the default STUN-only configuration', () => {
    assert.deepStrictEqual(resolveIceServers(), [{
      urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']
    }]);
  });

  it('normalizes custom STUN and TURN configuration', () => {
    assert.deepStrictEqual(resolveIceServers({
      VYNTRIX_STUN_URLS: 'stun:one.example:3478, stun:two.example:3478',
      VYNTRIX_TURN_URLS: 'turn:relay.example:3478 turns:relay.example:5349',
      VYNTRIX_TURN_USERNAME: 'turn-user',
      VYNTRIX_TURN_CREDENTIAL: 'turn-secret'
    }), [
      { urls: ['stun:one.example:3478', 'stun:two.example:3478'] },
      {
        urls: ['turn:relay.example:3478', 'turns:relay.example:5349'],
        username: 'turn-user',
        credential: 'turn-secret'
      }
    ]);
  });

  it('omits optional TURN when it is not configured', () => {
    assert.strictEqual(resolveIceServers({ VYNTRIX_TURN_URLS: '' }).length, 1);
  });

  it('rejects malformed ICE URLs and incomplete TURN credentials', () => {
    assert.throws(() => resolveIceServers({ VYNTRIX_STUN_URLS: 'https://not-stun.example' }));
    assert.throws(() => resolveIceServers({
      VYNTRIX_TURN_URLS: 'turn:relay.example:3478',
      VYNTRIX_TURN_USERNAME: 'turn-user'
    }));
  });

  it('uses the shared browser ICE helper in both device clients', () => {
    const cameraSource = fs.readFileSync(path.join(projectRoot, 'public/js/camera.js'), 'utf8');
    const monitorSource = fs.readFileSync(path.join(projectRoot, 'public/js/monitor.js'), 'utf8');
    assert.match(cameraSource, /getIceServers\(\)/);
    assert.match(monitorSource, /getIceServers\(\)/);
    assert.doesNotMatch(cameraSource, /stun:stun\.l\.google\.com/);
    assert.doesNotMatch(monitorSource, /stun:stun\.l\.google\.com/);
  });

  it('normalizes a configured frontend origin and rejects paths', () => {
    assert.strictEqual(
      resolveFrontendOrigin({ VYNTRIX_FRONTEND_ORIGIN: 'https://vyntrix.example/' }),
      'https://vyntrix.example'
    );
    assert.throws(() => resolveFrontendOrigin({
      VYNTRIX_FRONTEND_ORIGIN: 'https://vyntrix.example/app'
    }));
  });
});
