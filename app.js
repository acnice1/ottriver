/* =========================================================
   Ottawa River Navigator — app.js (MapLibre GL patch)
   ========================================================= */
"use strict";

/* =========================================================
   Utilities & shared helpers
   ========================================================= */
const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));
const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "—");
const mpsToKts = (mps) => (mps ?? 0) * 1.94384;
const mToNm = (m) => m / 1852;

// Haversine distance (replaces Leaflet's mmMap.distance)
function geoDistMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* =========================================================
   Tuning parameters — all tweakables up front
   ========================================================= */
// Smoothing (snappier, trusts new data more)
const SPD_EMA_ALPHA = 0.7; // 0.60–0.80 recommended
const HEADING_SMOOTH_ALPHA = 0.5;

// Speed / movement gating
const MOVING_ENTER_KTS = 1.0;
const MOVING_EXIT_KTS = 0.4;
const SPEED_MIN_MOVE_M = 2; // ↓ from 5 (lets slow speeds register)
const SPEED_ACC_FACTOR = 0.2; // ↓ from 0.6 (less harsh accuracy gate)

// Trail cadence (more frequent, based on RAW fixes)
const TRAIL_MAX_POINTS = 30000;
const TRAIL_MIN_DIST_M = 5;
const TRAIL_MIN_SEC = 2;
const TRAIL_REDRAW_MS = 2000;
const TRAIL_SAVE_MS = 15000;
const TRAIL_MAX_ACC_M = 30;
const TRAIL_ACC_DIST_FACTOR = 0.35; // increase point spacing as GPS uncertainty grows
const TRAIL_SEGMENT_GAP_MS = 30 * 60 * 1000; // break the drawn line after 30 min without a stored point
const TRAIL_SEGMENT_JUMP_M = 500; // also break if the next accepted point is implausibly far away

// Anchor watch cadence / quality
const ANCHOR_HISTORY_MAX_POINTS = 8000;
const ANCHOR_HISTORY_MIN_SEC = 10;
const ANCHOR_HISTORY_MIN_DIST_M = 1.5;
const ANCHOR_HISTORY_HEARTBEAT_SEC = 60;
const ANCHOR_HISTORY_GAP_MS = 5 * 60 * 1000;
const ANCHOR_MAX_ACC_M = 30;
const ANCHOR_ALARM_VIBRATE_MS = 30000;

// Staleness / fallbacks
const MAX_STALE_MS = 4000; // watchdog pull-fresh threshold
const NAV_MAX_FIX_AGE_MS = 5000;
const NAV_MAX_ACC_M = 15;
const NAV_MAX_PLAUSIBLE_KTS = 15;
const NAV_MIN_UNCERTAINTY_GROWTH_MPS = 0.75;
const GEO_LO_MAX_AGE_MS = 30000; // ↓ from 600000 (≤30s for low-accuracy retry)
const GEO_HIGH_RETRY_MS = 30000;
const COMPASS_MAX_AGE_MS = 2000;
const COG_MIN_KTS = 1.0;
const COG_ANCHOR_MAX_MS = 15000;
const MAP_BEARING_MIN_MS = 125;
const MAP_BEARING_MIN_DEG = 1.5;

// LocalStorage keys
const LS_POINTS = "sailTrailPoints_v1";
const LS_DIST = "sailTrailDistM_v1";
const LS_MARKERS = "sailMarkers_v1";
const LS_CHART_OPACITY = "sailChartOpacity_v1";
const LS_COMPASS_POS = "sailCompassPosition_v1";
const LS_COMPASS_VISIBLE = "sailCompassVisible_v1";
const LS_WIND_BEARING = "sailWindBearing_v1";
const LS_MEASURE_UNIT = "sailMeasureUnit_v1";
const LS_ROUTE_SPEED = "sailRouteSpeedKts_v1";
const LS_TRAIL_RECORDING = "sailTrailRecording_v1";
const LS_TRAIL_VISIBLE = "sailTrailVisible_v1";
const LS_HYDRO_VISIBLE = "sailHydroVisible_v1";
const LS_SHALLOW_BUFFER = "sailShallowBufferM_v1";
const LS_HAZARD_BUFFER = "sailHazardBufferM_v1";
const LS_ANCHOR_WATCH = "sailAnchorWatch_v1";
const LS_SCREEN_AWAKE = "sailScreenAwake_v1";

/* ===== EMA helpers (explicit position & speed EMAs) ===== */
const makeEma = (alpha) => (current, prev) =>
  prev == null ? current : alpha * current + (1 - alpha) * prev;
const spdEma = makeEma(SPD_EMA_ALPHA);

/* ===== Speed smoothing & stationary detection ===== */
let speedEmaVal = null;
let moving = false;
let windBearing = (() => {
  const v = parseFloat(localStorage.getItem(LS_WIND_BEARING) || "");
  return Number.isFinite(v) ? ((v % 360) + 360) % 360 : null;
})();

/* =========================================================
   CSS offset for floating map panel
   ========================================================= */
function adjustPanelOffset() {
  // The primary navigation is now a vertical rail, so it consumes no map height.
  document.documentElement.style.setProperty("--nav-h", "0px");
  document.documentElement.style.setProperty("--topbar-h", "0px");
}
window.addEventListener("resize", adjustPanelOffset);
window.addEventListener("orientationchange", adjustPanelOffset);

/* =========================================================
   Service Worker (relative path for GitHub Pages & others)
   ========================================================= */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("service-worker.js", { updateViaCache: "none" })
    .then((reg) => console.log("Service worker registered:", reg.scope))
    .catch((err) => console.error("Service worker error:", err));
}

/* =========================================================
   Tabs & collapsibles (robust + simple)
   ========================================================= */
function syncMobilePanelState() {
  document.body.classList.toggle("mobile-panel-open", !!document.querySelector(".map-flyout.open"));
}

function closeMapFlyouts(except = null) {
  $all(".map-flyout.open").forEach((panel) => {
    if (except && panel.dataset.flyout === except) return;
    panel.classList.remove("open");
  });
  $all("#app-rail [data-map-panel]").forEach((btn) => {
    const keep = except && btn.dataset.mapPanel === except;
    btn.classList.toggle("active", !!keep);
    btn.setAttribute("aria-expanded", keep ? "true" : "false");
  });
  syncMobilePanelState();
}

function showTab(tabId, btnEl) {
  const id = String(tabId || "").replace(/^#/, "");
  const tab = document.getElementById(id);
  if (!tab) return;

  document
    .querySelectorAll(".tab-content.active")
    .forEach((t) => t.classList.remove("active"));
  document
    .querySelectorAll("#app-rail [data-tab].active")
    .forEach((b) => b.classList.remove("active"));

  tab.classList.add("active");
  document.body.dataset.activeTab = id;
  if (btnEl) btnEl.classList.add("active");

  if (id === "map") {
    initMarineMapOnce();
    adjustPanelOffset();
    if (mmMap) mmMap.resize();
  } else {
    closeMapFlyouts();
  }
}

function setupMapRail() {
  const rail = $("#app-rail");
  if (!rail) return;
  const panelButtons = $all("#app-rail [data-map-panel]");

  panelButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.mapPanel;
      const panel = document.querySelector(`.map-flyout[data-flyout="${name}"]`);
      if (!panel) return;
      const isOpen = panel.classList.contains("open");

      // Boat, Route and Settings are map-operating controls. Selecting them from
      // another page returns to Charts automatically.
      if (["boat", "route", "settings"].includes(name) && !$("#map")?.classList.contains("active")) {
        showTab("map", null);
      }

      closeMapFlyouts();
      if (!isOpen) {
        panel.classList.add("open");
        btn.classList.add("active");
        btn.setAttribute("aria-expanded", "true");
      }
      syncMobilePanelState();
    });
  });

  $("#mm-mobile-speed-pill")?.addEventListener("click", () => {
    if (!$("#map")?.classList.contains("active")) showTab("map", null);
    const boatBtn = $("#app-rail > .rail-btn[data-map-panel=\"boat\"]");
    const boatPanel = document.querySelector('.map-flyout[data-flyout="boat"]');
    if (!boatPanel?.classList.contains("open")) boatBtn?.click();
  });

  // Compass is a direct control, not a flyout. If used from another page,
  // return to Charts first; setupFloatingCompass owns the visibility toggle.
  $("#mm-show-compass")?.addEventListener("click", () => {
    if (!$("#map")?.classList.contains("active")) showTab("map", null);
  });

  // Phones start with just the bottom dock visible so the map gets maximum room.
  // Desktop/tablet keeps the existing left-rail behaviour.
  const mobileDockQuery = window.matchMedia(
    "(max-width: 760px), (max-width: 900px) and (pointer: coarse)"
  );
  const applyMobileDockState = () => {
    if (mobileDockQuery.matches) closeMapFlyouts();
  };
  applyMobileDockState();
  if (mobileDockQuery.addEventListener) mobileDockQuery.addEventListener("change", applyMobileDockState);
  else mobileDockQuery.addListener?.(applyMobileDockState);
}

function bindTabsAndCollapsibles() {
  const rail = $("#app-rail");
  if (rail) {
    rail.addEventListener("click", (e) => {
      const t = e.target;
      const el = t instanceof Element ? t.closest("[data-tab]") : null;
      if (!el || !rail.contains(el)) return;
      e.preventDefault();
      showTab(el.dataset.tab, el);
    });

    rail.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") &&
          e.target instanceof Element && e.target.closest("[data-tab]")) {
        e.preventDefault();
        e.target.click();
      }
    });
  }

  $all(".collapsible").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
      const content = btn.nextElementSibling;
      if (content) content.style.display = content.style.display === "block" ? "none" : "block";
    });
  });

  // Charts is now the primary/default page.
  showTab("map", null);
}

/* =========================================================
   Weather widget loader
   ========================================================= */
(function loadWeatherWidget(d, s, id) {
  const fjs = d.getElementsByTagName(s)[0];
  if (!d.getElementById(id)) {
    const js = d.createElement(s);
    js.id = id;
    js.src = "https://weatherwidget.io/js/widget.min.js";
    fjs.parentNode.insertBefore(js, fjs);
  }
})(document, "script", "weatherwidget-io-js");

/* =========================================================
   Water level calculator (Info tab)
   ========================================================= */
$("#calc-offset")?.addEventListener("click", () => {
  const datum = 57.9;
  const input = parseFloat($("#levelInput")?.value ?? "");
  const result = $("#offsetResult");
  if (!Number.isFinite(input)) {
    if (result)
      result.innerHTML =
        "<span style='color: red;'>Please enter a value.</span>";
    return;
  }
  const offset = input - datum;
  const offsetFeet = offset * 3.28084;
  const direction = offset >= 0 ? "deeper" : "shallower";
  const color = offset >= 0 ? "green" : "red";
  if (result) {
    result.innerHTML =
      `Current Level: <strong>${input.toFixed(2)} m MASL</strong><br>` +
      `Offset from Datum: <strong style="color:${color};">${offset.toFixed(
        2
      )} m</strong> ` +
      `(<strong>${Math.abs(offsetFeet).toFixed(1)} ft ${direction}</strong>)`;
  }
});

/* =========================================================
   Singleton GEO watcher
   ========================================================= */
const GEO = (() => {
  let watchId = null;
  let starting = false;
  let generation = 0;
  let retryTimer = null;
  const listeners = new Set();

  const notify = (type, payload) => {
    for (const fn of listeners) {
      try {
        fn(type, payload);
      } catch (_) {}
    }
  };
  const on = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const stop = () => {
    generation++;
    if (retryTimer != null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  };

  function start(preferHighAccuracy = true) {
    if (!("geolocation" in navigator)) {
      notify("error", new Error("Geolocation not supported"));
      return;
    }
    if (watchId != null || starting) return;
    starting = true;
    // Permission reporting must not hold up the continuous GPS watch.
    try {
      if (navigator.permissions?.query) {
        navigator.permissions.query({ name: "geolocation" })
          .then((st) => notify("perm", st.state))
          .catch(() => {});
      }
    } catch {}
    notify("diag", {
      secure: window.isSecureContext,
      inIframe: window.top !== window.self,
    });

    const hi = {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000,
    };
    const lo = {
      enableHighAccuracy: false,
      maximumAge: GEO_LO_MAX_AGE_MS, // ↓ from 10 minutes
      timeout: 30000,
    };

    function scheduleHighRetry() {
      if (retryTimer != null) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (watchId != null) startWatch("high");
      }, GEO_HIGH_RETRY_MS);
    }

    function startWatch(mode) {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      const myGeneration = ++generation;
      try {
        watchId = navigator.geolocation.watchPosition(
          (p) => {
            if (myGeneration !== generation) return;
            if (mode === "high" && retryTimer != null) {
              clearTimeout(retryTimer);
              retryTimer = null;
            }
            notify("position", p);
          },
          (e) => {
            if (myGeneration !== generation) return;
            notify("error", e);
            const unavailable = e?.code === 2 || e?.code === 3 ||
              String(e?.message || "").toLowerCase().includes("unavailable");
            if (mode === "high" && unavailable) {
              notify("retry", "low-accuracy");
              startWatch("low");
              scheduleHighRetry();
            }
          },
          mode === "high" ? hi : lo
        );
      } catch (e) {
        notify("error", e);
      }
    }

    startWatch(preferHighAccuracy ? "high" : "low");
    starting = false;
  }

  return { start, stop, on };
})();

/* =========================================================
   Info tab: GPS widget wiring
   ========================================================= */
(function setupInfoGps() {
  const output = $("#gps-output");
  const mapLink = $("#gps-map-link");
  if (!output || !mapLink) return;

  const cached = localStorage.getItem("lastPosition");
  if (cached) {
    const { lat, lon } = JSON.parse(cached);
    output.innerHTML = `📍 Last known: ${lat}, ${lon}`;
    mapLink.innerHTML = `<a href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" rel="noopener">🗺️ View on Google Maps</a>`;
  }

  function showPosition(position) {
    const lat = position.coords.latitude.toFixed(6);
    const lon = position.coords.longitude.toFixed(6);
    output.innerHTML = `📡 Live position: ${lat}, ${lon} (±${Math.round(
      position.coords.accuracy
    )}m)`;
    mapLink.innerHTML = `<a href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" rel="noopener">🗺️ View on Google Maps</a>`;
    localStorage.setItem("lastPosition", JSON.stringify({ lat, lon }));
  }
  function showError(e) {
    if (e.code === 1)
      output.textContent =
        "Permission denied. Allow location in the browser’s site settings.";
    else if (e.code === 2)
      output.textContent =
        "Position unavailable. On desktop, enable OS Location Services and try again.";
    else if (e.code === 3) output.textContent = "Timeout. Retrying…";
    else output.textContent = `Error (${e.code ?? "—"}): ${e.message || e}`;
  }

  GEO.on((type, payload) => {
    if (type === "position") showPosition(payload);
    else if (type === "error") showError(payload);
    else if (type === "perm" && payload === "denied") {
      output.textContent =
        "Location blocked. Click the lock icon → Site settings → Allow Location.";
    } else if (type === "diag" && !payload.secure) {
      output.textContent =
        "This page must be served over HTTPS for geolocation.";
    } else if (type === "retry" && payload === "low-accuracy") {
      output.textContent =
        "High-accuracy failed; retrying with network-based location…";
    }
  });

  GEO.start(true);
})();

/* =========================================================
   Marine Map (MapLibre GL) + GPS integration
   ========================================================= */
const CHARTS = [
  { name: "1550A01", folder: "tiles_1550A01", minZoom: 10, maxZoom: 16 },
  { name: "1550A04", folder: "tiles_1550A04", minZoom: 10, maxZoom: 16 },
  { name: "1550B01", folder: "tiles_1550B01", minZoom: 10, maxZoom: 16 },
  { name: "1550B02", folder: "tiles_1550B02", minZoom: 10, maxZoom: 16 },
  { name: "1550B03", folder: "tiles_1550B03", minZoom: 10, maxZoom: 16 },
];

let mmMap,
  mmBoat = null;
let chartsLoaded = false;
let chartOpacity = (() => {
  const saved = parseFloat(localStorage.getItem(LS_CHART_OPACITY) || "");
  return Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 0.98;
})();
let plotLat = null,
  plotLon = null,
  emaHead = null,
  lastFix = null; // last displayed GPS fix { latitude, longitude, t, acc }
