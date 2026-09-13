// Safe frontend-visible configuration. Set this value to the persistent
// backend origin for a separately hosted frontend; leave blank for local use.
window.VYNTRIX_BACKEND_URL = 'https://vyntrix-2w97.onrender.com';

(function initializeVyntrixConfig() {
  const configured = String(window.VYNTRIX_BACKEND_URL || '').trim().replace(/\/$/, '');
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  const backendOrigin = configured || (isLocal ? 'http://localhost:3050' : window.location.origin);

  let parsed;
  try {
    parsed = new URL(backendOrigin);
  } catch (_) {
    throw new Error('VYNTRIX_BACKEND_URL must be a valid http(s) origin');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== backendOrigin) {
    throw new Error('VYNTRIX_BACKEND_URL must be a valid http(s) origin without a path');
  }

  window.VyntrixConfig = {
    backendOrigin: parsed.origin,
    apiUrl(path) {
      return new URL(path, `${parsed.origin}/`).toString();
    }
  };
})();
