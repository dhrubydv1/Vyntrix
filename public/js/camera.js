// Camera Console Logic - Vyntrix

let socket;
let localStream = null;
let userId = null;
let cameraName = 'Camera';
let isStreaming = false;
let iceServers = null;

// WebRTC connections map: monitorSocketId -> RTCPeerConnection
const peerConnections = {};

// Motion Detection Variables
let prevFrameData = null;
let motionIntervalId = null;
let motionDetectionEnabled = false;
let alertCooldown = false;
let alertCooldownTimeoutId = null;
let motionAlertController = null;
const MOTION_COOLDOWN_MS = 10000; // 10 seconds cooldown between uploads

// Audio Synth Alarm (Siren)
let audioCtx = null;
let sirenCarrier = null;
let sirenModulator = null;
let sirenGain = null;

// Initialize Session & Auth
async function init() {
  const session = await protectPage();
  if (session && session.loggedIn) {
    userId = session.user.id;
    window.CCTV_USER_ID = userId;
    // Suggest default camera name based on browser/OS
    const os = navigator.userAgent.includes('Windows') ? 'PC' : 
               navigator.userAgent.includes('Android') ? 'Android' : 
               navigator.userAgent.includes('iPhone') ? 'iPhone' : 'Device';
    document.getElementById('camera-name').value = `${session.user.username}'s ${os} Camera`;
  }
  
  setupDOMListeners();
  setupTimeCounter();
  await window.VyntrixSocketReady;

  // Auto-start camera if redirect query param is present
  const params = new URLSearchParams(window.location.search);
  if (params.get('autostart') === 'true') {
    setTimeout(() => {
      startCamera();
    }, 500);
  }
}

function setupDOMListeners() {
  document.getElementById('btn-start').addEventListener('click', startCamera);
  document.getElementById('btn-stop').addEventListener('click', stopCamera);
  document.getElementById('btn-kill-siren').addEventListener('click', stopSiren);
  
  // Motion settings update
  const sensitivitySlider = document.getElementById('motion-sensitivity');
  const sensitivityValText = document.getElementById('sensitivity-val');
  const motionToggle = document.getElementById('toggle-motion');

  motionDetectionEnabled = motionToggle.checked;
  motionToggle.addEventListener('change', (e) => {
    motionDetectionEnabled = e.target.checked;
    if (motionDetectionEnabled && isStreaming) {
      startMotionDetection();
    } else if (!motionDetectionEnabled) {
      stopMotionDetection();
    }
  });

  sensitivitySlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    if (val <= 20) sensitivityValText.innerText = 'High (Very Sensitive)';
    else if (val <= 45) sensitivityValText.innerText = 'Medium';
    else sensitivityValText.innerText = 'Low (Heavy Movement)';
  });
}

function setupTimeCounter() {
  setInterval(() => {
    const now = new Date();
    const timeStr = now.toISOString().replace('T', ' ').substring(0, 19);
    const el = document.getElementById('stream-time');
    if (el) el.innerText = timeStr;
  }, 1000);
}

// Siren sound synthesis using Web Audio API
function startSiren() {
  if (audioCtx) return; // Already running

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    // Create Nodes
    sirenCarrier = audioCtx.createOscillator();
    sirenModulator = audioCtx.createOscillator();
    const modGain = audioCtx.createGain();
    sirenGain = audioCtx.createGain();
    
    // Configure Carrier (the main sound)
    sirenCarrier.type = 'sawtooth';
    sirenCarrier.frequency.value = 750; // Central frequency
    
    // Configure Modulator (LFO that sweeps the pitch up and down)
    sirenModulator.type = 'sine';
    sirenModulator.frequency.value = 2; // Sweep frequency (2 Hz)
    
    // Modulation depth (amplitude of the sweep: +- 300Hz)
    modGain.gain.value = 300; 
    
    // Volume Gain
    sirenGain.gain.setValueAtTime(0.0, audioCtx.currentTime);
    sirenGain.gain.linearRampToValueAtTime(0.7, audioCtx.currentTime + 0.1); // Fade in
    
    // Connections
    // Modulator -> modGain -> Carrier Frequency (Modulation)
    sirenModulator.connect(modGain);
    modGain.connect(sirenCarrier.frequency);
    
    // Carrier -> Volume -> Speakers
    sirenCarrier.connect(sirenGain);
    sirenGain.connect(audioCtx.destination);
    
    // Start oscillators
    sirenCarrier.start();
    sirenModulator.start();

    // UI Updates
    document.getElementById('local-siren-card').style.background = 'rgba(255, 59, 48, 0.15)';
    document.getElementById('btn-kill-siren').style.display = 'block';
    updateCameraStatus('alerting');
  } catch (err) {
    console.error('Failed to start Web Audio Siren:', err);
  }
}

