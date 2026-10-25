// Needs common.js loaded first: <script src="common.js"></script>
const {
  API_URLS, OPERATOR_NAMES, escapeHtml, naturalCompare, describeDelay,
  getPosition, loadLocalData, fetchAllVehicles, fetchStops, enrichVehicle
} = Common;

const REFRESH_MS = 10_000;

// ============================================================
// State
// ============================================================

const ctx = { vehicles: {}, routes: {}, stops: {}, patterns: {} };

let allVehicles = [];
let lastWarning = "";
let isRefreshing = false;
let refreshTimer = null;

const markers = new Map();
const warnedRoutes = new Set();

const $ = id => document.getElementById(id);


// ============================================================
// Map
// ============================================================

const map = L.map("map").setView([46.1870132,21.314879], 13);

const markerBus = L.icon({
  iconUrl: "../images/markerBus.png",
  iconSize: [75, 65],
  iconAnchor: [35, 32],
  popupAnchor: [0, -32]
});

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);


// ============================================================
// Popup
// ============================================================

function delayText(seconds) {
  const { kind, minutes } = describeDelay(seconds);
  if (kind === "early") return `${minutes} min în avans`;
  if (kind === "late") return `${minutes} min întârziere`;
  return "La timp";
}

function popupHtml(v) {
  const row = (label, value) => `<p><strong>${label}:</strong> ${escapeHtml(value)}</p>`;

  return `<div class="vehicle-popup">${[
    row("Operator", v.operatorName),
    row("Nr. Parc", v.label),
    row("Nr. Inmatriculare", v.unknownPlate ? `Unknown (vehicle ${v.id})` : v.licensePlate),
    row("Model", v.model),
    row("Linia", v.routeIndicative),
    v.stopName ? row("Următoarea stație", v.stopName) : "",
    row("Întârziere", delayText(Number(v.delaySeconds ?? 0)))
  ].join("")}</div>`;
}

function upsertMarker(v) {
  const position = getPosition(v);
  if (!position) return;

  const existing = markers.get(v.key);

  if (existing) {
    existing.setLatLng(position).setPopupContent(popupHtml(v));
    return;
  }

  markers.set(v.key, L.marker(position, { icon: markerBus }).bindPopup(popupHtml(v)).addTo(map));
}

function removeStaleMarkers(currentVehicles) {
  const currentKeys = new Set(currentVehicles.map(v => v.key));

  for (const [key, marker] of markers) {
    if (!currentKeys.has(key)) {
      marker.remove();
      markers.delete(key);
    }
  }
}


// ============================================================
// Filters
// ============================================================

function readFilters() {
  const route = $("routeFilter").value;

  return {
    operator: $("operatorFilter").value,
    route: route === "all" ? null : route.split("|"), // [operator, routeId]
    model: $("modelFilter").value,
    unknown: $("unknownFilter").value
  };
}

function matches(v, f) {
  if (f.operator !== "all" && v.operator !== f.operator) return false;
  if (f.route && v.routeKey !== f.route.join("|")) return false;
  if (f.model !== "all" && v.model !== f.model) return false;

  if (f.unknown === "plate") return v.unknownPlate;
  if (f.unknown === "model") return v.unknownModel;
  if (f.unknown === "any") return v.unknownPlate || v.unknownModel;

  return true;
}

// makes is so that the options don't refresh unless new data has loaded
function fillSelect(select, placeholder, options) {
  const signature = JSON.stringify(options);
  if (select.dataset.signature === signature) return;

  const previous = select.value;

  select.replaceChildren(
    new Option(placeholder, "all"),
    ...options.map(o => new Option(o.label, o.value))
  );
  select.dataset.signature = signature;
  select.value = options.some(o => o.value === previous) ? previous : "all";
}

const byLabel = (a, b) => naturalCompare(a.label, b.label);

function vehiclesForSelectedOperator() {
  const operator = $("operatorFilter").value;
  return operator === "all" ? allVehicles : allVehicles.filter(v => v.operator === operator);
}

function updateModelFilter() {
  const models = new Set();

  for (const v of vehiclesForSelectedOperator()) {
    if (!v.unknownModel) models.add(v.model);
  }

  fillSelect(
    $("modelFilter"),
    "All models",
    [...models].map(m => ({ value: m, label: m })).sort(byLabel)
  );
}

function updateRouteFilter() {
  const routes = new Map();

  for (const v of vehiclesForSelectedOperator()) {
    if (v.routeId == null) continue;

    routes.set(v.routeKey, {
      value: v.routeKey,
      label: `${v.routeIndicative} (${OPERATOR_NAMES[v.operator] ?? v.operator})`
    });
  }

  fillSelect($("routeFilter"), "All routes", [...routes.values()].sort(byLabel));
}


// ============================================================
// Display
// ============================================================

function updateStatus(count) {
  const warning = lastWarning ? ` • Could not load: ${lastWarning}` : "";
  $("status").textContent =
    `${count} buses shown • Last update: ${new Date().toLocaleTimeString()}${warning}`;
}

function displayVehicles() {
  const filters = readFilters();
  const shown = allVehicles.filter(v => matches(v, filters));

  removeStaleMarkers(shown);
  shown.forEach(upsertMarker);
  updateStatus(shown.length);
}


// ============================================================
// Refresh loop
// ============================================================

async function updateVehicles() {
  if (isRefreshing) return;
  isRefreshing = true;
  $("status").textContent = "Updating...";

  try {
    const { buses, failed } = await fetchAllVehicles();

    if (failed.length === API_URLS.length) {
      $("status").textContent = "Could not load any operator. Showing the last known positions.";
      return;
    }

    allVehicles = buses.map(bus => enrichVehicle(bus, ctx));
    lastWarning = failed.join(", ");

    for (const v of allVehicles) {
      const warnKey = `${v.operator}:${v.routeId}`;
      if (!v.routeKnown && !warnedRoutes.has(warnKey)) {
        warnedRoutes.add(warnKey);
        console.warn("Route not found in routes.json:", v.operator, v.routeId);
      }
    }

    updateModelFilter();
    updateRouteFilter();
    displayVehicles();
  } catch (error) {
    console.error(error);
    $("status").textContent = `Error updating buses: ${error.message}`;
  } finally {
    isRefreshing = false;
  }
}


async function refreshLoop() {
  clearTimeout(refreshTimer);
  if (!document.hidden) await updateVehicles();
  refreshTimer = setTimeout(refreshLoop, REFRESH_MS);
}


// ============================================================
// Events
// ============================================================

$("operatorFilter").addEventListener("change", () => {
  updateModelFilter();
  updateRouteFilter();
  displayVehicles();
});

$("routeFilter").addEventListener("change", () => {
  const route = $("routeFilter").value;

  if (route !== "all") {
    $("operatorFilter").value = route.split("|")[0];
    updateModelFilter();
  }

  displayVehicles();
});

$("modelFilter").addEventListener("change", displayVehicles);
$("unknownFilter").addEventListener("change", displayVehicles);
$("refreshButton").addEventListener("click", refreshLoop);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshLoop();
});


// ============================================================
// Start
// ============================================================

(async function startApp() {
  try {
    $("status").textContent = "Loading local data...";
    const [local, stopData] = await Promise.all([loadLocalData(), fetchStops()]);
    Object.assign(ctx, local, stopData);

    $("status").textContent = "Loading buses...";
    await refreshLoop();
  } catch (error) {
    console.error(error);
    $("status").textContent = `Startup error: ${error.message}`;
  }
})();
