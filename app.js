/* =========================================================
   Ottawa Sailing Dashboard — app.js (regenerated)
   ========================================================= */
'use strict';

/* ========================================================= 
   Utilities & shared helpers
   ========================================================= */
const $ = sel => document.querySelector(sel);
const $all = sel => Array.from(document.querySelectorAll(sel));
const fmt = (n, d = 1) => Number.isFinite(n) ? n.toFixed(d) : '—';
const mpsToKts = mps => (mps ?? 0) * 1.94384;
const mToNm = m => m / 1852;

/* ===== Speed smoothing & stationary detection ===== */
const SPEED_ALPHA = 0.25;          // 0..1, lower = smoother
const MOVING_ENTER_KTS = 1.0;      // must exceed this to consider "moving"
const MOVING_EXIT_KTS  = 0.4;      // must drop below this to consider "stopped"
const SPEED_MIN_MOVE_M = 5;        // base displacement gate (meters)
const SPEED_ACC_FACTOR = 0.6;      // raise gate by a fraction of GPS accuracy
let speedEma = null;
let moving = false;

/* =========================================================
   CSS offset for floating map panel
   ========================================================= */
function adjustPanelOffset() {
  const header = document.querySelector('header');
  const nav = document.querySelector('nav');
  const headerH = header ? header.offsetHeight : 0;
  const navH = nav ? nav.offsetHeight : 0;
  const topbarH = headerH + navH;
  document.documentElement.style.setProperty('--nav-h', `${navH}px`);
  document.documentElement.style.setProperty('--topbar-h', `${topbarH}px`);
}
window.addEventListener('resize', adjustPanelOffset);
window.addEventListener('orientationchange', adjustPanelOffset);

/* =========================================================
   Service Worker (relative path for GitHub Pages & others)
   ========================================================= */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js')
    .then(reg => console.log('Service worker registered:', reg.scope))
    .catch(err => console.error('Service worker error:', err));
}

/* =========================================================
   Tabs & collapsibles (robust + simple)
   ========================================================= */
function showTab(tabId, btnEl) {
  const id = String(tabId || '').replace(/^#/, '');
  const tab = document.getElementById(id);
  if (!tab) return;

  document.querySelectorAll('.tab-content.active').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('nav [data-tab].active, nav a.active').forEach(b => b.classList.remove('active'));

  tab.classList.add('active');
  if (btnEl) btnEl.classList.add('active');

  if (id === 'map') {
    initMarineMapOnce();
    adjustPanelOffset();
    if (mmMap) mmMap.invalidateSize();
  }
}

function bindTabsAndCollapsibles() {
  const nav = document.querySelector('nav');
  if (nav) {
    nav.addEventListener('click', (e) => {
      const t = e.target;
      const el = (t instanceof Element) ? t.closest('[data-tab], a[href^="#"]') : null;
      if (!el || !nav.contains(el)) return;
      e.preventDefault();
      const tabId = el.dataset.tab || el.getAttribute('href');
      showTab(tabId, el);
    });

    nav.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element && e.target.closest('[data-tab], a[href^="#"]')) {
        e.preventDefault();
        e.target.click();
      }
    });
  }

  $all('.collapsible').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      const content = btn.nextElementSibling;
      if (content) content.style.display = (content.style.display === 'block' ? 'none' : 'block');
      adjustPanelOffset(); // keep panel positioned if height changes
    });
  });

  // initial tab
  const activeNav = document.querySelector('nav [data-tab].active, nav a.active');
  if (activeNav) {
    showTab(activeNav.dataset.tab || activeNav.getAttribute('href'), activeNav);
  } else {
    const first = document.querySelector('nav [data-tab], nav a[href^="#"]');
    if (first) showTab(first.dataset.tab || first.getAttribute('href'), first);
  }
}

/* =========================================================
   Weather widget loader
   ========================================================= */
(function loadWeatherWidget(d, s, id) {
  const fjs = d.getElementsByTagName(s)[0];
  if (!d.getElementById(id)) {
    const js = d.createElement(s); js.id = id;
    js.src = 'https://weatherwidget.io/js/widget.min.js';
    fjs.parentNode.insertBefore(js, fjs);
  }
})(document, 'script', 'weatherwidget-io-js');

