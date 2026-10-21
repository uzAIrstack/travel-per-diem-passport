const API_BASE = "https://api.gsa.gov/travel/perdiem/v2/rates";

const datasets = {
  2027: {
    rates: "https://www.gsa.gov/system/files/FY2027_PerDiemRates_Validated090126.xlsx",
    zip: "https://www.gsa.gov/system/files/FY2027PerDiemZipCode_Validated090126.xlsx"
  },
  2026: {
    rates: "https://www.gsa.gov/system/files/FY2026_PerDiemMasterRatesFile.xlsx",
    zip: "https://www.gsa.gov/system/files/FY2026_ZipCodeFile.xlsx"
  },
  2025: {
    rates: "https://www.gsa.gov/system/files/FY2025_PerDiemMasterRatesFile.xlsx",
    zip: "https://www.gsa.gov/system/files/FY2025_ZipCodeFile_080824.xlsx"
  }
};

const fallbackRates = {
  "Washington, DC": { code: "DCA", lodging: 287, mie: 92, breakfast: 23, lunch: 26, dinner: 38, incidental: 5 },
  "New York City, NY": { code: "NYC", lodging: 358, mie: 92, breakfast: 23, lunch: 26, dinner: 38, incidental: 5 },
  "Chicago, IL": { code: "CHI", lodging: 234, mie: 86, breakfast: 22, lunch: 23, dinner: 36, incidental: 5 },
  "Austin, TX": { code: "AUS", lodging: 173, mie: 80, breakfast: 20, lunch: 22, dinner: 33, incidental: 5 },
  "Los Angeles, CA": { code: "LAX", lodging: 191, mie: 86, breakfast: 22, lunch: 23, dinner: 36, incidental: 5 },
  "Standard CONUS": { code: "USA", lodging: 113, mie: 68, breakfast: 16, lunch: 19, dinner: 28, incidental: 5 }
};

const knownBreakdowns = {
  68: { breakfast: 16, lunch: 19, dinner: 28, incidental: 5 },
  74: { breakfast: 18, lunch: 20, dinner: 31, incidental: 5 },
  80: { breakfast: 20, lunch: 22, dinner: 33, incidental: 5 },
  86: { breakfast: 22, lunch: 23, dinner: 36, incidental: 5 },
  92: { breakfast: 23, lunch: 26, dinner: 38, incidental: 5 }
};

const $ = selector => document.querySelector(selector);
const routeTrack = $("#routeTrack");
const dayList = $("#dayList");
const addStopForm = $("#addStopForm");
const apiCache = { mie: new Map(), lookup: new Map() };
let lookupResults = [];
let selectedLocation = null;
let editingStopIndex = null;

function makeApiFallbackLocation(label, fiscalYear = 2027) {
  const rate = fallbackRates[label] || fallbackRates["Standard CONUS"];
  return {
    id: `demo:${label}:${fiscalYear}`,
    label,
    city: label.replace(/, [A-Z]{2}$/, ""),
    state: label.match(/, ([A-Z]{2})$/)?.[1] || "",
    zip: "",
    county: "Demo rate",
    code: rate.code,
    fiscalYear,
    source: "DEMO FALLBACK",
    months: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index + 1, rate.lodging])),
    mie: rate.mie,
    breakfast: rate.breakfast,
    lunch: rate.lunch,
    dinner: rate.dinner,
    incidental: rate.incidental
  };
}

function makeApiStop(label, start, end) {
  const location = makeApiFallbackLocation(label, fiscalYearForDate(start));
  return { query: label, label, start, end, locationsByFY: { [location.fiscalYear]: location } };
}

const initialState = () => ({
  travelerName: "",
  homeCity: "Washington, DC",
  scope: "both",
  personal: {},
  stops: [
    makeStop("Washington, DC", "2026-10-21", "2026-10-22"),
    makeStop("New York City, NY", "2026-10-24", "2026-10-25")
  ],
  meals: {
    "2026-10-22": ["lunch"],
    "2026-10-24": ["breakfast"]
  }
});

let state = initialState();

function localDate(value) {
  return new Date(`${value}T12:00:00`);
}

function iso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fiscalYearForDate(value) {
  const date = localDate(value);
  return date.getMonth() >= 9 ? date.getFullYear() + 1 : date.getFullYear();
}

function money(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function shortDate(value) {
  return localDate(value).toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toUpperCase();
}

function routeSummaryLabel() {
  const labels = state.stops.map(stop => stop.label);
  return labels.length ? labels.join(" → ") : "NO DESTINATION SELECTED";
}

function tripDateLabel() {
  const days = tripDays();
  return days.length ? `${shortDate(days[0].date)} → ${shortDate(days.at(-1).date)}` : "NO DATES YET";
}

function datesBetween(start, end) {
  const dates = [];
  const cursor = localDate(start);
  const last = localDate(end);
  while (cursor <= last) {
    dates.push(iso(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  })[character]);
}

function getApiKey() {
  try { return sessionStorage.getItem("gsaApiKey") || ""; } catch { return ""; }
}

function saveApiKey(value) {
  try { sessionStorage.setItem("gsaApiKey", value); } catch { /* session storage may be disabled */ }
}

function updateDatasetLinks() {
  const year = Number($("#fiscalYear").value);
  const set = datasets[year];
  $("#rateFileLink").href = set.rates;
  $("#rateFileLink").textContent = `↓ FY${String(year).slice(-2)} RATE FILE`;
  $("#zipFileLink").href = set.zip;
  $("#zipFileLink").textContent = `↓ FY${String(year).slice(-2)} ZIP FILE`;
}

function setApiStatus(mode, message) {
  const status = $("#apiStatus");
  status.className = `status-badge ${mode}`;
  status.textContent = message;
  $("#sourceDot").style.background = mode === "error" ? "var(--coral)" : mode === "demo" ? "var(--yellow)" : "#3ee35f";
  $("#sourceMode").textContent = mode === "connected" ? "LIVE" : mode === "error" ? "CHECK KEY" : "READY";
}

async function apiFetch(path, key) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { "x-api-key": key },
      signal: controller.signal
    });
    if (!response.ok) {
      const hint = response.status === 403 ? "API key rejected" : `GSA API returned ${response.status}`;
      throw new Error(hint);
    }
    return await response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

