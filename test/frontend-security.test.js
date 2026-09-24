const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const authSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'auth.js'), 'utf8');
const context = vm.createContext({
  URL,
  URLSearchParams,
  window: { location: { origin: 'https://vyntrix.example' } },
  document: { addEventListener() {} },
  console
});
vm.runInContext(authSource, context);

function safeLocalRedirect(value) {
  context.redirectCandidate = value;
  return vm.runInContext('safeLocalRedirect(redirectCandidate)', context);
}

describe('Frontend redirect safety', () => {
  it('allows same-origin application paths', () => {
    assert.strictEqual(safeLocalRedirect('/monitor.html?camera=living-room#live'), '/monitor.html?camera=living-room#live');
  });

  it('rejects absolute and protocol-relative external redirects', () => {
    assert.strictEqual(safeLocalRedirect('https://attacker.example'), null);
    assert.strictEqual(safeLocalRedirect('//attacker.example/path'), null);
  });
});