/* =========================================================
   Water level calculator (Info tab)
   ========================================================= */
$('#calc-offset')?.addEventListener('click', () => {
  const datum = 57.9;
  const input = parseFloat($('#levelInput')?.value ?? '');
  const result = $('#offsetResult');
  if (!Number.isFinite(input)) {
    if (result) result.innerHTML = "<span style='color: red;'>Please enter a value.</span>";
    return;
  }
  const offset = input - datum;
  const offsetFeet = offset * 3.28084;
  const direction = offset >= 0 ? "deeper" : "shallower";
  const color = offset >= 0 ? "green" : "red";
  if (result) {
    result.innerHTML =
      `Current Level: <strong>${input.toFixed(2)} m MASL</strong><br>` +
      `Offset from Datum: <strong style="color:${color};">${offset.toFixed(2)} m</strong> ` +
      `(<strong>${Math.abs(offsetFeet).toFixed(1)} ft ${direction}</strong>)`;
  }
});

/* =========================================================
   Singleton GEO watcher (with Firefox prompt kick)
   ========================================================= */
const GEO = (() => {
  let watchId = null;
  const listeners = new Set();
  let retriedLowAcc = false;

  const notify = (type, payload) => { for (const fn of listeners) { try { fn(type, payload); } catch (_) {} } };
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const stop = () => { if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } };

  function getOnce(opts) {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, opts);
    });
  }

  async function start(preferHighAccuracy = true) {
    if (!('geolocation' in navigator)) { notify('error', new Error('Geolocation not supported')); return; }

    try {
      if (navigator.permissions?.query) {
        const st = await navigator.permissions.query({ name: 'geolocation' });
        notify('perm', st.state);
      }
    } catch {}

    notify('diag', { secure: window.isSecureContext, inIframe: window.top !== window.self });
    if (watchId != null) return;

    const hi = { enableHighAccuracy: preferHighAccuracy, maximumAge: 0, timeout: 15000 };
    const lo = { enableHighAccuracy: false, maximumAge: 600000, timeout: 30000 };

    try { await getOnce({ ...hi, timeout: 5000 }); } catch {}

    function onPos(p) { retriedLowAcc = false; notify('position', p); }
    function onErr(e) {
      notify('error', e);
      if (!retriedLowAcc && (e?.code === 2 || String(e?.message || '').toLowerCase().includes('unavailable'))) {
        retriedLowAcc = true;
        stop();
        watchId = navigator.geolocation.watchPosition(onPos, onErr, lo);
        notify('retry', 'low-accuracy');
      }
    }
    watchId = navigator.geolocation.watchPosition(onPos, onErr, hi);
  }

  return { start, stop, on };
})();

/* =========================================================
   Info tab: GPS widget wiring
   ========================================================= */
(function setupInfoGps() {
  const output = $('#gps-output');
  const mapLink = $('#gps-map-link');
  if (!output || !mapLink) return;

  const cached = localStorage.getItem('lastPosition');
  if (cached) {
    const { lat, lon } = JSON.parse(cached);
    output.innerHTML = `📍 Last known: ${lat}, ${lon}`;
    mapLink.innerHTML = `<a href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" rel="noopener">🗺️ View on Google Maps</a>`;
  }

  function showPosition(position) {
    const lat = position.coords.latitude.toFixed(6);
    const lon = position.coords.longitude.toFixed(6);
    output.innerHTML = `📡 Live position: ${lat}, ${lon} (±${Math.round(position.coords.accuracy)}m)`;
    mapLink.innerHTML = `<a href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" rel="noopener">🗺️ View on Google Maps</a>`;
    localStorage.setItem('lastPosition', JSON.stringify({ lat, lon }));
  }
  function showError(e) {
    if (e.code === 1) output.textContent = "Permission denied. Allow location in the browser’s site settings.";
    else if (e.code === 2) output.textContent = "Position unavailable. On desktop, enable OS Location Services and try again.";
    else if (e.code === 3) output.textContent = "Timeout. Retrying…";
    else output.textContent = `Error (${e.code ?? '—'}): ${e.message || e}`;
  }

  GEO.on((type, payload) => {
    if (type === 'position') showPosition(payload);
    else if (type === 'error') showError(payload);
    else if (type === 'perm' && payload === 'denied') {
      output.textContent = "Location blocked. Click the lock icon → Site settings → Allow Location.";
    } else if (type === 'diag' && !payload.secure) {
      output.textContent = "This page must be served over HTTPS for geolocation.";
    } else if (type === 'retry' && payload === 'low-accuracy') {
      output.textContent = "High-accuracy failed; retrying with network-based location…";
    }
  });

  GEO.start(true);
})();

