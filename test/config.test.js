const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const projectRoot = path.join(__dirname, '..');
const configExpression = "process.stdout.write(require('./backend/config').DATA_DIR)";
const iceExpression = "process.stdout.write(JSON.stringify(require('./backend/config').ICE_SERVERS))";

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
});
