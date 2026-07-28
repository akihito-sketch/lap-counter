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

const els = {
  gpsStatus: document.getElementById('gpsStatus'),
  lapCount: document.getElementById('lapCount'),
  distance: document.getElementById('distance'),
  elapsed: document.getElementById('elapsed'),
  pace: document.getElementById('pace'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  message: document.getElementById('message'),
  awayThreshold: document.getElementById('awayThreshold'),
  returnThreshold: document.getElementById('returnThreshold'),
  historyList: document.getElementById('historyList'),
  historyEmpty: document.getElementById('historyEmpty'),
  clearHistoryBtn: document.getElementById('clearHistoryBtn'),
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
  hasLeftStart: false,
  lapCount: 0,
  totalDistanceM: 0,
  startTime: null,
  timerId: null,
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

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (state.tracking && document.visibilityState === 'visible' && !state.wakeLock) {
    requestWakeLock();
  }
});

function onPosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  const point = { lat: latitude, lon: longitude, t: pos.timestamp };

  setGpsStatus('active', `計測中（精度 ${Math.round(accuracy)}m）`);

  if (accuracy > MAX_ACCEPTABLE_ACCURACY_M) {
    // Fix is too noisy to trust for distance/lap math; still show status, skip math.
    return;
  }

  if (!state.startPoint) {
    state.startPoint = point;
    state.lastPoint = point;
    render();
    return;
  }

  if (state.lastPoint) {
    const segment = haversineMeters(state.lastPoint, point);
    const dtSec = Math.max((point.t - state.lastPoint.t) / 1000, 0.001);
    const impliedSpeed = segment / dtSec;
    if (impliedSpeed <= MAX_PLAUSIBLE_SPEED_MPS) {
      state.totalDistanceM += segment;
    }
    // else: treat as GPS noise/jump, don't add to distance, but still update lastPoint below
  }
  state.lastPoint = point;

  const distFromStart = haversineMeters(state.startPoint, point);
  if (!state.hasLeftStart && distFromStart >= settings.awayThreshold) {
    state.hasLeftStart = true;
  } else if (state.hasLeftStart && distFromStart <= settings.returnThreshold) {
    state.hasLeftStart = false;
    state.lapCount += 1;
  }

  render();
}

function onPositionError(err) {
  setGpsStatus('error', 'GPS取得エラー: ' + err.message);
}

async function startTracking() {
  if (!('geolocation' in navigator)) {
    setMessage('この端末・ブラウザは位置情報に対応していません。');
    return;
  }

  state.tracking = true;
  state.startPoint = null;
  state.lastPoint = null;
  state.hasLeftStart = false;
  state.lapCount = 0;
  state.totalDistanceM = 0;
  state.startTime = Date.now();

  els.startBtn.hidden = true;
  els.stopBtn.hidden = false;
  setMessage('スタート地点を取得しています。その場で少し待ってください。');
  setGpsStatus('idle', 'GPS取得中');

  await requestWakeLock();

  state.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
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

  const elapsedMs = state.startTime ? Date.now() - state.startTime : 0;

  if (state.startTime && (state.lapCount > 0 || state.totalDistanceM > 20)) {
    const history = loadHistory();
    history.unshift({
      date: new Date().toISOString(),
      laps: state.lapCount,
      distanceM: Math.round(state.totalDistanceM),
      elapsedMs,
    });
    saveHistory(history.slice(0, 100));
    renderHistory();
  }

  state.tracking = false;
  els.startBtn.hidden = false;
  els.stopBtn.hidden = true;
  setGpsStatus('idle', 'GPS待機中');
  setMessage('計測を終了し、記録を保存しました。');
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

els.startBtn.addEventListener('click', startTracking);
els.stopBtn.addEventListener('click', stopTracking);

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