/* =========================================================
   Marine Map (Leaflet) + GPS integration
   ========================================================= */
const CHARTS = [
  { name: '1550A01', folder: 'tiles_1550A01', minZoom: 10, maxZoom: 16 },
  { name: '1550A04', folder: 'tiles_1550A04', minZoom: 10, maxZoom: 16 },
  { name: '1550B01', folder: 'tiles_1550B01', minZoom: 10, maxZoom: 16 },
  { name: '1550B02', folder: 'tiles_1550B02', minZoom: 10, maxZoom: 16 },
  { name: '1550B03', folder: 'tiles_1550B03', minZoom: 10, maxZoom: 16 },
];

let mmMap, baseOSM, mmBoat = null;
let chartsLoaded = false;
let emaLat = null, emaLon = null, emaHead = null, lastFix = null;
const alpha = 0.25, ema = (c, p) => p == null ? c : alpha * c + (1 - alpha) * p;
let trail = [], trailLine = null, totalDistM = 0;
const TRAIL_MAX_POINTS = 2000, TRAIL_MIN_DIST_M = 5, TRAIL_MIN_SEC = 2;
const LS_POINTS = 'sailTrailPoints_v1', LS_DIST = 'sailTrailDistM_v1';

let courseUp = false;
let follow = true;
let addMarkerActive = false;

let markersLayer = null;
const LS_MARKERS = 'sailMarkers_v1';

const overlayLayers = {};

// --- Heading fusion & resume helpers ---
let compassHeading = null;   // from device orientation (0..360)
let gpsHeading = null;       // from geolocation heading when moving
let prevPointForCog = null;  // previous GPS fix for computed COG
let compassListening = false;
const HEADING_SMOOTH_ALPHA = 0.25;
const MAX_STALE_MS = 4000;

// Prevent duplicate GEO.on wiring for the map
let mapGpsBound = false;
let mapUnsub = null;

// Shortest-path angular smoothing (wrap-aware)
function smoothAngle(prev, next, a = HEADING_SMOOTH_ALPHA) {
  if (!Number.isFinite(next)) return prev ?? null;
  if (prev == null) return ((next % 360) + 360) % 360;
  let delta = ((next - prev + 540) % 360) - 180;
  return (prev + a * delta + 360) % 360;
}

function chooseHeading(rawGpsHeading, speed, lat, lon) {
  // Priority: device compass > GPS heading (>~1 kt) > computed COG
  if (Number.isFinite(compassHeading)) return compassHeading;

  const gh = Number.isFinite(rawGpsHeading) ? rawGpsHeading : gpsHeading;
  if (Number.isFinite(gh) && (speed || 0) > 0.5) return ((gh % 360) + 360) % 360;

  if (prevPointForCog && Number.isFinite(lat) && Number.isFinite(lon)) {
    const r = Math.PI / 180;
    const dLon = (lon - prevPointForCog.lon) * r;
    const y = Math.sin(dLon) * Math.cos(lat * r);
    const x = Math.cos(prevPointForCog.lat * r) * Math.sin(lat * r) -
              Math.sin(prevPointForCog.lat * r) * Math.cos(lat * r) * Math.cos(dLon);
    let brng = Math.atan2(y, x) * 180 / Math.PI;
    return (brng + 360) % 360;
  }
  return emaHead; // fallback
}