function stopSiren() {
  if (!audioCtx) return;

  try {
    sirenGain.gain.setValueAtTime(sirenGain.gain.value, audioCtx.currentTime);
    sirenGain.gain.linearRampToValueAtTime(0.0, audioCtx.currentTime + 0.1); // Fade out
    
    const tempCtx = audioCtx;
    const tempCarrier = sirenCarrier;
    const tempModulator = sirenModulator;
    
    audioCtx = null;
    sirenCarrier = null;
    sirenModulator = null;
    sirenGain = null;

    setTimeout(() => {
      tempCarrier.stop();
      tempModulator.stop();
      tempCtx.close();
    }, 150);

    // UI Updates
    document.getElementById('local-siren-card').style.background = 'rgba(255, 59, 48, 0.02)';
    document.getElementById('btn-kill-siren').style.display = 'none';
    if (isStreaming) {
      updateCameraStatus('streaming');
    }
  } catch (err) {
    console.error('Failed to stop Web Audio Siren:', err);
  }
}

// Media stream functions
async function startCamera() {
  cameraName = document.getElementById('camera-name').value.trim() || 'Camera';
  
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: 'environment' } },
      audio: true
    });

    localStream.getTracks().forEach((track) => {
      track.addEventListener('ended', handleLocalStreamEnded);
    });
    
    const previewEl = document.getElementById('webcam-preview');
    previewEl.srcObject = localStream;
    
    // Set UI state
    document.getElementById('btn-start').style.display = 'none';
    document.getElementById('btn-stop').style.display = 'block';
    document.getElementById('camera-name').disabled = true;
    document.getElementById('rec-indicator').style.display = 'flex';
    
    isStreaming = true;
    updateCameraStatus('streaming');

    iceServers = await getIceServers();
    if (!isStreaming) return;

    // Establish Socket.io connection
    connectSocket();
    
    // Start Motion Detection loop
    startMotionDetection();
  } catch (err) {
    alert('Failed to access camera/microphone: ' + err.message);
    console.error('getUserMedia error:', err);
  }
}

function stopCamera() {
  // Stop media tracks
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  const previewEl = document.getElementById('webcam-preview');
  previewEl.srcObject = null;
  
  // Stop motion loop
  stopMotionDetection();
  
  // Close socket
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  // Clean up all WebRTC peers
  Object.keys(peerConnections).forEach(monitorId => {
    cleanPeer(monitorId);
  });

  // Stop siren
  stopSiren();

  // Reset UI
  document.getElementById('btn-start').style.display = 'block';
  document.getElementById('btn-stop').style.display = 'none';
  document.getElementById('camera-name').disabled = false;
  document.getElementById('rec-indicator').style.display = 'none';
  
  isStreaming = false;
  updateCameraStatus('offline');
}

function handleLocalStreamEnded() {
  if (isStreaming) stopCamera();
}

function updateCameraStatus(status) {
  const dot = document.getElementById('camera-status-dot');
  const text = document.getElementById('camera-status-text');
  if (!dot || !text) return;

  dot.className = 'status-indicator';
  if (status === 'streaming') {
    dot.classList.add('streaming');
    text.innerText = 'STREAMING';
  } else if (status === 'alerting') {
    dot.classList.add('alerting');
    text.innerText = '🚨 ALARM TRIPPED';
  } else if (status === 'offline') {
    text.innerText = 'OFFLINE';
  }
}

// Socket IO setup
function connectSocket() {
  socket = io(VyntrixConfig.backendOrigin, { withCredentials: true });
  const signalingSocket = socket;
  
  signalingSocket.on('connect', () => {
    console.log('Connected to signaling server');
    signalingSocket.emit('register-device', {
      type: 'camera',
      cameraName
    });
  });

  signalingSocket.on('disconnect', () => {
    console.warn('Signaling server disconnected; cleaning stale monitor peers');
    Object.keys(peerConnections).forEach(cleanPeer);
  });

  // Relay signals
  signalingSocket.on('webrtc-signal', async ({ senderSocketId, signalData }) => {
    try {
      let pc = peerConnections[senderSocketId];
      if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.iceConnectionState === 'failed')) {
        cleanPeer(senderSocketId);
        pc = null;
      }
      if (!pc) {
        pc = createPeerConnection(senderSocketId, signalingSocket);
      }

      if (signalData.offer) {
        await pc.setRemoteDescription(new RTCSessionDescription(signalData.offer));
        if (peerConnections[senderSocketId] !== pc || !signalingSocket.connected) return;
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (peerConnections[senderSocketId] !== pc || !signalingSocket.connected) return;
        signalingSocket.emit('webrtc-signal', {
          targetSocketId: senderSocketId,
          signalData: { answer }
        });
      } else if (signalData.candidate) {
        if (peerConnections[senderSocketId] !== pc || !signalingSocket.connected) return;
        await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
      }
    } catch (err) {
      console.error('Error handling WebRTC signal:', err);
    }
  });

  // Listen for monitor command triggers
  socket.on('trigger-siren', ({ action }) => {
    if (action === 'start') {
      startSiren();
    } else if (action === 'stop') {
      stopSiren();
    }
  });
}

