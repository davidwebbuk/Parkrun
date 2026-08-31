(() => {
  const state = {
    userLocation: null,
    stations: [],
    map: null,
    markers: [],
  };

  const el = {
    locationStatus: document.getElementById("location-status"),
    globalStatus: document.getElementById("global-status"),
    stationPanel: document.getElementById("station-panel"),
    optionsPanel: document.getElementById("options-panel"),
    mapPanel: document.getElementById("map-panel"),
    stationSelect: document.getElementById("station-select"),
    results: document.getElementById("results"),
    useLocationBtn: document.getElementById("use-location-btn"),
    postcodeForm: document.getElementById("postcode-form"),
    postcodeInput: document.getElementById("postcode-input"),
    findBtn: document.getElementById("find-btn"),
    bufferInput: document.getElementById("buffer-input"),
    maxTimeInput: document.getElementById("max-time-input"),
    athleteIdInput: document.getElementById("athlete-id-input"),
  };

  function setStatus(node, text, isError = false) {
    node.textContent = text;
    node.classList.toggle("error", isError);
  }

  async function onLocationResolved(lat, lon, label) {
    state.userLocation = { lat, lon };
    setStatus(el.locationStatus, `${label} (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
    el.stationPanel.hidden = false;
    el.optionsPanel.hidden = false;
    await loadNearestStations();
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

  async function loadNearestStations() {
    const { lat, lon } = state.userLocation;
    setStatus(el.globalStatus, "Finding nearby stations…");
    const res = await fetch(`/api/nearest-stations?lat=${lat}&lon=${lon}&limit=15`);
    const body = await res.json();
    state.stations = body.stations || [];
    el.stationSelect.innerHTML = "";
    state.stations.forEach((s, idx) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.name} (${s.distanceKm.toFixed(1)} km away)`;
      if (idx === 0) opt.selected = true;
      el.stationSelect.appendChild(opt);
    });
    setStatus(el.globalStatus, body.source === "fallback"
      ? "Using bundled sample station data (live NaPTAN fetch unavailable)."
      : "");
  }

  el.findBtn.addEventListener("click", findReachableParkruns);

  async function findReachableParkruns() {
    if (!state.userLocation) return;
    const { lat, lon } = state.userLocation;
    const stationId = el.stationSelect.value;
    const arrivalBufferMin = Number(el.bufferInput.value) || 15;
    const maxTotalMinutes = Number(el.maxTimeInput.value) || 60;
    const athleteId = el.athleteIdInput.value.trim();

    el.findBtn.disabled = true;
    setStatus(el.globalStatus, "Crunching train times…");
    el.results.innerHTML = "";

    try {
      const params = new URLSearchParams({ lat, lon, stationId, arrivalBufferMin, maxTotalMinutes });
      if (athleteId) params.set("athleteId", athleteId);
      const res = await fetch(`/api/reachable?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Request failed");
      renderResults(body);
    } catch (err) {
      setStatus(el.globalStatus, `Something went wrong: ${err.message}`, true);
    } finally {
      el.findBtn.disabled = false;
    }
  }

  function renderResults(body) {
    const { results, originStation, disclaimer, eventsSource, count, athleteFilter } = body;

    if (count === 0) {
      const reason = athleteFilter?.applied
        ? "No unrun parkruns found reachable in time with these settings — try relaxing the max journey time."
        : "No parkruns found reachable in time with these settings — try relaxing the max journey time.";
      setStatus(el.globalStatus, reason, false);
      el.results.innerHTML = "";
      return;
    }

    let statusText = `${count} parkrun${count === 1 ? "" : "s"} reachable in time from ${originStation.name}. ${disclaimer}`;
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