function rotateCompass(deg) {
  const n = $('#mm-needle');
  if (n) n.style.transform = `translate(-50%,-90%) rotate(${deg}deg)`;
}

function applyHeadingToUi(deg) {
  const h = Number.isFinite(deg) ? ((deg % 360) + 360) % 360 : 0;
  // Smooth and store
  emaHead = smoothAngle(emaHead, h, HEADING_SMOOTH_ALPHA);
  // Rotate needle
  rotateCompass(emaHead || 0);
  // Rotate boat if course-up
  if (courseUp && mmBoat) {
    const rotNode = mmBoat._icon?.querySelector('#boat-rot');
    if (rotNode) rotNode.setAttribute('transform', `rotate(${emaHead} 50 50)`);
  }
}

async function enableCompass() {
  if (compassListening || !window.DeviceOrientationEvent) return;

  const onDO = (e) => {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') {
      // iOS: already clockwise from north
      h = e.webkitCompassHeading;
    } else if (typeof e.alpha === 'number') {
      // Best-effort: treat alpha as clockwise from north
      h = (360 - e.alpha) % 360;
    }
    if (h != null && isFinite(h)) {
      compassHeading = (h + 360) % 360;
      applyHeadingToUi(compassHeading);   // immediate UI update
    }
  };

  const attach = () => {
    const evt = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(evt, onDO, { passive: true });
    compassListening = true;
  };

  try {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      // iOS 13+ (must be called from user gesture; we call this in Start GPS click)
      const resp = await DeviceOrientationEvent.requestPermission().catch(() => null);
      if (resp === 'granted') attach();
    } else {
      attach();
    }
  } catch { /* ignore */ }
}

function forceFreshFix() {
  if (!('geolocation' in navigator)) return;
  try {
    navigator.geolocation.getCurrentPosition(p => {
      // Only run full map pipeline if map exists; otherwise just refresh lastFix
      if (mmMap) {
        onPos(p);
      } else {
        const { latitude, longitude } = p.coords || {};
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          lastFix = { latitude, longitude, t: p.timestamp };
        }
      }
    }, () => {}, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 8000
    });
  } catch {}
}

