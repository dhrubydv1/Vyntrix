// Shared Authentication Manager for Vyntrix

async function checkSession() {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('Failed to verify session status:', err);
    return { loggedIn: false };
  }
}

async function updateNavbar() {
  const session = await checkSession();
  const navActions = document.getElementById('nav-actions');
  const navLinksContainer = document.getElementById('nav-links-container');
  
  if (!navActions || !navLinksContainer) return session;

  if (session.loggedIn) {
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
    name.style.cssText = 'font-size: 0.9rem; font-weight: 500;';
    name.textContent = session.user.username;
    badge.append(avatar, name);
    const logout = document.createElement('button');
    logout.className = 'btn btn-secondary';
    logout.style.cssText = 'padding: 0.5rem 1rem; font-size: 0.85rem;';
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
  if (className.startsWith('btn ')) link.style.cssText = 'padding: 0.5rem 1.25rem; font-size: 0.85rem;';
  link.textContent = label;
  return link;
}

async function handleLogout() {
  try {
    const res = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
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
  if (!session.loggedIn) {
    window.location.href = `/login.html?redirect=${encodeURIComponent(window.location.pathname)}`;
  }
  return session;
}

async function redirectIfLoggedIn() {
  const session = await checkSession();
  if (session.loggedIn) {
    try {
      const res = await fetch('/api/devices/active-cameras', { credentials: 'same-origin' });
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