let navFixSuppressed = false;
let navAlertEl = null;
let navIssue = "Waiting for a reliable GPS fix";
let chartQualityText = "Marine chart placement has not been checked";
let freshFixInFlight = false;
let trail = [],
  totalDistM = 0;
let trailWasMoving = false;
let trailRecording = localStorage.getItem(LS_TRAIL_RECORDING) !== "false";
let trailVisible = localStorage.getItem(LS_TRAIL_VISIBLE) !== "false";
let forceTrailSegmentBreak = false;
let currentTripSegmentId = 0;
let trailRedrawAt = 0;
let trailRedrawTimer = null;
let trailSaveTimer = null;
let trailDirty = false;

let courseUp = false;
let follow = true;
let pendingMobileRecenter = false;
let addMarkerActive = false;
let measureActive = false;
let measurePoints = [];
let measureUnit = localStorage.getItem(LS_MEASURE_UNIT) || "nm";
let routeSpeedKts = parseFloat(localStorage.getItem(LS_ROUTE_SPEED) || "4.5") || 4.5;
let routeWaypointMarkers = [];
let routeHydroAssessments = [];
let hydroVisible = localStorage.getItem(LS_HYDRO_VISIBLE) === "true";
let shallowBufferM = Math.min(100, Math.max(1, parseFloat(localStorage.getItem(LS_SHALLOW_BUFFER) || "10") || 10));
let hazardBufferM = Math.min(200, Math.max(1, parseFloat(localStorage.getItem(LS_HAZARD_BUFFER) || "20") || 20));
let hydroIndex = null;
const HYDRO_GRID_DEG = 0.0125;

const anchorWatchDefaults = () => ({
  active: false,
  lat: null,
  lon: null,
  radiusM: 40,
  startedAt: null,
  history: [],
  swingVisible: true,
});
let anchorWatch = (() => {
  const fallback = anchorWatchDefaults();
  try {
    const raw = JSON.parse(localStorage.getItem(LS_ANCHOR_WATCH) || "null");
    if (!raw || typeof raw !== "object") return fallback;
    const lat = Number(raw.lat), lon = Number(raw.lon);
    const active = !!raw.active && Number.isFinite(lat) && Number.isFinite(lon);
    const radiusM = Math.min(250, Math.max(5, Number(raw.radiusM) || 40));
    const history = Array.isArray(raw.history)
      ? raw.history.filter((pt) => Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1]) && Number.isFinite(pt[2]))
          .slice(-ANCHOR_HISTORY_MAX_POINTS)
      : [];
    return {
      active, lat: active ? lat : null, lon: active ? lon : null, radiusM,
      startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
      history, swingVisible: raw.swingVisible !== false,
    };
  } catch (_) {
    return fallback;
  }
})();
let anchorMarker = null;
let anchorCurrentDistanceM = null;
let anchorMaxDistanceM = 0;
let anchorFixAccuracyM = null;
let anchorAlarmActive = false;
let anchorLastVibrateAt = 0;
let anchorWatchDirty = false;
let anchorWatchSaveTimer = null;
let pendingAnchorSet = false;
let anchorAutoResumeAttempted = false;

// Screen Wake Lock is an explicit user preference, independent of GPS/Anchor Watch.
let keepScreenAwake = (() => {
  try { return localStorage.getItem(LS_SCREEN_AWAKE) === "true"; } catch (_) { return false; }
})();
let screenWakeLock = null;
let wakeLockRequestInFlight = false;
let wakeToastTimer = null;

// MapLibre DOM markers we add (keeps API simple)
let markersLayer = [];
const overlayLayers = {};

// --- Heading fusion & resume helpers ---
let compassHeading = null; // from device orientation (0..360)
let compassHeadingAt = 0;
let cogAnchor = null; // distance-gated baseline for calculated COG
let compassListening = false;
let compassStarting = false;
let mapBearingAt = 0;
let mapBearing = null;
let mapBearingTimer = null;

// Shortest-path angular smoothing (wrap-aware)
function smoothAngle(prev, next, a = HEADING_SMOOTH_ALPHA) {
  if (!Number.isFinite(next)) return prev ?? null;
  if (prev == null) return ((next % 360) + 360) % 360;
  let delta = ((next - prev + 540) % 360) - 180;
  return (prev + a * delta + 360) % 360;
}

function chooseHeading(rawGpsHeading, speedKts, lat, lon, accuracy, timestamp) {
  // GPS course is the boat's direction of travel when moving; the phone
  // compass is useful only at low speed and may not align with the hull.
  if (!moving || speedKts < COG_MIN_KTS) {
    cogAnchor = { lat, lon, t: timestamp };
  } else {
    if (Number.isFinite(rawGpsHeading)) {
      cogAnchor = { lat, lon, t: timestamp };
      return ((rawGpsHeading % 360) + 360) % 360;
    }
    // Use the previous fix on entry; accumulate displacement only while the
    // direction is too small relative to GPS accuracy to calculate safely.
    if (!cogAnchor) {
      cogAnchor = lastFix
        ? { lat: lastFix.latitude, lon: lastFix.longitude, t: lastFix.t }
        : { lat, lon, t: timestamp };
    }
    const d = geoDistMeters(cogAnchor.lat, cogAnchor.lon, lat, lon);
    if (timestamp - cogAnchor.t > COG_ANCHOR_MAX_MS) {
      cogAnchor = { lat, lon, t: timestamp };
    } else if (d >= Math.max(2, Number.isFinite(accuracy) ? accuracy * 0.5 : 2)) {
      const r = Math.PI / 180;
      const dLon = (lon - cogAnchor.lon) * r;
      const y = Math.sin(dLon) * Math.cos(lat * r);
      const x =
        Math.cos(cogAnchor.lat * r) * Math.sin(lat * r) -
        Math.sin(cogAnchor.lat * r) * Math.cos(lat * r) * Math.cos(dLon);
      cogAnchor = { lat, lon, t: timestamp };
      return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }
  }
  if (!moving && Number.isFinite(compassHeading) &&
      Date.now() - compassHeadingAt <= COMPASS_MAX_AGE_MS)
    return compassHeading;
  return null; // No current course or fresh compass reading.
}

function rotateCompass(deg) {
  const n = $("#mm-needle");
  if (n) n.style.transform = `translate(-50%,-90%) rotate(${deg}deg)`;
}

function compassPoint(deg) {
  if (!Number.isFinite(deg)) return "—";
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return points[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

function setWindBearing(deg, persist = true) {
  if (deg == null || deg === "" || !Number.isFinite(Number(deg))) {
    windBearing = null;
    if (persist) { try { localStorage.removeItem(LS_WIND_BEARING); } catch {} }
  } else {
    windBearing = ((Number(deg) % 360) + 360) % 360;
    if (persist) { try { localStorage.setItem(LS_WIND_BEARING, String(windBearing)); } catch {} }
  }
  updateWindCompassUi();
  // Wind direction affects every planned leg's point of sail, efficiency colour,
  // and ETA. Rebuild the route source live so dragging the wind arrow immediately
  // recolours the map segments as well as refreshing the leg summary.
  if (typeof updateMeasureSource === "function" && mmMap?.getSource?.("measure")) {
    updateMeasureSource(false);
  } else if (typeof updateMeasureUi === "function") {
    updateMeasureUi();
  }
}

function updateWindCompassUi() {
  const marker = $("#mm-wind-marker");
  const readout = $("#mm-wind-readout");
  const input = $("#mm-wind-bearing");
  if (Number.isFinite(windBearing)) {
    const w = ((windBearing % 360) + 360) % 360;
    if (marker) {
      marker.style.display = "";
      marker.style.transform = `rotate(${w}deg)`;
    }
    if (readout) readout.textContent = `${Math.round(w).toString().padStart(3, "0")}° ${compassPoint(w)}`;
    if (input && document.activeElement !== input) input.value = String(Math.round(w));
  } else {
    if (marker) marker.style.display = "none";
    if (readout) readout.textContent = "not set";
    if (input && document.activeElement !== input) input.value = "";
  }
}

function updateDetailedCompass(deg) {
  if (!Number.isFinite(deg)) return;
  const h = ((deg % 360) + 360) % 360;
  const needle = $("#mm-detailed-needle");
  const degrees = $("#mm-compass-degrees");
  const point = $("#mm-compass-point");
  const source = $("#mm-compass-source");
  if (needle) needle.style.transform = `rotate(${h}deg)`;
  if (degrees) degrees.textContent = `${Math.round(h).toString().padStart(3, "0")}°`;
  if (point) point.textContent = compassPoint(h);
  if (source) source.textContent = moving ? "course over ground" : "device compass";
}

function setupFloatingCompass() {
  const panel = $("#mm-detailed-compass");
  const dragHandle = $("#mm-compass-drag");
  const hideBtn = $("#mm-compass-hide");
  const showBtn = $("#mm-show-compass");
  const ticks = $("#mm-compass-ticks");
  const labels = $("#mm-compass-labels");
  const compassSvg = $("#mm-compass-svg");
  const windInput = $("#mm-wind-bearing");
  const windClear = $("#mm-wind-clear");
  if (!panel || !dragHandle) return;

  const svgNS = "http://www.w3.org/2000/svg";
  if (ticks && !ticks.childNodes.length) {
    for (let deg = 0; deg < 360; deg += 10) {
      const major = deg % 30 === 0;
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", "75");
      line.setAttribute("y1", major ? "8" : "11");
      line.setAttribute("x2", "75");
      line.setAttribute("y2", major ? "18" : "16");
      line.setAttribute("class", `detailed-compass-tick${major ? " major" : ""}`);
      line.setAttribute("transform", `rotate(${deg} 75 75)`);
      ticks.appendChild(line);
    }
  }
  if (labels && !labels.childNodes.length) {
    const dirs = [
      [0, "N", "north"], [45, "NE", ""], [90, "E", ""], [135, "SE", ""],
      [180, "S", ""], [225, "SW", ""], [270, "W", ""], [315, "NW", ""]
    ];
    for (const [deg, label, extra] of dirs) {
      const r = 49;
      const a = (deg - 90) * Math.PI / 180;
      const t = document.createElementNS(svgNS, "text");
      t.setAttribute("x", String(75 + Math.cos(a) * r));
      t.setAttribute("y", String(75 + Math.sin(a) * r));
      t.setAttribute("class", `detailed-compass-cardinal${extra ? ` ${extra}` : ""}`);
      t.textContent = label;
      labels.appendChild(t);
    }
    for (let deg = 30; deg < 360; deg += 30) {
      if (deg % 90 === 0) continue;
      const r = 62;
      const a = (deg - 90) * Math.PI / 180;
      const t = document.createElementNS(svgNS, "text");
      t.setAttribute("x", String(75 + Math.cos(a) * r));
      t.setAttribute("y", String(75 + Math.sin(a) * r));
      t.setAttribute("class", "detailed-compass-label");
      t.textContent = String(deg);
      labels.appendChild(t);
    }
  }

  const bearingFromPointer = (e) => {
    if (!compassSvg) return null;
    const rect = compassSvg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    if (Math.hypot(dx, dy) < rect.width * 0.16) return null;
    return (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  };
  // Wind bearing can be set by tapping/clicking or by dragging continuously
  // around the compass rose. Pointer Events cover mouse, touch, and pen.
  let windDragPointerId = null;
  let windDragBearing = null;

  const updateWindFromPointer = (e, persist = false) => {
    const bearing = bearingFromPointer(e);
    if (!Number.isFinite(bearing)) return;
    windDragBearing = bearing;
    setWindBearing(Math.round(bearing), persist);
  };

  compassSvg?.addEventListener("pointerdown", (e) => {
    // Primary button only for mouse; touch/pen report button 0 as well.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    windDragPointerId = e.pointerId;
    windDragBearing = null;
    compassSvg.setPointerCapture?.(e.pointerId);
    updateWindFromPointer(e, false);
    e.preventDefault();
  });

  compassSvg?.addEventListener("pointermove", (e) => {
    if (windDragPointerId !== e.pointerId) return;
    updateWindFromPointer(e, false);
    e.preventDefault();
  });

  const finishWindDrag = (e) => {
    if (windDragPointerId !== e.pointerId) return;
    updateWindFromPointer(e, false);
    try { compassSvg.releasePointerCapture?.(e.pointerId); } catch {}
    windDragPointerId = null;
    if (Number.isFinite(windDragBearing)) {
      // Persist only once at the end of the gesture.
      setWindBearing(Math.round(windDragBearing), true);
    }
    windDragBearing = null;
    e.preventDefault();
  };

  compassSvg?.addEventListener("pointerup", finishWindDrag);
  compassSvg?.addEventListener("pointercancel", (e) => {
    if (windDragPointerId !== e.pointerId) return;
    try { compassSvg.releasePointerCapture?.(e.pointerId); } catch {}
    windDragPointerId = null;
    if (Number.isFinite(windDragBearing)) setWindBearing(Math.round(windDragBearing), true);
    windDragBearing = null;
  });
  windInput?.addEventListener("change", (e) => {
    const n = Number(e.target.value);
    if (Number.isFinite(n)) setWindBearing(n);
    else setWindBearing(null);
  });
  windInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.target.blur();
  });
  windClear?.addEventListener("click", () => setWindBearing(null));
  updateWindCompassUi();

  const syncCompassToggleLabel = () => {
    if (!showBtn) return;
    const hidden = panel.classList.contains("hidden");
    showBtn.classList.toggle("compass-on", !hidden);
    showBtn.setAttribute("aria-pressed", hidden ? "false" : "true");
    showBtn.setAttribute("aria-label", hidden ? "Show compass" : "Hide compass");
  };

  try {
    const saved = JSON.parse(localStorage.getItem(LS_COMPASS_POS) || "null");
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      panel.style.left = `${saved.left}px`;
      panel.style.top = `${saved.top}px`;
    }
    if (localStorage.getItem(LS_COMPASS_VISIBLE) === "0") panel.classList.add("hidden");
  } catch {}
  syncCompassToggleLabel();

  const clampToViewport = () => {
    const rect = panel.getBoundingClientRect();
    const minTop = Math.max(6, parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--topbar-h")) || 0);
    const railW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--rail-w")) || 0;
    const minLeft = railW + 8;
    const left = Math.min(Math.max(minLeft, rect.left), Math.max(minLeft, window.innerWidth - rect.width - 6));
    const top = Math.min(Math.max(minTop + 6, rect.top), Math.max(minTop + 6, window.innerHeight - rect.height - 6));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    try { localStorage.setItem(LS_COMPASS_POS, JSON.stringify({ left, top })); } catch {}
  };

  let drag = null;
  dragHandle.addEventListener("pointerdown", (e) => {
    if (e.target instanceof Element && e.target.closest("button")) return;
    const rect = panel.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, id: e.pointerId };
    dragHandle.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  dragHandle.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    panel.style.left = `${e.clientX - drag.dx}px`;
    panel.style.top = `${e.clientY - drag.dy}px`;
  });
  const finishDrag = (e) => {
    if (!drag || (e.pointerId != null && e.pointerId !== drag.id)) return;
    drag = null;
    clampToViewport();
  };
  dragHandle.addEventListener("pointerup", finishDrag);
  dragHandle.addEventListener("pointercancel", finishDrag);

  const setCompassVisible = (visible) => {
    panel.classList.toggle("hidden", !visible);
    try { localStorage.setItem(LS_COMPASS_VISIBLE, visible ? "1" : "0"); } catch {}
    syncCompassToggleLabel();
    if (visible) requestAnimationFrame(clampToViewport);
  };

  hideBtn?.addEventListener("click", () => setCompassVisible(false));
  showBtn?.addEventListener("click", () => {
    setCompassVisible(panel.classList.contains("hidden"));
  });
  window.addEventListener("resize", () => {
    if (!panel.classList.contains("hidden")) clampToViewport();
  });

  updateDetailedCompass(emaHead);
}

let mmBoatEl = null; // DOM element inside MapLibre Marker