async function loadChartBounds(def) {
  try {
    const url = `${def.folder}/tilemapresource.xml`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('no tilemapresource.xml');
    const xml = new DOMParser().parseFromString(await resp.text(), 'application/xml');
    const bb = xml.querySelector('BoundingBox');
    const minx = parseFloat(bb.getAttribute('minx')), miny = parseFloat(bb.getAttribute('miny'));
    const maxx = parseFloat(bb.getAttribute('maxx')), maxy = parseFloat(bb.getAttribute('maxy'));
    const sw = L.CRS.EPSG3857.unproject(L.point(minx, miny));
    const ne = L.CRS.EPSG3857.unproject(L.point(maxx, maxy));
    def.bounds = L.latLngBounds(sw, ne);
    const fmtNode = xml.querySelector('TileFormat');
    def.ext = (fmtNode && (fmtNode.getAttribute('extension') || '').toLowerCase()) || 'png';
    const orders = Array.from(xml.querySelectorAll('TileSets > TileSet'))
      .map(ts => parseInt(ts.getAttribute('order'), 10))
      .filter(Number.isFinite);
    def.minZ = orders.length ? Math.min(...orders) : (def.minZoom ?? 10);
    def.maxZ = orders.length ? Math.max(...orders) : (def.maxZoom ?? 16);
  } catch (e) {
    def.ext = 'png';
    def.minZ = def.minZoom ?? 10;
    def.maxZ = def.maxZoom ?? 16;
    console.warn('Bounds/ext missing for', def.name, e.message || e);
  }
}
async function ensureAllChartBounds() {
  if (chartsLoaded) return;
  await Promise.all(CHARTS.map(d => loadChartBounds(d)));
  chartsLoaded = true;
}
function addAllCharts() {
  CHARTS.forEach(def => {
    const url = `${def.folder}/{z}/{x}/{y}.${def.ext || 'png'}`;
    const layer = L.tileLayer(url, {
      minZoom: def.minZ ?? def.minZoom ?? 10,
      maxZoom: def.maxZ ?? def.maxZoom ?? 16,
      bounds: def.bounds,
      noWrap: true,
      opacity: 0.98
    });
    layer.addTo(mmMap);
    overlayLayers[def.name] = layer;
  });

  const alwaysOnBounds = CHARTS.filter(c => (c.name === '1550A01' || c.name === '1550B01') && c.bounds).map(c => c.bounds);
  if (alwaysOnBounds.length) {
    const union = alwaysOnBounds.slice(1).reduce((acc, b) => acc.extend(b), alwaysOnBounds[0].clone());
    mmMap.fitBounds(union.pad(0.02));
  }
}
function saveTrail() {
  try {
    localStorage.setItem(LS_POINTS, JSON.stringify(trail));
    localStorage.setItem(LS_DIST, String(totalDistM));
  } catch (e) { console.warn('trail save failed', e); }
}
function loadTrail() {
  try {
    const pts = JSON.parse(localStorage.getItem(LS_POINTS) || '[]');
    if (Array.isArray(pts)) {
      const now = Date.now();
      trail = pts.slice(0, TRAIL_MAX_POINTS).map(p =>
        Array.isArray(p) && p.length >= 2 ? [p[0], p[1], p[2] ?? now] : p
      );
    }
    totalDistM = parseFloat(localStorage.getItem(LS_DIST) || '0') || 0;
  } catch (e) { trail = []; totalDistM = 0; }
}
function resetTrail() {
  trail = []; totalDistM = 0;
  if (trailLine) trailLine.setLatLngs(trail);
  saveTrail();
  updateStats({ kts: null });
}
function updateStats({ kts }) {
  const el = document.getElementById('mm-stats');
  if (el) {
    el.innerHTML = `
      <div><strong>Speed:</strong> ${fmt(kts, 1)} kn</div>
      <div><strong>Distance:</strong> ${fmt(mToNm(totalDistM), 2)} NM</div>
    `;
  }
  const h = document.getElementById('mm-speed');
  if (h) h.textContent = fmt(kts, 1);
}
function exportGPX() {
  if (!trail.length) { alert('No trail to export yet.'); return; }
  const nowISO = new Date().toISOString();
  let gpx = '';
  gpx += '<?xml version="1.0" encoding="UTF-8"?>\n';
  gpx += '<gpx version="1.1" creator="Ottawa Sailing Dashboard" ';
  gpx += 'xmlns="http://www.topografix.com/GPX/1/1" ';
  gpx += 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ';
  gpx += 'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 ';
  gpx += 'http://www.topografix.com/GPX/1/1/gpx.xsd">\n';
  gpx += `  <metadata><time>${nowISO}</time></metadata>\n`;
  gpx += '  <trk>\n';
  gpx += '    <name>Track</name>\n';
  gpx += '    <trkseg>\n';
  for (const p of trail) {
    const lat = p[0], lon = p[1], t = p[2];
    gpx += `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">`;
    if (Number.isFinite(t)) gpx += `<time>${new Date(t).toISOString()}</time>`;
    gpx += `</trkpt>\n`;
  }
  gpx += '    </trkseg>\n';
  gpx += '  </trk>\n';
  gpx += '</gpx>\n';

  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const ts = new Date(), pad = n => String(n).padStart(2, '0');
  const fname = `sail_track_${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}.gpx`;

  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(a.href);
  a.remove();
}