function createPeerConnection(monitorSocketId, signalingSocket = socket) {
  console.log('Creating RTCPeerConnection for monitor:', monitorSocketId);
  
  const pc = new RTCPeerConnection({
    iceServers
  });

  // Attach local tracks
  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  // ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate && signalingSocketIsActive(signalingSocket, monitorSocketId, pc)) {
      signalingSocket.emit('webrtc-signal', {
        targetSocketId: monitorSocketId,
        signalData: { candidate: event.candidate }
      });
    }
  };

  // Walkie Talkie: handle incoming audio track from monitor
  pc.ontrack = (event) => {
    console.log('Received track from monitor:', event.track.kind);
    if (event.track.kind === 'audio') {
      const audioStream = event.streams[0];
      
      // Play walkie-talkie speaker audio using an HTML audio element
      let monitorAudioEl = document.getElementById(`audio-speaker-${monitorSocketId}`);
      if (!monitorAudioEl) {
        monitorAudioEl = document.createElement('audio');
        monitorAudioEl.id = `audio-speaker-${monitorSocketId}`;
        monitorAudioEl.autoplay = true;
        monitorAudioEl.style.display = 'none';
        document.body.appendChild(monitorAudioEl);
      }
      monitorAudioEl.srcObject = audioStream;
    }
  };

  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    console.log(`ICE connection state for ${monitorSocketId}: ${state}`);
    if (state === 'disconnected' || state === 'failed' || state === 'closed') {
      cleanPeer(monitorSocketId);
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === 'failed' || state === 'disconnected' || state === 'closed') {
      cleanPeer(monitorSocketId);
    }
  };

  peerConnections[monitorSocketId] = pc;
  return pc;
}

function signalingSocketIsActive(currentSocket, monitorSocketId, pc) {
  return Boolean(currentSocket && currentSocket.connected && peerConnections[monitorSocketId] === pc);
}

function cleanPeer(monitorSocketId) {
  const pc = peerConnections[monitorSocketId];
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.oniceconnectionstatechange = null;
    pc.onconnectionstatechange = null;
    pc.close();
    delete peerConnections[monitorSocketId];
  }
  const audioEl = document.getElementById(`audio-speaker-${monitorSocketId}`);
  if (audioEl) {
    audioEl.srcObject = null;
    audioEl.remove();
  }
}