function updateCourseUpBearing(force = false) {
  if (!courseUp || !mmMap || !Number.isFinite(emaHead)) return;
  const delta = mapBearing == null ? Infinity :
    Math.abs(((emaHead - mapBearing + 540) % 360) - 180);
  if (!force && delta < MAP_BEARING_MIN_DEG) return;
  const elapsed = performance.now() - mapBearingAt;
  if (!force && mapBearing != null && elapsed < MAP_BEARING_MIN_MS) {
    if (mapBearingTimer == null) {
      mapBearingTimer = setTimeout(() => {
        mapBearingTimer = null;
        updateCourseUpBearing();
      }, MAP_BEARING_MIN_MS - elapsed);
    }
    return;
  }
  if (mapBearingTimer != null) {
    clearTimeout(mapBearingTimer);
    mapBearingTimer = null;
  }
  mmMap.jumpTo({ bearing: emaHead });
  mapBearing = emaHead;
  mapBearingAt = performance.now();
}

function applyHeadingToUi(deg) {
  if (!Number.isFinite(deg)) return; // Keep the last orientation until a new heading arrives.
  const h = ((deg % 360) + 360) % 360;
  // Smooth and store
  emaHead = smoothAngle(emaHead, h, HEADING_SMOOTH_ALPHA);
  // Rotate compass needle and update the detailed floating compass.
  rotateCompass(emaHead || 0);
  updateDetailedCompass(emaHead || 0);

  // When course-up is ON: rotate the MAP, keep boat upright.
  // When OFF: keep map north-up, rotate the boat icon.
  updateCourseUpBearing();
  if (mmBoatEl) {
    const rotNode = mmBoatEl.querySelector("#boat-rot");
    if (rotNode) {
      const angle = courseUp ? 0 : emaHead || 0;
      rotNode.setAttribute("transform", `rotate(${angle} 50 50)`);
    }
  }
}

async function enableCompass() {
  if (compassListening || compassStarting || !window.DeviceOrientationEvent) return;
  compassStarting = true;

  // Headings refer to the top of the displayed screen, so a phone used in
  // landscape needs its natural device orientation adjusted to screen rotation.
  const screenAngle = () => {
    const angle = window.screen?.orientation?.angle ?? window.orientation ?? 0;
    return Number.isFinite(angle) ? angle : 0;
  };
  const onDO = (e) => {
    let h = null;
    if (Number.isFinite(e.webkitCompassHeading)) {
      if (Number.isFinite(e.webkitCompassAccuracy) &&
          (e.webkitCompassAccuracy < 0 || e.webkitCompassAccuracy > 30)) return;
      // iOS compass is north-referenced even when e.absolute is unavailable.
      h = e.webkitCompassHeading;
    } else if (e.absolute === true && Number.isFinite(e.alpha) &&
               (!Number.isFinite(e.beta) || Math.abs(e.beta) <= 65) &&
               (!Number.isFinite(e.gamma) || Math.abs(e.gamma) <= 65)) {
      // Relative alpha values have no north reference and must be ignored.
      h = (360 - e.alpha) % 360;
    }
    if (h != null) {
      compassHeading = ((h - screenAngle()) % 360 + 360) % 360;
      compassHeadingAt = Date.now();
      // Sensor events should not override GPS course while under way.
      if (!moving) applyHeadingToUi(compassHeading);
    }
  };

  const attach = () => {
    // Both event names are safe to subscribe to; only absolute samples pass.
    window.addEventListener("deviceorientationabsolute", onDO, { passive: true });
    window.addEventListener("deviceorientation", onDO, { passive: true });
    compassListening = true;
  };

  try {
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      // iOS 13+ (must be called from user gesture; we call this in Start GPS click)
      const resp = await DeviceOrientationEvent.requestPermission().catch(
        () => null
      );
      if (resp === "granted") attach();
    } else {
      attach();
    }
  } catch {
    /* ignore */
  } finally {
    compassStarting = false;
  }
}

function forceFreshFix() {
  if (!("geolocation" in navigator) || !mmMap || freshFixInFlight) return;
  freshFixInFlight = true;
  try {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        freshFixInFlight = false;
        onPos(p);
      },
      () => { freshFixInFlight = false; },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 8000,
      }
    );
  } catch { freshFixInFlight = false; }
}

// Web Mercator unproject (EPSG:3857) to lat/lon (for tilemapresource.xml bounds)
function wmUnproject(x, y) {
  const R = 6378137;
  const toDeg = 180 / Math.PI;
  const lon = (x / R) * toDeg;
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * toDeg;
  return { lat, lon };
}

async function loadChartBounds(def) {
  try {
    const url = `${def.folder}/tilemapresource.xml`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("no tilemapresource.xml");
    const xml = new DOMParser().parseFromString(
      await resp.text(),
      "application/xml"
    );
    const bb = xml.querySelector("BoundingBox");
    const minx = parseFloat(bb.getAttribute("minx")),
      miny = parseFloat(bb.getAttribute("miny"));
    const maxx = parseFloat(bb.getAttribute("maxx")),
      maxy = parseFloat(bb.getAttribute("maxy"));
    const sw = wmUnproject(minx, miny);
    const ne = wmUnproject(maxx, maxy);
    def.bounds = [sw.lon, sw.lat, ne.lon, ne.lat]; // [w,s,e,n]
    const fmtNode = xml.querySelector("TileFormat");
    def.ext =
      (fmtNode && (fmtNode.getAttribute("extension") || "").toLowerCase()) ||
      "png";
    const orders = Array.from(xml.querySelectorAll("TileSets > TileSet"))
      .map((ts) => parseInt(ts.getAttribute("order"), 10))
      .filter(Number.isFinite);
    def.minZ = orders.length ? Math.min(...orders) : def.minZoom ?? 10;
    def.maxZ = orders.length ? Math.max(...orders) : def.maxZoom ?? 16;
  } catch (e) {
    def.ext = "png";
    def.minZ = def.minZoom ?? 10;
    def.maxZ = def.maxZoom ?? 16;
    console.warn("Bounds/ext missing for", def.name, e.message || e);
  }
}
async function ensureAllChartBounds() {
  if (chartsLoaded) return;
  await Promise.all(CHARTS.map((d) => loadChartBounds(d)));
  chartsLoaded = true;
}
function addAllCharts() {
  CHARTS.forEach((def) => {
    const srcId = `chart-${def.name}`;
    const lyrId = `chart-${def.name}-lyr`;
    const url = `${def.folder}/{z}/{x}/{y}.${def.ext || "png"}`;
    if (!mmMap.getSource(srcId)) {
      const source = {
        type: "raster",
        tiles: [url],
        tileSize: 256,
        minzoom: def.minZ ?? def.minZoom ?? 10,
        maxzoom: def.maxZ ?? def.maxZoom ?? 16,
      };
      if (def.bounds) source.bounds = def.bounds;
      mmMap.addSource(srcId, source);
      mmMap.addLayer({
        id: lyrId,
        type: "raster",
        source: srcId,
        paint: { "raster-opacity": chartOpacity },
      }, mmMap.getLayer("nav-accuracy-fill") ? "nav-accuracy-fill" : undefined);
    }
  });
  if (mmMap.getLayer("trail-line") && mmMap.getLayer("nav-accuracy-fill"))
    mmMap.moveLayer("trail-line", "nav-accuracy-fill");
  // Keep operational graphics above the marine raster tiles.
  raiseOperationalLayers();
  chartQualityText = "Marine chart alignment has not been independently verified";
  refreshNavStatus();
}

function raiseMeasurementLayers() {
  if (!mmMap) return;
  ["measure-line-casing", "measure-line", "measure-points"].forEach((id) => {
    if (mmMap.getLayer(id)) mmMap.moveLayer(id);
  });
}

function raiseOperationalLayers() {
  if (!mmMap) return;
  // Explicit map stack: charts < accuracy < sailed track < anchor watch < measurement.
  [
    "nav-accuracy-fill", "nav-accuracy-outline",
    "trail-line-casing", "trail-line",
    "anchor-radius-fill", "anchor-radius-outline",
    "anchor-swing-line", "anchor-swing-points", "anchor-distance-line"
  ].forEach((id) => {
    if (mmMap.getLayer(id)) mmMap.moveLayer(id);
  });
  raiseMeasurementLayers();
}

function applyTrailVisibility() {
  if (!mmMap) return;
  const visibility = trailVisible ? "visible" : "none";
  ["trail-line-casing", "trail-line"].forEach((id) => {
    if (mmMap.getLayer(id)) mmMap.setLayoutProperty(id, "visibility", visibility);
  });
}

function setChartOpacity(value, persist = true) {
  const next = Math.min(1, Math.max(0, Number(value)));
  if (!Number.isFinite(next)) return;
  chartOpacity = next;

  if (mmMap) {
    CHARTS.forEach((def) => {
      const lyrId = `chart-${def.name}-lyr`;
      if (mmMap.getLayer(lyrId)) {
        mmMap.setPaintProperty(lyrId, "raster-opacity", chartOpacity);
      }
    });
  }

  const slider = $("#mm-chart-opacity");
  const label = $("#mm-chart-opacity-value");
  if (slider && Number(slider.value) !== Math.round(chartOpacity * 100)) {
    slider.value = String(Math.round(chartOpacity * 100));
  }
  if (label) label.textContent = `${Math.round(chartOpacity * 100)}%`;

  if (persist) {
    try {
      localStorage.setItem(LS_CHART_OPACITY, String(chartOpacity));
    } catch (_) {}
  }
}

function saveTrail() {
  try {
    localStorage.setItem(LS_POINTS, JSON.stringify(trail));
    localStorage.setItem(LS_DIST, String(totalDistM));
    trailDirty = false;
  } catch (e) {
    console.warn("trail save failed", e);
  }
}
function queueTrailSave() {
  trailDirty = true;
  if (trailSaveTimer != null) return;
  trailSaveTimer = setTimeout(() => {
    trailSaveTimer = null;
    if (trailDirty) saveTrail();
  }, TRAIL_SAVE_MS);
}
function flushTrailSave() {
  if (trailSaveTimer != null) clearTimeout(trailSaveTimer);
  trailSaveTimer = null;
  if (trailDirty) saveTrail();
}
function queueTrailRedraw() {
  if (!mmMap?.getSource?.("trail")) return;
  const wait = Math.max(0, TRAIL_REDRAW_MS - (Date.now() - trailRedrawAt));
  if (!wait) {
    if (trailRedrawTimer != null) clearTimeout(trailRedrawTimer);
    trailRedrawTimer = null;
    updateTrailSource();
  } else if (trailRedrawTimer == null) {
    trailRedrawTimer = setTimeout(() => {
      trailRedrawTimer = null;
      updateTrailSource();
    }, wait);
  }
}
function loadTrail() {
  try {
    const pts = JSON.parse(localStorage.getItem(LS_POINTS) || "[]");
    if (Array.isArray(pts)) {
      const now = Date.now();
      trail = pts
        .filter((p) => Array.isArray(p) && p.length >= 2)
        .slice(-TRAIL_MAX_POINTS)
        .map((p) => [p[0], p[1], p[2] ?? now, Number.isFinite(p[3]) ? p[3] : 0]);
    }
    totalDistM = parseFloat(localStorage.getItem(LS_DIST) || "0") || 0;
    currentTripSegmentId = trail.length && Number.isFinite(trail[trail.length - 1][3])
      ? trail[trail.length - 1][3] : 0;
    trailWasMoving = false;
  } catch (e) {
    trail = [];
    totalDistM = 0;
  }
}
function resetTrail() {
  if (trailRedrawTimer != null) clearTimeout(trailRedrawTimer);
  if (trailSaveTimer != null) clearTimeout(trailSaveTimer);
  trailRedrawTimer = trailSaveTimer = null;
  trail = [];
  totalDistM = 0;
  trailWasMoving = false;
  currentTripSegmentId = 0;
  forceTrailSegmentBreak = false;
  trailDirty = true;
  updateTrailSource();
  saveTrail();
  updateStats({ kts: null });
}
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function currentTripStats() {
  const pts = trail.filter((p) => Array.isArray(p) && p[3] === currentTripSegmentId);
  if (pts.length < 2) return { distanceM: 0, elapsedMs: 0, avgKts: 0, maxKts: 0 };
  let distanceM = 0;
  let maxKts = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = geoDistMeters(a[0], a[1], b[0], b[1]);
    distanceM += d;
    const dt = (b[2] - a[2]) / 1000;
    if (dt > 0) maxKts = Math.max(maxKts, Math.min(NAV_MAX_PLAUSIBLE_KTS, mpsToKts(d / dt)));
  }
  const elapsedMs = Math.max(0, pts[pts.length - 1][2] - pts[0][2]);
  const avgKts = elapsedMs > 0 ? mpsToKts(distanceM / (elapsedMs / 1000)) : 0;
  return { distanceM, elapsedMs, avgKts, maxKts };
}

function updateTrackUi() {
  const stats = currentTripStats();
  const distance = $("#mm-track-distance");
  const elapsed = $("#mm-track-time");
  const avg = $("#mm-track-avg");
  const max = $("#mm-track-max");
  if (distance) distance.textContent = `${fmt(mToNm(stats.distanceM), 2)} NM`;
  if (elapsed) elapsed.textContent = formatDuration(stats.elapsedMs);
  if (avg) avg.textContent = `${fmt(stats.avgKts, 1)} kn`;
  if (max) max.textContent = `${fmt(stats.maxKts, 1)} kn`;
  const rec = $("#mm-trail-recording");
  const vis = $("#mm-trail-visible");
  if (rec) rec.checked = trailRecording;
  if (vis) vis.checked = trailVisible;
}

function updateStats({ kts }) {
  const el = document.getElementById("mm-stats");
  if (el) {
    el.textContent = `${trail.length.toLocaleString()} points • ${fmt(mToNm(totalDistM), 2)} NM recorded`;
  }
  const speedText = fmt(kts, 1);
  const h = document.getElementById("mm-speed");
  if (h) h.textContent = speedText;
  const mobile = document.getElementById("mm-mobile-speed");
  if (mobile) mobile.textContent = speedText;
  updateTrackUi();
}

function startNewTrip() {
  const lastSegmentId = trail.length && Number.isFinite(trail[trail.length - 1][3])
    ? trail[trail.length - 1][3] : currentTripSegmentId;
  currentTripSegmentId = Math.max(currentTripSegmentId, lastSegmentId) + 1;
  forceTrailSegmentBreak = true;
  trailWasMoving = false;
  updateStats({ kts: moving ? speedEmaVal : 0 });
  setGpsStatus("New trip started. Previous track history is preserved.");
}

function exportGPX() {
  if (!trail.length) {
    alert("No trail to export yet.");
    return;
  }
  const nowISO = new Date().toISOString();
  let gpx = "";
  gpx += '<?xml version="1.0" encoding="UTF-8"?>\n';
  gpx += '<gpx version="1.1" creator="Ottawa River Navigator" ';
  gpx += 'xmlns="http://www.topografix.com/GPX/1/1" ';
  gpx += 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ';
  gpx += 'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 ';
  gpx += 'http://www.topografix.com/GPX/1/1/gpx.xsd">\n';
  gpx += `  <metadata><time>${nowISO}</time></metadata>\n`;
  gpx += "  <trk>\n";
  gpx += "    <name>Track</name>\n";
  let openSegment = false;
  let activeSegmentId = null;
  for (const p of trail) {
    const lat = p[0],
      lon = p[1],
      t = p[2],
      segmentId = Number.isFinite(p[3]) ? p[3] : 0;
    if (!openSegment || segmentId !== activeSegmentId) {
      if (openSegment) gpx += "    </trkseg>\n";
      gpx += "    <trkseg>\n";
      openSegment = true;
      activeSegmentId = segmentId;
    }
    gpx += `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">`;
    if (Number.isFinite(t)) gpx += `<time>${new Date(t).toISOString()}</time>`;
    gpx += `</trkpt>\n`;
  }
  if (openSegment) gpx += "    </trkseg>\n";
  gpx += "  </trk>\n";
  gpx += "</gpx>\n";

  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const ts = new Date(),
    pad = (n) => String(n).padStart(2, "0");
  const fname = `sail_track_${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(
    ts.getDate()
  )}_${pad(ts.getHours())}${pad(ts.getMinutes())}.gpx`;

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(a.href);
  a.remove();
}

