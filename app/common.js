// code sharde by the web pages

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();   // Node
  } else {
    root.Common = factory();      // Browser: window.Common
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ============================================================
  // Settings
  // ============================================================

  const API_URLS = [
    {
      operator: "Transbus Buzau",
      name: "Transbus Buzau",
      url: "https://www.telelink.city/api/v1/556cb222-5456-403c-904f-cff58fbfd622/transport/planner/vehicles"
    }
  ];

  const OPERATOR_NAMES = Object.fromEntries(API_URLS.map(a => [a.operator, a.name]));

  const ON_TIME_SECONDS = 60;
  const FETCH_TIMEOUT_MS = 8000;
  const TIME_ZONE = "Europe/Bucharest";


  // ============================================================
  // Small helpers
  // ============================================================

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
  }

  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  async function fetchJson(url, label = url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${label} returned ${response.status}`);
    return response.json();
  }


  // ============================================================
  // date and time conversion to bucharest
  // ============================================================

  const dateFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  });

  const timeFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });

  function bucharestDate(date = new Date()) {
    return dateFormat.format(date);
  }

  function bucharestTime(date = new Date()) {
    return timeFormat.format(date);
  }

  function formatTime(iso) {
    return iso ? bucharestTime(new Date(iso)) : "";
  }

  function toMinutes(hhmm) {
    const [h, m] = String(hhmm).split(":").map(Number);
    return h * 60 + m;
  }


  // ============================================================
  // Vehicle helpers
  // ============================================================

  // type of delay
  function describeDelay(seconds) {
    const minutes = Math.round(Math.abs(seconds) / 60);
    if (seconds > ON_TIME_SECONDS) return { kind: "late", minutes };
    if (seconds < -ON_TIME_SECONDS) return { kind: "early", minutes };
    return { kind: "ontime", minutes };
  }

  // get lat and lng
  function getPosition(v) {
    const lat = Number(v.latitude);
    const lng = Number(v.longitude);
    return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
  }


  // ============================================================
  // Loading data
  // ============================================================


  async function loadLocalData() {
    const [vehicles, routes] = await Promise.all([
      fetchJson("data/vehicles.json", "data/vehicles.json"),
      fetchJson("data/routes.json", "data/routes.json")
    ]);
    return { vehicles, routes };
  }

  // makes it so that the vehicles from the API that isn't down still show on the map
  async function fetchAllVehicles() {
    const results = await Promise.allSettled(API_URLS.map(async api => {
      const data = await fetchJson(api.url, `${api.name} API`);
      if (!Array.isArray(data)) throw new Error(`${api.name} API did not return an array`);
      return data.map(v => ({ ...v, operator: api.operator, operatorName: api.name }));
    }));

    const buses = [];
    const failed = [];

    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        buses.push(...result.value);
      } else {
        failed.push(API_URLS[i].name);
        console.error(`Could not load ${API_URLS[i].name}:`, result.reason);
      }
    });

    return { buses, failed };
  }

   // stops:    { operator: { stopId: "Stop name" } }
   // patterns: { operator: { "routeId:patternIndex": { from, to } } }
  async function fetchStops() {
    const stops = {};
    const patterns = {};

    const results = await Promise.allSettled(API_URLS.map(api =>
      fetchJson(api.url.replace(/vehicles$/, "stops"), `${api.name} stops API`)));

    results.forEach((result, i) => {
      const { operator, name } = API_URLS[i];
      stops[operator] = {};
      patterns[operator] = {};

      if (result.status !== "fulfilled" || !Array.isArray(result.value)) {
        console.error(`Could not load stops for ${name}:`, result.reason);
        return;
      }

      for (const stop of result.value) {
        stops[operator][stop.id] = stop.name;

        for (const p of stop.patterns ?? []) {
          patterns[operator][`${p.routeId}:${p.index}`] ??= { from: p.fromStopId, to: p.toStopId };
        }
      }
    });

    return { stops, patterns };
  }


  // ============================================================
  // raw API data + local data
  // ============================================================

  /**
   * Adds these fields on top of everything the API sent (lat/lng, delaySeconds, ...):
   *
   *   id, key            "53", "transmixt:53"
   *   routeKey           "transmixt|10"
   *   routeKnown         false if routes.json doesn't know this route yet
   *   routeIndicative    "10" (the line number people see)
   *   licensePlate       real plate, or "Unknown"
   *   model              real model, or "Unknown"
   *   unknownPlate/Model true/false
   *   assignedRoutes     from vehicles.json, [] if none
   *   destination        "Gara" (headsign if it exists)
   *   direction          "Piața - Gara" (in case the headsign doesn't exist)
   *   stopName           the stop the bus is at or heading to ("" if none)
   */
  function enrichVehicle(bus, ctx) {
    const { operator } = bus;

    const routeInfo = ctx.routes[operator]?.[String(bus.routeId)];
    const vehicleInfo = ctx.vehicles[operator]?.[String(bus.label)];

    const stopName = id => ctx.stops[operator]?.[id] ?? "";

    //  patternIndex 1-10 = direction 0, 11+ = direction 1
    const pattern = ctx.patterns[operator]?.[`${bus.routeId}:${bus.patternIndex}`];
    const first = pattern ? stopName(pattern.from) : "";
    const last = pattern ? stopName(pattern.to) : "";
    const patternUsable = Boolean(pattern && pattern.from !== pattern.to && first && last);

    const directionIndex = bus.patternIndex < 0 ? -1 : bus.patternIndex >= 11 ? 1 : 0;
    const fromRoutesJson = routeInfo?.directions?.[String(directionIndex)] || "";
    const headsign = bus.headsign?.trim() || "";

    const fleet = String(bus.label ?? "");
    const plate = vehicleInfo?.licensePlate ? String(vehicleInfo.licensePlate) : "";
    const model = vehicleInfo?.model ? String(vehicleInfo.model) : "";
    const unknownPlate = !plate || plate.toLowerCase() === "unknown";
    const unknownModel = !model || model.toLowerCase() === "unknown";

    return {
      ...bus,

      id: String(bus.label ?? ""),
      key: `${operator}:${bus.label}`,

      routeKey: `${operator}|${bus.routeId}`,
      routeKnown: Boolean(routeInfo),
      routeIndicative: String(routeInfo?.indicative ?? bus.routeId),

      label: fleet,
      licensePlate: unknownPlate ? "Unknown" : plate,
      model: unknownModel ? "Unknown" : model,
      unknownPlate,
      unknownModel,
      assignedRoutes: vehicleInfo?.assignedRoutes ?? [],

      destination: headsign || (patternUsable ? last : "") || fromRoutesJson || "Unknown",
      direction: headsign || (patternUsable ? `${first} \u2192 ${last}` : "") || fromRoutesJson || "Unknown",

      stopName: bus.stopId != null ? (stopName(bus.stopId) || `Stop ${bus.stopId}`) : ""
    };
  }


  return {
    API_URLS,
    OPERATOR_NAMES,
    ON_TIME_SECONDS,
    escapeHtml,
    naturalCompare,
    fetchJson,
    bucharestDate,
    bucharestTime,
    formatTime,
    toMinutes,
    describeDelay,
    getPosition,
    loadLocalData,
    fetchAllVehicles,
    fetchStops,
    enrichVehicle
  };
});
