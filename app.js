(async function () {
  const DRAFT_KEY = "athens_places_draft_v1";

  const state = {
    config: null,
    chunksMeta: null,
    extractedMapData: null,
    markersJson: null,
    places: [],
    world: null,
    mapCfg: null,
    activeMeta: null,
    tileLayer: null,
    layersById: {},       // id -> { id, label, visible, count, built, build, group }
    dynmapItems: [],      // searchable records from extracted + Dynmap sets
    customItems: [],      // searchable records from custom pins
    liByUid: new Map(),   // uid -> <li>
    measureLayer: L.layerGroup(),
    measurePoints: [],
    measuring: false,
    editMode: false,
    selectedUid: null
  };

  const DEFAULT_VISIBLE_EXTRACTED = new Set([
    "City Lines",
    "Interstate Signs",
    "A Road Signs"
  ]);
  const DEFAULT_VISIBLE_MARKER_SETS = new Set([
    "Landmarks",
    "Markers"
  ]);

  const DEFAULT_PIN_ICON = "star";
  const PIN_ICONS = [
    { id: "redflag", label: "Landmark / flag" },
    { id: "greenflag", label: "Town / city" },
    { id: "star", label: "Star" },
    { id: "temple", label: "Temple" },
    { id: "tower", label: "Tower" },
    { id: "building", label: "Building" },
    { id: "compass", label: "Compass" },
    { id: "minecart", label: "Mine" },
    { id: "tree", label: "Tree" },
    { id: "flower", label: "Flower" },
    { id: "sign", label: "Sign" },
    { id: "gear", label: "Gear" },
    { id: "exclamation", label: "Point of interest" },
    { id: "world", label: "Spawn / world" }
  ];
  const PIN_ICON_IDS = new Set(PIN_ICONS.map(icon => icon.id));
  const CLOCK_EXPANDED_KEY = "athens_clock_expanded_v1";

  function iconUrlFor(name) {
    return `data/icons/${encodeURIComponent(PIN_ICON_IDS.has(name) ? name : DEFAULT_PIN_ICON)}.png`;
  }

  async function loadJSON(path, fallback) {
    try {
      const res = await fetch(path);
      if (!res.ok) return fallback;
      return await res.json();
    } catch {
      return fallback;
    }
  }

  function setActiveLayerLabel(text) {
    const el = document.getElementById("active-layer-label");
    if (el) el.textContent = text;
  }

  // startup fetch
  const [config, chunksMeta, extractedMapData, fetchedPlaces] = await Promise.all([
    loadJSON("data/config.json", null),
    loadJSON("data/chunks_meta.json", {}),
    loadJSON("data/extracted_map_data.json?v=9", null),
    loadJSON("data/athens_places.json", [])
  ]);

  state.config = config;
  state.chunksMeta = chunksMeta;
  state.extractedMapData = extractedMapData;

  // restore unsaved local pin edits if present
  try {
    const savedDraft = localStorage.getItem(DRAFT_KEY);
    state.places = savedDraft ? JSON.parse(savedDraft) : fetchedPlaces;
  } catch {
    state.places = fetchedPlaces;
  }

  const metaKeys = Object.keys(state.chunksMeta || {});
  if (!state.config || !metaKeys.length) {
    setActiveLayerLabel(
      window.location.protocol === "file:"
        ? "Serve this folder over HTTP to load map data"
        : "Run download_dynmap.py first"
    );
    return;
  }

  state.activeMeta = state.chunksMeta[metaKeys[0]];
  state.world = state.config.worlds.find(w => w.name === state.activeMeta.world) || state.config.worlds[0];
  state.mapCfg = state.world.maps.find(m => m.name === state.activeMeta.map) || state.world.maps[0];
  state.markersJson = await loadJSON(`data/markers_${encodeURIComponent(state.world.name)}.json`, null);

  function persistCustomDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(state.places));
    } catch { /* ignore quota errors */ }
  }

  function denom() {
    const step = 1 << (state.activeMeta.target_zoom ?? 0);
    const maxLvl = state.activeMeta.max_level ?? 3;
    return step * (1 << maxLvl);
  }

  function worldToLatLng(wx, wy, wz) {
    const wtp = state.mapCfg.worldtomap || [1, 0, 0, 0, 0, -1];
    const d = denom();
    const mapX = wtp[0] * wx + wtp[1] * wy + wtp[2] * wz;
    const mapY = wtp[3] * wx + wtp[4] * wy + wtp[5] * wz;
    return L.latLng(mapY / d, mapX / d);
  }

  function extractedWorldToLatLng(wx, wz) {
    if (state.extractedMapData?.coordinate_space === "world") {
      return worldToLatLng(wx, 64, wz);
    }
    const t = state.extractedMapData?.source_transform || {};
    return worldToLatLng(
      wx * (t.scale_x ?? 1) + (t.offset_x ?? 0),
      64,
      wz * (t.scale_z ?? 1) + (t.offset_z ?? 0)
    );
  }

  function latLngToWorld(latlng) {
    const d = denom();
    const mapX = latlng.lng * d;
    const mapY = latlng.lat * d;
    const wtp = state.mapCfg.worldtomap || [1, 0, 0, 0, 0, -1];
    const det = wtp[0] * wtp[5] - wtp[2] * wtp[3];
    if (Math.abs(det) > 1e-9) {
      return {
        x: Math.round((mapX * wtp[5] - wtp[2] * mapY) / det),
        z: Math.round((wtp[0] * mapY - mapX * wtp[3]) / det)
      };
    }
    return { x: Math.round(mapX), z: Math.round(-mapY) };
  }

  function toHexColor(val, fallback = "#e09c3e") {
    if (val == null) return fallback;
    if (typeof val === "string") {
      if (val.startsWith("#")) return val;
      if (val.startsWith("0x")) return "#" + val.slice(2).padStart(6, "0");
    }
    if (typeof val === "number") {
      return "#" + (val & 0xffffff).toString(16).padStart(6, "0");
    }
    return fallback;
  }

  function sanitizeHtml(html) {
    if (!html) return "";
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, iframe").forEach(el => el.remove());
    doc.querySelectorAll("*").forEach(el => {
      for (const attr of [...el.attributes]) {
        if (attr.name.startsWith("on")) el.removeAttribute(attr.name);
      }
    });
    return doc.body.innerHTML;
  }

  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ESC_MAP[c]);
  }

  function ringBounds(ring) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < ring.length; i++) {
      const x = ring[i][0], z = ring[i][1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    return [minX, minZ, maxX, maxZ];
  }

  function pointInRing(px, pz, ring, aabb) {
    if (aabb && (px < aabb[0] || px > aabb[2] || pz < aabb[1] || pz > aabb[3])) {
      return false;
    }
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], zi = ring[i][1];
      const xj = ring[j][0], zj = ring[j][1];
      if ((zi > pz) !== (zj > pz) &&
          px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  const cityNameCache = new Map();
  let entityDecoder = null;
  function cityDisplayName(raw) {
    const key = String(raw);
    let name = cityNameCache.get(key);
    if (name == null) {
      let decoded = key;
      if (key.includes("&")) {
        entityDecoder ||= document.createElement("textarea");
        entityDecoder.innerHTML = key;
        decoded = entityDecoder.value;
      }
      name = decoded.replace(/_/g, " ").replace(/\s+/g, " ").trim();
      cityNameCache.set(key, name);
    }
    return name;
  }

  // precomputes polygon AABBs
  let cachedCityNames = null;
  function getCityLineNames(polygons) {
    if (cachedCityNames) return cachedCityNames;
    const names = new Map();
    const sets = state.markersJson?.sets || {};
    const incorporated = sets.Incorporated_Cities?.areas || {};
    const priority = { star: 0, greenflag: 1, redflag: 2 };
    const aabbs = polygons.map(ringBounds);

    for (const [aid, area] of Object.entries(incorporated)) {
      const xs = area.x || [], zs = area.z || [];
      if (!xs.length || xs.length !== zs.length) continue;
      let cx = 0, cz = 0;
      for (let i = 0; i < xs.length; i++) {
        cx += xs[i];
        cz += zs[i];
      }
      cx /= xs.length;
      cz /= zs.length;
      const idx = polygons.findIndex((ring, i) => pointInRing(cx, cz, ring, aabbs[i]));
      if (idx >= 0 && !names.has(idx)) names.set(idx, area.label || aid);
    }

    const candidates = [];
    for (const setName of ["CityMarkers", "markers"]) {
      for (const m of Object.values(sets[setName]?.markers || {})) {
        if (!m?.label || !Number.isFinite(m.x) || !Number.isFinite(m.z)) continue;
        if (!(m.icon in priority)) continue;
        candidates.push(m);
      }
    }

    const used = new Set(names.values());
    for (let idx = 0; idx < polygons.length; idx++) {
      if (names.has(idx)) continue;
      const ring = polygons[idx], aabb = aabbs[idx];
      let best = null;
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        if (used.has(m.label)) continue;
        if (!pointInRing(m.x, m.z, ring, aabb)) continue;
        if (!best || priority[m.icon] < priority[best.icon]) best = m;
      }
      if (best) {
        names.set(idx, best.label);
        used.add(best.label);
      }
    }
    cachedCityNames = names;
    return names;
  }

  // map + shared canvas renderers
  const map = L.map("map", {
    crs: L.CRS.Simple,
    minZoom: 0,
    maxZoom: (state.activeMeta.max_level ?? 3) + 2,
    zoomSnap: 1,
    preferCanvas: true,
    wheelDebounceTime: 40,
    wheelPxPerZoomLevel: 85,
    inertiaDeceleration: 2800,
    attributionControl: false
  });

  map.createPane("extractedMapPane");
  map.getPane("extractedMapPane").style.zIndex = 450;
  map.getPane("extractedMapPane").style.pointerEvents = "none";

  const extractedCanvas = L.canvas({ pane: "extractedMapPane", padding: 0.5, tolerance: 6 });
  const dynmapCanvas = L.canvas({ padding: 0.5, tolerance: 6 });
  state.measureLayer.addTo(map);

  // viewport-culled LayerGroup wrapper for large marker/label/sign collections
  function createCulledGroup(entries) {
    if (entries.length <= 80) {
      const grp = L.layerGroup();
      for (let i = 0; i < entries.length; i++) {
        entries[i].buildMarker().addTo(grp);
      }
      return grp;
    }

    const grp = L.layerGroup();
    let rafId = 0;

    function syncViewport() {
      rafId = 0;
      if (!map.hasLayer(grp)) return;
      const padded = map.getBounds().pad(0.35);
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const inside = padded.contains(e.latlng);
        if (inside && !e.mounted) {
          e.marker ||= e.buildMarker();
          grp.addLayer(e.marker);
          e.mounted = true;
        } else if (!inside && e.mounted) {
          grp.removeLayer(e.marker);
          e.mounted = false;
        }
      }
    }

    function scheduleSync() {
      if (!rafId) rafId = requestAnimationFrame(syncViewport);
    }

    grp.on("add", () => {
      syncViewport();
      map.on("moveend zoomend", scheduleSync);
    });
    grp.on("remove", () => {
      map.off("moveend zoomend", scheduleSync);
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].mounted) {
          grp.removeLayer(entries[i].marker);
          entries[i].mounted = false;
        }
      }
    });

    return grp;
  }

  const BlendedChunkLayer = L.TileLayer.extend({
    getTileUrl: function (coords) {
      const maxLvl = state.activeMeta.max_level ?? 3;
      const level = Math.max(0, maxLvl - coords.z);
      const lstep = 1 << level;
      const mx = coords.x * lstep;
      const my = (-1 - coords.y) * lstep;
      return `${state.activeMeta.chunks_dir}/L${level}_${mx}_${my}.${state.activeMeta.ext}`;
    }
  });

  function findSpawnMarker() {
    const sets = state.markersJson?.sets || {};
    for (const mset of Object.values(sets)) {
      const spawn = mset?.markers?._spawn_world;
      if (spawn && Number.isFinite(spawn.x) && Number.isFinite(spawn.z)) return spawn;
    }
    for (const mset of Object.values(sets)) {
      for (const m of Object.values(mset?.markers || {})) {
        if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.z)) continue;
        if (String(m.label || "").trim().toLowerCase() === "spawn") return m;
      }
    }
    return null;
  }

  function loadMapLayer(resetCenter = true) {
    if (state.tileLayer) map.removeLayer(state.tileLayer);
    const m = state.activeMeta;
    const d = denom();
    const [bx0, by0, bx1, by1] = m.bounds_map;
    const bounds = L.latLngBounds([by0 / d, bx0 / d], [by1 / d, bx1 / d]);

    map.setMaxZoom(m.max_level + 2);
    state.tileLayer = new BlendedChunkLayer("", {
      tileSize: m.chunk_px,
      minZoom: 0,
      maxNativeZoom: m.max_level,
      maxZoom: m.max_level + 2,
      keepBuffer: 4,
      updateWhenZooming: false,
      bounds,
      errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
    }).addTo(map);

    setActiveLayerLabel(
      `${state.world.title || state.world.name} • ${state.mapCfg.title || state.mapCfg.name}`
    );

    if (resetCenter) {
      const spawn = findSpawnMarker();
      if (spawn) {
        const spawnLatLng = worldToLatLng(spawn.x, spawn.y ?? 64, spawn.z);
        map.setView(spawnLatLng, Math.min(1, m.max_level));
      } else {
        const wb = state.extractedMapData?.source_canvas?.world_bounds;
        if (wb) {
          map.fitBounds(L.latLngBounds(
            extractedWorldToLatLng(wb[0], wb[1]),
            extractedWorldToLatLng(wb[2], wb[3])
          ));
        } else {
          map.fitBounds(bounds);
        }
      }
    }
    buildMapStyleMenu();
    rebuildAllLayers();
  }

  function buildMapStyleMenu() {
    const menu = document.getElementById("map-style-menu");
    menu.innerHTML = "";
    metaKeys.forEach(k => {
      const m = state.chunksMeta[k];
      const btn = document.createElement("button");
      btn.textContent = `${m.world} — ${m.map} (${m.is_day ? "Day" : "Night"})`;
      if (m === state.activeMeta) btn.classList.add("active");
      btn.onclick = async () => {
        state.activeMeta = m;
        state.world = state.config.worlds.find(w => w.name === m.world) || state.config.worlds[0];
        state.mapCfg = state.world.maps.find(mp => mp.name === m.map) || state.world.maps[0];
        state.markersJson = await loadJSON(`data/markers_${encodeURIComponent(state.world.name)}.json`, null);
        cachedCityNames = null;
        menu.classList.remove("open");
        loadMapLayer(true);
      };
      menu.appendChild(btn);
    });
  }

  function ensureLayerBuilt(layer) {
    if (layer.built) return;
    layer.group = layer.build();
    layer.built = true;
  }

  function setLayerVisible(layer, visible) {
    layer.visible = visible;
    if (visible) {
      ensureLayerBuilt(layer);
      layer.group.addTo(map);
    } else if (layer.group) {
      map.removeLayer(layer.group);
    }
  }

  function registerExtractedLayer(index, layer) {
    const id = `extracted:${index}`;
    const visibleByDefault = DEFAULT_VISIBLE_EXTRACTED.has(layer.label);
    const pointToLatLng = ([x, z]) => extractedWorldToLatLng(x, z);

    let count = 0;
    if (layer.polygons?.length) count = layer.polygons.length;
    else if (layer.lines?.length) count = layer.lines.length;
    else if (layer.labels?.length) count = layer.labels.length;
    else if (layer.signs?.length) count = layer.signs.length;

    const build = () => {
      if (layer.polygons?.length) {
        const grp = L.layerGroup();
        const isCityLines = layer.label === "City Lines";
        const cityNames = isCityLines ? getCityLineNames(layer.polygons) : null;
        const weight = layer.weight ?? 2;
        const fillOpacity = layer.fillOpacity ?? 0.12;

        layer.polygons.forEach((polygon, polyIndex) => {
          const rawName = cityNames?.get(polyIndex) || "";
          const isAthens = isCityLines && rawName.trim().toLowerCase() === "athens";
          const color = isCityLines ? (isAthens ? "#ffff00" : "#00ff00") : layer.color;
          const polyWeight = isCityLines ? (isAthens ? 2.4 : 1.5) : weight;
          const baseFill = isCityLines ? (isAthens ? 0.10 : 0.045) : fillOpacity;

          const shape = L.polygon(polygon.map(pointToLatLng), {
            color,
            weight: polyWeight,
            opacity: 0.95,
            fillColor: color,
            fillOpacity: baseFill,
            interactive: isCityLines,
            renderer: extractedCanvas,
            pane: "extractedMapPane"
          }).addTo(grp);

          if (isCityLines) {
            if (rawName) {
              const html = `<span class="city-hover${isAthens ? " athens" : ""}">${escapeHtml(cityDisplayName(rawName))}</span>`;
              shape.bindTooltip(html, {
                sticky: true,
                direction: "top",
                opacity: 1,
                className: `city-hover-tip${isAthens ? " city-tip-athens" : ""}`
              });
            }
            shape.on("mouseover", () => shape.setStyle({
              fillOpacity: isAthens ? 0.24 : 0.16,
              weight: isAthens ? 3.2 : 2.2
            }));
            shape.on("mouseout", () => shape.setStyle({
              fillOpacity: baseFill,
              weight: polyWeight
            }));
          }
        });
        return grp;
      }

      if (layer.lines?.length) {
        const grp = L.layerGroup();
        L.polyline(layer.lines.map(line => line.map(pointToLatLng)), {
          color: layer.color,
          weight: layer.weight ?? 3,
          opacity: 0.9,
          interactive: false,
          smoothFactor: 0,
          renderer: extractedCanvas,
          pane: "extractedMapPane"
        }).addTo(grp);
        return grp;
      }

      if (layer.labels?.length) {
        const entries = layer.labels.map(label => {
          const latlng = pointToLatLng(label.at);
          const kind = label.kind || "county";
          const html = `<span class="county-name kind-${escapeHtml(kind)}">${escapeHtml(label.text)}</span>`;
          return {
            latlng,
            mounted: false,
            marker: null,
            buildMarker: () => L.marker(latlng, {
              icon: L.divIcon({ className: "atlas-label-icon", html, iconSize: [0, 0], iconAnchor: [0, 0] }),
              interactive: false,
              keyboard: false,
              pane: "extractedMapPane"
            })
          };
        });
        return createCulledGroup(entries);
      }

      if (layer.signs?.length) {
        const entries = layer.signs.map(sign => {
          const latlng = pointToLatLng(sign.at);
          const isInterstate = sign.type === "I";
          const text = isInterstate ? `I-${sign.label}` : sign.label;
          const html = `<span class="route-sign ${isInterstate ? "route-i" : "route-a"}">${escapeHtml(text)}</span>`;
          return {
            latlng,
            mounted: false,
            marker: null,
            buildMarker: () => L.marker(latlng, {
              icon: L.divIcon({ className: "atlas-label-icon", html, iconSize: [0, 0], iconAnchor: [0, 0] }),
              interactive: false,
              keyboard: false,
              pane: "extractedMapPane"
            })
          };
        });
        return createCulledGroup(entries);
      }

      return L.layerGroup();
    };

    const layerObj = { id, label: layer.label, visible: visibleByDefault, count, built: false, build, group: null };
    state.layersById[id] = layerObj;
    if (visibleByDefault) setLayerVisible(layerObj, true);
  }

  function registerDynmapSet(setId, mset) {
    const label = mset.label || setId;
    const visibleByDefault = DEFAULT_VISIBLE_MARKER_SETS.has(label);

    const areasArr = Object.entries(mset.areas || {});
    const linesArr = Object.entries(mset.lines || {});
    const circlesArr = Object.entries(mset.circles || {});
    const markersArr = Object.entries(mset.markers || {});
    const count = areasArr.length + linesArr.length + circlesArr.length + markersArr.length;

    // index directory records
    const areaItems = new Map();
    for (const [aid, area] of areasArr) {
      const xs = area.x || [], zs = area.z || [];
      if (xs.length < 2 || zs.length < 2) continue;
      let sx = 0, sz = 0;
      for (let i = 0; i < xs.length; i++) { sx += xs[i]; sz += zs[i]; }
      const cx = Math.round(sx / xs.length), cz = Math.round(sz / zs.length);
      const strokeColor = toHexColor(area.color, "#3f70b5");
      const fillColor = toHexColor(area.fillcolor, strokeColor);
      const name = area.label || aid;
      const item = {
        uid: `area:${setId}:${aid}`,
        layerId: setId,
        name,
        groupLabel: label,
        _search: `${name}\0${label}`.toLowerCase(),
        x: cx,
        z: cz,
        color: fillColor,
        rawDesc: area.desc || "",
        _bounds: null,
        focus: () => {
          setLayerVisible(state.layersById[setId], true);
          syncLayerCheckbox(setId, true);
          if (item._bounds) map.fitBounds(item._bounds, { maxZoom: state.activeMeta.max_level });
          else map.setView(worldToLatLng(cx, 64, cz), state.activeMeta.max_level);
        }
      };
      areaItems.set(aid, item);
      state.dynmapItems.push(item);
    }

    const markerItems = new Map();
    for (const [mid, m] of markersArr) {
      const ll = worldToLatLng(m.x, m.y || 64, m.z);
      const iconName = m.icon || "pin";
      const iconUrl = `data/icons/${encodeURIComponent(iconName)}.png`;
      const name = m.label || mid;
      const item = {
        uid: `marker:${setId}:${mid}`,
        layerId: setId,
        name,
        groupLabel: label,
        _search: `${name}\0${label}`.toLowerCase(),
        x: Math.round(m.x),
        z: Math.round(m.z),
        iconUrl,
        rawDesc: m.desc || "",
        _latlng: ll,
        focus: () => {
          setLayerVisible(state.layersById[setId], true);
          syncLayerCheckbox(setId, true);
          map.setView(ll, Math.max(map.getZoom(), state.activeMeta.max_level));
        }
      };
      markerItems.set(mid, item);
      state.dynmapItems.push(item);
    }

    const build = () => {
      const vectorGroup = L.layerGroup();

      for (const [aid, area] of areasArr) {
        const item = areaItems.get(aid);
        if (!item) continue;
        const xs = area.x, zs = area.z;
        const latlngs = xs.length === 2
          ? [
              worldToLatLng(xs[0], 64, zs[0]),
              worldToLatLng(xs[1], 64, zs[0]),
              worldToLatLng(xs[1], 64, zs[1]),
              worldToLatLng(xs[0], 64, zs[1])
            ]
          : xs.map((x, idx) => worldToLatLng(x, 64, zs[idx]));

        const strokeColor = toHexColor(area.color, "#3f70b5");
        const poly = L.polygon(latlngs, {
          color: strokeColor,
          weight: area.weight ?? 2,
          opacity: area.opacity ?? 0.85,
          fillColor: item.color,
          fillOpacity: area.fillopacity ?? 0.28,
          renderer: dynmapCanvas
        }).addTo(vectorGroup);

        item._bounds = poly.getBounds();
        poly.bindTooltip(`${item.name} (${label})`);
        poly.on("click", () => { if (!state.measuring) inspectItem(item); });
      }

      for (const [, line] of linesArr) {
        const xs = line.x || [], zs = line.z || [];
        if (xs.length < 2) continue;
        const pl = L.polyline(xs.map((x, idx) => worldToLatLng(x, 64, zs[idx])), {
          color: toHexColor(line.color, "#f28c18"),
          weight: line.weight ?? 3,
          opacity: line.opacity ?? 0.9,
          renderer: dynmapCanvas
        }).addTo(vectorGroup);
        if (line.label) pl.bindTooltip(line.label);
      }

      for (const [, circ] of circlesArr) {
        const center = worldToLatLng(circ.x, 64, circ.z);
        const edge = worldToLatLng(circ.x + (circ.xr || 100), 64, circ.z);
        L.circle(center, {
          radius: map.distance(center, edge),
          color: toHexColor(circ.color, "#3f70b5"),
          fillColor: toHexColor(circ.fillcolor, "#65a3ea"),
          fillOpacity: circ.fillopacity ?? 0.25,
          weight: circ.weight ?? 2,
          renderer: dynmapCanvas
        }).addTo(vectorGroup);
      }

      const markerEntries = [];
      for (const [mid, m] of markersArr) {
        const item = markerItems.get(mid);
        if (!item) continue;
        markerEntries.push({
          latlng: item._latlng,
          mounted: false,
          marker: null,
          buildMarker: () => {
            const html = `<div class="dynmap-marker-wrap">
              <img class="dynmap-marker-img" src="${item.iconUrl}" alt="" onerror="this.style.display='none'" />
              ${m.label ? `<span class="dynmap-marker-label">${escapeHtml(m.label)}</span>` : ""}
            </div>`;
            const divIcon = L.divIcon({ className: "", html, iconSize: [24, 24], iconAnchor: [12, 12] });
            const mk = L.marker(item._latlng, { icon: divIcon });
            mk.on("click", () => { if (!state.measuring) inspectItem(item); });
            return mk;
          }
        });
      }

      const culledMarkers = createCulledGroup(markerEntries);
      return L.layerGroup([vectorGroup, culledMarkers]);
    };

    const layerObj = { id: setId, label, visible: visibleByDefault, count, built: false, build, group: null };
    state.layersById[setId] = layerObj;
    if (visibleByDefault) setLayerVisible(layerObj, true);
  }

  function rebuildCustomLayerOnly() {
    const prev = state.layersById.__custom__;
    const wasVisible = prev ? prev.visible : true;
    if (prev?.group) map.removeLayer(prev.group);

    state.customItems = [];
    const customGroup = L.layerGroup();
    const worldCustom = state.places.filter(p => !p.world || p.world === state.world.name);

    for (const p of worldCustom) {
      const ll = worldToLatLng(p.x, p.y || 64, p.z);
      const iconUrl = iconUrlFor(p.icon);
      const pinIcon = L.divIcon({
        className: "athens-custom-pin",
        html: `<img class="athens-custom-pin-img" src="${iconUrl}" alt="" onerror="this.style.display='none'" />`,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      const marker = L.marker(ll, { icon: pinIcon }).addTo(customGroup);
      marker.bindTooltip(`${p.name} (Custom)`);
      const item = {
        uid: `custom:${p.id}`,
        layerId: "__custom__",
        name: p.name,
        groupLabel: "",
        _search: `${p.name}\0custom pin`.toLowerCase(),
        x: p.x,
        z: p.z,
        iconUrl,
        color: "#ac4900",
        customPin: p,
        rawDesc: "",
        safeDesc: `<p>${escapeHtml(p.description || "Custom Athens landmark.")}</p>`,
        focus: () => {
          setLayerVisible(state.layersById.__custom__, true);
          syncLayerCheckbox("__custom__", true);
          map.setView(ll, Math.max(map.getZoom(), state.activeMeta.max_level));
        }
      };
      marker.on("click", () => {
        if (state.measuring) return;
        if (state.editMode) openPinModal(p);
        else inspectItem(item);
      });
      state.customItems.push(item);
    }

    state.layersById.__custom__ = {
      id: "__custom__",
      label: "Custom Athens Pins",
      visible: wasVisible,
      count: worldCustom.length,
      built: true,
      build: () => customGroup,
      group: customGroup
    };
    if (wasVisible) customGroup.addTo(map);

    renderLayersPanel();
    renderDirectory();
  }

  function rebuildAllLayers() {
    for (const l of Object.values(state.layersById)) {
      if (l.group) map.removeLayer(l.group);
    }
    state.layersById = {};
    state.dynmapItems = [];
    state.customItems = [];

    const extracted = state.extractedMapData?.layers || [];
    for (let i = 0; i < extracted.length; i++) {
      registerExtractedLayer(i, extracted[i]);
    }

    const sets = state.markersJson?.sets || {};
    const sortedSets = Object.entries(sets).sort((a, b) => (a[1].layerprio || 0) - (b[1].layerprio || 0));
    for (const [setId, mset] of sortedSets) {
      registerDynmapSet(setId, mset);
    }

    rebuildCustomLayerOnly();
  }

  const layerCheckboxes = new Map();
  function syncLayerCheckbox(layerId, checked) {
    const cb = layerCheckboxes.get(layerId);
    if (cb) cb.checked = checked;
  }

  function renderLayersPanel() {
    const wrap = document.getElementById("layers-list");
    wrap.innerHTML = "";
    layerCheckboxes.clear();

    const entries = Object.values(state.layersById)
      .sort((a, b) => Number(b.visible) - Number(a.visible));
    document.getElementById("layer-count-badge").textContent = entries.length;

    const frag = document.createDocumentFragment();
    for (const layer of entries) {
      const row = document.createElement("div");
      row.className = "layer-row";
      row.innerHTML = `
        <label>
          <input type="checkbox" ${layer.visible ? "checked" : ""} />
          <span>${escapeHtml(layer.label)}</span>
        </label>
        <span class="layer-count">${layer.count}</span>
      `;
      const cb = row.querySelector("input");
      layerCheckboxes.set(layer.id, cb);
      cb.onchange = (e) => setLayerVisible(layer, e.target.checked);
      frag.appendChild(row);
    }
    wrap.appendChild(frag);
  }

  function renderDirectory() {
    const q = (document.getElementById("search-input").value || "").trim().toLowerCase();
    const list = document.getElementById("places-list");
    list.innerHTML = "";
    state.liByUid.clear();

    const all = state.customItems.concat(state.dynmapItems);
    const filtered = q ? all.filter(it => it._search.includes(q)) : all;
    document.getElementById("place-count-badge").textContent = filtered.length;

    const limit = Math.min(filtered.length, 250);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < limit; i++) {
      const item = filtered[i];
      const li = document.createElement("li");
      if (item.uid === state.selectedUid) li.classList.add("selected");
      const visual = item.iconUrl
        ? `<img class="place-ico" src="${item.iconUrl}" alt="" loading="lazy" onerror="this.style.display='none'" />`
        : `<span class="place-ico-dot" style="background:${item.color || "#3f70b5"}"></span>`;
      const metaParts = [];
      if (item.groupLabel) metaParts.push(escapeHtml(item.groupLabel));
      metaParts.push(`${item.x}, ${item.z}`);

      li.innerHTML = `${visual}
        <div>
          <div class="place-title">${escapeHtml(item.name)}</div>
          <div class="place-meta">${metaParts.join(" • ")}</div>
        </div>`;
      li.onclick = () => {
        item.focus();
        inspectItem(item);
      };
      state.liByUid.set(item.uid, li);
      frag.appendChild(li);
    }
    list.appendChild(frag);
  }

  function inspectItem(item) {
    if (state.selectedUid && state.selectedUid !== item.uid) {
      state.liByUid.get(state.selectedUid)?.classList.remove("selected");
    }
    state.selectedUid = item.uid;
    const activeLi = state.liByUid.get(item.uid);
    if (activeLi) {
      activeLi.classList.add("selected");
      activeLi.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    if (item.safeDesc == null) {
      item.safeDesc = sanitizeHtml(item.rawDesc);
    }
    const metaParts = [];
    if (item.groupLabel) metaParts.push(escapeHtml(item.groupLabel));
    metaParts.push(`X ${item.x}, Z ${item.z}`);
    document.getElementById("plex-inspector").innerHTML = `
      <strong>${escapeHtml(item.name)}</strong><br/>
      <span>${metaParts.join(" • ")}</span>
      <div style="margin-top:6px">${item.safeDesc || "No description provided."}</div>
      ${item.customPin ? `<button id="btn-inspect-edit" class="hdr-btn" style="margin-top:8px">Edit Pin</button>` : ""}
    `;
    const editBtn = document.getElementById("btn-inspect-edit");
    if (editBtn && item.customPin) editBtn.onclick = () => openPinModal(item.customPin);
  }

  // cursor telemetry
  let pendingLatLng = null;
  let cursorRaf = 0;
  const cursorEl = document.getElementById("plex-cursor");
  map.on("mousemove", (e) => {
    pendingLatLng = e.latlng;
    if (!cursorRaf) {
      cursorRaf = requestAnimationFrame(() => {
        cursorRaf = 0;
        if (!pendingLatLng) return;
        const w = latLngToWorld(pendingLatLng);
        cursorEl.textContent = `${w.x}, ${w.z}`;
      });
    }
  });

  map.on("zoomend", () => {
    document.getElementById("plex-zoom").textContent = map.getZoom();
  });

  map.on("click", (e) => {
    const w = latLngToWorld(e.latlng);
    if (state.measuring) {
      state.measurePoints.push(w);
      L.circleMarker(e.latlng, { radius: 4, color: "#f28c18", fillOpacity: 1 }).addTo(state.measureLayer);
      if (state.measurePoints.length >= 2) {
        const pts = state.measurePoints.map(pt => worldToLatLng(pt.x, 64, pt.z));
        L.polyline(pts, { color: "#f9e4bf", weight: 2, dashArray: "5,4" }).addTo(state.measureLayer);
        let total = 0;
        for (let i = 1; i < state.measurePoints.length; i++) {
          const a = state.measurePoints[i - 1], b = state.measurePoints[i];
          total += Math.hypot(b.x - a.x, b.z - a.z);
        }
        document.getElementById("measure-readout").classList.remove("hidden");
        document.getElementById("measure-val").textContent = `${Math.round(total)} m`;
      }
      return;
    }
    if (state.editMode) {
      openPinModal({
        id: "", name: "", icon: DEFAULT_PIN_ICON,
        world: state.world.name, x: w.x, y: 64, z: w.z, description: ""
      });
    }
  });

  // pin editor
  const iconPickerEl = document.getElementById("pin-icon-picker");
  const pinIconInput = document.getElementById("pin-icon");
  for (const icon of PIN_ICONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-choice";
    btn.dataset.icon = icon.id;
    btn.title = icon.label;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-label", icon.label);
    btn.innerHTML = `<img src="${iconUrlFor(icon.id)}" alt="" />`;
    btn.onclick = () => setPinIcon(icon.id);
    iconPickerEl.appendChild(btn);
  }
  setPinIcon(DEFAULT_PIN_ICON);

  function setPinIcon(name) {
    const selected = PIN_ICON_IDS.has(name) ? name : DEFAULT_PIN_ICON;
    pinIconInput.value = selected;
    for (const btn of iconPickerEl.querySelectorAll(".icon-choice")) {
      const active = btn.dataset.icon === selected;
      btn.classList.toggle("selected", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
    }
  }

  function openPinModal(pin) {
    document.getElementById("pin-modal-title").textContent = pin.id ? "Edit Custom pin" : "Add custom pin";
    document.getElementById("pin-id").value = pin.id || "";
    document.getElementById("pin-name").value = pin.name || "";
    setPinIcon(pin.icon);
    document.getElementById("pin-x").value = pin.x ?? 0;
    document.getElementById("pin-z").value = pin.z ?? 0;
    document.getElementById("pin-desc").value = pin.description || "";
    document.getElementById("btn-delete-pin").classList.toggle("hidden", !pin.id);
    document.getElementById("pin-modal").classList.remove("hidden");
    document.getElementById("pin-name").focus();
  }

  document.getElementById("pin-form").onsubmit = (ev) => {
    ev.preventDefault();
    const existingId = document.getElementById("pin-id").value;
    const existing = existingId ? state.places.find(p => p.id === existingId) : null;
    const item = {
      ...(existing || {}),
      id: existingId || `pin_${Date.now()}`,
      name: document.getElementById("pin-name").value.trim(),
      icon: pinIconInput.value,
      world: state.world.name,
      x: Number(document.getElementById("pin-x").value),
      y: existing?.y ?? 64,
      z: Number(document.getElementById("pin-z").value),
      description: document.getElementById("pin-desc").value.trim()
    };
    if (existing) {
      const idx = state.places.findIndex(p => p.id === existingId);
      if (idx >= 0) state.places[idx] = item;
    } else {
      state.places.push(item);
    }
    persistCustomDraft();
    document.getElementById("pin-modal").classList.add("hidden");
    rebuildCustomLayerOnly();
  };

  document.getElementById("btn-delete-pin").onclick = () => {
    const id = document.getElementById("pin-id").value;
    state.places = state.places.filter(p => p.id !== id);
    persistCustomDraft();
    document.getElementById("pin-modal").classList.add("hidden");
    rebuildCustomLayerOnly();
  };

  function closePinModal() {
    document.getElementById("pin-modal").classList.add("hidden");
  }
  document.getElementById("btn-close-pin").onclick = closePinModal;
  document.getElementById("btn-cancel-pin").onclick = closePinModal;

  // header controls
  document.getElementById("btn-reset-view").onclick = () => loadMapLayer(true);
  document.getElementById("btn-map-switch").onclick = (e) => {
    e.stopPropagation();
    document.getElementById("map-style-menu").classList.toggle("open");
  };
  document.addEventListener("click", () => document.getElementById("map-style-menu").classList.remove("open"));

  function setEditMode(on) {
    state.editMode = on;
    document.getElementById("btn-edit-mode").classList.toggle("active", on);
    document.getElementById("edit-banner").classList.toggle("hidden", !on);
  }
  function setMeasureMode(on) {
    state.measuring = on;
    document.getElementById("btn-measure").classList.toggle("active", on);
    if (!on) {
      state.measurePoints = [];
      state.measureLayer.clearLayers();
      document.getElementById("measure-readout").classList.add("hidden");
    }
  }

  document.getElementById("btn-edit-mode").onclick = () => setEditMode(!state.editMode);
  document.getElementById("btn-measure").onclick = () => setMeasureMode(!state.measuring);

  document.getElementById("btn-export-json").onclick = () => {
    const blob = new Blob([JSON.stringify(state.places, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "athens_places.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  document.getElementById("import-json-input").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (Array.isArray(parsed)) {
        state.places = parsed;
        persistCustomDraft();
        rebuildCustomLayerOnly();
      }
    } catch {
      alert("Invalid JSON file.");
    }
  };

  document.getElementById("btn-toggle-utility").onclick = () => {
    document.getElementById("plex-utility").classList.toggle("collapsed");
    setTimeout(() => map.invalidateSize(), 150);
  };

  // clock card collapse
  const clockCard = document.getElementById("clock-card");
  const clockToggleBtn = document.getElementById("btn-clock-toggle");
  function setClockExpanded(expanded, persist = false) {
    clockCard.classList.toggle("collapsed", !expanded);
    clockToggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    clockToggleBtn.title = expanded ? "Minimize clock" : "Expand clock";
    if (persist) {
      try { localStorage.setItem(CLOCK_EXPANDED_KEY, expanded ? "1" : "0"); } catch { /* ignore */ }
    }
  }
  try {
    setClockExpanded(localStorage.getItem(CLOCK_EXPANDED_KEY) === "1");
  } catch {
    setClockExpanded(false);
  }
  clockToggleBtn.onclick = () => setClockExpanded(clockCard.classList.contains("collapsed"), true);

  // search + keyboard ergonomics
  let searchTimer = 0;
  document.getElementById("search-input").oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderDirectory, 100);
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
      e.preventDefault();
      document.getElementById("search-input").focus();
    } else if (e.key === "Escape") {
      if (!document.getElementById("pin-modal").classList.contains("hidden")) closePinModal();
      else if (state.measuring) setMeasureMode(false);
      else if (state.editMode) setEditMode(false);
    }
  });

  // analog + digital clock
  const clockCanvas = document.getElementById("lh-analog-clock");
  const dialCache = document.createElement("canvas");
  dialCache.width = 128;
  dialCache.height = 128;
  (function buildDial() {
    const dctx = dialCache.getContext("2d");
    const r = 56, cx = 64, cy = 64;
    dctx.beginPath(); dctx.arc(cx, cy, r, 0, Math.PI * 2); dctx.fillStyle = "#f4f6fa"; dctx.fill();
    dctx.lineWidth = 4; dctx.strokeStyle = "#bcc9da"; dctx.stroke();
    for (let i = 0; i < 12; i++) {
      const ang = (i * Math.PI) / 6;
      dctx.beginPath();
      dctx.moveTo(cx + Math.sin(ang) * (r - 10), cy - Math.cos(ang) * (r - 10));
      dctx.lineTo(cx + Math.sin(ang) * (r - 4), cy - Math.cos(ang) * (r - 4));
      dctx.lineWidth = i % 3 === 0 ? 2 : 1;
      dctx.strokeStyle = "#2d3540";
      dctx.stroke();
    }
  })();

  let lastMinuteKey = "";
  function drawClock() {
    const now = new Date();
    const minKey = `${now.getHours()}:${now.getMinutes()}`;
    if (minKey !== lastMinuteKey) {
      lastMinuteKey = minKey;
      const timeText = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      document.getElementById("plex-time").textContent = timeText;
      document.getElementById("plex-time-compact").textContent = timeText;
      document.getElementById("plex-date").textContent = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    }
    if (!clockCanvas) return;
    const ctx = clockCanvas.getContext("2d");
    const r = 56, cx = 64, cy = 64;
    ctx.clearRect(0, 0, 128, 128);
    ctx.drawImage(dialCache, 0, 0);

    const sec = now.getSeconds(), min = now.getMinutes() + sec / 60, hr = (now.getHours() % 12) + min / 60;
    const hand = (ang, len, w, col) => {
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.sin(ang) * len, cy - Math.cos(ang) * len);
      ctx.lineWidth = w; ctx.strokeStyle = col; ctx.stroke();
    };
    hand((hr * Math.PI) / 6, r * 0.52, 3, "#1c2430");
    hand((min * Math.PI) / 30, r * 0.74, 2, "#1c2430");
    hand((sec * Math.PI) / 30, r * 0.82, 1, "#3f70b5");
  }
  drawClock();
  setInterval(drawClock, 1000);

  loadMapLayer(true);
})();
