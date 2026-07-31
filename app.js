'use strict';

const SETTINGS_KEY = 'lapCounter.settings.v1';
const HISTORY_KEY = 'lapCounter.history.v1';

const DEFAULT_SETTINGS = {
  awayThreshold: 25,   // meters from start point counted as "left the start"
  returnThreshold: 15, // meters from start point counted as "back at the start"
};

// GPS readings jump around. Ignore fixes worse than this accuracy (meters),
// and ignore any single hop that implies an implausible walking speed.
const MAX_ACCEPTABLE_ACCURACY_M = 30;
const MAX_PLAUSIBLE_SPEED_MPS = 4; // ~14.4 km/h, generous for fast walking/light jogging

// A cold GPS fix can genuinely take this long outdoors (longer under tree cover
// or near buildings). After this much waiting, offer to start with whatever fix we have.
const FORCE_START_WAIT_MS = 10000;

const els = {
  gpsStatus: document.getElementById('gpsStatus'),
  lapCount: document.getElementById('lapCount'),
  distance: document.getElementById('distance'),
  elapsed: document.getElementById('elapsed'),
  pace: document.getElementById('pace'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  forceStartBtn: document.getElementById('forceStartBtn'),
  message: document.getElementById('message'),
  awayThreshold: document.getElementById('awayThreshold'),
  returnThreshold: document.getElementById('returnThreshold'),
  historyList: document.getElementById('historyList'),
  historyEmpty: document.getElementById('historyEmpty'),
  clearHistoryBtn: document.getElementById('clearHistoryBtn'),
  lapList: document.getElementById('lapList'),
  lapEmpty: document.getElementById('lapEmpty'),
  lockBtn: document.getElementById('lockBtn'),
  lockOverlay: document.getElementById('lockOverlay'),
  lockProgressBar: document.getElementById('lockProgressBar'),
  lockLapCount: document.getElementById('lockLapCount'),
  lockDistance: document.getElementById('lockDistance'),
  lockElapsed: document.getElementById('lockElapsed'),
  keepAliveAudio: document.getElementById('keepAliveAudio'),
  pipCanvas: document.getElementById('pipCanvas'),
  pipVideo: document.getElementById('pipVideo'),
  pipBtn: document.getElementById('pipBtn'),
};

let settings = loadSettings();
els.awayThreshold.value = settings.awayThreshold;
els.returnThreshold.value = settings.returnThreshold;

const state = {
  tracking: false,
  watchId: null,
  wakeLock: null,
  startPoint: null,
  lastPoint: null,
  pendingPoint: null, // best fix so far while accuracy is still above threshold
  waitStartedAt: null,
  hasLeftStart: false,
  lapCount: 0,
  totalDistanceM: 0,
  startTime: null,
  timerId: null,
  laps: [], // completed lap splits: { lap, splitTimeMs, splitDistanceM }
  lastLapAt: null,
  lastLapDistanceM: 0,
  hiddenAt: null,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatPace(elapsedMs, distanceM) {
  if (distanceM < 50) return '--:--';
  const km = distanceM / 1000;
  const minPerKm = elapsedMs / 60000 / km;
  if (!isFinite(minPerKm) || minPerKm <= 0) return '--:--';
  const m = Math.floor(minPerKm);
  const s = Math.round((minPerKm - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setGpsStatus(kind, text) {
  els.gpsStatus.textContent = text;
  els.gpsStatus.className = 'gps-status gps-status--' + kind;
}

function setMessage(text) {
  els.message.textContent = text || '';
}

function render() {
  els.lapCount.textContent = state.lapCount;
  els.distance.textContent = (state.totalDistanceM / 1000).toFixed(2);
  const elapsedMs = state.startTime ? Date.now() - state.startTime : 0;
  els.elapsed.textContent = formatElapsed(elapsedMs);
  els.pace.textContent = formatPace(elapsedMs, state.totalDistanceM);

  if (!els.lockOverlay.hidden) {
    els.lockLapCount.textContent = state.lapCount;
    els.lockDistance.textContent = (state.totalDistanceM / 1000).toFixed(2);
    els.lockElapsed.textContent = formatElapsed(elapsedMs);
  }

  drawPipFrame(elapsedMs);
}

function drawPipFrame(elapsedMs) {
  const ctx = els.pipCanvas.getContext('2d');
  if (!ctx) return;
  const w = els.pipCanvas.width;
  const h = els.pipCanvas.height;
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#38bdf8';
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText(`${state.lapCount}周`, 16, 46);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '20px sans-serif';
  ctx.fillText(`${(state.totalDistanceM / 1000).toFixed(2)}km ・ ${formatElapsed(elapsedMs)}`, 16, 84);
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {
    // Not fatal: tracking still works, screen may just turn off.
  }
}

function startKeepAlive() {
  // Best effort only: some mobile browsers give a page noticeably more background
  // runtime while it holds active audio playback (a recognized legitimate background
  // use case). This does not guarantee GPS keeps updating once another app is in front —
  // that is still governed separately by the OS/browser's location permission policy.
  try {
    els.keepAliveAudio.play().catch(() => {});
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: '周回カウンター計測中' });
      navigator.mediaSession.playbackState = 'playing';
    }
  } catch {
    // Ignore — this is a mitigation, not a requirement for the app to function.
  }
}

function stopKeepAlive() {
  try {
    els.keepAliveAudio.pause();
    els.keepAliveAudio.currentTime = 0;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
    }
  } catch {
    // Ignore.
  }
}

const pipSupported = 'requestPictureInPicture' in HTMLVideoElement.prototype && els.pipCanvas.captureStream;

function startPipVideo() {
  if (!pipSupported) return;
  drawPipFrame(0); // the stream must have at least one real frame before playback can start
  try {
    if (!els.pipVideo.srcObject) {
      els.pipVideo.srcObject = els.pipCanvas.captureStream(2); // 2 fps is plenty for text stats
    }
    // Fire-and-forget: this is a best-effort mitigation and must never block the
    // actual GPS tracking setup below, even if play() stalls on some device/browser.
    els.pipVideo.play().catch(() => {});
  } catch {
    // Not fatal: PiP is a mitigation, not a requirement for the app to function.
  }
}

function stopPipVideo() {
  if (document.pictureInPictureElement === els.pipVideo) {
    document.exitPictureInPicture().catch(() => {});
  }
  els.pipVideo.pause();
}

async function togglePip() {
  if (!pipSupported) {
    setMessage('この端末・ブラウザは小画面表示（Picture-in-Picture）に対応していません。');
    return;
  }
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      await startPipVideo();
      await els.pipVideo.requestPictureInPicture();
    }
  } catch {
    setMessage('小画面表示を開始できませんでした。');
  }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!state.tracking) return;
  if (document.visibilityState === 'hidden') {
    // Remember that the screen/app was hidden at some point; checked on the next GPS fix.
    if (!state.hiddenAt) state.hiddenAt = Date.now();
  } else if (document.visibilityState === 'visible' && !state.wakeLock) {
    requestWakeLock();
  }
});