/* ===== Markers: persistence ===== */
function saveMarkers(list) {
  try { localStorage.setItem(LS_MARKERS, JSON.stringify(list)); }
  catch (e) { console.warn('markers save failed', e); }
}
function loadMarkers() {
  try {
    const raw = localStorage.getItem(LS_MARKERS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function renderMarkersFromStore() {
  const arr = loadMarkers();
  markersLayer.clearLayers();
  for (const m of arr) {
    const mk = L.marker([m.lat, m.lng], { icon: iconFor(m.type) }).addTo(markersLayer);
    const label = m.type === 'warn' ? '⚠️ Warning' : m.type === 'fish' ? '🐟 Fish' : '📍 Other';
    mk.bindPopup(`${label}<br>${new Date(m.ts).toLocaleString()}`);
  }
}
function addMarkerToStore(latlng, type) {
  const arr = loadMarkers();
  arr.push({ lat: latlng.lat, lng: latlng.lng, type, ts: Date.now() });
  saveMarkers(arr);
}
function clearAllMarkers() {
  saveMarkers([]);
  markersLayer.clearLayers();
}

/* ===== Markers: icons ===== */
function iconFor(type) {
  const color = type === 'warn' ? '#e11' : type === 'fish' ? '#1a8f1a' : '#e6c300';
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.5)"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
}

function setGpsStatus(msg) {
  const el = document.getElementById('mm-gps-status');
  if (el) el.textContent = msg || '';
  if (msg) console.log('[GPS]', msg);
}

function recenterToBoat() {
  if (emaLat != null && emaLon != null && mmMap) {
    follow = true;
    mmMap.setView([emaLat, emaLon], Math.max(mmMap.getZoom(), 15));
    setGpsStatus('Recentered.');
    const chk = $('#mm-follow'); if (chk) chk.checked = true;
  } else {
    setGpsStatus('No GPS fix yet — start GPS first.');
  }
}

function toggleCourseUp(on) {
  courseUp = !!on;
  const rotNode = mmBoat?._icon?.querySelector('#boat-rot');
  if (rotNode) {
    if (courseUp && Number.isFinite(emaHead)) {
      rotNode.setAttribute('transform', `rotate(${emaHead} 50 50)`);
    } else {
      rotNode.setAttribute('transform', 'rotate(0 50 50)');
    }
  }
}

function buildControls() {
  const panel = document.getElementById('mm-panel');
  const header = document.getElementById('mm-toggle');
  if (!panel || !header) return;

  try {
    if (window.L && L.DomEvent) {
      L.DomEvent.disableClickPropagation(panel);
      L.DomEvent.disableScrollPropagation(panel);
    }
  } catch {}

  const doToggle = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const isCollapsed = panel.classList.toggle('collapsed');
    header.setAttribute('aria-expanded', String(!isCollapsed));
  };

  panel.addEventListener('click', (e) => {
    const hit = e.target instanceof Element && e.target.closest('#mm-toggle');
    if (hit) doToggle(e);
  });

  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      doToggle(e);
    }
  });

  // Ensure "Clear markers" button exists
  const dropBtn = $('#mm-drop-marker');
  if (dropBtn) {
    let clearBtn = $('#mm-clearmarkers');
    if (!clearBtn) {
      clearBtn = document.createElement('button');
      clearBtn.id = 'mm-clearmarkers';
      clearBtn.textContent = 'Clear markers';
      (dropBtn.parentElement || panel.querySelector('.ctrl-body'))?.appendChild(clearBtn);
      clearBtn.addEventListener('click', () => {
        if (confirm('Remove all markers?')) {
          clearAllMarkers();
          setGpsStatus('All markers cleared.');
        }
      });
    }
  }

  updateStats({ kts: null });
}

function initMarineMapOnce() {
  if (mmMap) return;
  mmMap = L.map('leaflet-map', { zoomControl: true, attributionControl: true })
    .setView([45.4215, -75.6972], 12);

  baseOSM = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
  }).addTo(mmMap);

  trailLine = L.polyline([], { weight: 3, opacity: 0.85 }).addTo(mmMap);
  loadTrail();
  if (trail.length) trailLine.setLatLngs(trail.map(p => [p[0], p[1]]));

  markersLayer = L.layerGroup().addTo(mmMap);
  renderMarkersFromStore();

  mmMap.on('dragstart zoomstart', () => {
    follow = false;
    const chk = $('#mm-follow'); if (chk) chk.checked = false;
  });

  mmMap.on('click', (e) => {
    if (!addMarkerActive) return;
    const type = $('#mm-marker-type')?.value || 'other';
    const mk = L.marker(e.latlng, { icon: iconFor(type) }).addTo(markersLayer);
    const label = type === 'warn' ? '⚠️ Warning' : type === 'fish' ? '🐟 Fish' : '📍 Other';
    mk.bindPopup(`${label}<br>${new Date().toLocaleString()}`);
    addMarkerToStore(e.latlng, type);
    addMarkerActive = false;
    const btn = $('#mm-drop-marker'); if (btn) btn.textContent = 'Drop marker';
    setGpsStatus('Marker added.');
  });

  buildControls();
  ensureAllChartBounds().then(addAllCharts);
}