/* ===== Markers: persistence ===== */
function saveMarkers(list) {
  try {
    localStorage.setItem(LS_MARKERS, JSON.stringify(list));
  } catch (e) {
    console.warn("markers save failed", e);
  }
}
function loadMarkers() {
  try {
    const raw = localStorage.getItem(LS_MARKERS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}
function renderMarkersFromStore() {
  // Clear existing DOM markers
  markersLayer.forEach((m) => m.remove());
  markersLayer = [];
  const arr = loadMarkers();
  for (const m of arr) addDomMarker(m.lat, m.lng, m.type, m.ts);
}
function addMarkerToStore(latlng, type) {
  const arr = loadMarkers();
  arr.push({ lat: latlng.lat, lng: latlng.lng, type, ts: Date.now() });
  saveMarkers(arr);
}
function clearAllMarkers() {
  saveMarkers([]);
  markersLayer.forEach((m) => m.remove());
  markersLayer = [];
}

/* ===== Markers: icons (kept for compatibility; DOM markers used below) ===== */
function iconFor(type) {
  const color =
    type === "warn" ? "#e11" : type === "fish" ? "#1a8f1a" : "#e6c300";
  return { color }; // placeholder; actual rendering uses DOM markers
}

// MapLibre DOM marker helper
function addDomMarker(lat, lng, type, ts) {
  const el = document.createElement("div");
  el.style.cssText =
    "width:14px;height:14px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.5)";
  el.style.background =
    type === "warn" ? "#e11" : type === "fish" ? "#1a8f1a" : "#e6c300";
  const label =
    type === "warn" ? "⚠️ Warning" : type === "fish" ? "🐟 Fish" : "📍 Other";
  el.title = ts ? `${label} — ${new Date(ts).toLocaleString()}` : label;

  const mk = new maplibregl.Marker({ element: el, anchor: "center" })
    .setLngLat([lng, lat])
    .addTo(mmMap);

  markersLayer.push(mk);
  return mk;
}

function setGpsStatus(msg) {
  const el = document.getElementById("mm-gps-status");
  if (el) el.textContent = msg || "";
}

function showMobileControlToast(msg, ms = 2200) {
  const el = $("#mm-mobile-control-toast");
  if (!el) return;
  if (wakeToastTimer != null) clearTimeout(wakeToastTimer);
  el.textContent = msg || "";
  el.classList.toggle("show", !!msg);
  if (msg) {
    wakeToastTimer = setTimeout(() => {
      el.classList.remove("show");
      wakeToastTimer = null;
    }, ms);
  }
}

function wakeLockSupported() {
  return !!(window.isSecureContext && navigator.wakeLock &&
    typeof navigator.wakeLock.request === "function");
}

function syncScreenWakeUi() {
  const btn = $("#mm-mobile-wake");
  if (!btn) return;
  const active = !!screenWakeLock && !screenWakeLock.released;
  btn.classList.toggle("awake-on", active);
  btn.classList.toggle("awake-requested", keepScreenAwake && !active);
  btn.setAttribute("aria-pressed", keepScreenAwake ? "true" : "false");
  if (active) {
    btn.setAttribute("aria-label", "Allow screen to sleep");
    btn.title = "Screen awake — tap to allow sleep";
  } else if (keepScreenAwake) {
    btn.setAttribute("aria-label", "Keep screen awake requested; tap to turn off");
    btn.title = "Screen awake requested — reconnecting";
  } else {
    btn.setAttribute("aria-label", "Keep screen awake");
    btn.title = "Keep screen awake";
  }
}

async function acquireScreenWakeLock({ notify = false } = {}) {
  if (!keepScreenAwake) { syncScreenWakeUi(); return false; }
  if (screenWakeLock && !screenWakeLock.released) { syncScreenWakeUi(); return true; }
  if (wakeLockRequestInFlight || document.visibilityState !== "visible") {
    syncScreenWakeUi();
    return false;
  }
  if (!wakeLockSupported()) {
    keepScreenAwake = false;
    try { localStorage.setItem(LS_SCREEN_AWAKE, "false"); } catch (_) {}
    syncScreenWakeUi();
    if (notify) showMobileControlToast(window.isSecureContext
      ? "Screen-awake control is not supported by this browser."
      : "Screen awake requires the app to run from a secure HTTPS/PWA context.", 3200);
    return false;
  }

  wakeLockRequestInFlight = true;
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    screenWakeLock = sentinel;
    sentinel.addEventListener("release", () => {
      if (screenWakeLock === sentinel) screenWakeLock = null;
      syncScreenWakeUi();
    });
    syncScreenWakeUi();
    if (notify) showMobileControlToast("Screen will stay awake.");
    return true;
  } catch (err) {
    screenWakeLock = null;
    syncScreenWakeUi();
    if (notify) showMobileControlToast(`Could not keep screen awake${err?.name ? ` (${err.name})` : ""}.`, 3200);
    return false;
  } finally {
    wakeLockRequestInFlight = false;
  }
}

async function setScreenAwake(on) {
  keepScreenAwake = !!on;
  try { localStorage.setItem(LS_SCREEN_AWAKE, String(keepScreenAwake)); } catch (_) {}

  if (!keepScreenAwake) {
    const lock = screenWakeLock;
    screenWakeLock = null;
    syncScreenWakeUi();
    if (lock && !lock.released) {
      try { await lock.release(); } catch (_) {}
    }
    showMobileControlToast("Screen sleep enabled.");
    return;
  }

  syncScreenWakeUi();
  await acquireScreenWakeLock({ notify: true });
}

function ensureNavAlert() {
  if (navAlertEl || !mmMap) return;
  navAlertEl = document.createElement("div");
  navAlertEl.id = "mm-nav-alert";
  navAlertEl.setAttribute("role", "status");
  navAlertEl.style.cssText =
    "position:absolute;left:12px;bottom:12px;z-index:3;max-width:min(420px,80vw);" +
    "padding:8px 11px;border-radius:6px;background:#7c2020;color:white;" +
    "font:600 13px/1.4 Arial,sans-serif;white-space:pre-line;pointer-events:none;";
  mmMap.getContainer().appendChild(navAlertEl);
  refreshNavStatus();
}

function accuracyPolygon(lat, lon, radius) {
  const coords = [];
  const lat1 = lat * Math.PI / 180, lon1 = lon * Math.PI / 180;
  const arc = radius / 6371000;
  for (let i = 0; i <= 48; i++) {
    const bearing = i * Math.PI * 2 / 48;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(arc) +
      Math.cos(lat1) * Math.sin(arc) * Math.cos(bearing));
    const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(arc) * Math.cos(lat1),
      Math.cos(arc) - Math.sin(lat1) * Math.sin(lat2));
    coords.push([lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]);
  }
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: {} };
}

function accuracyRingRadius() {
  if (!lastFix || !Number.isFinite(lastFix.acc)) return null;
  const age = Math.max(0, (Date.now() - lastFix.t) / 1000);
  return Math.min(50000, lastFix.acc +
    Math.max(NAV_MIN_UNCERTAINTY_GROWTH_MPS, lastFix.speedMps) *
    Math.min(age, NAV_MAX_FIX_AGE_MS / 1000) +
    NAV_MAX_PLAUSIBLE_KTS / 1.94384 *
    Math.max(0, age - NAV_MAX_FIX_AGE_MS / 1000));
}

function updateAccuracyRing() {
  const source = mmMap?.getSource?.("nav-accuracy");
  if (!source) return;
  const radius = accuracyRingRadius();
  source.setData({
    type: "FeatureCollection",
    features: radius != null
      ? [accuracyPolygon(lastFix.latitude, lastFix.longitude, radius)] : [],
  });
}

function refreshNavStatus() {
  const age = lastFix ? Math.max(0, (Date.now() - lastFix.t) / 1000) : null;
  const current = !!lastFix && !navFixSuppressed &&
    Date.now() - lastFix.t >= -1000 &&
    Date.now() - lastFix.t <= NAV_MAX_FIX_AGE_MS &&
    Number.isFinite(lastFix.acc) && lastFix.acc <= NAV_MAX_ACC_M;
  if (mmBoatEl) {
    mmBoatEl.style.visibility = "visible";
    mmBoatEl.classList.toggle("uncertain", !current);
  }
  // The expanding map accuracy area is paused; the marker has one fixed ring.
  // updateAccuracyRing();
  if (!navAlertEl) return;
  const radius = accuracyRingRadius();
  const ringRadius = radius == null ? null : Math.ceil(radius);
  const chartBounds = CHARTS.filter((def) => def.bounds);
  const outsideChart = current && chartBounds.length > 0 &&
    chartBounds.length === CHARTS.length &&
    !chartBounds.some((def) =>
    lastFix.longitude >= def.bounds[0] && lastFix.longitude <= def.bounds[2] &&
    lastFix.latitude >= def.bounds[1] && lastFix.latitude <= def.bounds[3]);
  const accuracy = lastFix && Number.isFinite(lastFix.acc)
    ? `±${Math.round(lastFix.acc)} m` : "accuracy unknown";
  const ring = ringRadius == null ? "no accuracy ring" :
    ringRadius >= 50000 ? "ring capped at 50 km" : `ring ~${ringRadius} m`;
  const position = !lastFix ? navIssue : current
    ? `GPS ${accuracy} · ${age.toFixed(1)} s old · ${ring}`
    : `UNCERTAIN — ${navFixSuppressed ? `${navIssue} · ` : ""}` +
      `last reported position ${accuracy} · ${age.toFixed(0)} s old · ${ring} · yellow boat`;
  navAlertEl.textContent = `${position}\n${outsideChart ? "Outside detected chart bounds — base map only" : chartQualityText}`;
  navAlertEl.style.background = current ? "#244657" : "#7c2020";
}

function validateNavigationFix(p, receivedAt = Date.now()) {
  const c = p?.coords;
  if (!c || !Number.isFinite(c.latitude) || Math.abs(c.latitude) > 90 ||
      !Number.isFinite(c.longitude) || Math.abs(c.longitude) > 180)
    return "GPS coordinates invalid";
  if (!Number.isFinite(p.timestamp) ||
      p.timestamp - receivedAt > 1000)
    return "GPS time invalid";
  if (lastFix && p.timestamp > lastFix.t) {
    const dt = (p.timestamp - lastFix.t) / 1000;
    const d = geoDistMeters(lastFix.latitude, lastFix.longitude, c.latitude, c.longitude);
    if (dt <= 30 && d > NAV_MAX_PLAUSIBLE_KTS / 1.94384 * dt +
        (Number.isFinite(lastFix.acc) ? lastFix.acc : 0) +
        (Number.isFinite(c.accuracy) && c.accuracy > 0 ? c.accuracy : 0))
      return "GPS position jumped implausibly; showing last known fix";
  }
  return null;
}

function recenterToBoat() {
  if (plotLat != null && plotLon != null && mmMap) {
    follow = true;
    mmMap.jumpTo({
      center: [plotLon, plotLat],
      zoom: Math.max(mmMap.getZoom(), 15),
    });
    setGpsStatus("Recentered to last reported GPS position; check the uncertainty indicator.");
    const chk = $("#mm-follow");
    if (chk) chk.checked = true;
    return true;
  }
  setGpsStatus("No GPS position has been received yet.");
  return false;
}

function recenterOrStartGps() {
  if (!mmMap) initMarineMapOnce();

  // If a position is already available, recenter immediately.
  if (recenterToBoat()) {
    pendingMobileRecenter = false;
    return;
  }

  // Otherwise start GPS from this user gesture and recenter automatically
  // when the first accepted position is received.
  pendingMobileRecenter = true;
  follow = true;
  const chk = $("#mm-follow");
  if (chk) chk.checked = true;
  setGpsStatus("Starting GPS — map will recenter on the first position fix…");
  startGpsForMap();
}

function toggleCourseUp(on) {
  courseUp = !!on;
  if (!mmMap) return;
  if (courseUp) {
    if (Number.isFinite(emaHead)) updateCourseUpBearing(true);
    if (mmBoatEl)
      mmBoatEl
        .querySelector("#boat-rot")
        ?.setAttribute("transform", "rotate(0 50 50)");
  } else {
    if (mapBearingTimer != null) clearTimeout(mapBearingTimer);
    mapBearingTimer = null;
    mapBearing = null;
    mmMap.jumpTo({ bearing: 0 });
    mmBoatEl?.querySelector("#boat-rot")
      ?.setAttribute("transform", `rotate(${emaHead || 0} 50 50)`);
  }
}

/* =========================================================
   Hydro intelligence — 1550A
   Land is a hard invalid route. Dark-blue shallow water is checked directly,
   and closest route-to-boundary distance is used for the configured caution zone.
   Point hazards have a configurable exclusion
   radius, except red and green buoys. Data loads from hydro_1550A.js
   so it also works when the app is opened from file://.
   ========================================================= */
function hydroFlattenParts(fc) {
  const parts = [];
  for (const feature of fc?.features || []) {
    const g = feature?.geometry;
    if (!g) continue;
    const polys = g.type === "Polygon" ? [g.coordinates] :
      (g.type === "MultiPolygon" ? g.coordinates : []);
    for (const rings of polys) {
      if (!rings?.length || !rings[0]?.length) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of rings[0]) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      if (Number.isFinite(minX)) parts.push({ rings, bbox: [minX, minY, maxX, maxY] });
    }
  }
  return parts;
}

function hydroCellKey(x, y) {
  return `${Math.floor(x / HYDRO_GRID_DEG)},${Math.floor(y / HYDRO_GRID_DEG)}`;
}

function hydroBuildLayerIndex(fc) {
  const parts = hydroFlattenParts(fc);
  const grid = new Map();
  parts.forEach((part, idx) => {
    const [minX, minY, maxX, maxY] = part.bbox;
    const x0 = Math.floor(minX / HYDRO_GRID_DEG), x1 = Math.floor(maxX / HYDRO_GRID_DEG);
    const y0 = Math.floor(minY / HYDRO_GRID_DEG), y1 = Math.floor(maxY / HYDRO_GRID_DEG);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const key = `${ix},${iy}`;
        let bucket = grid.get(key);
        if (!bucket) grid.set(key, bucket = []);
        bucket.push(idx);
      }
    }
  });
  return { parts, grid };
}

function hydroPointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const hit = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-15) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

function hydroPointInPart(x, y, part) {
  const [minX, minY, maxX, maxY] = part.bbox;
  if (x < minX || x > maxX || y < minY || y > maxY) return false;
  if (!hydroPointInRing(x, y, part.rings[0])) return false;
  for (let i = 1; i < part.rings.length; i++) {
    if (hydroPointInRing(x, y, part.rings[i])) return false;
  }
  return true;
}

function hydroPointInLayer(layer, x, y) {
  if (!layer) return false;
  const bucket = layer.grid.get(hydroCellKey(x, y));
  if (!bucket) return false;
  for (const idx of bucket) {
    if (hydroPointInPart(x, y, layer.parts[idx])) return true;
  }
  return false;
}


function hydroOrient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function hydroOnSegment(ax, ay, bx, by, px, py) {
  const eps = 1e-12;
  return px >= Math.min(ax, bx) - eps && px <= Math.max(ax, bx) + eps &&
         py >= Math.min(ay, by) - eps && py <= Math.max(ay, by) + eps;
}

function hydroSegmentsIntersect(a1, a2, b1, b2) {
  const o1 = hydroOrient(a1[0], a1[1], a2[0], a2[1], b1[0], b1[1]);
  const o2 = hydroOrient(a1[0], a1[1], a2[0], a2[1], b2[0], b2[1]);
  const o3 = hydroOrient(b1[0], b1[1], b2[0], b2[1], a1[0], a1[1]);
  const o4 = hydroOrient(b1[0], b1[1], b2[0], b2[1], a2[0], a2[1]);
  const eps = 1e-12;
  if (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
      ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))) return true;
  if (Math.abs(o1) <= eps && hydroOnSegment(a1[0], a1[1], a2[0], a2[1], b1[0], b1[1])) return true;
  if (Math.abs(o2) <= eps && hydroOnSegment(a1[0], a1[1], a2[0], a2[1], b2[0], b2[1])) return true;
  if (Math.abs(o3) <= eps && hydroOnSegment(b1[0], b1[1], b2[0], b2[1], a1[0], a1[1])) return true;
  if (Math.abs(o4) <= eps && hydroOnSegment(b1[0], b1[1], b2[0], b2[1], a2[0], a2[1])) return true;
  return false;
}