// Fallback only, for the rare case a gap happens without a visibilitychange event.
// Ordinary GPS updates while walking with the screen on can easily be this far apart
// (poor signal under trees, slow devices), so this must stay generous.
const MAX_GAP_SEC = 45;

function lockStartPoint(point) {
  state.startPoint = point;
  state.lastPoint = point;
  state.startTime = Date.now();
  state.lastLapAt = state.startTime;
  state.lastLapDistanceM = 0;
  state.laps = [];
  els.forceStartBtn.hidden = true;
  setMessage('スタート地点を記録しました。1周歩いてみましょう。');
  renderLaps();
  render();
}

function recordLapSplit() {
  const now = Date.now();
  state.laps.unshift({
    lap: state.lapCount,
    splitTimeMs: now - state.lastLapAt,
    splitDistanceM: state.totalDistanceM - state.lastLapDistanceM,
  });
  state.lastLapAt = now;
  state.lastLapDistanceM = state.totalDistanceM;
  renderLaps();
}

function onPosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  const point = { lat: latitude, lon: longitude, t: pos.timestamp };

  if (accuracy > MAX_ACCEPTABLE_ACCURACY_M) {
    // Fix is too noisy to trust for distance/lap math; keep the user posted, skip math.
    state.pendingPoint = point;
    setGpsStatus('idle', `精度待ち（現在 ${Math.round(accuracy)}m）`);
    if (!state.startPoint) {
      setMessage(`GPSの精度が上がるのを待っています（現在 ${Math.round(accuracy)}m）。屋外の見晴らしの良い場所でお待ちください。`);
      if (state.waitStartedAt && Date.now() - state.waitStartedAt >= FORCE_START_WAIT_MS) {
        els.forceStartBtn.hidden = false;
      }
    }
    return;
  }

  setGpsStatus('active', `計測中（精度 ${Math.round(accuracy)}m）`);

  if (!state.startPoint) {
    lockStartPoint(point);
    return;
  }

  if (state.lastPoint) {
    const dtSec = (point.t - state.lastPoint.t) / 1000;
    const wasHidden = state.hiddenAt !== null;
    if (wasHidden || dtSec > MAX_GAP_SEC) {
      // Screen was off / app backgrounded (or a long silent gap happened either way).
      // Don't guess a distance across it — just resync from here and say why.
      setMessage(`他のアプリに切り替えていた間（約${Math.round(dtSec)}秒）は距離を計測できていません。計測中はこの画面を開いたままにしてください。`);
    } else {
      const segment = haversineMeters(state.lastPoint, point);
      const impliedSpeed = segment / Math.max(dtSec, 0.001);
      if (impliedSpeed <= MAX_PLAUSIBLE_SPEED_MPS) {
        state.totalDistanceM += segment;
      }
      // else: treat as GPS noise/jump, don't add to distance, but still update lastPoint below
    }
    state.hiddenAt = null;
  }
  state.lastPoint = point;

  const distFromStart = haversineMeters(state.startPoint, point);
  if (!state.hasLeftStart && distFromStart >= settings.awayThreshold) {
    state.hasLeftStart = true;
  } else if (state.hasLeftStart && distFromStart <= settings.returnThreshold) {
    state.hasLeftStart = false;
    state.lapCount += 1;
    recordLapSplit();
  }

  render();
}

