(function exposeRecordingStorage(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VyntrixRecordingStorage = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const GIBIBYTE = 1024 ** 3;

  function personalUsageBoundary(usedBytes) {
    const normalized = Math.max(0, Number(usedBytes) || 0);
    return Math.floor(normalized / GIBIBYTE);
  }

  function personalUsageNotice(boundary) {
    const normalized = Math.max(0, Math.floor(Number(boundary) || 0));
    return normalized > 0 ? `You have used ${normalized} GB of recording storage.` : '';
  }

  function noticeStorageKey(userId) {
    const scopedUser = typeof userId === 'string' && userId ? userId : 'browser';
    return `vyntrix.recordings.usageNoticeGb.${scopedUser}`;
  }

  function consumePersonalUsageNotice(storage, userId, usedBytes) {
    const boundary = personalUsageBoundary(usedBytes);
    if (boundary < 1) return '';
    const key = noticeStorageKey(userId);
    let previousBoundary = 0;
    try {
      previousBoundary = Math.max(0, Number.parseInt(storage?.getItem(key), 10) || 0);
    } catch (_) {
      // A notice can still be shown when storage is unavailable.
    }
    if (boundary <= previousBoundary) return '';
    try {
      storage?.setItem(key, String(boundary));
    } catch (_) {
      // Notice persistence is non-essential.
    }
    return personalUsageNotice(boundary);
  }

  return Object.freeze({
    GIBIBYTE,
    consumePersonalUsageNotice,
    noticeStorageKey,
    personalUsageBoundary,
    personalUsageNotice
  });
}));
