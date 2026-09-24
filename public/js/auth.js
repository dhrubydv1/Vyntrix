// Shared Authentication Manager for Vyntrix

let sessionRequest = null;

function setGlobalConnectionState(message = '', state = 'info') {
  let banner = document.getElementById('global-connection-state');
  if (!message) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'global-connection-state';
    banner.className = 'connection-banner';
    document.querySelector('header')?.insertAdjacentElement('afterend', banner);
  }
  banner.setAttribute('role', state === 'error' ? 'alert' : 'status');
  banner.setAttribute('aria-live', state === 'error' ? 'assertive' : 'polite');
  banner.className = `connection-banner connection-banner-${state}`;
  banner.textContent = message;
}

async function requestSession() {
  const delays = [0, 1200, 2500];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    try {
      const res = await fetch(VyntrixConfig.apiUrl('/api/auth/session'), { credentials: 'include' });
      if (!res.ok) throw new Error(`Session request returned ${res.status}`);
      const data = await res.json();
      setGlobalConnectionState();
      return data;
    } catch (err) {
      console.error('Failed to verify session status:', err);
      if (attempt < delays.length - 1) {
        setGlobalConnectionState('Vyntrix is waking up. Reconnecting securely…');
      }
    }
  }
  setGlobalConnectionState('Vyntrix is currently unreachable. Check your connection and try again.', 'error');
  return { loggedIn: false, unavailable: true };
}

function checkSession({ refresh = false } = {}) {
  if (refresh || !sessionRequest) sessionRequest = requestSession();
  return sessionRequest;
}

async function updateNavbar(options) {
  const session = await checkSession(options);
  const navActions = document.getElementById('nav-actions');
  const navLinksContainer = document.getElementById('nav-links-container');
  
  if (!navActions || !navLinksContainer) return session;

  if (session.unavailable) {
    navLinksContainer.replaceChildren(createNavLink('link-home', '/', 'Home'));
    const retry = document.createElement('button');
    retry.className = 'btn btn-secondary nav-retry';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => updateNavbar({ refresh: true }));
    navActions.replaceChildren(retry);
  } else if (session.loggedIn) {
    navLinksContainer.replaceChildren(
      createNavLink('link-home', '/', 'Home'),
      createNavLink('link-monitor', '/monitor.html', 'Web Monitor'),
      createNavLink('link-camera', '/camera.html', 'Camera Console')
    );

    const badge = document.createElement('div');
    badge.className = 'user-badge';
    const avatar = document.createElement('div');
    avatar.className = 'user-avatar';
    avatar.textContent = session.user.username.charAt(0).toUpperCase();
    const name = document.createElement('span');
    name.className = 'user-name';
    name.textContent = session.user.username;
    badge.append(avatar, name);
    const logout = document.createElement('button');
    logout.className = 'btn btn-secondary nav-logout';
    logout.textContent = 'Logout';
    logout.addEventListener('click', handleLogout);
    navActions.replaceChildren(badge, logout);
  } else {
    navLinksContainer.replaceChildren(createNavLink('link-home', '/', 'Home'));
    navActions.replaceChildren(
      createNavLink('', '/login.html', 'Login', 'btn btn-secondary'),
      createNavLink('', '/register.html', 'Sign Up', 'btn btn-primary')
    );
  }

  // Highlight active link
  const path = window.location.pathname;
  if (path === '/' || path === '/index.html') {
    const link = document.getElementById('link-home');
    if (link) link.classList.add('active');
  } else if (path.includes('/monitor.html')) {
    const link = document.getElementById('link-monitor');
    if (link) link.classList.add('active');
  } else if (path.includes('/camera.html')) {
    const link = document.getElementById('link-camera');
    if (link) link.classList.add('active');
  }

  return session;
}

function createNavLink(id, href, label, className = 'nav-link') {
  const link = document.createElement('a');
  link.id = id;
  link.href = href;
  link.className = className;
  if (className.startsWith('btn ')) link.classList.add('nav-auth-link');
  link.textContent = label;
  return link;
}

function safeLocalRedirect(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const target = new URL(value, window.location.origin);
    if (target.origin !== window.location.origin) return null;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch (_) {
    return null;
  }
}

async function handleLogout() {
  try {
    const res = await fetch(VyntrixConfig.apiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include' });
    const data = await res.json();
    if (data.success) {
      window.location.href = '/';
    }
  } catch (err) {
    console.error('Logout request failed:', err);
    // Redirect even on network failure to clear local state
    window.location.href = '/';
  }
}

// Redirect helpers for protected pages
async function protectPage() {
  const session = await updateNavbar();
  if (!session.loggedIn && !session.unavailable) {
    window.location.href = `/login.html?redirect=${encodeURIComponent(window.location.pathname)}`;
  }
  return session;
}

async function redirectIfLoggedIn() {
  const session = await checkSession();
  if (session.loggedIn) {
    try {
      const res = await fetch(VyntrixConfig.apiUrl('/api/devices/active-cameras'), { credentials: 'include' });
      const data = await res.json();
      if (data.count === 0) {
        window.location.href = '/camera.html?autostart=true';
      } else {
        window.location.href = '/monitor.html';
      }
    } catch (err) {
      window.location.href = '/monitor.html';
    }
  }
}

// Run navbar update automatically on load if element is present
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('nav-actions')) {
    updateNavbar();
  }
});