function hydroPartIntersectsSegment(part, a, b) {
  const minX = Math.min(a.lng, b.lng), maxX = Math.max(a.lng, b.lng);
  const minY = Math.min(a.lat, b.lat), maxY = Math.max(a.lat, b.lat);
  const [pMinX, pMinY, pMaxX, pMaxY] = part.bbox;
  if (maxX < pMinX || minX > pMaxX || maxY < pMinY || minY > pMaxY) return false;
  if (hydroPointInPart(a.lng, a.lat, part) || hydroPointInPart(b.lng, b.lat, part)) return true;
  const segA = [a.lng, a.lat], segB = [b.lng, b.lat];
  for (const ring of part.rings) {
    for (let i = 1; i < ring.length; i++) {
      if (hydroSegmentsIntersect(segA, segB, ring[i - 1], ring[i])) return true;
    }
  }
  return false;
}

function hydroRouteIntersectsLayer(layer, a, b) {
  if (!layer) return false;
  const minX = Math.min(a.lng, b.lng), maxX = Math.max(a.lng, b.lng);
  const minY = Math.min(a.lat, b.lat), maxY = Math.max(a.lat, b.lat);
  const x0 = Math.floor(minX / HYDRO_GRID_DEG), x1 = Math.floor(maxX / HYDRO_GRID_DEG);
  const y0 = Math.floor(minY / HYDRO_GRID_DEG), y1 = Math.floor(maxY / HYDRO_GRID_DEG);
  const seen = new Set();
  for (let ix = x0; ix <= x1; ix++) {
    for (let iy = y0; iy <= y1; iy++) {
      const bucket = layer.grid.get(`${ix},${iy}`) || [];
      for (const idx of bucket) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        if (hydroPartIntersectsSegment(layer.parts[idx], a, b)) return true;
      }
    }
  }
  return false;
}

function hydroBuildBoundaryIndex(fc) {
  const segments = [];
  const grid = new Map();

  function addSegment(a, b) {
    if (!a || !b || a.length < 2 || b.length < 2) return;
    const minX = Math.min(a[0], b[0]), minY = Math.min(a[1], b[1]);
    const maxX = Math.max(a[0], b[0]), maxY = Math.max(a[1], b[1]);
    const idx = segments.length;
    segments.push({ a, b, bbox: [minX, minY, maxX, maxY] });
    const x0 = Math.floor(minX / HYDRO_GRID_DEG), x1 = Math.floor(maxX / HYDRO_GRID_DEG);
    const y0 = Math.floor(minY / HYDRO_GRID_DEG), y1 = Math.floor(maxY / HYDRO_GRID_DEG);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const key = `${ix},${iy}`;
        let bucket = grid.get(key);
        if (!bucket) grid.set(key, bucket = []);
        bucket.push(idx);
      }
    }
  }

  for (const feature of fc?.features || []) {
    const g = feature?.geometry;
    if (!g) continue;
    const polys = g.type === "Polygon" ? [g.coordinates] :
      (g.type === "MultiPolygon" ? g.coordinates : []);
    for (const rings of polys) {
      for (const ring of rings || []) {
        if (!ring || ring.length < 2) continue;
        for (let i = 1; i < ring.length; i++) addSegment(ring[i - 1], ring[i]);
        const first = ring[0], last = ring[ring.length - 1];
        if (first && last && (first[0] !== last[0] || first[1] !== last[1])) addSegment(last, first);
      }
    }
  }
  return { segments, grid };
}

function hydroSegmentDistanceMeters(a, b, c, d) {
  const latRef = (a.lat + b.lat + c[1] + d[1]) / 4;
  const mLat = 111320;
  const mLng = 111320 * Math.cos(latRef * Math.PI / 180);
  const lon0 = (a.lng + b.lng + c[0] + d[0]) / 4;
  const lat0 = latRef;
  const A = [(a.lng - lon0) * mLng, (a.lat - lat0) * mLat];
  const B = [(b.lng - lon0) * mLng, (b.lat - lat0) * mLat];
  const C = [(c[0] - lon0) * mLng, (c[1] - lat0) * mLat];
  const D = [(d[0] - lon0) * mLng, (d[1] - lat0) * mLat];

  if (hydroSegmentsIntersect(A, B, C, D)) return 0;

  const pointSeg = (P, X, Y) => {
    const dx = Y[0] - X[0], dy = Y[1] - X[1];
    const denom = dx * dx + dy * dy;
    const t = denom > 0
      ? Math.max(0, Math.min(1, ((P[0] - X[0]) * dx + (P[1] - X[1]) * dy) / denom))
      : 0;
    const qx = X[0] + t * dx, qy = X[1] + t * dy;
    return Math.hypot(P[0] - qx, P[1] - qy);
  };

  return Math.min(
    pointSeg(A, C, D),
    pointSeg(B, C, D),
    pointSeg(C, A, B),
    pointSeg(D, A, B)
  );
}

function hydroRouteBoundaryDistanceMeters(boundary, a, b, searchRadiusM = 10) {
  if (!boundary) return Infinity;
  const latRef = (a.lat + b.lat) / 2;
  const latPad = searchRadiusM / 111320;
  const cosLat = Math.max(0.15, Math.cos(latRef * Math.PI / 180));
  const lngPad = searchRadiusM / (111320 * cosLat);
  const minX = Math.min(a.lng, b.lng) - lngPad;
  const maxX = Math.max(a.lng, b.lng) + lngPad;
  const minY = Math.min(a.lat, b.lat) - latPad;
  const maxY = Math.max(a.lat, b.lat) + latPad;
  const x0 = Math.floor(minX / HYDRO_GRID_DEG), x1 = Math.floor(maxX / HYDRO_GRID_DEG);
  const y0 = Math.floor(minY / HYDRO_GRID_DEG), y1 = Math.floor(maxY / HYDRO_GRID_DEG);

  let best = Infinity;
  const seen = new Set();
  for (let ix = x0; ix <= x1; ix++) {
    for (let iy = y0; iy <= y1; iy++) {
      const bucket = boundary.grid.get(`${ix},${iy}`) || [];
      for (const idx of bucket) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const seg = boundary.segments[idx];
        const [sMinX, sMinY, sMaxX, sMaxY] = seg.bbox;
        if (sMaxX < minX || sMinX > maxX || sMaxY < minY || sMinY > maxY) continue;
        const d = hydroSegmentDistanceMeters(a, b, seg.a, seg.b);
        if (d < best) best = d;
        if (best <= 0.01) return 0;
      }
    }
  }
  return best;
}

function ensureHydroIndex() {
  if (hydroIndex) return hydroIndex;
  const h = window.HYDRO_1550A;
  if (!h?.dark || !h?.land) return null;
  hydroIndex = {
    dark: hydroBuildLayerIndex(h.dark),
    darkBoundary: hydroBuildBoundaryIndex(h.dark),
    land: hydroBuildLayerIndex(h.land),
    hazards: (h.hazards?.features || []).filter((f) => f?.geometry?.type === "Point"),
  };
  const status = $("#mm-hydro-status");
  if (status) status.textContent = "1550A hydro model ready";
  return hydroIndex;
}

function hydroClassAt(lng, lat) {
  const h = ensureHydroIndex();
  if (!h) return "unavailable";
  if (hydroPointInLayer(h.land, lng, lat)) return "land";
  if (hydroPointInLayer(h.dark, lng, lat)) return "dark";

  // White/light layers are primarily visual, so build their point-query indexes
  // lazily only if a caller actually asks for a point classification. This keeps
  // normal routing startup lighter on mobile devices.
  const model = window.HYDRO_1550A || {};
  if (!h.light && model.light) h.light = hydroBuildLayerIndex(model.light);
  if (!h.white && model.white) h.white = hydroBuildLayerIndex(model.white);
  if (h.light && hydroPointInLayer(h.light, lng, lat)) return "light";
  if (h.white && hydroPointInLayer(h.white, lng, lat)) return "white";
  return "other";
}

function routePointHazardDistanceMeters(a, b, feature) {
  const c = feature?.geometry?.coordinates;
  if (!c || c.length < 2) return Infinity;
  const lng = Number(c[0]), lat = Number(c[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return Infinity;
  const mLat = 111320;
  const mLng = 111320 * Math.cos(lat * Math.PI / 180);
  const ax = (a.lng - lng) * mLng, ay = (a.lat - lat) * mLat;
  const bx = (b.lng - lng) * mLng, by = (b.lat - lat) * mLat;
  const dx = bx - ax, dy = by - ay;
  const denom = dx * dx + dy * dy;
  const t = denom > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denom)) : 0;
  const x = ax + t * dx, y = ay + t * dy;
  return Math.hypot(x, y);
}

function hydroHazardIsExempt(feature) {
  const type = String(feature?.properties?.Type || "").trim().toLowerCase();
  return type === "red buoy" || type === "green buoy";
}

function nearestRouteHazard(a, b) {
  const h = ensureHydroIndex();
  if (!h) return null;
  let best = null;
  for (const feature of h.hazards || []) {
    if (hydroHazardIsExempt(feature)) continue;
    const distanceM = routePointHazardDistanceMeters(a, b, feature);
    if (!best || distanceM < best.distanceM) best = { feature, distanceM };
  }
  return best;
}

function routeHydroAssessment(a, b) {
  const h = ensureHydroIndex();
  if (!h) {
    return { kind: "unavailable", label: "Hydro model unavailable", color: "#64748b" };
  }

  const landHit = hydroRouteIntersectsLayer(h.land, a, b);
  const shallowHit = hydroRouteIntersectsLayer(h.dark, a, b);
  const shallowDistanceM = shallowHit ? 0 : hydroRouteBoundaryDistanceMeters(h.darkBoundary, a, b, shallowBufferM);
  const shallowNear = !shallowHit && shallowDistanceM <= shallowBufferM;
  const hazard = nearestRouteHazard(a, b);
  const hazardNear = !!hazard && hazard.distanceM <= hazardBufferM;

  if (landHit) {
    return { kind: "land", label: "⛔ Land / invalid", color: "#ef4444", hazard };
  }

  const hazardName = hazard?.feature?.properties?.Name || hazard?.feature?.properties?.Type || "Hazard";
  const hazardLabel = hazardNear ? `${hazardName} within ${Math.round(hazardBufferM)} m (${Math.max(0, Math.round(hazard.distanceM))} m)` : "";

  if (shallowHit && hazardNear) {
    return { kind: "multi", label: `⚠ In shallow water + ${hazardLabel}`, color: "#ef4444", hazard };
  }
  if (shallowHit) {
    return { kind: "shallow", label: "⚠ In shallow water", color: "#ef4444", hazard };
  }
  const shallowDistanceLabel = Number.isFinite(shallowDistanceM)
    ? `${Math.max(0, Math.round(shallowDistanceM))} m`
    : `≤${Math.round(shallowBufferM)} m`;

  if (shallowNear && hazardNear) {
    return { kind: "multi", label: `⚠ Near shallow water (${shallowDistanceLabel}) + ${hazardLabel}`, color: "#ef4444", hazard, shallowDistanceM };
  }
  if (shallowNear) {
    return { kind: "shallow-near", label: `⚠ Near shallow water (${shallowDistanceLabel})`, color: "#f59e0b", hazard, shallowDistanceM };
  }
  if (hazardNear) {
    return { kind: "hazard", label: `⚠ ${hazardLabel}`, color: "#ef4444", hazard };
  }
  return { kind: "ok", label: "✓ Hydro OK", color: "#22a06b", hazard };
}

