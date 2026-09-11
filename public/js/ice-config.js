// Shared server-controlled WebRTC ICE configuration.
const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
];
let iceServersPromise = null;

async function getIceServers() {
  if (!iceServersPromise) {
    iceServersPromise = fetch(VyntrixConfig.apiUrl('/api/webrtc/ice-servers'), { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`ICE configuration request failed (${response.status})`);
        const payload = await response.json();
        if (!payload || !Array.isArray(payload.iceServers) || payload.iceServers.length === 0) {
          throw new Error('ICE configuration response was invalid');
        }
        return payload.iceServers;
      })
      .catch((error) => {
        console.warn('Using fallback STUN configuration:', error.message);
        return DEFAULT_ICE_SERVERS;
      });
  }
  return iceServersPromise;
}
