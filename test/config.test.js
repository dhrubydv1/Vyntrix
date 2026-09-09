const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const configExpression = "process.stdout.write(require('./backend/config').DATA_DIR)";

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