function ensureHazardMapLayer() {
  if (!mmMap || !window.HYDRO_1550A?.hazards) return;
  const src = "hydro-hazards";
  const lyr = "hydro-hazards-symbol";
  if (!mmMap.getSource(src)) mmMap.addSource(src, { type: "geojson", data: window.HYDRO_1550A.hazards });

  function addHazardIcon(name, shape, fill) {
    if (mmMap.hasImage(name)) return;
    const size = 24;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = fill;
    ctx.strokeStyle = "rgba(20,24,28,0.9)";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (shape === "triangle") {
      ctx.moveTo(12, 3.5);
      ctx.lineTo(20, 19.5);
      ctx.lineTo(4, 19.5);
      ctx.closePath();
    } else if (shape === "can") {
      ctx.rect(6, 4.5, 12, 15);
    } else {
      ctx.moveTo(12, 3.5);
      ctx.lineTo(20.5, 12);
      ctx.lineTo(12, 20.5);
      ctx.lineTo(3.5, 12);
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
    mmMap.addImage(name, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
  }

  addHazardIcon("buoy-red-cone", "triangle", "#ef4444");
  addHazardIcon("buoy-green-can", "can", "#22c55e");
  addHazardIcon("hazard-diamond", "diamond", "#f59e0b");

  if (!mmMap.getLayer(lyr)) {
    mmMap.addLayer({
      id: lyr,
      type: "symbol",
      source: src,
      layout: {
        "icon-image": ["match", ["get", "Type"],
          "Red Buoy", "buoy-red-cone",
          "Green Buoy", "buoy-green-can",
          "hazard-diamond"
        ],
        "icon-size": ["interpolate", ["linear"], ["zoom"],
          9, 0.42,
          12, 0.58,
          14, 0.88,
          15, 1.25,
          17, 1.80
        ],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: {
        "icon-opacity": ["interpolate", ["linear"], ["zoom"],
          9, 0.72,
          12, 0.84,
          15, 0.94
        ],
      },
    });
    mmMap.on("mouseenter", lyr, () => { mmMap.getCanvas().style.cursor = "pointer"; });
    mmMap.on("mouseleave", lyr, () => { mmMap.getCanvas().style.cursor = measureActive ? "crosshair" : ""; });
    mmMap.on("click", lyr, (e) => {
      e.originalEvent?.stopPropagation?.();
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties || {};
      const rows = [
        p.Name ? `<strong>${String(p.Name)}</strong>` : "<strong>Hazard</strong>",
        p.Type ? `Type: ${String(p.Type)}` : "",
        p.Depth !== undefined && p.Depth !== null && p.Depth !== "" ? `Depth: ${String(p.Depth)} ft` : "",
        p.Severity ? `Severity: ${String(p.Severity)}` : "",
        p.Notes ? String(p.Notes) : "",
      ].filter(Boolean).join("<br>");
      new maplibregl.Popup({ closeButton: true, closeOnClick: true })
        .setLngLat(e.lngLat)
        .setHTML(rows)
        .addTo(mmMap);
    });
  }
}

function ensureHydroMapLayers() {
  if (!mmMap || !window.HYDRO_1550A) return;

  // Visual hydro overlay is water-only. Land geometry is intentionally kept
  // in the hydro model for route validation, but it is not painted on the map.
  // Draw deeper water first so progressively shallower classes remain visible
  // on top if simplified source polygons touch or overlap.
  const defs = [
    ["white", "#f7fbff", 0.34],
    ["light", "#86ccea", 0.40],
    ["dark", "#277fb5", 0.48],
  ];

  // Defensive cleanup for users upgrading from versions that rendered land.
  if (mmMap.getLayer("hydro-land-fill")) mmMap.removeLayer("hydro-land-fill");
  if (mmMap.getSource("hydro-land")) mmMap.removeSource("hydro-land");

  for (const [key, color, opacity] of defs) {
    const src = `hydro-${key}`;
    const lyr = `hydro-${key}-fill`;
    if (!mmMap.getSource(src)) mmMap.addSource(src, { type: "geojson", data: window.HYDRO_1550A[key] });
    if (!mmMap.getLayer(lyr)) {
      mmMap.addLayer({
        id: lyr,
        type: "fill",
        source: src,
        layout: { visibility: "visible" },
        paint: { "fill-color": color, "fill-opacity": opacity, "fill-outline-color": color },
      });
    }
  }
  raiseOperationalLayers();
}

function applyHydroVisibility() {
  if (!mmMap) return;
  if (hydroVisible) ensureHydroMapLayers();
  const visibility = hydroVisible ? "visible" : "none";
  for (const key of ["white", "light", "dark"]) {
    const layerId = `hydro-${key}-fill`;
    if (mmMap.getLayer(layerId)) {
      mmMap.setLayoutProperty(layerId, "visibility", visibility);
    }
  }

  // Land remains a routing/safety layer only; never render it as an overlay.
  if (mmMap.getLayer("hydro-land-fill")) mmMap.removeLayer("hydro-land-fill");
  if (mmMap.getSource("hydro-land")) mmMap.removeSource("hydro-land");

  const chk = $("#mm-hydro-visible");
  if (chk) chk.checked = hydroVisible;
}

function addHydroLayers() {
  if (!mmMap || !window.HYDRO_1550A) {
    const status = $("#mm-hydro-status");
    if (status) status.textContent = "1550A hydro model unavailable";
    return;
  }
  const status = $("#mm-hydro-status");
  if (status) status.textContent = "1550A hydro model ready";
  // Build the route-query index once. Hazard points are operational and remain
  // visible; the heavier polygon fills are only shown by the debug toggle.
  ensureHydroIndex();
  ensureHazardMapLayer();
  applyHydroVisibility();
}

function routeBearingDeg(a, b) {
  const r = Math.PI / 180;
  const lat1 = a.lat * r, lat2 = b.lat * r;
  const dLon = (b.lng - a.lng) * r;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function measureDistanceMeters() {
  let total = 0;
  for (let i = 1; i < measurePoints.length; i++) {
    const a = measurePoints[i - 1];
    const b = measurePoints[i];
    total += geoDistMeters(a.lat, a.lng, b.lat, b.lng);
  }
  return total;
}

function formatMeasureDistance(meters) {
  if (measureUnit === "km") return `${(meters / 1000).toFixed(meters >= 100000 ? 1 : 2)} km`;
  if (measureUnit === "mi") return `${(meters / 1609.344).toFixed(meters >= 160934 ? 1 : 2)} mi`;
  return `${(meters / 1852).toFixed(meters >= 185200 ? 1 : 2)} NM`;
}

function formatRouteDuration(hours) {
  if (!Number.isFinite(hours) || hours < 0) return "—";
  const mins = Math.round(hours * 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function routeWindAngle(courseDeg) {
  if (!Number.isFinite(windBearing) || !Number.isFinite(courseDeg)) return null;
  const d = Math.abs(((courseDeg - windBearing + 540) % 360) - 180);
  return Math.min(180, d);
}

function routeSailingProfile(courseDeg) {
  const angle = routeWindAngle(courseDeg);
  if (angle == null) return { code: "—", factor: 1, angle: null, tack: false, efficiency: "neutral" };
  // Approximate effective boat-speed / VMG factors relative to the user-entered
  // beam-reach speed. This is an estimator, not a Catalina 27 polar model.
  if (angle < 45) return { code: "CH", factor: 0.55, angle, tack: true, efficiency: "red" };
  if (angle < 60) return { code: "CH", factor: 0.72, angle, tack: false, efficiency: "yellow" };
  if (angle < 80) return { code: "CR", factor: 0.90, angle, tack: false, efficiency: "green" };
  if (angle < 110) return { code: "BER", factor: 1.00, angle, tack: false, efficiency: "green" };
  if (angle < 150) return { code: "BRR", factor: 0.90, angle, tack: false, efficiency: "green" };
  return { code: "Run", factor: 0.76, angle, tack: false, efficiency: "yellow" };
}

function routeEfficiencyColor(efficiency) {
  if (efficiency === "red") return "#e53935";
  if (efficiency === "yellow") return "#f5b700";
  if (efficiency === "green") return "#22a447";
  return "#ff2aa1"; // no wind set: retain planned-route magenta
}

function updateMeasureUi() {
  const totalM = measureDistanceMeters();
  const out = $("#mm-measure-value");
  if (out) out.textContent = formatMeasureDistance(totalM);
  const legCount = Math.max(0, measurePoints.length - 1);
  const countEl = $("#mm-route-count");
  if (countEl) countEl.textContent = `${legCount} ${legCount === 1 ? "leg" : "legs"}`;

  let totalEtaHours = 0;
  let etaLegs = 0;
  for (let i = 1; i < measurePoints.length; i++) {
    const a = measurePoints[i - 1], b = measurePoints[i];
    const legNm = geoDistMeters(a.lat, a.lng, b.lat, b.lng) / 1852;
    const bearing = routeBearingDeg(a, b);
    const profile = routeSailingProfile(bearing);
    const effectiveKts = routeSpeedKts * profile.factor;
    if (effectiveKts > 0) {
      totalEtaHours += legNm / effectiveKts;
      etaLegs++;
    }
  }
  const etaEl = $("#mm-route-eta");
  if (etaEl) {
    etaEl.textContent = routeSpeedKts > 0 && etaLegs > 0
      ? `ETA ${formatRouteDuration(totalEtaHours)}${Number.isFinite(windBearing) ? " · wind-adjusted" : ""}`
      : "ETA —";
  }

  const btn = $("#mm-measure");
  if (btn) {
    btn.textContent = measureActive ? "Finish route" : (measurePoints.length ? "Edit route" : "Start route");
    btn.classList.toggle("active", measureActive);
    btn.setAttribute("aria-pressed", String(measureActive));
  }
  const undo = $("#mm-route-undo");
  if (undo) undo.disabled = measurePoints.length === 0;
  const reverse = $("#mm-route-reverse");
  if (reverse) reverse.disabled = measurePoints.length < 2;

  const legsEl = $("#mm-route-legs");
  if (legsEl) {
    legsEl.innerHTML = "";
    for (let i = 1; i < measurePoints.length; i++) {
      const a = measurePoints[i - 1], b = measurePoints[i];
      const meters = geoDistMeters(a.lat, a.lng, b.lat, b.lng);
      const bearingRaw = routeBearingDeg(a, b);
      const bearing = Math.round(bearingRaw) % 360;
      const legNm = meters / 1852;
      const profile = routeSailingProfile(bearingRaw);
      const effectiveKts = routeSpeedKts * profile.factor;
      const eta = effectiveKts > 0 ? formatRouteDuration(legNm / effectiveKts) : "—";
      const pointText = Number.isFinite(windBearing)
        ? `${profile.code}${profile.tack ? " · Tack" : ""}`
        : "—";
      const div = document.createElement("div");
      div.className = "route-leg";
      const efficiencyColor = routeEfficiencyColor(profile.efficiency);
      const hydro = routeHydroAssessments[i - 1] || routeHydroAssessment(a, b);
      div.style.borderLeft = `4px solid ${efficiencyColor}`;
      div.style.paddingLeft = "8px";
      div.innerHTML = `<span>${i}→${i + 1}</span><span class="bearing">${String(bearing).padStart(3, "0")}° · ${pointText}</span><span class="distance">${formatMeasureDistance(meters)} · ${eta}</span><span class="hydro-status"><i class="hydro-dot" style="background:${hydro.color}"></i>${hydro.label}</span>`;
      legsEl.appendChild(div);
    }
  }
  updateMobileHydroAlert();
  if (mmMap?.getCanvas?.()) mmMap.getCanvas().style.cursor = measureActive ? "crosshair" : "";
}

function updateMobileHydroAlert() {
  const el = document.getElementById("mm-mobile-hydro-alert");
  if (!el) return;
  const rank = { land: 5, shallow: 5, multi: 5, hazard: 4, "shallow-near": 3, unavailable: 1, ok: 0 };
  let worst = null;
  for (const a of routeHydroAssessments || []) {
    if (!a || a.kind === "ok" || a.kind === "unavailable") continue;
    if (!worst || (rank[a.kind] || 0) > (rank[worst.kind] || 0)) worst = a;
  }
  if (!worst) {
    el.textContent = "";
    el.classList.remove("has-warning");
    return;
  }
  el.textContent = worst.label;
  el.style.background = worst.kind === "shallow-near"
    ? "rgba(181,106,20,.94)" : "rgba(145,37,37,.94)";
  el.classList.add("has-warning");
}

function clearRouteWaypointMarkers() {
  routeWaypointMarkers.forEach((m) => m.remove());
  routeWaypointMarkers = [];
}

function syncRouteWaypointMarkers() {
  if (!mmMap) return;
  clearRouteWaypointMarkers();
  measurePoints.forEach((p, index) => {
    const el = document.createElement("div");
    el.className = "route-waypoint";
    el.textContent = String(index + 1);
    el.title = `Route waypoint ${index + 1} — drag to move`;
    el.addEventListener("click", (e) => e.stopPropagation());
    const marker = new maplibregl.Marker({ element: el, draggable: true, anchor: "center" })
      .setLngLat([p.lng, p.lat])
      .addTo(mmMap);
    marker.on("drag", () => {
      const ll = marker.getLngLat();
      measurePoints[index] = { lat: ll.lat, lng: ll.lng };
      updateMeasureSource(false);
    });
    marker.on("dragend", () => {
      const ll = marker.getLngLat();
      measurePoints[index] = { lat: ll.lat, lng: ll.lng };
      updateMeasureSource(false);
    });
    routeWaypointMarkers.push(marker);
  });
}

function updateMeasureSource(syncMarkers = true) {
  if (!mmMap?.getSource?.("measure")) return;
  const features = [];
  routeHydroAssessments = [];
  // Each route leg is its own feature. The inner line keeps wind-efficiency
  // colour; the outer casing carries the independent hydro classification.
  for (let i = 1; i < measurePoints.length; i++) {
    const a = measurePoints[i - 1];
    const b = measurePoints[i];
    const bearing = routeBearingDeg(a, b);
    const profile = routeSailingProfile(bearing);
    const hydro = routeHydroAssessment(a, b);
    routeHydroAssessments.push(hydro);
    features.push({
      type: "Feature",
      properties: {
        leg: i,
        efficiency: profile.efficiency,
        pointOfSail: profile.code,
        tack: profile.tack ? 1 : 0,
        hydroKind: hydro.kind,
        hydroColor: hydro.color,
      },
      geometry: {
        type: "LineString",
        coordinates: [[a.lng, a.lat], [b.lng, b.lat]],
      },
    });
  }
  mmMap.getSource("measure").setData({ type: "FeatureCollection", features });
  if (syncMarkers) syncRouteWaypointMarkers();
  updateMeasureUi();
  raiseMeasurementLayers();
}

function setMeasureActive(active) {
  measureActive = !!active;
  if (measureActive && addMarkerActive) {
    addMarkerActive = false;
    const markerBtn = $("#mm-drop-marker");
    if (markerBtn) markerBtn.textContent = "Drop marker";
  }
  updateMeasureUi();
}

function clearMeasurement() {
  measurePoints = [];
  clearRouteWaypointMarkers();
  updateMeasureSource(false);
}

function undoRoutePoint() {
  if (!measurePoints.length) return;
  measurePoints.pop();
  updateMeasureSource();
}

function reverseRoute() {
  if (measurePoints.length < 2) return;
  measurePoints.reverse();
  updateMeasureSource();
}

function saveAnchorWatchNow() {
  if (anchorWatchSaveTimer != null) clearTimeout(anchorWatchSaveTimer);
  anchorWatchSaveTimer = null;
  try {
    localStorage.setItem(LS_ANCHOR_WATCH, JSON.stringify(anchorWatch));
    anchorWatchDirty = false;
  } catch (e) {
    console.warn("anchor watch save failed", e);
  }
}

function queueAnchorWatchSave() {
  anchorWatchDirty = true;
  if (anchorWatchSaveTimer != null) return;
  anchorWatchSaveTimer = setTimeout(saveAnchorWatchNow, 15000);
}

function flushAnchorWatchSave() {
  if (anchorWatchSaveTimer != null) clearTimeout(anchorWatchSaveTimer);
  anchorWatchSaveTimer = null;
  if (anchorWatchDirty) saveAnchorWatchNow();
}

function anchorRadiusPolygon(lat, lon, radiusM, steps = 72) {
  const coords = [];
  const latScale = 111320;
  const lonScale = Math.max(1, 111320 * Math.cos(lat * Math.PI / 180));
  for (let i = 0; i <= steps; i++) {
    const a = i / steps * Math.PI * 2;
    const east = Math.sin(a) * radiusM;
    const north = Math.cos(a) * radiusM;
    coords.push([lon + east / lonScale, lat + north / latScale]);
  }
  return coords;
}

function anchorHistorySegments() {
  const segments = [];
  let current = [];
  let prev = null;
  for (const pt of anchorWatch.history) {
    if (!Array.isArray(pt) || pt.length < 3) continue;
    if (prev && pt[2] - prev[2] > ANCHOR_HISTORY_GAP_MS) {
      if (current.length >= 2) segments.push(current);
      current = [];
    }
    current.push([pt[1], pt[0]]);
    prev = pt;
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

function recomputeAnchorDistances() {
  anchorMaxDistanceM = 0;
  if (!anchorWatch.active || !Number.isFinite(anchorWatch.lat) || !Number.isFinite(anchorWatch.lon)) {
    anchorCurrentDistanceM = null;
    return;
  }
  for (const pt of anchorWatch.history) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    anchorMaxDistanceM = Math.max(anchorMaxDistanceM,
      geoDistMeters(anchorWatch.lat, anchorWatch.lon, pt[0], pt[1]));
  }
  if (plotLat != null && plotLon != null) {
    anchorCurrentDistanceM = geoDistMeters(anchorWatch.lat, anchorWatch.lon, plotLat, plotLon);
    anchorMaxDistanceM = Math.max(anchorMaxDistanceM, anchorCurrentDistanceM);
  } else {
    anchorCurrentDistanceM = null;
  }
}

function setAnchorAlarm(isAlarm) {
  anchorAlarmActive = !!isAlarm;
  const markerEl = anchorMarker?.getElement?.();
  markerEl?.classList.toggle("alarm", anchorAlarmActive);
  if (anchorAlarmActive && Date.now() - anchorLastVibrateAt >= ANCHOR_ALARM_VIBRATE_MS) {
    anchorLastVibrateAt = Date.now();
    try { navigator.vibrate?.([300, 180, 300]); } catch (_) {}
  }
}

function ensureAnchorMarker() {
  if (!mmMap) return;
  if (!anchorWatch.active || !Number.isFinite(anchorWatch.lat) || !Number.isFinite(anchorWatch.lon)) {
    if (anchorMarker) {
      anchorMarker.remove();
      anchorMarker = null;
    }
    return;
  }
  if (!anchorMarker) {
    const el = document.createElement("div");
    el.className = "anchor-watch-marker";
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", "Anchor position. Drag to correct anchor location.");
    el.title = "Drag to correct anchor position";
    el.textContent = "⚓";
    anchorMarker = new maplibregl.Marker({ element: el, draggable: true, anchor: "center" })
      .setLngLat([anchorWatch.lon, anchorWatch.lat])
      .addTo(mmMap);
    anchorMarker.on("dragend", () => {
      const ll = anchorMarker.getLngLat();
      anchorWatch.lat = ll.lat;
      anchorWatch.lon = ll.lng;
      recomputeAnchorDistances();
      const shouldAlarm = anchorCurrentDistanceM != null && Number.isFinite(anchorFixAccuracyM) &&
        anchorFixAccuracyM <= ANCHOR_MAX_ACC_M && anchorCurrentDistanceM > anchorWatch.radiusM;
      setAnchorAlarm(shouldAlarm);
      saveAnchorWatchNow();
      updateAnchorWatchMap();
      updateAnchorWatchUi();
      setGpsStatus("Anchor position corrected. Swing history retained and distances recalculated.");
    });
  } else {
    anchorMarker.setLngLat([anchorWatch.lon, anchorWatch.lat]);
  }
  anchorMarker.getElement()?.classList.toggle("alarm", anchorAlarmActive);
}

function updateAnchorWatchMap() {
  if (!mmMap?.getSource?.("anchor-watch")) return;
  const features = [];
  if (anchorWatch.active && Number.isFinite(anchorWatch.lat) && Number.isFinite(anchorWatch.lon)) {
    features.push({
      type: "Feature", properties: { kind: "radius", alarm: anchorAlarmActive ? 1 : 0 },
      geometry: { type: "Polygon", coordinates: [anchorRadiusPolygon(anchorWatch.lat, anchorWatch.lon, anchorWatch.radiusM)] },
    });
    if (anchorWatch.swingVisible && anchorWatch.history.length) {
      const pts = anchorWatch.history.map((pt) => [pt[1], pt[0]]);
      features.push({
        type: "Feature", properties: { kind: "swingPoints" },
        geometry: { type: "MultiPoint", coordinates: pts },
      });
      const segs = anchorHistorySegments();
      if (segs.length) {
        features.push({
          type: "Feature", properties: { kind: "swing" },
          geometry: segs.length === 1
            ? { type: "LineString", coordinates: segs[0] }
            : { type: "MultiLineString", coordinates: segs },
        });
      }
    }
    if (plotLat != null && plotLon != null) {
      features.push({
        type: "Feature", properties: { kind: "distance", alarm: anchorAlarmActive ? 1 : 0 },
        geometry: { type: "LineString", coordinates: [[anchorWatch.lon, anchorWatch.lat], [plotLon, plotLat]] },
      });
    }
  }
  mmMap.getSource("anchor-watch").setData({ type: "FeatureCollection", features });
  ensureAnchorMarker();
  raiseOperationalLayers();
}

function updateAnchorWatchUi() {
  const status = $("#mm-anchor-status");
  const current = $("#mm-anchor-current");
  const max = $("#mm-anchor-max");
  const points = $("#mm-anchor-points");
  const radius = $("#mm-anchor-radius");
  const swing = $("#mm-anchor-swing-visible");
  const setBtn = $("#mm-anchor-set");
  const clearBtn = $("#mm-anchor-clear");
  const clearSwingBtn = $("#mm-anchor-clear-swing");
  const banner = $("#mm-anchor-alarm");

  if (radius && document.activeElement !== radius) radius.value = String(Math.round(anchorWatch.radiusM));
  if (swing) swing.checked = anchorWatch.swingVisible;
  if (setBtn) setBtn.textContent = pendingAnchorSet ? "Waiting for GPS…" : (anchorWatch.active ? "Reset at boat" : "Set anchor at boat");
  if (clearBtn) clearBtn.disabled = !anchorWatch.active;
  if (clearSwingBtn) clearSwingBtn.disabled = !anchorWatch.active || !anchorWatch.history.length;

  if (!anchorWatch.active) {
    if (status) {
      status.textContent = pendingAnchorSet ? "Starting GPS to set anchor…" : "Off";
      status.classList.remove("alarm");
    }
    if (current) current.textContent = "—";
    if (max) max.textContent = "—";
    if (points) points.textContent = "0";
    if (banner) banner.classList.remove("active");
    return;
  }

  if (status) {
    const accText = Number.isFinite(anchorFixAccuracyM) ? ` · GPS ±${Math.round(anchorFixAccuracyM)} m` : "";
    status.textContent = (anchorAlarmActive ? "ALARM — outside radius" : "Watching") + accText;
    status.classList.toggle("alarm", anchorAlarmActive);
  }
  if (current) current.textContent = anchorCurrentDistanceM == null ? "—" : `${Math.round(anchorCurrentDistanceM)} m`;
  if (max) max.textContent = `${Math.round(anchorMaxDistanceM)} m`;
  if (points) points.textContent = anchorWatch.history.length.toLocaleString();

  if (banner) {
    banner.textContent = anchorAlarmActive
      ? `⚠ Anchor watch: ${Math.round(anchorCurrentDistanceM)} m from anchor · radius ${Math.round(anchorWatch.radiusM)} m`
      : "";
    banner.classList.toggle("active", anchorAlarmActive);
  }
}

function startAnchorWatchAt(lat, lon, timestamp = Date.now(), accuracy = null) {
  anchorWatch.active = true;
  anchorWatch.lat = lat;
  anchorWatch.lon = lon;
  anchorWatch.startedAt = timestamp;
  anchorWatch.history = [[lat, lon, timestamp, Number.isFinite(accuracy) ? accuracy : null]];
  anchorCurrentDistanceM = 0;
  anchorMaxDistanceM = 0;
  anchorFixAccuracyM = Number.isFinite(accuracy) ? accuracy : null;
  pendingAnchorSet = false;
  setAnchorAlarm(false);
  saveAnchorWatchNow();
  updateAnchorWatchMap();
  updateAnchorWatchUi();
  setGpsStatus("Anchor watch started. Drag the ⚓ marker if the actual anchor position differs from the boat position.");
}

function setAnchorAtBoat() {
  if (anchorWatch.active) {
    const ok = confirm("Reset the anchor to the boat's current position and start a new swing history? To correct the existing anchor without clearing history, drag the ⚓ marker instead.");
    if (!ok) return;
  }
  if (plotLat != null && plotLon != null) {
    startAnchorWatchAt(plotLat, plotLon, lastFix?.t || Date.now(), lastFix?.acc ?? null);
    return;
  }
  pendingAnchorSet = true;
  updateAnchorWatchUi();
  startGpsForMap();
  setGpsStatus("Starting GPS — anchor will be set at the first accepted position.");
}

function clearAnchorWatch() {
  if (anchorWatch.active && !confirm("Stop anchor watch and clear the anchor and swing history?")) return;
  const radiusM = anchorWatch.radiusM;
  const swingVisible = anchorWatch.swingVisible;
  anchorWatch = { ...anchorWatchDefaults(), radiusM, swingVisible };
  pendingAnchorSet = false;
  anchorCurrentDistanceM = null;
  anchorMaxDistanceM = 0;
  anchorFixAccuracyM = null;
  setAnchorAlarm(false);
  saveAnchorWatchNow();
  updateAnchorWatchMap();
  updateAnchorWatchUi();
  setGpsStatus("Anchor watch stopped and cleared.");
}

function clearAnchorSwingHistory() {
  if (!anchorWatch.active) return;
  anchorWatch.history = [];
  if (plotLat != null && plotLon != null) {
    anchorWatch.history.push([plotLat, plotLon, lastFix?.t || Date.now(), lastFix?.acc ?? null]);
  }
  recomputeAnchorDistances();
  saveAnchorWatchNow();
  updateAnchorWatchMap();
  updateAnchorWatchUi();
  setGpsStatus("Anchor swing history cleared; anchor watch is still active.");
}

function updateAnchorWatchWithFix(lat, lon, timestamp, accuracy, recent) {
  if (!anchorWatch.active) return;
  const goodFix = recent && Number.isFinite(accuracy) && accuracy > 0 && accuracy <= ANCHOR_MAX_ACC_M;
  anchorFixAccuracyM = Number.isFinite(accuracy) ? accuracy : null;
  anchorCurrentDistanceM = geoDistMeters(anchorWatch.lat, anchorWatch.lon, lat, lon);

  if (goodFix) {
    const last = anchorWatch.history.length ? anchorWatch.history[anchorWatch.history.length - 1] : null;
    const dtSec = last ? (timestamp - last[2]) / 1000 : Infinity;
    const movedM = last ? geoDistMeters(last[0], last[1], lat, lon) : Infinity;
    const shouldStore = !last || (dtSec >= ANCHOR_HISTORY_MIN_SEC &&
      (movedM >= ANCHOR_HISTORY_MIN_DIST_M || dtSec >= ANCHOR_HISTORY_HEARTBEAT_SEC));
    if (shouldStore) {
      anchorWatch.history.push([lat, lon, timestamp, accuracy]);
      if (anchorWatch.history.length > ANCHOR_HISTORY_MAX_POINTS) {
        anchorWatch.history.splice(0, anchorWatch.history.length - ANCHOR_HISTORY_MAX_POINTS);
      }
      anchorMaxDistanceM = Math.max(anchorMaxDistanceM, anchorCurrentDistanceM);
      queueAnchorWatchSave();
    }
  }

  const shouldAlarm = goodFix && anchorCurrentDistanceM > anchorWatch.radiusM;
  setAnchorAlarm(shouldAlarm);
  updateAnchorWatchMap();
  updateAnchorWatchUi();
}

function buildControls() {
  const rail = document.getElementById("app-rail");
  if (!rail) return;

  // Ensure the Clear markers action exists alongside Drop marker.
  const dropBtn = $("#mm-drop-marker");
  if (dropBtn) {
    let clearBtn = $("#mm-clearmarkers");
    if (!clearBtn) {
      clearBtn = document.createElement("button");
      clearBtn.id = "mm-clearmarkers";
      clearBtn.type = "button";
      clearBtn.textContent = "Clear markers";
      (dropBtn.closest(".ctrl-section") || dropBtn.parentElement)?.appendChild(clearBtn);
      clearBtn.addEventListener("click", () => {
        if (confirm("Remove all markers?")) {
          clearAllMarkers();
          setGpsStatus("All markers cleared.");
        }
      });
    }
  }

  const hydroToggle = $("#mm-hydro-visible");
  if (hydroToggle) {
    hydroToggle.checked = hydroVisible;
    hydroToggle.addEventListener("change", () => {
      hydroVisible = hydroToggle.checked;
      try { localStorage.setItem(LS_HYDRO_VISIBLE, String(hydroVisible)); } catch (_) {}
      applyHydroVisibility();
    });
  }

  updateStats({ kts: null });
}

function initMarineMapOnce() {
  if (mmMap) return;
  // Restore saved points before live GPS can add points during map loading.
  loadTrail();

  // MapLibre GL map with OSM raster style
  mmMap = new maplibregl.Map({
    container: "leaflet-map",
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors",
        },
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }],
    },
    center: [-75.8266, 45.3513], // Nepean Sailing Club. Ottawa = -75.6972, 45.4215 [lng, lat]
    zoom: 12,
    bearing: 0,
    pitch: 0,
    attributionControl: false, // use the single compact control added below
  });
  // The large map warning panel is paused at the user's request.
  // ensureNavAlert();

  mmMap.addControl(
    new maplibregl.NavigationControl({ visualizePitch: true }),
    "top-right"
  );
  mmMap.addControl(
    new maplibregl.AttributionControl({ compact: true }),
    "bottom-right"
  );

  mmMap.on("load", () => {
    // Trail source/layer
    mmMap.addSource("trail", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    mmMap.addLayer({
      id: "trail-line-casing",
      type: "line",
      source: "trail",
      paint: {
        "line-color": "#17202a",
        "line-width": 7,
        "line-opacity": 0.92,
      },
    });
    mmMap.addLayer({
      id: "trail-line",
      type: "line",
      source: "trail",
      paint: {
        "line-color": "#ff7a00",
        "line-width": 4,
        "line-opacity": 1,
      },
    });
    applyTrailVisibility();
    mmMap.addSource("measure", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    // A dark casing plus vivid magenta stays legible over white/blue marine charts.
    mmMap.addLayer({
      id: "measure-line-casing",
      type: "line",
      source: "measure",
      filter: ["==", ["geometry-type"], "LineString"],
      paint: {
        "line-color": ["coalesce", ["get", "hydroColor"], "#17202a"],
        "line-width": 10,
        "line-opacity": 0.86,
      },
    });
    mmMap.addLayer({
      id: "measure-line",
      type: "line",
      source: "measure",
      filter: ["==", ["geometry-type"], "LineString"],
      paint: {
        "line-color": [
          "match",
          ["get", "efficiency"],
          "red", "#e53935",
          "yellow", "#f5b700",
          "green", "#22a447",
          "#ff2aa1"
        ],
        "line-width": 5,
        "line-opacity": 1,
        "line-dasharray": [1.7, 1.05],
      },
    });
    mmMap.addLayer({
      id: "measure-points",
      type: "circle",
      source: "measure",
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 7,
        "circle-color": "#ff2aa1",
        "circle-opacity": 1,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 3.5,
      },
    });
    mmMap.addSource("nav-accuracy", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    mmMap.addLayer({
      id: "nav-accuracy-fill", type: "fill", source: "nav-accuracy",
      paint: { "fill-color": "#1b83be", "fill-opacity": 0.13 },
    });
    mmMap.addLayer({
      id: "nav-accuracy-outline", type: "line", source: "nav-accuracy",
      paint: { "line-color": "#1175aa", "line-width": 2 },
    });

    mmMap.addSource("anchor-watch", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    mmMap.addLayer({
      id: "anchor-radius-fill", type: "fill", source: "anchor-watch",
      filter: ["==", ["get", "kind"], "radius"],
      paint: {
        "fill-color": ["case", ["==", ["get", "alarm"], 1], "#dc2626", "#0ea5e9"],
        "fill-opacity": 0.08,
      },
    });
    mmMap.addLayer({
      id: "anchor-radius-outline", type: "line", source: "anchor-watch",
      filter: ["==", ["get", "kind"], "radius"],
      paint: {
        "line-color": ["case", ["==", ["get", "alarm"], 1], "#ef4444", "#0ea5e9"],
        "line-width": 2.5,
        "line-dasharray": [2, 1.4],
      },
    });
    mmMap.addLayer({
      id: "anchor-swing-line", type: "line", source: "anchor-watch",
      filter: ["==", ["get", "kind"], "swing"],
      paint: { "line-color": "#13b8d2", "line-width": 2.2, "line-opacity": 0.72 },
    });
    mmMap.addLayer({
      id: "anchor-swing-points", type: "circle", source: "anchor-watch",
      filter: ["==", ["get", "kind"], "swingPoints"],
      paint: {
        "circle-radius": 2.5, "circle-color": "#67e8f9", "circle-opacity": 0.72,
        "circle-stroke-color": "#083344", "circle-stroke-width": 0.7,
      },
    });
    mmMap.addLayer({
      id: "anchor-distance-line", type: "line", source: "anchor-watch",
      filter: ["==", ["get", "kind"], "distance"],
      paint: {
        "line-color": ["case", ["==", ["get", "alarm"], 1], "#ef4444", "#f8fafc"],
        "line-width": 2, "line-opacity": 0.8, "line-dasharray": [1.5, 1.4],
      },
    });

    updateTrailSource();
    recomputeAnchorDistances();
    updateAnchorWatchMap();
    updateAnchorWatchUi();
    raiseOperationalLayers();
    applyTrailVisibility();
    // updateAccuracyRing();
    renderMarkersFromStore();
    ensureAllChartBounds().then(() => {
      addAllCharts();
      addHydroLayers();
    });
  });

  ["dragstart", "zoomstart", "rotatestart"].forEach((ev) => {
    mmMap.on(ev, (event) => {
      // Camera calls such as jumpTo also fire these events, but have no
      // originating pointer, wheel, touch, or keyboard event.
      if (!event.originalEvent) return;
      follow = false;
      const chk = $("#mm-follow");
      if (chk) chk.checked = false;
    });
  });

  mmMap.on("click", (e) => {
    if (measureActive) {
      measurePoints.push({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      updateMeasureSource();
      return;
    }
    if (!addMarkerActive) return;
    const type = $("#mm-marker-type")?.value || "other";
    addDomMarker(e.lngLat.lat, e.lngLat.lng, type);
    addMarkerToStore({ lat: e.lngLat.lat, lng: e.lngLat.lng }, type);
    addMarkerActive = false;
    const btn = $("#mm-drop-marker");
    if (btn) btn.textContent = "Drop marker";
    setGpsStatus("Marker added.");
  });

  buildControls();
  if (anchorWatch.active && !anchorAutoResumeAttempted) {
    anchorAutoResumeAttempted = true;
    setTimeout(() => {
      if (anchorWatch.active && document.visibilityState === "visible") startGpsForMap();
    }, 350);
  }
}

function startGpsForMap() {
  if (!("geolocation" in navigator)) {
    if (pendingAnchorSet) { pendingAnchorSet = false; updateAnchorWatchUi(); }
    setGpsStatus("Geolocation not supported by this browser.");
    return;
  }
  if (!mmMap) initMarineMapOnce();
  document.body.classList.add("gps-active");
  setGpsStatus("Starting live GPS…");

  // Enable device compass (iOS permission happens here via user gesture)
  enableCompass();

  // Bind GEO -> map once
  if (!mapGpsBound) {
    mapUnsub = GEO.on((type, payload) => {
      if (type === "position") onPos(payload);
      else if (type === "error") {
        if (pendingAnchorSet) { pendingAnchorSet = false; updateAnchorWatchUi(); }
        setGpsStatus(`GPS error: ${payload.message || payload.code}`);
      } else if (type === "perm" && payload === "denied") {
        if (pendingAnchorSet) { pendingAnchorSet = false; updateAnchorWatchUi(); }
        setGpsStatus("Location blocked in site settings.");
      }
      else if (type === "retry" && payload === "low-accuracy")
        setGpsStatus(
          "High-accuracy failed; retrying with network-based location…"
        );
    });
    mapGpsBound = true;
  }

  GEO.start(true);
  forceFreshFix();
}

/* Prevent duplicate GEO.on wiring for the map */
let mapGpsBound = false;
let mapUnsub = null;

function onPos(p) {
  // Ignore an older result from the watch or the parallel one-shot. It must
  // not displace or invalidate a newer accepted position.
  if (lastFix && Number.isFinite(p?.timestamp) && p.timestamp <= lastFix.t) return;
  const reason = validateNavigationFix(p);
  if (reason) {
    navFixSuppressed = true;
    navIssue = reason;
    refreshNavStatus();
    setGpsStatus(reason);
    return;
  }
  const { latitude, longitude, heading, speed, accuracy } = p.coords;
  const now = p.timestamp;
  const acc = Number.isFinite(accuracy) && accuracy > 0 ? accuracy : null;
  const recent = now >= Date.now() - NAV_MAX_FIX_AGE_MS;
  const reliable = recent && acc != null && acc >= 1 && acc <= NAV_MAX_ACC_M;

  // ---------- SPEED (noise-resistant) ----------
  // Preferred: device-reported speed (m/s)
  let instKts = reliable && Number.isFinite(speed) && speed >= 0 &&
    mpsToKts(speed) <= NAV_MAX_PLAUSIBLE_KTS ? mpsToKts(speed) : null;

  // Fallback: compute from *raw* displacement, gently gated by accuracy
  if (reliable && !Number.isFinite(instKts)) {
    const dt = lastFix && lastFix.acc != null && lastFix.acc <= NAV_MAX_ACC_M
      ? Math.max(0.5, (now - lastFix.t) / 1000) : null;
    const d =
      lastFix != null
        ? geoDistMeters(
            latitude,
            longitude,
            lastFix.latitude,
            lastFix.longitude
          )
        : null;

    if (dt && d != null) {
      const minMove = Math.max(SPEED_MIN_MOVE_M, acc * SPEED_ACC_FACTOR);
      instKts = d >= minMove ? Math.min(NAV_MAX_PLAUSIBLE_KTS, mpsToKts(d / dt)) : 0;
    } else {
      instKts = 0;
    }
  }

  // Smooth speed (EMA)
  speedEmaVal = reliable ? spdEma(instKts, speedEmaVal) : null;

  // Hysteresis: moving vs stopped
  if (!reliable) moving = false;
  else if (!moving && speedEmaVal >= MOVING_ENTER_KTS) moving = true;
  else if (moving && speedEmaVal <= MOVING_EXIT_KTS) moving = false;

  const kts = moving ? Math.max(0, speedEmaVal) : 0;

  // ---------- HEADING ----------
  if (reliable) {
    const chosen = chooseHeading(heading, kts, latitude, longitude, acc, now);
    applyHeadingToUi(chosen);
  } else {
    cogAnchor = null;
  }

  // ---------- POSITION: use the accepted raw fix to avoid lag near hazards ----------
  plotLat = latitude;
  plotLon = longitude;

  if (pendingAnchorSet) {
    startAnchorWatchAt(latitude, longitude, now, acc);
  }
  updateAnchorWatchWithFix(latitude, longitude, now, acc, recent);

  if (mmMap && !mmBoat) {
    mmBoatEl = document.createElement("div");
    mmBoatEl.className = "boat";
    mmBoatEl.style.width = "36px";
    mmBoatEl.style.height = "36px";
    mmBoatEl.innerHTML = `<svg viewBox="-10 -10 120 120" style="width:36px;height:36px">
               <circle class="boat-ring" cx="50" cy="50" r="55" fill="none" stroke="#70b7dd" stroke-width="3"/>
               <g id="boat-rot">
                 <polygon class="hull" points="50,8 74,60 50,94 26,60" fill="#003b8e" stroke="#ffffff" stroke-width="3"/>
                 <line class="mast" x1="50" y1="20" x2="50" y2="82" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/>
               </g>
               <circle cx="50" cy="50" r="9" fill="#ffffff" stroke="#003b8e" stroke-width="5"/>
             </svg>`;
    mmBoat = new maplibregl.Marker({ element: mmBoatEl, anchor: "center" })
      .setLngLat([plotLon, plotLat])
      .addTo(mmMap);
    if (follow) mmMap.jumpTo({ center: [plotLon, plotLat], zoom: 15 });
  } else if (mmBoat) {
    mmBoat.setLngLat([plotLon, plotLat]);
  }

  if (pendingMobileRecenter) {
    pendingMobileRecenter = false;
    recenterToBoat();
  }

  // ---------- Trail: collect moving fixes, batch map redraw and storage ----------
  const lastPt = trail.length ? trail[trail.length - 1] : null; // [rawLat, rawLon, t, segmentId]
  const dtSinceLastPtMs = lastPt ? now - lastPt[2] : Infinity;
  const dtSinceLastPt = dtSinceLastPtMs / 1000;
  const dRaw = lastPt ? geoDistMeters(latitude, longitude, lastPt[0], lastPt[1]) : 0;
  const goodTrailFix = reliable && acc <= TRAIL_MAX_ACC_M;
  const trailMoveThresholdM = Math.max(
    TRAIL_MIN_DIST_M,
    Number.isFinite(acc) ? acc * TRAIL_ACC_DIST_FACTOR : TRAIL_MIN_DIST_M
  );
  const shouldAdd = trailRecording && goodTrailFix &&
    (!lastPt || (moving && (!trailWasMoving ||
      (dRaw >= trailMoveThresholdM && dtSinceLastPt >= TRAIL_MIN_SEC))));
  if (shouldAdd) {
    const autoSegmentBreak = !!lastPt &&
      (dtSinceLastPtMs >= TRAIL_SEGMENT_GAP_MS || dRaw >= TRAIL_SEGMENT_JUMP_M);
    const segmentBreak = forceTrailSegmentBreak || autoSegmentBreak;
    const lastSegmentId = lastPt && Number.isFinite(lastPt[3]) ? lastPt[3] : currentTripSegmentId;
    const segmentId = segmentBreak
      ? Math.max(currentTripSegmentId, lastSegmentId + 1)
      : lastSegmentId;

    if (!segmentBreak && moving && trailWasMoving && lastPt) {
      totalDistM += dRaw;
    }
    currentTripSegmentId = segmentId;
    forceTrailSegmentBreak = false;
    // Store raw coordinates plus a segment id. Segments prevent false straight
    // lines between separate sessions, recording pauses or large GPS/location jumps.
    trail.push([latitude, longitude, now, segmentId]);
    if (trail.length > TRAIL_MAX_POINTS)
      trail.splice(0, trail.length - TRAIL_MAX_POINTS);
    queueTrailRedraw();
    queueTrailSave();
  }
  trailWasMoving = trailRecording && moving && goodTrailFix;

  // ---------- Follow pan (unconditional when ON) ----------
  if (follow && mmMap && plotLat != null && plotLon != null) {
    // Always keep centered, no animation lag
    mmMap.jumpTo({ center: [plotLon, plotLat], zoom: mmMap.getZoom() });
  }

  updateStats({ kts });
  lastFix = { latitude, longitude, t: now, acc,
    speedMps: Math.min(NAV_MAX_PLAUSIBLE_KTS / 1.94384,
      reliable && Number.isFinite(speed) && speed >= 0 ? speed : kts / 1.94384) };
  navFixSuppressed = false;
  refreshNavStatus();
  setGpsStatus(reliable
    ? `Fix: ${latitude.toFixed(5)}, ${longitude.toFixed(5)} @ ${fmt(kts, 1)} kn (±${Math.round(acc)}m)`
    : `Uncertain GPS position: ${latitude.toFixed(5)}, ${longitude.toFixed(5)} ` +
      `(${acc == null ? "accuracy unknown" : `±${Math.round(acc)} m`}); yellow boat`);
}

// Update trail GeoJSON source
function updateTrailSource() {
  if (!mmMap || !mmMap.getSource || !mmMap.getSource("trail")) return;

  const segments = [];
  let current = [];
  let currentId = null;
  for (const p of trail) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const segmentId = Number.isFinite(p[3]) ? p[3] : 0;
    if (currentId == null || segmentId === currentId) {
      current.push([p[1], p[0]]);
    } else {
      if (current.length >= 2) segments.push(current);
      current = [[p[1], p[0]]];
    }
    currentId = segmentId;
  }
  if (current.length >= 2) segments.push(current);

  mmMap.getSource("trail").setData({
    type: "FeatureCollection",
    features: segments.map((coordinates, i) => ({
      type: "Feature",
      properties: { segment: i },
      geometry: { type: "LineString", coordinates },
    })),
  });
  trailRedrawAt = Date.now();
}

/* =======================
   Wake-from-idle boosters
   ======================= */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    // Force a fresh high-accuracy fix and restart the watch for snappier updates
    GEO.stop();
    refreshNavStatus();
    forceFreshFix();
    GEO.start(true);
    if (mmMap) mmMap.resize();
    if (keepScreenAwake) void acquireScreenWakeLock({ notify: false });
    // Reset heading smoothing so the first rotation is crisp
    emaHead = null;
    setGpsStatus("Resumed — refreshing GPS & sensors…");
  } else {
    flushTrailSave();
    flushAnchorWatchSave();
  }
});
window.addEventListener("pagehide", () => {
  flushTrailSave();
  flushAnchorWatchSave();
});

// Stale-fix watchdog: if stream stalls, pull a fresh fix (safe even if map not started)
setInterval(() => {
  if (document.visibilityState !== "visible" || !mapGpsBound || !mmMap) return;
  refreshNavStatus();
  if (!lastFix) {
    forceFreshFix();
    return;
  }
  const age = Date.now() - lastFix.t;
  if (age > MAX_STALE_MS) forceFreshFix();
}, 1000);

/* =========================================================
   Wire up Marine Map controls (no inline handlers)
   ========================================================= */
function wireControls() {
  setupMapRail();
  syncMobilePanelState();
  $("#mm-startgps")?.addEventListener("click", startGpsForMap);
  $("#mm-recenter")?.addEventListener("click", recenterToBoat);
  $("#mm-mobile-recenter")?.addEventListener("click", recenterOrStartGps);
  $("#mm-mobile-wake")?.addEventListener("click", () => {
    void setScreenAwake(!keepScreenAwake);
  });
  syncScreenWakeUi();
  if (keepScreenAwake && document.visibilityState === "visible") {
    void acquireScreenWakeLock({ notify: false });
  }

  $("#mm-anchor-set")?.addEventListener("click", setAnchorAtBoat);
  $("#mm-anchor-clear")?.addEventListener("click", clearAnchorWatch);
  $("#mm-anchor-clear-swing")?.addEventListener("click", clearAnchorSwingHistory);
  const anchorRadiusInput = $("#mm-anchor-radius");
  if (anchorRadiusInput) {
    anchorRadiusInput.value = String(Math.round(anchorWatch.radiusM));
    anchorRadiusInput.addEventListener("change", (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      anchorWatch.radiusM = Math.min(250, Math.max(5, v));
      e.target.value = String(Math.round(anchorWatch.radiusM));
      recomputeAnchorDistances();
      const shouldAlarm = anchorWatch.active && anchorCurrentDistanceM != null &&
        Number.isFinite(anchorFixAccuracyM) && anchorFixAccuracyM <= ANCHOR_MAX_ACC_M &&
        anchorCurrentDistanceM > anchorWatch.radiusM;
      setAnchorAlarm(shouldAlarm);
      saveAnchorWatchNow();
      updateAnchorWatchMap();
      updateAnchorWatchUi();
    });
  }
  const anchorSwingToggle = $("#mm-anchor-swing-visible");
  if (anchorSwingToggle) {
    anchorSwingToggle.checked = anchorWatch.swingVisible;
    anchorSwingToggle.addEventListener("change", (e) => {
      anchorWatch.swingVisible = !!e.target.checked;
      saveAnchorWatchNow();
      updateAnchorWatchMap();
    });
  }
  recomputeAnchorDistances();
  updateAnchorWatchUi();

  setupFloatingCompass();

  const chartOpacitySlider = $("#mm-chart-opacity");
  if (chartOpacitySlider) {
    chartOpacitySlider.value = String(Math.round(chartOpacity * 100));
    setChartOpacity(chartOpacity, false);
    chartOpacitySlider.addEventListener("input", (e) => {
      setChartOpacity(Number(e.target.value) / 100);
    });
  }

  $("#mm-follow")?.addEventListener("change", (e) => {
    follow = !!e.target.checked;
    if (follow) recenterToBoat();
  });

  $("#mm-courseup")?.addEventListener("change", (e) => {
    toggleCourseUp(e.target.checked);
  });

  const measureUnitSelect = $("#mm-measure-unit");
  if (measureUnitSelect) {
    if (!["nm", "km", "mi"].includes(measureUnit)) measureUnit = "nm";
    measureUnitSelect.value = measureUnit;
    measureUnitSelect.addEventListener("change", (e) => {
      measureUnit = e.target.value;
      try { localStorage.setItem(LS_MEASURE_UNIT, measureUnit); } catch {}
      updateMeasureUi();
    });
  }
  const routeSpeedInput = $("#mm-route-speed");
  if (routeSpeedInput) {
    routeSpeedKts = Math.min(15, Math.max(0.5, Number(routeSpeedKts) || 4.5));
    routeSpeedInput.value = routeSpeedKts.toFixed(1);
    routeSpeedInput.addEventListener("input", (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v) || v <= 0) return;
      routeSpeedKts = Math.min(15, Math.max(0.5, v));
      try { localStorage.setItem(LS_ROUTE_SPEED, String(routeSpeedKts)); } catch {}
      updateMeasureUi();
    });
  }
  const shallowBufferInput = $("#mm-shallow-buffer");
  if (shallowBufferInput) {
    shallowBufferInput.value = String(Math.round(shallowBufferM));
    shallowBufferInput.addEventListener("change", (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      shallowBufferM = Math.min(100, Math.max(1, v));
      e.target.value = String(Math.round(shallowBufferM));
      try { localStorage.setItem(LS_SHALLOW_BUFFER, String(shallowBufferM)); } catch {}
      updateMeasureSource(false);
    });
  }
  const hazardBufferInput = $("#mm-hazard-buffer");
  if (hazardBufferInput) {
    hazardBufferInput.value = String(Math.round(hazardBufferM));
    hazardBufferInput.addEventListener("change", (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      hazardBufferM = Math.min(200, Math.max(1, v));
      e.target.value = String(Math.round(hazardBufferM));
      try { localStorage.setItem(LS_HAZARD_BUFFER, String(hazardBufferM)); } catch {}
      updateMeasureSource(false);
    });
  }
  $("#mm-measure")?.addEventListener("click", () => setMeasureActive(!measureActive));
  $("#mm-route-undo")?.addEventListener("click", undoRoutePoint);
  $("#mm-route-reverse")?.addEventListener("click", reverseRoute);
  $("#mm-measure-clear")?.addEventListener("click", clearMeasurement);
  updateMeasureUi();

  $("#mm-drop-marker")?.addEventListener("click", (e) => {
    if (measureActive) setMeasureActive(false);
    addMarkerActive = !addMarkerActive;
    e.target.textContent = addMarkerActive ? "Tap map…" : "Drop marker";
    setGpsStatus(addMarkerActive ? "Tap on the map to place marker." : "");
  });

  const trailRecordingToggle = $("#mm-trail-recording");
  const trailVisibleToggle = $("#mm-trail-visible");
  if (trailRecordingToggle) {
    trailRecordingToggle.checked = trailRecording;
    trailRecordingToggle.addEventListener("change", (e) => {
      const wasRecording = trailRecording;
      trailRecording = !!e.target.checked;
      try { localStorage.setItem(LS_TRAIL_RECORDING, String(trailRecording)); } catch {}
      if (trailRecording && !wasRecording) forceTrailSegmentBreak = true;
      if (!trailRecording) trailWasMoving = false;
      updateTrackUi();
    });
  }
  if (trailVisibleToggle) {
    trailVisibleToggle.checked = trailVisible;
    trailVisibleToggle.addEventListener("change", (e) => {
      trailVisible = !!e.target.checked;
      try { localStorage.setItem(LS_TRAIL_VISIBLE, String(trailVisible)); } catch {}
      applyTrailVisibility();
      updateTrackUi();
    });
  }
  $("#mm-newtrip")?.addEventListener("click", startNewTrip);

  $("#mm-snapnorth")?.addEventListener("click", () => {
    toggleCourseUp(false);
    const chk = $("#mm-courseup");
    if (chk) chk.checked = false;
  });

  $("#mm-cleartrail")?.addEventListener("click", () => {
    if (confirm("Clear all stored trail history and distance?")) resetTrail();
  });
  $("#mm-exportgpx")?.addEventListener("click", exportGPX);
}

/* =========================================================
   DOM Ready
   ========================================================= */
if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      bindTabsAndCollapsibles();
      wireControls();
      adjustPanelOffset();
    },
    { once: true }
  );
} else {
  bindTabsAndCollapsibles();
  wireControls();
  adjustPanelOffset();
}
