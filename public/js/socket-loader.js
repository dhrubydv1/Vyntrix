// Load Socket.IO from the configured persistent backend, not the frontend host.
window.VyntrixSocketReady = new Promise((resolve, reject) => {
  const script = document.createElement('script');
  script.src = VyntrixConfig.apiUrl('/socket.io/socket.io.js');
  script.onload = resolve;
  script.onerror = () => reject(new Error('Unable to load Socket.IO from the backend'));
  document.head.appendChild(script);
});
