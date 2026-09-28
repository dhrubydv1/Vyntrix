const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const quality = require('../public/js/recording-quality');
const storageUsage = require('../public/js/recording-storage');

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
}

describe('recording quality preferences', () => {
  it('defaults to 720p and persists a user/browser-scoped selection', () => {
    const storage = memoryStorage();
    assert.strictEqual(quality.readQualityPreference(storage, 'user-a'), '720p');
    quality.writeQualityPreference(storage, 'user-a', '1080p');
    assert.strictEqual(quality.readQualityPreference(storage, 'user-a'), '1080p');
    assert.strictEqual(quality.readQualityPreference(storage, 'user-b'), '720p');
    assert.strictEqual(quality.writeQualityPreference(storage, 'user-a', '140p'), '720p');
  });

  it('maps each supported quality to its target resolution and bitrate', () => {
    assert.deepStrictEqual(
      quality.QUALITY_NAMES.map(name => {
        const preset = quality.getQualityPreset(name);
        return [name, preset.width, preset.height, preset.videoBitsPerSecond];
      }),
      [
        ['360p', 640, 360, 800000],
        ['480p', 854, 480, 1200000],
        ['720p', 1280, 720, 2500000],
        ['1080p', 1920, 1080, 5000000]
      ]
    );
    assert.ok(quality.estimateBytesPerHour('1080p') > quality.estimateBytesPerHour('720p'));
  });

  it('falls back to the nearest resolution supported by track capabilities', () => {
    assert.strictEqual(quality.nearestSupportedQuality('1080p', {
      width: { min: 320, max: 1280 },
      height: { min: 240, max: 720 }
    }), '720p');
    assert.strictEqual(quality.nearestSupportedQuality('720p', {
      width: { min: 320, max: 900 },
      height: { min: 240, max: 600 }
    }), '480p');
    assert.strictEqual(quality.nearestQualityForDimensions(720, 1280), '720p');
    assert.deepStrictEqual(quality.qualityFallbackOrder('1080p', {
      width: { min: 320, max: 1280 },
      height: { min: 240, max: 720 }
    }), ['720p', '480p', '360p']);
  });

  it('wires camera selection to MediaRecorder bitrate without creating a monitor recorder', () => {
    const root = path.join(__dirname, '..');
    const cameraScript = fs.readFileSync(path.join(root, 'public/js/camera.js'), 'utf8');
    const monitorScript = fs.readFileSync(path.join(root, 'public/js/monitor.js'), 'utf8');
    assert.match(cameraScript, /videoBitsPerSecond: qualityPreset\.videoBitsPerSecond/);
    assert.match(cameraScript, /track\.applyConstraints/);
    assert.match(cameraScript, /width: \{ exact: preset\.width \}/);
    assert.match(cameraScript, /syncActiveRecordingQuality\(track, appliedQuality\)/);
    assert.match(cameraScript, /camera:quality/);
    assert.match(monitorScript, /remote-recording-quality/);
    assert.doesNotMatch(monitorScript, /new MediaRecorder/);
  });
});

describe('personal recording usage notices', () => {
  it('notifies once at each crossed 1 GB boundary without imposing a personal quota', () => {
    const storage = memoryStorage();
    const gib = storageUsage.GIBIBYTE;
    assert.strictEqual(storageUsage.consumePersonalUsageNotice(storage, 'user-a', gib - 1), '');
    assert.strictEqual(
      storageUsage.consumePersonalUsageNotice(storage, 'user-a', gib),
      'You have used 1 GB of recording storage.'
    );
    assert.strictEqual(storageUsage.consumePersonalUsageNotice(storage, 'user-a', gib + 100), '');
    assert.strictEqual(
      storageUsage.consumePersonalUsageNotice(storage, 'user-a', 2 * gib),
      'You have used 2 GB of recording storage.'
    );
    assert.strictEqual(
      storageUsage.consumePersonalUsageNotice(storage, 'user-b', gib),
      'You have used 1 GB of recording storage.'
    );
  });
});
