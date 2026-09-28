/* =========================================================
   Ottawa Sailing Dashboard — app.js (MapLibre GL patch)
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
const TRAIL_MAX_POINTS = 2000;
const TRAIL_MIN_DIST_M = 2; // ↓ from 5
const TRAIL_MIN_SEC = 0.75; // 0.5–1 s recommended
const TRAIL_REDRAW_MS = 1000;
const TRAIL_SAVE_MS = 15000;
const TRAIL_MAX_ACC_M = 30;

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

/* ===== EMA helpers (explicit position & speed EMAs) ===== */
const makeEma = (alpha) => (current, prev) =>
  prev == null ? current : alpha * current + (1 - alpha) * prev;
const spdEma = makeEma(SPD_EMA_ALPHA);

/* ===== Speed smoothing & stationary detection ===== */
let speedEmaVal = null;
let moving = false;

/* =========================================================
   CSS offset for floating map panel
   ========================================================= */
function adjustPanelOffset() {
  const header = document.querySelector("header");
  const nav = document.querySelector("nav");
  const headerH = header ? header.offsetHeight : 0;
  const navH = nav ? nav.offsetHeight : 0;
  const topbarH = headerH + navH;
  document.documentElement.style.setProperty("--nav-h", `${navH}px`);
  document.documentElement.style.setProperty("--topbar-h", `${topbarH}px`);
}
window.addEventListener("resize", adjustPanelOffset);
window.addEventListener("orientationchange", adjustPanelOffset);

/* =========================================================
   Service Worker (relative path for GitHub Pages & others)
   ========================================================= */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("service-worker.js")
    .then((reg) => console.log("Service worker registered:", reg.scope))
    .catch((err) => console.error("Service worker error:", err));
}

/* =========================================================
   Tabs & collapsibles (robust + simple)
   ========================================================= */
function showTab(tabId, btnEl) {
  const id = String(tabId || "").replace(/^#/, "");
  const tab = document.getElementById(id);
  if (!tab) return;

  document
    .querySelectorAll(".tab-content.active")
    .forEach((t) => t.classList.remove("active"));
  document
    .querySelectorAll("nav [data-tab].active, nav a.active")
    .forEach((b) => b.classList.remove("active"));

  tab.classList.add("active");
  if (btnEl) btnEl.classList.add("active");

  if (id === "map") {
    initMarineMapOnce();
    adjustPanelOffset();
    if (mmMap) mmMap.resize();
  }
}

function bindTabsAndCollapsibles() {
  const nav = document.querySelector("nav");
  if (nav) {
    nav.addEventListener("click", (e) => {
      const t = e.target;
      const el =
        t instanceof Element ? t.closest('[data-tab], a[href^="#"]') : null;
      if (!el || !nav.contains(el)) return;
      e.preventDefault();
      const tabId = el.dataset.tab || el.getAttribute("href");
      showTab(tabId, el);
    });

    nav.addEventListener("keydown", (e) => {
      if (
        (e.key === "Enter" || e.key === " ") &&
        e.target instanceof Element &&
        e.target.closest('[data-tab], a[href^="#"]')
      ) {
        e.preventDefault();
        e.target.click();
      }
    });
  }

  $all(".collapsible").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
      const content = btn.nextElementSibling;
      if (content)
        content.style.display =
          content.style.display === "block" ? "none" : "block";
      adjustPanelOffset(); // keep panel positioned if height changes
    });
  });

  // initial tab
  const activeNav = document.querySelector(
    "nav [data-tab].active, nav a.active"
  );
  if (activeNav) {
    showTab(activeNav.dataset.tab || activeNav.getAttribute("href"), activeNav);
  } else {
    const first = document.querySelector('nav [data-tab], nav a[href^="#"]');
    if (first) showTab(first.dataset.tab || first.getAttribute("href"), first);
  }
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
let trailRedrawAt = 0;
let trailRedrawTimer = null;
let trailSaveTimer = null;
let trailDirty = false;