async function getMieTable(year, key) {
  if (apiCache.mie.has(year)) return apiCache.mie.get(year);
  const rows = await apiFetch(`/conus/mie/${year}`, key);
  if (!Array.isArray(rows)) throw new Error("Unexpected GSA M&IE response");
  apiCache.mie.set(year, rows);
  return rows;
}

function cleanCityForApi(city) {
  return city.replace(/\./g, "").replace(/[’'\-]/g, " ").replace(/\s+/g, " ").trim();
}

function parseDestinationQuery(query) {
  const trimmed = query.trim();
  if (/^\d{5}$/.test(trimmed)) return { kind: "zip", zip: trimmed };
  const match = trimmed.match(/^(.+?)(?:,|\s)\s*([A-Za-z]{2})$/);
  if (!match) throw new Error("Use City, ST or a 5-digit ZIP");
  return { kind: "city", city: cleanCityForApi(match[1]), state: match[2].toUpperCase() };
}

function breakdownFor(total, table) {
  const fromApi = table.find(row => Number(row.total) === Number(total));
  if (fromApi) return {
    breakfast: Number(fromApi.breakfast),
    lunch: Number(fromApi.lunch),
    dinner: Number(fromApi.dinner),
    incidental: Number(fromApi.incidental)
  };
  return knownBreakdowns[Number(total)] || {
    breakfast: Math.round(total * .24),
    lunch: Math.round(total * .27),
    dinner: Math.max(0, Number(total) - 5 - Math.round(total * .24) - Math.round(total * .27)),
    incidental: 5
  };
}

function parseApiLocations(payload, queryParts, fiscalYear, mieTable) {
  const output = [];
  const groups = Array.isArray(payload?.rates) ? payload.rates : [];
  groups.forEach(group => (Array.isArray(group.rate) ? group.rate : []).forEach(rate => {
    const monthRows = Array.isArray(rate?.months?.month) ? rate.months.month : [];
    const months = Object.fromEntries(monthRows.map(month => [Number(month.number), Number(month.value)]));
    const mie = Number(rate.meals);
    const breakdown = breakdownFor(mie, mieTable);
    const stateCode = String(group.state || queryParts.state || "").toUpperCase();
    const returnedCity = String(rate.city || queryParts.city || "GSA locality");
    const zip = queryParts.kind === "zip" ? queryParts.zip : String(rate.zip || "");
    const label = `${returnedCity}${stateCode ? `, ${stateCode}` : ""}${zip ? ` · ${zip}` : ""}`;
    output.push({
      id: `gsa:${fiscalYear}:${stateCode}:${zip || returnedCity}:${rate.county || ""}`,
      label,
      city: returnedCity,
      state: stateCode,
      zip,
      county: String(rate.county || ""),
      code: zip || stateCode || "GSA",
      fiscalYear,
      source: `GSA API FY${String(fiscalYear).slice(-2)}`,
      months,
      mie,
      ...breakdown
    });
  }));
  const seen = new Set();
  return output.filter(location => {
    const key = `${location.label}|${location.county}|${location.mie}|${JSON.stringify(location.months)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function lookupApiLocations(query, fiscalYear) {
  const key = getApiKey();
  if (!key) throw new Error("Connect a GSA API key for nationwide search");
  const cacheKey = `${fiscalYear}:${query.trim().toLowerCase()}`;
  if (apiCache.lookup.has(cacheKey)) return apiCache.lookup.get(cacheKey);
  const parts = parseDestinationQuery(query);
  const path = parts.kind === "zip"
    ? `/zip/${parts.zip}/year/${fiscalYear}`
    : `/city/${encodeURIComponent(parts.city)}/state/${parts.state}/year/${fiscalYear}`;
  const [payload, mieTable] = await Promise.all([apiFetch(path, key), getMieTable(fiscalYear, key)]);
  const locations = parseApiLocations(payload, parts, fiscalYear, mieTable);
  if (!locations.length) throw new Error("No GSA locality found. Try the ZIP code or verify the state abbreviation.");
  apiCache.lookup.set(cacheKey, locations);
  return locations;
}

function fallbackLookup(query, fiscalYear) {
  const normalized = query.trim().toLowerCase();
  return Object.keys(fallbackRates)
    .filter(label => label.toLowerCase().includes(normalized) || normalized.includes(label.toLowerCase()))
    .map(label => makeApiFallbackLocation(label, fiscalYear));
}

function renderApiLookupResults(results, note = "") {
  lookupResults = results;
  selectedLocation = results[0] || null;
  $("#addRouteBtn").disabled = !selectedLocation;
  const target = $("#lookupResult");
  if (!results.length) {
    target.textContent = note || "No matching location.";
    return;
  }
  const month = Number($("#newStart").value?.slice(5, 7));
  target.innerHTML = `${note ? `<span>${escapeHtml(note)}</span><br>` : ""}${results.slice(0, 8).map((location, index) => `
    <button class="lookup-choice ${index === 0 ? "selected" : ""}" type="button" data-location-index="${index}">${escapeHtml(location.label)} · ${money(location.months[month] || Object.values(location.months)[0] || 0)} / ${money(location.mie)}</button>
  `).join("")}`;
  target.querySelectorAll("[data-location-index]").forEach(button => button.addEventListener("click", () => {
    selectedLocation = lookupResults[Number(button.dataset.locationIndex)];
    target.querySelectorAll(".lookup-choice").forEach(choice => choice.classList.toggle("selected", choice === button));
  }));
}

async function searchApiDestination() {
  const query = $("#locationQuery").value.trim();
  if (!query) {
    renderApiLookupResults([], "Enter a city with state abbreviation or a 5-digit ZIP.");
    return;
  }
  const fiscalYear = fiscalYearForDate($("#newStart").value || iso(new Date()));
  if (!datasets[fiscalYear]) {
    renderApiLookupResults([], `FY${String(fiscalYear).slice(-2)} is not available in this build.`);
    return;
  }
  $("#fiscalYear").value = String(fiscalYear);
  updateDatasetLinks();
  $("#lookupResult").textContent = `SEARCHING GSA FY${String(fiscalYear).slice(-2)}…`;
  $("#lookupBtn").disabled = true;
  try {
    if (getApiKey()) {
      const results = await lookupApiLocations(query, fiscalYear);
      renderApiLookupResults(results, `${results.length} OFFICIAL GSA MATCH${results.length === 1 ? "" : "ES"}`);
      setApiStatus("connected", `GSA FY${String(fiscalYear).slice(-2)} LIVE`);
    } else {
      const results = fallbackLookup(query, fiscalYear);
      renderApiLookupResults(results, results.length ? "DEMO RATE — CONNECT A KEY FOR OFFICIAL LOOKUP" : "Connect a free GSA API key above to search every CONUS city or ZIP.");
    }
  } catch (error) {
    renderApiLookupResults([], error.message || "GSA lookup failed.");
    setApiStatus("error", "CONNECTION ERROR");
  } finally {
    $("#lookupBtn").disabled = false;
  }
}

async function ensureApiFiscalYearLocations(query, start, end, seedLocation) {
  const years = [...new Set(datesBetween(start, end).map(fiscalYearForDate))];
  const locationsByFY = { [seedLocation.fiscalYear]: seedLocation };
  for (const year of years) {
    if (locationsByFY[year]) continue;
    if (getApiKey()) {
      const matches = await lookupApiLocations(query, year);
      locationsByFY[year] = matches[0];
    } else {
      locationsByFY[year] = makeApiFallbackLocation(seedLocation.label, year);
    }
  }
  return locationsByFY;
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function downloadedLocation(index, zip = "", labelOverride = "") {
  const row = FY2027_DATA.locations[index];
  const label = labelOverride || `${row.name}, ${row.state}${zip ? ` · ${zip}` : ""}`;
  return {
    id: `gsa-file:2027:${row.state}:${row.destinationId}:${zip || "city"}`,
    dataIndex: index,
    label,
    city: row.name,
    state: row.state,
    zip,
    county: row.county || row.defined || "Standard CONUS",
    code: zip || row.state || "GSA",
    fiscalYear: 2027,
    source: "GSA FY27 FILE",
    months: Object.fromEntries(row.monthly.map((value, monthIndex) => [monthIndex + 1, Number(value)])),
    mie: Number(row.mie),
    breakfast: Number(row.breakfast),
    lunch: Number(row.lunch),
    dinner: Number(row.dinner),
    incidental: Number(row.incidental)
  };
}

function downloadedLocationsForZip(zip) {
  const reference = FY2027_DATA.zips[zip];
  if (reference === undefined) return [];
  const indexes = Array.isArray(reference) ? reference : [reference];
  return indexes.map(index => downloadedLocation(index, zip));
}

function makeFallbackLocation(label, fiscalYear = 2027) {
  const standardIndex = FY2027_DATA.locations.findIndex(location => location.destinationId === 0);
  const location = downloadedLocation(standardIndex, "", label);
  location.fiscalYear = fiscalYear;
  return location;
}

function makeStop(label, start, end) {
  const initialZip = label === "Washington, DC" ? "20016" : label === "New York City, NY" ? "10005" : "20016";
  const location = { ...downloadedLocationsForZip(initialZip)[0], label };
  return { query: initialZip, label, start, end, locationsByFY: { 2027: location } };
}

function downloadedCityLookup(query) {
  const trimmed = query.trim();
  if (/^\d{5}$/.test(trimmed)) return downloadedLocationsForZip(trimmed);
  const stateMatch = trimmed.match(/(?:,|\s)\s*([A-Za-z]{2})$/);
  const stateCode = stateMatch ? stateMatch[1].toUpperCase() : "";
  const cityText = stateMatch ? trimmed.slice(0, stateMatch.index).replace(/,$/, "").trim() : trimmed;
  const needle = normalizeSearchText(cityText);
  if (needle.length < 2) return [];
  const matches = FY2027_DATA.locations
    .map((location, index) => ({ location, index }))
    .filter(({ location }) => location.destinationId !== 0)
    .filter(({ location }) => !stateCode || location.state === stateCode)
    .map(({ location, index }) => {
      const name = normalizeSearchText(location.name);
      const county = normalizeSearchText(location.county);
      const defined = normalizeSearchText(location.defined);
      const washingtonAlias = location.state === "DC" && needle === "washington";
      const matchesText = washingtonAlias || name.includes(needle) || county.includes(needle) || defined.includes(needle);
      const score = washingtonAlias ? 0 : name === needle ? 0 : name.startsWith(needle) ? 1 : county.includes(needle) ? 2 : 3;
      return { index, matchesText, score, name: location.name };
    })
    .filter(result => result.matchesText)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return matches.slice(0, 12).map(result => downloadedLocation(result.index));
}

function renderLookupResults(results, note = "") {
  lookupResults = results;
  selectedLocation = results[0] || null;
  $("#addRouteBtn").disabled = !selectedLocation;
  const target = $("#lookupResult");
  if (!results.length) {
    target.textContent = note || "No matching FY27 destination. Try a 5-digit ZIP for the exact rate.";
    return;
  }
  const month = Number($("#newStart").value?.slice(5, 7));
  target.innerHTML = `${note ? `<span>${escapeHtml(note)}</span><br>` : ""}${results.map((location, index) => `
    <button class="lookup-choice ${index === 0 ? "selected" : ""}" type="button" data-location-index="${index}">${escapeHtml(location.label)} · ${money(location.months[month])} LODGING / ${money(location.mie)} M&IE</button>
  `).join("")}`;
  target.querySelectorAll("[data-location-index]").forEach(button => button.addEventListener("click", () => {
    selectedLocation = lookupResults[Number(button.dataset.locationIndex)];
    target.querySelectorAll(".lookup-choice").forEach(choice => choice.classList.toggle("selected", choice === button));
  }));
}

function searchDestination() {
  const query = $("#locationQuery").value.trim();
  if (!query) {
    renderLookupResults([], "Enter a GSA destination with state or a 5-digit ZIP.");
    return;
  }
  const fiscalYear = fiscalYearForDate($("#newStart").value || "2026-10-01");
  if (fiscalYear !== 2027) {
    renderLookupResults([], "This build currently includes FY2027 dates only: October 1, 2026 through September 30, 2027.");
    return;
  }
  const results = downloadedCityLookup(query);
  const isZip = /^\d{5}$/.test(query);
  const note = results.length
    ? isZip && results.length > 1
      ? `${results.length} GSA RATE AREAS OVERLAP THIS ZIP — SELECT THE APPLICABLE LOCALITY`
      : `${results.length} FY27 FILE MATCH${results.length === 1 ? "" : "ES"}`
    : "GSA does not name every U.S. city. Enter the destination ZIP for the exact FY27 rate.";
  renderLookupResults(results, note);
}

async function ensureFiscalYearLocations(query, start, end, seedLocation) {
  const years = [...new Set(datesBetween(start, end).map(fiscalYearForDate))];
  if (years.some(year => year !== 2027)) {
    throw new Error("FY27 data covers October 1, 2026 through September 30, 2027");
  }
  return { 2027: seedLocation };
}

function tripDays() {
  if (!state.stops.length) return [];
  const ordered = [...state.stops].sort((a, b) => a.start.localeCompare(b.start));
  const covered = new Map();
  ordered.forEach(stop => datesBetween(stop.start, stop.end).forEach(date => {
    if (!covered.has(date)) covered.set(date, { date, stop, forcedPersonal: false });
  }));
  const start = ordered.reduce((earliest, stop) => stop.start < earliest ? stop.start : earliest, ordered[0].start);
  const end = ordered.reduce((latest, stop) => stop.end > latest ? stop.end : latest, ordered[0].end);
  return datesBetween(start, end).map(date => covered.get(date) || { date, stop: null, forcedPersonal: true });
}

function primaryLocation(stop) {
  return stop.locationsByFY[fiscalYearForDate(stop.start)] || Object.values(stop.locationsByFY)[0];
}

function locationForDay(day) {
  if (!day.stop) return makeFallbackLocation("Standard CONUS", fiscalYearForDate(day.date));
  return day.stop.locationsByFY[fiscalYearForDate(day.date)] || primaryLocation(day.stop);
}

function renderRoute() {
  routeTrack.innerHTML = state.stops.map((stop, index) => {
    const location = primaryLocation(stop);
    const isEditing = editingStopIndex === index;
    return `
      <article class="stop">
        <div class="stop-inner">
          <span class="stop-number">STOP ${String(index + 1).padStart(2, "0")} · ${escapeHtml(location.code)} · ${escapeHtml(location.source)}</span>
          <div class="stop-title">
            <h3>${escapeHtml(stop.label)}</h3>
            <div class="stop-actions">
              <button class="edit-stop" type="button" data-edit="${index}" aria-expanded="${isEditing}" aria-label="Edit travel dates for ${escapeHtml(stop.label)}">✎ EDIT DATES</button>
              <button class="remove-stop" type="button" data-remove="${index}" aria-label="Remove ${escapeHtml(stop.label)} from trip">× REMOVE CITY</button>
            </div>
          </div>
          <div class="stop-meta"><span>${shortDate(stop.start)} → ${shortDate(stop.end)}</span><span>${datesBetween(stop.start, stop.end).length} ${datesBetween(stop.start, stop.end).length === 1 ? "DAY" : "DAYS"}</span></div>
          ${isEditing ? `
            <form class="edit-stop-form" data-edit-form="${index}">
              <label>ARRIVE<input name="editStart" type="date" min="2026-10-01" max="2027-09-30" value="${stop.start}" required></label>
              <label>LEAVE<input name="editEnd" type="date" min="2026-10-01" max="2027-09-30" value="${stop.end}" required></label>
              <button class="edit-save" type="submit">SAVE</button>
              <button class="edit-cancel" type="button" data-cancel-edit>Cancel</button>
            </form>
          ` : ""}
        </div>
      </article>
    `;
  }).join("") + `
    <button class="add-stop" id="addStopBtn" type="button"><span class="plus">＋</span><span>ADD A CITY</span></button>
  `;

  routeTrack.querySelectorAll("[data-remove]").forEach(button => button.addEventListener("click", () => {
    state.stops.splice(Number(button.dataset.remove), 1);
    editingStopIndex = null;
    render();
    showToast("CITY REMOVED FROM ROUTE");
  }));

  routeTrack.querySelectorAll("[data-edit]").forEach(button => button.addEventListener("click", () => {
    editingStopIndex = Number(button.dataset.edit);
    renderRoute();
    routeTrack.querySelector(`[data-edit-form="${editingStopIndex}"] input`)?.focus();
  }));

  routeTrack.querySelectorAll("[data-cancel-edit]").forEach(button => button.addEventListener("click", () => {
    editingStopIndex = null;
    renderRoute();
  }));

  routeTrack.querySelectorAll("[data-edit-form]").forEach(form => form.addEventListener("submit", event => {
    event.preventDefault();
    const index = Number(form.dataset.editForm);
    const formData = new FormData(form);
    const start = String(formData.get("editStart"));
    const end = String(formData.get("editEnd"));
    if (end < start) {
      showToast("LEAVE DATE MUST FOLLOW ARRIVAL");
      return;
    }
    if (fiscalYearForDate(start) !== 2027 || fiscalYearForDate(end) !== 2027) {
      showToast("FY2027 DATES: OCT 1, 2026 – SEP 30, 2027");
      return;
    }
    state.stops[index].start = start;
    state.stops[index].end = end;
    editingStopIndex = null;
    render();
    showToast("TRAVEL DATES UPDATED");
  }));

  $("#addStopBtn").addEventListener("click", () => {
    addStopForm.hidden = !addStopForm.hidden;
    if (!addStopForm.hidden) $("#locationQuery").focus();
  });

  const days = tripDays();
  $("#dateStamp").textContent = days.length ? `${shortDate(days[0].date)} → ${shortDate(days.at(-1).date)}` : "NO DATES YET";
}

function calculateDay(day, index, allDays) {
  const location = locationForDay(day);
  const lodgingRate = Number(location.months[localDate(day.date).getMonth() + 1] || 0);
  const rate = { ...location, lodging: lodgingRate };
  const isPersonal = day.forcedPersonal || Boolean(state.personal[day.date]);
  const claimable = allDays.filter(item => !item.forcedPersonal && !state.personal[item.date]);
  const isFirstOrLast = !isPersonal && (day.date === claimable[0]?.date || day.date === claimable.at(-1)?.date);
  const baseMie = isFirstOrLast ? rate.mie * .75 : rate.mie;
  const provided = state.meals[day.date] || [];
  const rawDeduction = provided.reduce((sum, meal) => sum + Number(rate[meal] || 0), 0);
  const includeMie = state.scope !== "lodging";
  const includeLodging = state.scope !== "mie";
  const mie = !isPersonal && includeMie ? Math.max(rate.incidental, baseMie - rawDeduction) : 0;
  const appliedDeduction = !isPersonal && includeMie ? Math.max(0, baseMie - mie) : 0;
  const lodging = !isPersonal && includeLodging && index !== allDays.length - 1 ? rate.lodging : 0;
  return { rate, location, isPersonal, isFirstOrLast, baseMie: isPersonal ? 0 : baseMie, rawDeduction: isPersonal ? 0 : rawDeduction, appliedDeduction, mie, lodging, total: mie + lodging };
}

function renderLedger() {
  const days = tripDays();
  if (!days.length) {
    dayList.innerHTML = `<div class="empty-ledger">NO CITIES YET — ADD A CITY TO START THE CALCULATION.</div>`;
    return;
  }
  dayList.innerHTML = days.map((day, index) => {
    const calc = calculateDay(day, index, days);
    const date = localDate(day.date);
    const provided = state.meals[day.date] || [];
    return `
      <article class="day-row ${calc.isPersonal ? "personal-day" : ""}">
        <div class="day-date">${date.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase()}<strong>${String(date.getDate()).padStart(2, "0")}</strong>${date.toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</div>
        <div class="day-city"><strong>${calc.isPersonal ? "PERSONAL DAY" : escapeHtml(day.stop.label)}</strong><span>${calc.isPersonal ? "NOT CLAIMED · $0" : `${state.scope !== "mie" ? `${money(calc.rate.lodging)} LODGING` : ""}${state.scope === "both" ? " · " : ""}${state.scope !== "lodging" ? `${money(calc.rate.mie)} M&IE` : ""}`}</span>${calc.isPersonal ? `<span class="personal-tag">${day.forcedPersonal ? "AUTO · ITINERARY GAP" : "MANUALLY EXCLUDED"}</span>` : calc.isFirstOrLast && state.scope !== "lodging" ? `<span class="travel-tag">75% M&IE DAY</span>` : ""}</div>
        <div class="meal-toggles ${state.scope === "lodging" || calc.isPersonal ? "disabled" : ""}" aria-label="Provided meals and personal day status for ${day.date}">
          ${[["breakfast","☀"],["lunch","◒"],["dinner","☾"]].map(([meal, icon]) => `<button class="meal-button ${provided.includes(meal) && state.scope !== "lodging" && !calc.isPersonal ? "active" : ""}" type="button" data-date="${day.date}" data-meal="${meal}" data-label="${meal.toUpperCase()} · DEDUCT ${money(calc.rate[meal])}" aria-pressed="${provided.includes(meal) && state.scope !== "lodging" && !calc.isPersonal}" aria-label="Toggle provided ${meal}, deduction ${money(calc.rate[meal])}" ${state.scope === "lodging" || calc.isPersonal ? "disabled" : ""}>${icon}</button>`).join("")}
          <button class="meal-button personal-toggle ${calc.isPersonal ? "active" : ""} ${day.forcedPersonal ? "locked" : ""}" type="button" data-date="${day.date}" data-personal="true" data-label="${day.forcedPersonal ? "ITINERARY GAP · $0 CLAIM" : "PERSONAL DAY · $0 CLAIM"}" aria-pressed="${calc.isPersonal}" aria-label="${day.forcedPersonal ? "Personal day created from itinerary gap" : "Toggle personal day with zero claim"}" ${day.forcedPersonal ? "disabled" : ""}>P</button>
        </div>
        <div class="day-total"><strong>${money(calc.total)}</strong><span>${calc.isPersonal ? "NOT CLAIMED" : state.scope === "both" ? (calc.lodging ? `${money(calc.lodging)} + ${money(calc.mie)}` : `M&IE ONLY · ${money(calc.mie)}`) : state.scope === "lodging" ? (calc.lodging ? "LODGING ONLY" : "NO CHECKOUT-NIGHT LODGING") : "M&IE ONLY"}</span></div>
      </article>
    `;
  }).join("");

  dayList.querySelectorAll("[data-meal]").forEach(button => button.addEventListener("click", () => {
    const { date, meal } = button.dataset;
    const current = new Set(state.meals[date] || []);
    current.has(meal) ? current.delete(meal) : current.add(meal);
    state.meals[date] = [...current];
    renderLedger();
    renderSummary();
  }));
  dayList.querySelectorAll("[data-personal]").forEach(button => button.addEventListener("click", () => {
    const { date } = button.dataset;
    state.personal[date] = !state.personal[date];
    renderLedger();
    renderSummary();
    showToast(state.personal[date] ? "PERSONAL DAY · CLAIM SET TO $0" : "TRAVEL DAY RESTORED");
  }));
}

function calculateTotals() {
  const days = tripDays();
  return days.reduce((acc, day, index) => {
    const calc = calculateDay(day, index, days);
    acc.lodging += calc.lodging;
    acc.baseMie += state.scope !== "lodging" ? calc.baseMie : 0;
    acc.deductions += calc.appliedDeduction;
    acc.mie += calc.mie;
    acc.total += calc.total;
    return acc;
  }, { lodging: 0, baseMie: 0, deductions: 0, mie: 0, total: 0 });
}

function renderSummary() {
  const days = tripDays();
  const totals = calculateTotals();
  $("#tripDays").textContent = `${days.length} ${days.length === 1 ? "DAY" : "DAYS"}`;
  $("#lodgingTotal").textContent = money(totals.lodging);
  $("#mieTotal").textContent = money(totals.mie);
  $("#deductionTotal").textContent = `−${money(totals.deductions)}`;
  $("#summaryTitle").textContent = money(totals.total);
}

function renderBoardingPass() {
  const nameInput = $("#travelerName");
  if (nameInput && nameInput.value !== state.travelerName) nameInput.value = state.travelerName;
  const homeInput = $("#homeCity");
  if (homeInput && homeInput.value !== state.homeCity) homeInput.value = state.homeCity;
  $("#passDestination").textContent = routeSummaryLabel();
  $("#passDates").textContent = tripDateLabel();
  $("#passStops").textContent = `${String(state.stops.length).padStart(2, "0")} ${state.stops.length === 1 ? "CITY" : "CITIES"}`;
  $("#passSerial").textContent = `FY27 · ${String(tripDays().length).padStart(3, "0")}`;
}

function render() {
  state.stops.sort((a, b) => a.start.localeCompare(b.start));
  renderRoute();
  renderBoardingPass();
  renderLedger();
  renderSummary();
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

function reportRows() {
  const days = tripDays();
  return days.map((day, index) => {
    const calc = calculateDay(day, index, days);
    const provided = state.meals[day.date] || [];
    return {
      date: day.date,
      city: calc.isPersonal ? "Personal day" : day.stop.label,
      state: calc.location.state,
      zip: calc.location.zip,
      fiscalYear: calc.location.fiscalYear,
      source: calc.location.source,
      lodgingRate: calc.rate.lodging,
      lodgingClaimed: calc.lodging,
      mieRate: calc.rate.mie,
      firstLast: calc.isFirstOrLast ? "Yes" : "No",
      breakfast: provided.includes("breakfast") ? "Provided" : "Claimed",
      lunch: provided.includes("lunch") ? "Provided" : "Claimed",
      dinner: provided.includes("dinner") ? "Provided" : "Claimed",
      personal: calc.isPersonal ? "Yes" : "No",
      mealDeduction: calc.appliedDeduction,
      mieClaimed: calc.mie,
      total: calc.total
    };
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function exportCsv() {
  const rows = reportRows();
  const columns = ["date","city","state","zip","fiscalYear","source","lodgingRate","lodgingClaimed","mieRate","firstLast","breakfast","lunch","dinner","personal","mealDeduction","mieClaimed","total"];
  const csv = [columns.map(csvCell).join(","), ...rows.map(row => columns.map(column => csvCell(row[column])).join(","))].join("\r\n");
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), "per-diem-trip-summary.csv");
  showToast("CSV DOWNLOADED");
}

const pdfTheme = {
  ink: "#11100e",
  paper: "#f3f0e8",
  white: "#fffdf7",
  acid: "#dbff3f",
  coral: "#ff6b55",
  blue: "#59c3ff",
  pink: "#ff9cd3",
  yellow: "#ffd94a",
  green: "#3ee35f"
};

function pdfRect(ctx, x, y, width, height, fill, stroke = pdfTheme.ink, lineWidth = 4) {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, width, height);
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.strokeRect(x, y, width, height);
  }
}

function pdfText(ctx, value, x, y, size, weight = 700, color = pdfTheme.ink, family = "Arial") {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px ${family}, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText(String(value), x, y);
}

function pdfFitText(ctx, value, x, y, maxWidth, size, minimum = 18, weight = 700, color = pdfTheme.ink) {
  let nextSize = size;
  while (nextSize > minimum) {
    ctx.font = `${weight} ${nextSize}px Arial, sans-serif`;
    if (ctx.measureText(String(value)).width <= maxWidth) break;
    nextSize -= 1;
  }
  pdfText(ctx, value, x, y, nextSize, weight, color);
}

function pdfWrapText(ctx, value, x, y, maxWidth, lineHeight, maxLines = 2, size = 25, weight = 700, color = pdfTheme.ink) {
  ctx.font = `${weight} ${size}px Arial, sans-serif`;
  const words = String(value).split(/\s+/);
  const lines = [];
  let line = "";
  words.forEach(word => {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  });
  if (line) lines.push(line);
  const visible = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    visible[maxLines - 1] = `${visible[maxLines - 1].replace(/[.…]*$/, "")}…`;
    while (ctx.measureText(visible[maxLines - 1]).width > maxWidth) visible[maxLines - 1] = `${visible[maxLines - 1].slice(0, -2)}…`;
  }
  visible.forEach((text, index) => pdfText(ctx, text, x, y + index * lineHeight, size, weight, color));
  return y + visible.length * lineHeight;
}

function loadPdfImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function drawPdfHeader(ctx, kogodLogo, pageNumber, pageCount) {
  pdfRect(ctx, 0, 0, 1224, 126, pdfTheme.white, null, 0);
  ctx.drawImage(kogodLogo, 54, 17, 292, 96);
  pdfRect(ctx, 835, 29, 62, 62, pdfTheme.acid, pdfTheme.ink, 4);
  pdfText(ctx, "↗", 851, 33, 42, 800);
  pdfText(ctx, "PER DIEM", 918, 30, 24, 800);
  pdfText(ctx, "PASSPORT", 918, 56, 24, 800);
  pdfText(ctx, `PAGE ${String(pageNumber).padStart(2, "0")} / ${String(pageCount).padStart(2, "0")}`, 1040, 94, 13, 700, pdfTheme.ink, "monospace");
  ctx.fillStyle = pdfTheme.ink;
  ctx.fillRect(0, 122, 1224, 5);
}

function drawPdfBoardingPass(ctx) {
  const x = 54;
  const y = 164;
  const width = 1116;
  const height = 354;
  pdfRect(ctx, x, y, width, height, pdfTheme.white, pdfTheme.ink, 5);
  pdfRect(ctx, x, y, 204, height, pdfTheme.acid, pdfTheme.ink, 5);
  pdfRect(ctx, x + 944, y, 172, height, pdfTheme.blue, pdfTheme.ink, 5);
  ctx.setLineDash([13, 11]);
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x + 204, y);
  ctx.lineTo(x + 204, y + height);
  ctx.moveTo(x + 944, y);
  ctx.lineTo(x + 944, y + height);
  ctx.stroke();
  ctx.setLineDash([]);

  pdfRect(ctx, x + 28, y + 30, 66, 66, pdfTheme.white, pdfTheme.ink, 4);
  pdfText(ctx, "↗", x + 45, y + 34, 45, 800);
  pdfText(ctx, "PER DIEM", x + 28, y + 136, 27, 800);
  pdfText(ctx, "PASSPORT", x + 28, y + 165, 27, 800);
  pdfText(ctx, "PDP · FY27", x + 28, y + 302, 15, 700, pdfTheme.ink, "monospace");

  pdfText(ctx, "TRAVEL AUTHORIZATION · BOARDING PASS", x + 235, y + 28, 14, 700, pdfTheme.ink, "monospace");
  pdfText(ctx, "TRIP AT A GLANCE", x + 235, y + 52, 32, 800);
  pdfRect(ctx, x + 739, y + 30, 168, 37, pdfTheme.green, pdfTheme.ink, 3);
  pdfText(ctx, "GSA FY27 · READY", x + 754, y + 40, 13, 700, pdfTheme.ink, "monospace");
  ctx.fillStyle = pdfTheme.ink;
  ctx.fillRect(x + 235, y + 100, 672, 3);

  pdfText(ctx, "TRAVEL FOR", x + 235, y + 126, 14, 700, pdfTheme.ink, "monospace");
  pdfRect(ctx, x + 235, y + 151, 314, 66, pdfTheme.yellow, pdfTheme.ink, 4);
  pdfFitText(ctx, state.travelerName.trim().toUpperCase() || "NAME NOT ENTERED", x + 250, y + 169, 285, 27, 17, 800);
  pdfText(ctx, "HOME CITY", x + 575, y + 126, 14, 700, pdfTheme.ink, "monospace");
  pdfRect(ctx, x + 575, y + 151, 332, 66, "#eaf8ff", pdfTheme.ink, 4);
  pdfFitText(ctx, state.homeCity.trim().toUpperCase() || "WASHINGTON, DC", x + 590, y + 169, 302, 27, 17, 800);
  pdfText(ctx, "TRAVEL TO", x + 235, y + 242, 14, 700, pdfTheme.ink, "monospace");
  pdfWrapText(ctx, routeSummaryLabel().toUpperCase(), x + 235, y + 267, 350, 28, 2, 23, 800);
  pdfText(ctx, "DATES", x + 610, y + 242, 14, 700, pdfTheme.ink, "monospace");
  pdfFitText(ctx, tripDateLabel(), x + 610, y + 267, 190, 21, 15, 800);
  pdfText(ctx, "STOPS", x + 840, y + 242, 14, 700, pdfTheme.ink, "monospace");
  pdfText(ctx, `${String(state.stops.length).padStart(2, "0")}`, x + 840, y + 267, 24, 800);

  pdfText(ctx, "BOARDING", x + 979, y + 28, 15, 700, pdfTheme.ink, "monospace");
  for (let line = 0; line < 14; line += 1) {
    const barWidth = line % 4 === 0 ? 7 : line % 3 === 0 ? 4 : 2;
    ctx.fillStyle = pdfTheme.ink;
    ctx.fillRect(x + 980 + line * 8, y + 82, barWidth, 170);
  }
  pdfText(ctx, `FY27 · ${String(tripDays().length).padStart(3, "0")}`, x + 979, y + 286, 15, 700, pdfTheme.ink, "monospace");
}

function drawPdfSummary(ctx, totals, y) {
  pdfText(ctx, "CLAIM SUMMARY", 54, y, 17, 700, pdfTheme.ink, "monospace");
  pdfRect(ctx, 54, y + 32, 420, 210, pdfTheme.acid, pdfTheme.ink, 5);
  pdfText(ctx, "TRIP TOTAL", 78, y + 55, 15, 700, pdfTheme.ink, "monospace");
  pdfFitText(ctx, money(totals.total), 76, y + 91, 370, 65, 44, 800);
  pdfText(ctx, `${tripDays().length} DAYS · ${state.scope.toUpperCase()}`, 78, y + 177, 15, 700, pdfTheme.ink, "monospace");

  const cards = [
    ["LODGING", totals.lodging, pdfTheme.blue],
    ["MEALS + INCIDENTALS", totals.mie, pdfTheme.pink],
    ["MEAL DEDUCTIONS", totals.deductions, pdfTheme.coral]
  ];
  cards.forEach(([label, amount, color], index) => {
    const cardX = 494 + index * 225;
    pdfRect(ctx, cardX, y + 32, 205, 210, color, pdfTheme.ink, 4);
    pdfText(ctx, label, cardX + 16, y + 55, 13, 700, pdfTheme.ink, "monospace");
    pdfFitText(ctx, money(amount), cardX + 16, y + 106, 173, 30, 22, 800);
    pdfText(ctx, index === 2 ? "SUBTRACTED" : "CLAIMED", cardX + 16, y + 177, 12, 700, pdfTheme.ink, "monospace");
  });
}

function drawPdfLedgerHeader(ctx, y) {
  pdfText(ctx, "DAILY LEDGER", 54, y, 17, 700, pdfTheme.ink, "monospace");
  pdfRect(ctx, 54, y + 30, 1116, 45, pdfTheme.ink, null, 0);
  pdfText(ctx, "DATE", 70, y + 44, 14, 700, pdfTheme.white, "monospace");
  pdfText(ctx, "DESTINATION / STATUS", 220, y + 44, 14, 700, pdfTheme.white, "monospace");
  pdfText(ctx, "LODGING", 770, y + 44, 14, 700, pdfTheme.white, "monospace");
  pdfText(ctx, "M&IE", 925, y + 44, 14, 700, pdfTheme.white, "monospace");
  pdfText(ctx, "TOTAL", 1052, y + 44, 14, 700, pdfTheme.white, "monospace");
}

function drawPdfLedgerRow(ctx, row, y, index) {
  const fill = row.personal === "Yes" ? pdfTheme.pink : index % 2 ? "#eaf8ff" : pdfTheme.white;
  pdfRect(ctx, 54, y, 1116, 104, fill, pdfTheme.ink, 2);
  pdfText(ctx, localDate(row.date).toLocaleDateString("en-US", { weekday: "short" }).toUpperCase(), 70, y + 17, 13, 700, pdfTheme.ink, "monospace");
  pdfText(ctx, shortDate(row.date), 70, y + 43, 24, 800);
  pdfFitText(ctx, String(row.city).toUpperCase(), 220, y + 17, 500, 22, 15, 800);
  const note = row.personal === "Yes" ? "PERSONAL DAY · NOT CLAIMED" : row.firstLast === "Yes" ? "75% M&IE TRAVEL DAY" : `${row.source} · FY${row.fiscalYear}`;
  pdfText(ctx, note, 220, y + 53, 13, 700, pdfTheme.ink, "monospace");
  pdfText(ctx, money(row.lodgingClaimed), 770, y + 34, 19, 800);
  pdfText(ctx, money(row.mieClaimed), 925, y + 34, 19, 800);
  pdfText(ctx, money(row.total), 1052, y + 34, 20, 800);
}

function drawPdfFooter(ctx, pageNumber) {
  ctx.fillStyle = pdfTheme.ink;
  ctx.fillRect(0, 1518, 1224, 66);
  pdfText(ctx, "GSA FY2027 · FIRST AND LAST ELIGIBLE TRAVEL DAYS USE 75% OF M&IE · PERSONAL DAYS ARE $0", 54, 1540, 12, 700, pdfTheme.white, "monospace");
  pdfText(ctx, `PER DIEM PASSPORT · ${String(pageNumber).padStart(2, "0")}`, 1024, 1540, 12, 700, pdfTheme.white, "monospace");
}

function canvasJpegBytes(canvas) {
  const base64 = canvas.toDataURL("image/jpeg", .94).split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function byteConcat(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  parts.forEach(part => { output.set(part, offset); offset += part.length; });
  return output;
}

function buildImagePdf(jpegs, width, height) {
  const encoder = new TextEncoder();
  const ascii = value => encoder.encode(value);
  const objects = [];
  objects[1] = ascii("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const pageIds = [];
  jpegs.forEach((jpeg, index) => {
    const pageId = 3 + index * 3;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const imageName = `Im${index}`;
    pageIds.push(`${pageId} 0 R`);
    objects[pageId] = ascii(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /${imageName} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`);
    objects[imageId] = byteConcat([
      ascii(`${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
      jpeg,
      ascii("\nendstream\nendobj\n")
    ]);
    const stream = `q\n612 0 0 792 0 0 cm\n/${imageName} Do\nQ\n`;
    objects[contentId] = ascii(`${contentId} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);
  });
  objects[2] = ascii(`2 0 obj\n<< /Type /Pages /Kids [${pageIds.join(" ")}] /Count ${pageIds.length} >>\nendobj\n`);
  const header = ascii("%PDF-1.4\n%1234\n");
  const offsets = new Array(objects.length).fill(0);
  let position = header.length;
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = position;
    position += objects[index].length;
  }
  const xrefPosition = position;
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) xref += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF`;
  return new Blob([header, ...objects.slice(1), ascii(xref)], { type: "application/pdf" });
}

async function exportPdf() {
  const rows = reportRows();
  const totals = calculateTotals();
  const firstPageCount = 5;
  const continuationPageCount = 9;
  const chunks = [rows.slice(0, firstPageCount)];
  for (let index = firstPageCount; index < rows.length; index += continuationPageCount) chunks.push(rows.slice(index, index + continuationPageCount));
  if (!rows.length) chunks[0] = [];
  showToast("BUILDING STYLED PDF…");
  try {
    const logo = await loadPdfImage($(".kogod-logo").src);
    const jpegs = chunks.map((pageRows, pageIndex) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1224;
      canvas.height = 1584;
      const ctx = canvas.getContext("2d");
      pdfRect(ctx, 0, 0, canvas.width, canvas.height, pdfTheme.paper, null, 0);
      drawPdfHeader(ctx, logo, pageIndex + 1, chunks.length);
      let ledgerY;
      if (pageIndex === 0) {
        drawPdfBoardingPass(ctx);
        drawPdfSummary(ctx, totals, 558);
        ledgerY = 840;
      } else {
        pdfText(ctx, "TRIP CONTINUED", 54, 166, 17, 700, pdfTheme.ink, "monospace");
        pdfFitText(ctx, state.travelerName.trim().toUpperCase() || "NAME NOT ENTERED", 54, 194, 520, 34, 22, 800);
        pdfWrapText(ctx, routeSummaryLabel().toUpperCase(), 620, 194, 550, 30, 2, 24, 800);
        pdfText(ctx, `HOME CITY · ${(state.homeCity.trim() || "Washington, DC").toUpperCase()}`, 54, 246, 14, 700, pdfTheme.ink, "monospace");
        ledgerY = 315;
      }
      drawPdfLedgerHeader(ctx, ledgerY);
      pageRows.forEach((row, rowIndex) => drawPdfLedgerRow(ctx, row, ledgerY + 75 + rowIndex * 104, rowIndex));
      drawPdfFooter(ctx, pageIndex + 1);
      return canvasJpegBytes(canvas);
    });
    const filenameName = state.travelerName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    downloadBlob(buildImagePdf(jpegs, 1224, 1584), `per-diem-${filenameName || "trip"}-fy2027.pdf`);
    showToast("STYLED PDF DOWNLOADED");
  } catch (error) {
    console.error(error);
    showToast("PDF EXPORT COULD NOT BE CREATED");
  }
}

$("#lookupBtn").addEventListener("click", searchDestination);
$("#locationQuery").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    searchDestination();
  }
});
$("#locationQuery").addEventListener("input", () => {
  selectedLocation = null;
  $("#addRouteBtn").disabled = true;
  $("#lookupResult").textContent = "Search again to select the official rate.";
});
$("#newStart").addEventListener("change", () => {
  const year = fiscalYearForDate($("#newStart").value);
  selectedLocation = null;
  $("#addRouteBtn").disabled = true;
  $("#lookupResult").textContent = year === 2027
    ? "Dates changed — search again for the applicable FY27 rate."
    : "FY27 covers October 1, 2026 through September 30, 2027.";
});

$("#addStopForm").addEventListener("submit", async event => {
  event.preventDefault();
  const start = $("#newStart").value;
  const end = $("#newEnd").value;
  if (!selectedLocation) {
    showToast("SEARCH AND SELECT A GSA RATE FIRST");
    return;
  }
  if (end < start) {
    showToast("LEAVE DATE MUST FOLLOW ARRIVAL");
    return;
  }
  const button = $("#addRouteBtn");
  button.disabled = true;
  button.textContent = "LOADING RATES…";
  try {
    const locationsByFY = await ensureFiscalYearLocations($("#locationQuery").value, start, end, selectedLocation);
    state.stops.push({ query: $("#locationQuery").value, label: selectedLocation.label, start, end, locationsByFY });
    addStopForm.hidden = true;
    render();
    showToast("NEW CITY ADDED");
  } catch (error) {
    showToast(error.message || "COULD NOT LOAD THE RATE");
  } finally {
    button.textContent = "ADD TO ROUTE →";
    button.disabled = !selectedLocation;
  }
});

$("#travelerName").addEventListener("input", event => {
  state.travelerName = event.target.value;
});

$("#homeCity").addEventListener("input", event => {
  state.homeCity = event.target.value;
});

$("#resetBtn").addEventListener("click", () => {
  state = initialState();
  selectedLocation = null;
  $("#locationQuery").value = "";
  $("#lookupResult").textContent = "Search a location to select its rate.";
  $("#addRouteBtn").disabled = true;
  document.querySelector('input[name="scope"][value="both"]').checked = true;
  render();
  showToast("TRIP RESET");
});

document.querySelectorAll('input[name="scope"]').forEach(input => input.addEventListener("change", event => {
  state.scope = event.target.value;
  renderLedger();
  renderSummary();
  showToast(`${event.target.closest("label").querySelector("strong").textContent} SELECTED`);
}));

$("#exportPdfBtn").addEventListener("click", exportPdf);
$("#exportCsvBtn").addEventListener("click", exportCsv);

const last = localDate(state.stops.at(-1).end);
last.setDate(last.getDate() + 1);
$("#newStart").value = iso(last);
$("#newEnd").value = iso(last);
render();