const GEOLOCATION_ERROR = { PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };

function onPositionError(err) {
  if (err.code === GEOLOCATION_ERROR.PERMISSION_DENIED) {
    stopTracking();
    setGpsStatus('error', '位置情報の利用が許可されていません');
    setMessage('スマホ側で、このアプリ（ホーム画面のアイコン）に対する位置情報の利用を許可してから、もう一度スタートしてください。');
    return;
  }

  // POSITION_UNAVAILABLE / TIMEOUT: GPS is still warming up. Not fatal — keep watching,
  // the browser continues to retry watchPosition on its own.
  if (!state.startPoint) {
    setGpsStatus('idle', 'GPS取得中（電波待ち）');
    setMessage('屋外の見晴らしの良い場所で少しお待ちください。初回の取得には30秒前後かかることがあります。');
    if (state.pendingPoint && state.waitStartedAt && Date.now() - state.waitStartedAt >= FORCE_START_WAIT_MS) {
      els.forceStartBtn.hidden = false;
    }
  } else {
    setGpsStatus('error', '一時的にGPS信号が届いていません');
  }
}

async function startTracking() {
  if (!('geolocation' in navigator)) {
    setMessage('この端末・ブラウザは位置情報に対応していません。');
    return;
  }

  state.tracking = true;
  state.startPoint = null;
  state.lastPoint = null;
  state.pendingPoint = null;
  state.hasLeftStart = false;
  state.lapCount = 0;
  state.totalDistanceM = 0;
  state.startTime = null; // set once GPS actually locks onto a start point, not on button press
  state.waitStartedAt = Date.now();
  state.laps = [];
  state.lastLapAt = null;
  state.lastLapDistanceM = 0;
  state.hiddenAt = null;
  renderLaps();

  els.startBtn.hidden = true;
  els.stopBtn.hidden = false;
  els.forceStartBtn.hidden = true;
  els.lockBtn.hidden = false;
  els.pipBtn.hidden = !pipSupported;
  setMessage('スタート地点を取得しています。その場で少し待ってください。');
  setGpsStatus('idle', 'GPS取得中');

  await requestWakeLock();
  startKeepAlive();
  startPipVideo();

  state.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    // Cold GPS fixes outdoors commonly take longer than a few seconds; a short
    // timeout here just produces spurious "error" callbacks while it's still warming up.
    timeout: 60000,
  });

  state.timerId = setInterval(render, 1000);
}

