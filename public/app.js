(() => {
  // Each live-refined result is a billed Google Directions call. The first
  // search only asks the server to live-check a small batch (enough to
  // confidently surface the NENDY plus a few alternates); "Show more
  // options" asks for progressively larger batches only when the user
  // actually wants to spend more of that budget. See server/index.js's
  // DEFAULT_LIVE_LIMIT for the server-side half of this.
  const INITIAL_LIVE_LIMIT = 10;
  const MORE_LIVE_LIMIT = 20;

  const state = {
    userLocation: null,
    map: null,
    markers: [],
    resultsById: new Map(),
    lastSearchParams: null,
    liveCovered: 0,
    totalHeuristicReachable: 0,
    athleteFilterApplied: false,
  };

  const el = {
    locationStatus: document.getElementById("location-status"),
    globalStatus: document.getElementById("global-status"),
    optionsPanel: document.getElementById("options-panel"),
    mapPanel: document.getElementById("map-panel"),
    results: document.getElementById("results"),
    useLocationBtn: document.getElementById("use-location-btn"),
    postcodeForm: document.getElementById("postcode-form"),
    postcodeInput: document.getElementById("postcode-input"),
    findBtn: document.getElementById("find-btn"),
    bufferInput: document.getElementById("buffer-input"),
    maxTimeInput: document.getElementById("max-time-input"),
    athleteIdInput: document.getElementById("athlete-id-input"),
    moreRow: document.getElementById("more-row"),
    moreBtn: document.getElementById("more-btn"),
    moreHint: document.getElementById("more-hint"),
  };

  function setStatus(node, text, isError = false) {
    node.textContent = text;
    node.classList.toggle("error", isError);
  }

  async function onLocationResolved(lat, lon, label) {
    state.userLocation = { lat, lon };
    setStatus(el.locationStatus, `${label} (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
    el.optionsPanel.hidden = false;
    ensureMap();
  }

  el.useLocationBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      setStatus(el.locationStatus, "Geolocation isn't available in this browser.", true);
      return;
    }
    setStatus(el.locationStatus, "Locating…");
    navigator.geolocation.getCurrentPosition(
      (pos) => onLocationResolved(pos.coords.latitude, pos.coords.longitude, "Using your current location"),
      (err) => setStatus(el.locationStatus, `Couldn't get your location: ${err.message}`, true)
    );
  });

  el.postcodeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const postcode = el.postcodeInput.value.trim();
    if (!postcode) return;
    setStatus(el.locationStatus, "Looking up postcode…");
    try {
      const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
      const body = await res.json();
      if (!res.ok || !body.result) {
        throw new Error(body.error || "Postcode not found");
      }
      await onLocationResolved(body.result.latitude, body.result.longitude, `Using postcode ${body.result.postcode}`);
    } catch (err) {
      setStatus(el.locationStatus, `Couldn't look up that postcode: ${err.message}`, true);
    }
  });

  el.findBtn.addEventListener("click", () => runSearch({ reset: true, liveOffset: 0, liveLimit: INITIAL_LIVE_LIMIT }));
  el.moreBtn.addEventListener("click", () => runSearch({ reset: false, liveOffset: state.liveCovered, liveLimit: MORE_LIVE_LIMIT }));

  async function runSearch({ reset, liveOffset, liveLimit }) {
    if (!state.userLocation) return;

    if (reset) {
      const { lat, lon } = state.userLocation;
      state.lastSearchParams = {
        lat, lon,
        arrivalBufferMin: Number(el.bufferInput.value) || 15,
        maxTotalMinutes: Number(el.maxTimeInput.value) || 90,
        athleteId: el.athleteIdInput.value.trim(),
      };
      state.resultsById.clear();
      state.liveCovered = 0;
      state.totalHeuristicReachable = 0;
      el.results.innerHTML = "";
      el.moreRow.hidden = true;
    }
    if (!state.lastSearchParams) return;

    const btn = reset ? el.findBtn : el.moreBtn;
    btn.disabled = true;
    setStatus(el.globalStatus, reset ? "Crunching journey times…" : "Checking more options…");

    try {
      const params = new URLSearchParams({ ...state.lastSearchParams, liveOffset, liveLimit });
      if (!state.lastSearchParams.athleteId) params.delete("athleteId");
      const res = await fetch(`/api/reachable?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Request failed");
      renderResults(body);
    } catch (err) {
      setStatus(el.globalStatus, `Something went wrong: ${err.message}`, true);
    } finally {
      btn.disabled = false;
    }
  }

  function mergeResults(newResults) {
    for (const r of newResults) {
      const existing = state.resultsById.get(r.id);
      // Never let a later, unrefined-for-this-call response downgrade a
      // result we already know is live-verified back to "estimated".
      if (!existing || existing.journey.source !== "live") {
        state.resultsById.set(r.id, r);
      }
    }
  }

  function renderResults(body) {
    const { originStation, disclaimer, eventsSource, athleteFilter, liveOffset, liveLimit, totalHeuristicReachable } = body;
    state.athleteFilterApplied = Boolean(athleteFilter?.applied);
    state.liveCovered = Math.max(state.liveCovered, liveOffset + liveLimit);
    state.totalHeuristicReachable = totalHeuristicReachable;

    mergeResults(body.results);
    const results = [...state.resultsById.values()].sort((a, b) => a.journey.totalMinutes - b.journey.totalMinutes);
    results.forEach((r, i) => { r.nendy = state.athleteFilterApplied && i === 0; });

    if (results.length === 0) {
      const reason = state.athleteFilterApplied
        ? "No unrun parkruns found reachable in time with these settings — try relaxing the max journey time."
        : "No parkruns found reachable in time with these settings — try relaxing the max journey time.";
      setStatus(el.globalStatus, reason, false);
      el.results.innerHTML = "";
      el.moreRow.hidden = true;
      return;
    }

    let statusText = `${results.length} parkrun${results.length === 1 ? "" : "s"} reachable in time from ${originStation.name}. ${disclaimer}`;
    if (eventsSource === "fallback") {
      statusText += " (Using bundled sample parkrun data — live parkrun.com fetch unavailable.)";
    }
    if (athleteFilter?.applied) {
      statusText += ` Hiding ${athleteFilter.completedCount} event(s) you've already done.`;
    } else if (athleteFilter?.note) {
      statusText += ` ${athleteFilter.note}`;
    }
    setStatus(el.globalStatus, statusText);
    el.results.innerHTML = results.map(resultCardHtml).join("");

    const moreAvailable = state.liveCovered < state.totalHeuristicReachable;
    el.moreRow.hidden = !moreAvailable;
    if (moreAvailable) {
      setStatus(el.moreHint, `${state.totalHeuristicReachable - state.liveCovered} more heuristic-only option(s) not yet live-checked.`);
    }

    // Map is a nice-to-have on top of the text results above - if it fails
    // (CDN blocked, etc.) the results the user actually came for must stay up.
    try {
      ensureMap();
      clearMarkers();
      addMarker(state.userLocation.lat, state.userLocation.lon, "You", "blue");
      addMarker(originStation.lat, originStation.lon, `Departure: ${originStation.name}`, "black");
      results.forEach((r) => addMarker(r.lat, r.lon, r.name, "green"));
      fitMapToMarkers();
    } catch (err) {
      console.error("Map rendering failed, continuing without it:", err);
      el.mapPanel.hidden = true;
    }
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  function resultCardHtml(r) {
    const isLive = r.journey.source === "live";
    const needsNonRailTransit = isLive && r.journey.usesNonRailTransit;
    return `
      <article class="result-card${r.nendy ? " result-card-nendy" : ""}">
        <h3>${r.nendy ? "🏆 " : ""}${escapeHtml(r.name)}${r.nendy ? ` <span class="badge badge-nendy">NENDY</span>` : ""}</h3>
        <div class="result-meta">
          <span class="badge${isLive ? " badge-live" : ""}">${isLive ? "Live" : "Estimated"}</span>
          ${needsNonRailTransit ? `<span class="badge badge-warn">Needs: ${escapeHtml(r.journey.nonRailSummary || "other transport")}</span>` : ""}
          <span>Starts ${escapeHtml(r.startTime)}</span>
          <span>Leave by ~${fmtTime(r.requiredDepartureTime)}</span>
          <span>~${r.journey.totalMinutes} min door-to-door</span>
          <span>via ${escapeHtml(r.destStation.name)}</span>
          ${r.journey.estimatedInterchanges > 0 ? `<span>~${r.journey.estimatedInterchanges} change(s)</span>` : ""}
        </div>
        <div class="result-links">
          <a href="${r.mapsUrl}" target="_blank" rel="noopener">Check real directions on Google Maps →</a>
          ${r.url ? `<a href="${r.url}" target="_blank" rel="noopener">parkrun event page →</a>` : ""}
        </div>
      </article>`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // Leaflet loads from a CDN (see index.html) - if that's blocked (ad-blocker,
  // restrictive network, CDN hiccup) the map is just unavailable. That must
  // never take down the text results, which are the app's actual point.
  function ensureMap() {
    if (state.map || !state.userLocation) return;
    if (typeof L === "undefined") {
      el.mapPanel.hidden = true;
      return;
    }
    el.mapPanel.hidden = false;
    state.map = L.map("map").setView([state.userLocation.lat, state.userLocation.lon], 7);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(state.map);
  }

  function clearMarkers() {
    state.markers.forEach((m) => m.remove());
    state.markers = [];
  }

  function addMarker(lat, lon, label, color) {
    if (!state.map) return;
    const marker = L.circleMarker([lat, lon], {
      radius: 7,
      color,
      fillColor: color,
      fillOpacity: 0.8,
    }).bindPopup(label);
    marker.addTo(state.map);
    state.markers.push(marker);
  }

  function fitMapToMarkers() {
    if (!state.map || state.markers.length === 0) return;
    const group = L.featureGroup(state.markers);
    state.map.fitBounds(group.getBounds().pad(0.15));
  }
})();
