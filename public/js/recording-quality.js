(function exposeRecordingQuality(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VyntrixRecordingQuality = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const DEFAULT_QUALITY = '720p';
  const AUDIO_BITS_PER_SECOND = 128000;
  const QUALITY_PRESETS = Object.freeze({
    '360p': Object.freeze({ label: '360p', width: 640, height: 360, videoBitsPerSecond: 800000 }),
    '480p': Object.freeze({ label: '480p', width: 854, height: 480, videoBitsPerSecond: 1200000 }),
    '720p': Object.freeze({ label: '720p', width: 1280, height: 720, videoBitsPerSecond: 2500000 }),
    '1080p': Object.freeze({ label: '1080p', width: 1920, height: 1080, videoBitsPerSecond: 5000000 })
  });
  const QUALITY_NAMES = Object.freeze(Object.keys(QUALITY_PRESETS));

  function normalizeQuality(value) {
    return Object.hasOwn(QUALITY_PRESETS, value) ? value : DEFAULT_QUALITY;
  }

  function getQualityPreset(value) {
    return QUALITY_PRESETS[normalizeQuality(value)];
  }

  function estimateBytesPerHour(value) {
    const preset = getQualityPreset(value);
    return Math.round(((preset.videoBitsPerSecond + AUDIO_BITS_PER_SECOND) * 3600) / 8);
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes >= 1024 ** 3) return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
    return `${Math.round(bytes / (1024 ** 2))} MB`;
  }

  function estimateLabel(value) {
    return `About ${formatBytes(estimateBytesPerHour(value))} per hour`;
  }

  function qualityPreferenceKey(userId) {
    const scopedUser = typeof userId === 'string' && userId ? userId : 'browser';
    return `vyntrix.camera.recordingQuality.${scopedUser}`;
  }

  function readQualityPreference(storage, userId) {
    try {
      return normalizeQuality(storage?.getItem(qualityPreferenceKey(userId)));
    } catch (_) {
      return DEFAULT_QUALITY;
    }
  }

  function writeQualityPreference(storage, userId, quality) {
    const normalized = normalizeQuality(quality);
    try {
      storage?.setItem(qualityPreferenceKey(userId), normalized);
    } catch (_) {
      // Recording remains available when browser storage is unavailable.
    }
    return normalized;
  }

  function capabilityRangeSupports(range, value) {
    if (!range || typeof range !== 'object') return true;
    const min = Number.isFinite(range.min) ? range.min : 0;
    const max = Number.isFinite(range.max) ? range.max : Number.POSITIVE_INFINITY;
    return value >= min && value <= max;
  }

  function nearestSupportedQuality(requestedQuality, capabilities = {}) {
    return qualityFallbackOrder(requestedQuality, capabilities)[0];
  }

  function qualityFallbackOrder(requestedQuality, capabilities = {}) {
    const requested = normalizeQuality(requestedQuality);
    const supported = QUALITY_NAMES.filter((name) => {
      const preset = QUALITY_PRESETS[name];
      return capabilityRangeSupports(capabilities.width, preset.width)
        && capabilityRangeSupports(capabilities.height, preset.height);
    });
    const candidates = supported.length ? supported : [...QUALITY_NAMES];
    const requestedIndex = QUALITY_NAMES.indexOf(requested);
    return candidates.sort((first, second) => {
      const firstIndex = QUALITY_NAMES.indexOf(first);
      const secondIndex = QUALITY_NAMES.indexOf(second);
      return Math.abs(firstIndex - requestedIndex) - Math.abs(secondIndex - requestedIndex)
        || firstIndex - secondIndex;
    });
  }

  function nearestQualityForDimensions(width, height, fallback = DEFAULT_QUALITY) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return normalizeQuality(fallback);
    }
    const longEdge = Math.max(width, height);
    const shortEdge = Math.min(width, height);
    return QUALITY_NAMES.reduce((closest, candidate) => {
      const preset = QUALITY_PRESETS[candidate];
      const score = Math.abs(preset.width - longEdge) + Math.abs(preset.height - shortEdge);
      const closestPreset = QUALITY_PRESETS[closest];
      const closestScore = Math.abs(closestPreset.width - longEdge) + Math.abs(closestPreset.height - shortEdge);
      return score < closestScore ? candidate : closest;
    }, normalizeQuality(fallback));
  }

  return Object.freeze({
    AUDIO_BITS_PER_SECOND,
    DEFAULT_QUALITY,
    QUALITY_NAMES,
    QUALITY_PRESETS,
    estimateBytesPerHour,
    estimateLabel,
    getQualityPreset,
    nearestQualityForDimensions,
    nearestSupportedQuality,
    normalizeQuality,
    qualityFallbackOrder,
    qualityPreferenceKey,
    readQualityPreference,
    writeQualityPreference
  });
}));