function startGpsForMap() {
  if (!('geolocation' in navigator)) {
    setGpsStatus('Geolocation not supported by this browser.');
    return;
  }
  if (!mmMap) initMarineMapOnce();
  setGpsStatus('Starting live GPS…');

  // Enable device compass (iOS permission happens here via user gesture)
  enableCompass();

  if (!mapGpsBound) {
    mapUnsub = GEO.on((type, payload) => {
      if (type === 'position') onPos(payload);
      else if (type === 'error') setGpsStatus(`GPS error: ${payload.message || payload.code}`);
      else if (type === 'perm' && payload === 'denied') setGpsStatus('Location blocked in site settings.');
      else if (type === 'retry' && payload === 'low-accuracy') setGpsStatus('High-accuracy failed; retrying with network-based location…');
    });
    mapGpsBound = true;
  }

  GEO.start(true);
}

function onPos(p) {
  const { latitude, longitude, heading, speed, accuracy } = p.coords;
  const now = p.timestamp;
  const acc = Number.isFinite(accuracy) ? accuracy : 9999;

  // ---------- SPEED (noise-resistant) ----------
  // Preferred: device-reported speed (m/s)
  let instKts = (Number.isFinite(speed) && speed >= 0) ? mpsToKts(speed) : null;

  // Fallback: compute from displacement, gated by accuracy
  if (!Number.isFinite(instKts)) {
    const dt = lastFix ? Math.max(0.5, (now - lastFix.t) / 1000) : null;
    const d  = (lastFix && mmMap)
      ? mmMap.distance([latitude, longitude], [lastFix.latitude, lastFix.longitude])
      : null;

    if (dt && d != null) {
      const minMove = Math.max(SPEED_MIN_MOVE_M, acc * SPEED_ACC_FACTOR);
      instKts = (d >= minMove) ? mpsToKts(d / dt) : 0;
    } else {
      instKts = 0;
    }
  }

  // Smooth (EMA)
  speedEma = (speedEma == null) ? instKts : (SPEED_ALPHA * instKts + (1 - SPEED_ALPHA) * speedEma);

  // Hysteresis: moving vs stopped
  if (!moving && speedEma >= MOVING_ENTER_KTS) moving = true;
  else if (moving && speedEma <= MOVING_EXIT_KTS) moving = false;

  const kts = moving ? Math.max(0, speedEma) : 0;

  // ---------- HEADING ----------
  if (Number.isFinite(heading) && (speed || 0) > 0.5) {
    gpsHeading = (heading + 360) % 360;
  }
  const chosen = chooseHeading(heading, speed, latitude, longitude);
  applyHeadingToUi(chosen);

  // ---------- POSITION smoothing & boat marker ----------
  emaLat = ema(latitude, emaLat);
  emaLon = ema(longitude, emaLon);

  if (mmMap && !mmBoat) {
    const boatIcon = L.divIcon({
      className: 'boat',
      html: `<svg viewBox="0 0 100 100">
               <g id="boat-rot">
                 <polygon class="hull" points="50,8 74,60 50,94 26,60" fill="#003b8e" stroke="#ffffff" stroke-width="3"/>
                 <line class="mast" x1="50" y1="20" x2="50" y2="82" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/>
               </g>
             </svg>`,
      iconSize: [40, 40], iconAnchor: [20, 20]
    });
    mmBoat = L.marker([emaLat, emaLon], { icon: boatIcon, interactive: false }).addTo(mmMap);
    mmMap.setView([emaLat, emaLon], 15);
  } else if (mmBoat) {
    mmBoat.setLatLng([emaLat, emaLon]);
  }

  // ---------- Trail handling (safe if map not init) ----------
  const lastPt = trail.length ? trail[trail.length - 1] : null;
  const tryAddPt = () => {
    if (lastPt && mmMap) {
      const segM = mmMap.distance([emaLat, emaLon], [lastPt[0], lastPt[1]]);
      const segGate = Math.max(SPEED_MIN_MOVE_M, acc * SPEED_ACC_FACTOR);
      if (moving || segM >= segGate) {
        totalDistM += segM;
      }
    }
    trail.push([emaLat, emaLon, now]);
    if (trail.length > TRAIL_MAX_POINTS) trail.splice(0, trail.length - TRAIL_MAX_POINTS);
    if (trailLine) trailLine.setLatLngs(trail.map(p => [p[0], p[1]]));
    saveTrail();
  };

  if (!lastPt) {
    tryAddPt();
  } else {
    const d  = (mmMap && lastPt) ? mmMap.distance([emaLat, emaLon], [lastPt[0], lastPt[1]]) : 0;
    const dt = lastFix ? (now - lastFix.t) / 1000 : Infinity;
    if (d >= TRAIL_MIN_DIST_M && dt >= TRAIL_MIN_SEC) tryAddPt();
  }

  // ---------- Follow pan ----------
  if (follow && mmMap && emaLat != null && emaLon != null) {
    if (!mmMap.getBounds().pad(-0.3).contains([emaLat, emaLon])) {
      mmMap.panTo([emaLat, emaLon], { animate: true });
    }
  }

  updateStats({ kts });
  prevPointForCog = lastFix ? { lat: lastFix.latitude, lon: lastFix.longitude } : null;
  lastFix = { latitude, longitude, t: now };
  setGpsStatus(`Fix: ${latitude.toFixed(5)}, ${longitude.toFixed(5)} @ ${fmt(kts, 1)} kn (±${Math.round(acc)}m)`);
  }

