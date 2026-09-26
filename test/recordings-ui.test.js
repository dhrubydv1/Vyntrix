const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(projectRoot, 'public', 'recordings.html'), 'utf8');
const script = fs.readFileSync(path.join(projectRoot, 'public', 'js', 'recordings.js'), 'utf8');
const authScript = fs.readFileSync(path.join(projectRoot, 'public', 'js', 'auth.js'), 'utf8');

describe('recordings frontend', () => {
  it('provides protected loading, empty, error, playback, and deletion UI hooks', () => {
    assert.match(html, /id="recordings-list"/);
    assert.match(html, /id="recordings-status"/);
    assert.match(html, /id="btn-retry-recordings"/);
    assert.match(script, /protectPage\(\)/);
    assert.match(script, /\/api\/recordings/);
    assert.match(script, /credentials: 'include'/);
    assert.match(script, /Delete/);
    assert.match(script, /Play/);
  });

  it('adds Recordings to the authenticated shared navigation', () => {
    assert.match(authScript, /link-recordings/);
    assert.match(authScript, /\/recordings\.html/);
  });

  it('does not expose R2 configuration or object keys in frontend files', () => {
    assert.doesNotMatch(`${html}\n${script}`, /R2_(?:ACCESS|SECRET|ENDPOINT|BUCKET)/);
    assert.doesNotMatch(script, /objectKey/);
  });
});