// Client-Side Motion Detection Engine
function startMotionDetection() {
  if (!isStreaming || !motionDetectionEnabled || motionIntervalId) return;

  const video = document.getElementById('webcam-preview');
  const outputCanvas = document.getElementById('motion-canvas');
  const outCtx = outputCanvas.getContext('2d');

  // Small processing canvas to reduce computational overhead
  const processingCanvas = document.createElement('canvas');
  processingCanvas.width = 80;
  processingCanvas.height = 45;
  const procCtx = processingCanvas.getContext('2d');

  motionIntervalId = setInterval(() => {
    if (!motionDetectionEnabled || !isStreaming || video.paused || video.ended || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    // Set output overlay canvas resolution
    outputCanvas.width = video.videoWidth;
    outputCanvas.height = video.videoHeight;

    // Draw video frame to small canvas
    procCtx.drawImage(video, 0, 0, processingCanvas.width, processingCanvas.height);
    const frameData = procCtx.getImageData(0, 0, processingCanvas.width, processingCanvas.height);

    if (prevFrameData) {
      const sensitivity = parseInt(document.getElementById('motion-sensitivity').value); // 10 to 80
      
      // Scan pixels for changes
      const diff = compareFrames(prevFrameData, frameData, sensitivity);
      
      if (diff.ratio > 0.035) { // If > 3.5% of pixels changed
        // Show Motion Warning UI
        showMotionWarning();
        
        // Draw bounding box overlay in neon green
        drawMotionOverlay(outCtx, diff.boxes, video.videoWidth, video.videoHeight, processingCanvas.width, processingCanvas.height);
        
        // Trigger alert post to backend
        triggerMotionAlert();
      } else {
        outCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
        hideMotionWarning();
      }
    }

    prevFrameData = frameData;
  }, 250); // Scan 4 times per second
}

function stopMotionDetection() {
  if (motionIntervalId) {
    clearInterval(motionIntervalId);
    motionIntervalId = null;
  }
  prevFrameData = null;
  alertCooldown = false;

  if (alertCooldownTimeoutId) {
    clearTimeout(alertCooldownTimeoutId);
    alertCooldownTimeoutId = null;
  }

  if (motionAlertController) {
    motionAlertController.abort();
    motionAlertController = null;
  }

  hideMotionWarning();
  
  const canvas = document.getElementById('motion-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function compareFrames(frameA, frameB, sensitivity) {
  const dataA = frameA.data;
  const dataB = frameB.data;
  const w = frameA.width;
  const h = frameA.height;
  
  let changedCount = 0;
  let minX = w, maxX = 0, minY = h, maxY = 0;
  
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      
      // Grayscale conversion
      const grayA = (dataA[idx] + dataA[idx+1] + dataA[idx+2]) / 3;
      const grayB = (dataB[idx] + dataB[idx+1] + dataB[idx+2]) / 3;
      
      if (Math.abs(grayA - grayB) > sensitivity) {
        changedCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const ratio = changedCount / (w * h);
  
  return {
    ratio,
    boxes: changedCount > 0 ? { minX, maxX, minY, maxY } : null
  };
}

function drawMotionOverlay(ctx, boxes, videoW, videoH, procW, procH) {
  ctx.clearRect(0, 0, videoW, videoH);
  if (!boxes) return;

  // Scale back up to full video dimensions
  const scaleX = videoW / procW;
  const scaleY = videoH / procH;

  const x = boxes.minX * scaleX;
  const y = boxes.minY * scaleY;
  const width = (boxes.maxX - boxes.minX + 1) * scaleX;
  const height = (boxes.maxY - boxes.minY + 1) * scaleY;

  // Draw bounding box
  ctx.strokeStyle = '#ff3b30'; // Crimson neon alert box
  ctx.lineWidth = 3;
  ctx.shadowColor = 'rgba(255, 59, 48, 0.6)';
  ctx.shadowBlur = 10;
  ctx.strokeRect(x, y, width, height);
  
  // Reset shadow for next draws
  ctx.shadowBlur = 0;
}

let warningTimeout = null;
function showMotionWarning() {
  const el = document.getElementById('motion-warning');
  if (el) {
    el.style.display = 'block';
    if (warningTimeout) clearTimeout(warningTimeout);
    warningTimeout = setTimeout(hideMotionWarning, 1500);
  }
}

function hideMotionWarning() {
  if (warningTimeout) {
    clearTimeout(warningTimeout);
    warningTimeout = null;
  }
  const el = document.getElementById('motion-warning');
  if (el) el.style.display = 'none';
}

// Upload motion alerts to the backend
async function triggerMotionAlert() {
  if (!isStreaming || !motionDetectionEnabled || alertCooldown) return;
  
  alertCooldown = true;
  const controller = new AbortController();
  motionAlertController = controller;
  console.log('Motion alert triggered! Capturing snapshot...');
  
  // Auto Siren Trigger
  if (document.getElementById('toggle-auto-siren').checked) {
    startSiren();
  }

  try {
    if (!isStreaming || !motionDetectionEnabled) return;

    const video = document.getElementById('webcam-preview');
    
    // Draw high-resolution snapshot
    const captureCanvas = document.createElement('canvas');
    captureCanvas.width = 640;
    captureCanvas.height = 360;
    const ctx = captureCanvas.getContext('2d');
    ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
    
    // Export image as jpeg
    const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.65);

    if (!isStreaming || !motionDetectionEnabled) return;

    // Send to backend
    const res = await fetch(VyntrixConfig.apiUrl('/api/alerts/upload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      signal: controller.signal,
      body: JSON.stringify({
        cameraName,
        image: dataUrl
      })
    });
    
    const result = await res.json();
    if (res.ok && result.success) {
      console.log('Motion snapshot successfully uploaded:', result.alert.imagePath);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Failed to upload motion alert snapshot:', err);
    }
  } finally {
    if (motionAlertController === controller) {
      motionAlertController = null;
    }

    if (isStreaming && motionDetectionEnabled) {
      alertCooldownTimeoutId = setTimeout(() => {
        alertCooldown = false;
        alertCooldownTimeoutId = null;
      }, MOTION_COOLDOWN_MS);
    } else {
      alertCooldown = false;
    }
  }
}

// Initialise on load
document.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', stopCamera);