function stopTracking() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  releaseWakeLock();
  stopKeepAlive();
  stopPipVideo();

  const elapsedMs = state.startTime ? Date.now() - state.startTime : 0;

  if (state.startTime && (state.lapCount > 0 || state.totalDistanceM > 20)) {
    const history = loadHistory();
    history.unshift({
      date: new Date().toISOString(),
      laps: state.lapCount,
      distanceM: Math.round(state.totalDistanceM),
      elapsedMs,
      lapSplits: state.laps.slice().reverse(), // chronological order for storage
    });
    saveHistory(history.slice(0, 100));
    renderHistory();
  }

  state.tracking = false;
  els.startBtn.hidden = false;
  els.stopBtn.hidden = true;
  els.forceStartBtn.hidden = true;
  els.lockBtn.hidden = true;
  els.pipBtn.hidden = true;
  hideLockOverlay();
  setGpsStatus('idle', 'GPS待機中');
  setMessage(state.startTime ? '計測を終了し、記録を保存しました。' : '計測を中止しました。');
}

function renderLaps() {
  els.lapList.innerHTML = '';
  els.lapEmpty.hidden = state.laps.length > 0;

  for (const split of state.laps) {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `
      <div>${split.lap}周目</div>
      <div class="h-metrics">
        ${(split.splitDistanceM / 1000).toFixed(2)}km・${formatElapsed(split.splitTimeMs)}<br>
        ${formatPace(split.splitTimeMs, split.splitDistanceM)}/km
      </div>
    `;
    els.lapList.appendChild(li);
  }
}

function renderHistory() {
  const history = loadHistory();
  els.historyList.innerHTML = '';
  els.historyEmpty.hidden = history.length > 0;

  for (const record of history) {
    const li = document.createElement('li');
    li.className = 'history-item';
    const d = new Date(record.date);
    const dateLabel = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    li.innerHTML = `
      <div>
        <time>${dateLabel}</time>
        ${record.laps}周
      </div>
      <div class="h-metrics">
        ${(record.distanceM / 1000).toFixed(2)}km<br>
        ${formatElapsed(record.elapsedMs)}
      </div>
    `;
    els.historyList.appendChild(li);
  }
}

const UNLOCK_HOLD_MS = 3000;
let unlockHoldRAF = null;
let unlockHoldStartedAt = null;

function showLockOverlay() {
  els.lockOverlay.hidden = false;
  render();
}

function hideLockOverlay() {
  els.lockOverlay.hidden = true;
  cancelUnlockHold();
}

function cancelUnlockHold() {
  if (unlockHoldRAF) cancelAnimationFrame(unlockHoldRAF);
  unlockHoldRAF = null;
  unlockHoldStartedAt = null;
  els.lockProgressBar.style.width = '0%';
}

function startUnlockHold() {
  unlockHoldStartedAt = Date.now();
  const step = () => {
    const elapsed = Date.now() - unlockHoldStartedAt;
    els.lockProgressBar.style.width = Math.min(100, (elapsed / UNLOCK_HOLD_MS) * 100) + '%';
    if (elapsed >= UNLOCK_HOLD_MS) {
      hideLockOverlay();
      return;
    }
    unlockHoldRAF = requestAnimationFrame(step);
  };
  unlockHoldRAF = requestAnimationFrame(step);
}

els.lockBtn.addEventListener('click', showLockOverlay);
els.pipBtn.addEventListener('click', togglePip);

els.lockOverlay.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  startUnlockHold();
});
els.lockOverlay.addEventListener('pointerup', cancelUnlockHold);
els.lockOverlay.addEventListener('pointercancel', cancelUnlockHold);
els.lockOverlay.addEventListener('contextmenu', (e) => e.preventDefault());

els.startBtn.addEventListener('click', startTracking);
els.stopBtn.addEventListener('click', stopTracking);

els.forceStartBtn.addEventListener('click', () => {
  if (state.pendingPoint) {
    lockStartPoint(state.pendingPoint);
  }
});

els.clearHistoryBtn.addEventListener('click', () => {
  if (confirm('全ての記録を削除します。よろしいですか？')) {
    saveHistory([]);
    renderHistory();
  }
});

els.awayThreshold.addEventListener('change', () => {
  const v = Number(els.awayThreshold.value);
  if (v > 0) {
    settings.awayThreshold = v;
    saveSettings();
  }
});

els.returnThreshold.addEventListener('change', () => {
  const v = Number(els.returnThreshold.value);
  if (v > 0) {
    settings.returnThreshold = v;
    saveSettings();
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

render();
renderHistory();