let courseUp = false;
let follow = true;
let addMarkerActive = false;

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
  // Rotate compass needle
  rotateCompass(emaHead || 0);

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
  chartQualityText = "Marine chart alignment has not been independently verified";
  refreshNavStatus();
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
        .slice(-TRAIL_MAX_POINTS)
        .map((p) =>
          Array.isArray(p) && p.length >= 2 ? [p[0], p[1], p[2] ?? now] : p
        );
    }
    totalDistM = parseFloat(localStorage.getItem(LS_DIST) || "0") || 0;
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
  trailDirty = true;
  updateTrailSource();
  saveTrail();
  updateStats({ kts: null });
}
function updateStats({ kts }) {
  const el = document.getElementById("mm-stats");
  if (el) {
    el.innerHTML = `
      <div><strong>Speed:</strong> ${fmt(kts, 1)} kn</div>
      <div><strong>Distance:</strong> ${fmt(mToNm(totalDistM), 2)} NM</div>
    `;
  }
  const h = document.getElementById("mm-speed");
  if (h) h.textContent = fmt(kts, 1);
}
function exportGPX() {
  if (!trail.length) {
    alert("No trail to export yet.");
    return;
  }
  const nowISO = new Date().toISOString();
  let gpx = "";
  gpx += '<?xml version="1.0" encoding="UTF-8"?>\n';
  gpx += '<gpx version="1.1" creator="Ottawa Sailing Dashboard" ';
  gpx += 'xmlns="http://www.topografix.com/GPX/1/1" ';
  gpx += 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ';
  gpx += 'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 ';
  gpx += 'http://www.topografix.com/GPX/1/1/gpx.xsd">\n';
  gpx += `  <metadata><time>${nowISO}</time></metadata>\n`;
  gpx += "  <trk>\n";
  gpx += "    <name>Track</name>\n";
  gpx += "    <trkseg>\n";
  for (const p of trail) {
    const lat = p[0],
      lon = p[1],
      t = p[2];
    gpx += `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">`;
    if (Number.isFinite(t)) gpx += `<time>${new Date(t).toISOString()}</time>`;
    gpx += `</trkpt>\n`;
  }
  gpx += "    </trkseg>\n";
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
  if (plotLat != null && plotLon != null && mmMap && lastFix) {
    follow = true;
    mmMap.jumpTo({
      center: [plotLon, plotLat],
      zoom: Math.max(mmMap.getZoom(), 15),
    });
    setGpsStatus("Recentered to last reported GPS position; check the uncertainty indicator.");
    const chk = $("#mm-follow");
    if (chk) chk.checked = true;
  } else {
    setGpsStatus("No GPS position has been received yet.");
  }
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

function buildControls() {
  const panel = document.getElementById("mm-panel");
  const header = document.getElementById("mm-toggle");
  if (!panel || !header) return;

  try {
    // (Leaflet-specific propagation suppression skipped)
  } catch {}

  const doToggle = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const isCollapsed = panel.classList.toggle("collapsed");
    header.setAttribute("aria-expanded", String(!isCollapsed));
  };

  panel.addEventListener("click", (e) => {
    const hit = e.target instanceof Element && e.target.closest("#mm-toggle");
    if (hit) doToggle(e);
  });

  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      doToggle(e);
    }
  });

  // Ensure "Clear markers" button exists
  const dropBtn = $("#mm-drop-marker");
  if (dropBtn) {
    let clearBtn = $("#mm-clearmarkers");
    if (!clearBtn) {
      clearBtn = document.createElement("button");
      clearBtn.id = "mm-clearmarkers";
      clearBtn.textContent = "Clear markers";
      (dropBtn.parentElement || panel.querySelector(".ctrl-body"))?.appendChild(
        clearBtn
      );
      clearBtn.addEventListener("click", () => {
        if (confirm("Remove all markers?")) {
          clearAllMarkers();
          setGpsStatus("All markers cleared.");
        }
      });
    }
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
      id: "trail-line",
      type: "line",
      source: "trail",
      paint: { "line-width": 3, "line-opacity": 0.85 },
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

    updateTrailSource();
    // updateAccuracyRing();
    renderMarkersFromStore();
    ensureAllChartBounds().then(addAllCharts);
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
}

function startGpsForMap() {
  if (!("geolocation" in navigator)) {
    setGpsStatus("Geolocation not supported by this browser.");
    return;
  }
  if (!mmMap) initMarineMapOnce();
  setGpsStatus("Starting live GPS…");

  // Enable device compass (iOS permission happens here via user gesture)
  enableCompass();

  // Bind GEO -> map once
  if (!mapGpsBound) {
    mapUnsub = GEO.on((type, payload) => {
      if (type === "position") onPos(payload);
      else if (type === "error")
        setGpsStatus(`GPS error: ${payload.message || payload.code}`);
      else if (type === "perm" && payload === "denied")
        setGpsStatus("Location blocked in site settings.");
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

  // ---------- Trail: collect moving fixes, batch map redraw and storage ----------
  const lastPt = trail.length ? trail[trail.length - 1] : null; // [rawLat, rawLon, t]
  const dtSinceLastPt = lastPt ? (now - lastPt[2]) / 1000 : Infinity;
  const dRaw = lastPt ? geoDistMeters(latitude, longitude, lastPt[0], lastPt[1]) : 0;
  const goodTrailFix = reliable && acc <= TRAIL_MAX_ACC_M;
  const shouldAdd = goodTrailFix &&
    (!lastPt || (moving && (!trailWasMoving ||
      (dRaw >= TRAIL_MIN_DIST_M && dtSinceLastPt >= TRAIL_MIN_SEC))));
  if (shouldAdd) {
    if (moving && trailWasMoving && lastPt) {
      totalDistM += dRaw;
    }
    // Store raw coordinates for the trail; only redraw/save periodically.
    trail.push([latitude, longitude, now]);
    if (trail.length > TRAIL_MAX_POINTS)
      trail.splice(0, trail.length - TRAIL_MAX_POINTS);
    queueTrailRedraw();
    queueTrailSave();
  }
  trailWasMoving = moving && goodTrailFix;

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
  mmMap.getSource("trail").setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: trail.map((p) => [p[1], p[0]]),
        },
      },
    ],
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
    // Reset heading smoothing so the first rotation is crisp
    emaHead = null;
    setGpsStatus("Resumed — refreshing GPS & sensors…");
  } else {
    flushTrailSave();
  }
});
window.addEventListener("pagehide", flushTrailSave);

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
  $("#mm-startgps")?.addEventListener("click", startGpsForMap);
  $("#mm-recenter")?.addEventListener("click", recenterToBoat);

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

  $("#mm-drop-marker")?.addEventListener("click", (e) => {
    addMarkerActive = !addMarkerActive;
    e.target.textContent = addMarkerActive ? "Tap map…" : "Drop marker";
    setGpsStatus(addMarkerActive ? "Tap on the map to place marker." : "");
  });

  $("#mm-snapnorth")?.addEventListener("click", () => {
    toggleCourseUp(false);
    const chk = $("#mm-courseup");
    if (chk) chk.checked = false;
  });

  $("#mm-resettrail")?.addEventListener("click", resetTrail);
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