/* =======================
   Wake-from-idle boosters
   ======================= */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Force a fresh high-accuracy fix and restart the watch for snappier updates
    GEO.stop();
    forceFreshFix();
    GEO.start(true);
    if (mmMap) mmMap.invalidateSize({ animate: false });
    // Reset heading smoothing so the first rotation is crisp
    emaHead = null;
    setGpsStatus('Resumed — refreshing GPS & sensors…');
  }
});

// Stale-fix watchdog: if stream stalls, pull a fresh fix (safe even if map not started)
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (!lastFix) { forceFreshFix(); return; }
  const age = Date.now() - lastFix.t;
  if (age > MAX_STALE_MS) forceFreshFix();
}, 2500);

/* =========================================================
   Wire up Marine Map controls (no inline handlers)
   ========================================================= */
function wireControls() {
  $('#mm-startgps')?.addEventListener('click', startGpsForMap);
  $('#mm-recenter')?.addEventListener('click', recenterToBoat);

  $('#mm-follow')?.addEventListener('change', (e) => {
    follow = !!e.target.checked;
    if (follow) recenterToBoat();
  });

  $('#mm-courseup')?.addEventListener('change', (e) => {
    toggleCourseUp(e.target.checked);
  });

  $('#mm-drop-marker')?.addEventListener('click', (e) => {
    addMarkerActive = !addMarkerActive;
    e.target.textContent = addMarkerActive ? 'Tap map…' : 'Drop marker';
    setGpsStatus(addMarkerActive ? 'Tap on the map to place marker.' : '');
  });

  $('#mm-snapnorth')?.addEventListener('click', () => {
    toggleCourseUp(false);
    const chk = $('#mm-courseup'); if (chk) chk.checked = false;
  });

  $('#mm-resettrail')?.addEventListener('click', resetTrail);
  $('#mm-exportgpx')?.addEventListener('click', exportGPX);
}

/* =========================================================
   DOM Ready
   ========================================================= */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    bindTabsAndCollapsibles();
    wireControls();
    adjustPanelOffset();
  }, { once: true });
} else {
  bindTabsAndCollapsibles();
  wireControls();
  adjustPanelOffset();
}
