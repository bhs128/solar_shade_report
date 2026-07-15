/**
 * SolarScope — Central state management
 * Reactive state store with serialization for save/load
 */

let _state = null;
const _listeners = new Map();
let _nextId = 1;

/** Generate a unique ID */
export function uid(prefix = 'id') {
  return `${prefix}_${_nextId++}_${Date.now().toString(36)}`;
}

/** Default empty project */
function defaultProject() {
  return {
    name: 'Untitled Project',
    version: 2,

    location: {
      lat: null,
      lon: null,
      alt: null,
      address: '',
      source: 'manual', // 'manual' | 'photo-exif'
    },

    /**
     * User-supplied weather time series (e.g. NSRDB / SAM TMY CSV).
     * null until a file is uploaded on the Setup page. Shape:
     * { filename, format, meta:{lat,lon,tz,elevation,city,state,source},
     *   columns:[...], records:[{month,day,hour,minute,dni,dhi,ghi,temp,wind,...}],
     *   count }
     * The heavy `records` array is dropped from lightweight serialization.
     */
    weather: null,

    system: {
      rows: 2,
      cols: 10,
      tilt: 30,
      azimuth: 180,
      panelWp: 410,
      panelWidth: 1.134,   // meters
      panelHeight: 2.278,  // meters
      inverterType: 'micro', // 'micro' | 'string'
      inverterWatts: 320,
      systemLosses: 14.08,   // percent (PVWatts default)
      inverterEff: 96,       // percent
      diodeSplit: 'horizontal', // 'horizontal' | 'vertical'
      diodeSubsections: 2,      // visual sub-sections per panel
      cameraFovCalibration: 104, // fisheye half-angle (°) from star calibration; null = use INSP nominal
      // Monthly BARE-branch BEAM transmittance (Jan..Dec) for deciduous-class masks.
      // Default = temperate maple, ~43°N (Konarska bare midpoint ~0.45; leaf-on ~0.04).
      // Leaf-out in May, full leaf Jun–Sep, leaf-drop October.
      deciduousBeamTau: [0.45, 0.45, 0.45, 0.42, 0.25, 0.05, 0.04, 0.04, 0.07, 0.22, 0.42, 0.45],
      // Diffuse transmittance offset: diffuse τ(month) = beam τ(month) + offset (clamped).
      // Bare branches scatter/admit more sky-diffuse than collimated beam.
      deciduousDiffuseOffset: 0.15,
      // Physical gap between adjacent panels (meters). ~0.025 m ≈ 1 inch. Drawn as
      // a real gutter in the array map; intersection snaps sit in the gutter centre.
      panelGap: 0.025,
    },

    /**
     * Measurement points on the array (user-created, draggable).
     * Each point has panel coordinates and local position within the panel.
     */
    points: {},

    /**
     * Uploaded photos, keyed by ID.
     * Each photo contains parsed metadata, image data, coverage mapping, and traces.
     */
    photos: {},

    /** Active scenario name for analysis. Default: "As-Is" */
    activeScenario: 'As-Is',
    /** Comparison scenario name (null = no comparison) */
    compareScenario: null,

    /** Computed results cache (not serialized) */
    _results: null,
  };
}

/**
 * Normalize trace horizon profiles from saved JSON.
 * Older saves may store Float32Array as plain objects with numeric keys.
 */
function normalizeLoadedProfiles(project) {
  const photos = project?.photos;
  if (!photos || typeof photos !== 'object') return;

  for (const photo of Object.values(photos)) {
    if (!photo?.traces || typeof photo.traces !== 'object') continue;
    for (const trace of Object.values(photo.traces)) {
      if (!trace) continue;
      const hp = trace.horizonProfile;
      if (!hp) continue;

      if (ArrayBuffer.isView(hp)) {
        // Already typed array-like; keep as-is.
        continue;
      }

      if (Array.isArray(hp)) {
        const arr = new Float32Array(360);
        for (let i = 0; i < 360; i++) {
          arr[i] = Number(hp[i] ?? 0) || 0;
        }
        trace.horizonProfile = arr;
        continue;
      }

      if (typeof hp === 'object') {
        const arr = new Float32Array(360);
        for (let i = 0; i < 360; i++) {
          arr[i] = Number(hp[i] ?? hp[String(i)] ?? 0) || 0;
        }
        trace.horizonProfile = arr;
      }
    }
  }
}

/** Initialize the state store */
export function initState(saved = null) {
  if (saved) {
    _state = { ...defaultProject(), ...saved, _results: null };
    normalizeLoadedProfiles(_state);
  } else {
    _state = defaultProject();
  }
  emit('*');
  return _state;
}

/** Get current state (read-only reference) */
export function getState() {
  return _state;
}

/** Update state and notify */
export function setState(path, value) {
  if (!_state) initState();
  const parts = path.split('.');
  let obj = _state;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in obj)) obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = value;
  emit(path);
  emit('*');
}

/** Batch update multiple paths */
export function batchUpdate(updates) {
  for (const [path, value] of Object.entries(updates)) {
    const parts = path.split('.');
    let obj = _state;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in obj)) obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
  }
  for (const path of Object.keys(updates)) emit(path);
  emit('*');
}

/** Subscribe to state changes. Returns unsubscribe function. */
export function subscribe(path, fn) {
  if (!_listeners.has(path)) _listeners.set(path, new Set());
  _listeners.get(path).add(fn);
  return () => _listeners.get(path)?.delete(fn);
}

function emit(path) {
  _listeners.get(path)?.forEach(fn => fn(_state));
  // Also emit parent paths
  const parts = path.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const parent = parts.slice(0, i).join('.');
    _listeners.get(parent)?.forEach(fn => fn(_state));
  }
}

// --- Photo management ---

/** Add a photo with parsed metadata */
export function addPhoto(photoData) {
  const id = photoData.id || uid('photo');
  const photo = {
    id,
    filename: photoData.filename || 'unknown.jpg',
    dataUrl: photoData.dataUrl,
    width: photoData.width || 0,
    height: photoData.height || 0,
    projection: photoData.projection || 'equirectangular',
    metadata: {
      gps: photoData.metadata?.gps || null,
      compassHeading: photoData.metadata?.compassHeading ?? null,
      pitch: photoData.metadata?.pitch ?? 0,
      roll: photoData.metadata?.roll ?? 0,
      cameraModel: photoData.metadata?.cameraModel || '',
      datetime: photoData.metadata?.datetime || null,
      projectionType: photoData.metadata?.projectionType || null,
      fullPanoWidth: photoData.metadata?.fullPanoWidth || null,
      fullPanoHeight: photoData.metadata?.fullPanoHeight || null,
      croppedWidth: photoData.metadata?.croppedWidth || null,
      croppedHeight: photoData.metadata?.croppedHeight || null,
      raw: photoData.metadata?.raw || {},
    },
    // Fisheye-specific fields (Insta360 / hemisphere cameras)
    fisheye: photoData.fisheye || null,
    // { fov, accelTilt, accelClockAngle, lensSide, calibration }
    // Ground mask for fisheye shade analysis
    groundMask: photoData.groundMask || null,
    // Orientation overrides set by user in editor
    orientation: photoData.orientation || null,
    // { panelAzimuth, panelTilt, clockAngle } — null = use defaults from system config
    coveragePoints: photoData.coveragePoints || [],
    traces: photoData.traces || {
      'As-Is': {
        name: 'As-Is',
        isDefault: true,
        color: '#3b82f6',
        paths: [],
        horizonProfile: null,
        groundMask: null,
      },
    },
  };

  _state.photos[id] = photo;

  // Auto-fill location from photo GPS if not set
  if (photo.metadata.gps && _state.location.lat === null) {
    _state.location.lat = photo.metadata.gps.lat;
    _state.location.lon = photo.metadata.gps.lon;
    _state.location.alt = photo.metadata.gps.alt;
    _state.location.source = 'photo-exif';
    emit('location');
  }

  emit('photos');
  emit('*');
  return id;
}

/** Remove a photo and unlink from points */
export function removePhoto(photoId) {
  const photo = _state.photos[photoId];
  // Preserve any painted masks at the point level so they survive a
  // delete-and-replace of the photo for the same point. The snapshot keeps
  // enough projection info to re-rasterise the mask onto a new photo (even a
  // different projection) when one is assigned to the point.
  if (photo) {
    const maskTraces = {};
    for (const [name, t] of Object.entries(photo.traces || {})) {
      if (t.groundMask) {
        maskTraces[name] = {
          name,
          color: t.color,
          isDefault: !!t.isDefault,
          groundMask: t.groundMask,
        };
      }
    }
    if (Object.keys(maskTraces).length) {
      const retained = {
        projection: photo.projection,
        metadata: {
          compassHeading: photo.metadata?.compassHeading ?? null,
          pitch: photo.metadata?.pitch ?? 0,
        },
        fisheye: photo.fisheye || null,
        orientation: photo.orientation || null,
        filename: photo.filename,
        traces: maskTraces,
      };
      for (const pt of Object.values(_state.points)) {
        if (pt.photoId === photoId) pt.retainedMask = retained;
      }
    }
  }
  delete _state.photos[photoId];
  for (const pt of Object.values(_state.points)) {
    if (pt.photoId === photoId) pt.photoId = null;
  }
  emit('photos');
  emit('points');
  emit('*');
}

/** Add a trace scenario to a photo */
export function addTrace(photoId, traceName, color = null) {
  const photo = _state.photos[photoId];
  if (!photo) return;
  const colors = ['#3b82f6', '#22c55e', '#f5a623', '#ef4444', '#8b5cf6', '#ec4899'];
  const idx = Object.keys(photo.traces).length;
  photo.traces[traceName] = {
    name: traceName,
    isDefault: false,
    color: color || colors[idx % colors.length],
    paths: [],
    horizonProfile: null,
    groundMask: null,
  };
  emit('photos');
}

/** Update trace paths for a photo/scenario */
export function updateTracePaths(photoId, traceName, paths) {
  const trace = _state.photos[photoId]?.traces[traceName];
  if (!trace) return;
  trace.paths = paths;
  trace.horizonProfile = null; // invalidate computed profile
  emit('photos');
}

// --- Point management ---

/** Validate points: remove old-format or out-of-bounds points */
export function rebuildPoints() {
  const { rows, cols } = _state.system;
  const cleaned = {};
  for (const [id, pt] of Object.entries(_state.points)) {
    // Skip old-format points (pre-canvas model)
    if (pt.panelCol === undefined || pt.panelRow === undefined) continue;
    // Remove points outside current array dimensions
    if (pt.panelCol >= cols || pt.panelRow >= rows) continue;
    cleaned[id] = pt;
  }
  _state.points = cleaned;
  emit('points');
  emit('*');
}

/** Create a new measurement point in a panel */
export function addMeasurementPoint(panelCol, panelRow, localX = 0.5, localY = 0.5) {
  const id = uid('pt');
  const n = Object.keys(_state.points).length + 1;
  _state.points[id] = {
    id,
    name: `Point ${n}`,
    panelCol,
    panelRow,
    localX,
    localY,
    photoId: null,
  };
  emit('points');
  emit('*');
  return id;
}

/** Remove a measurement point */
export function removeMeasurementPoint(id) {
  const pt = _state.points[id];
  if (!pt) return;
  if (pt.photoId) {
    const photo = _state.photos[pt.photoId];
    if (photo) {
      photo.coveragePoints = photo.coveragePoints.filter(pid => pid !== id);
    }
  }
  delete _state.points[id];
  emit('points');
  emit('*');
}

/** Move a measurement point to a new position */
export function moveMeasurementPoint(id, panelCol, panelRow, localX, localY) {
  const pt = _state.points[id];
  if (!pt) return;
  pt.panelCol = panelCol;
  pt.panelRow = panelRow;
  pt.localX = Math.max(0, Math.min(1, localX));
  pt.localY = Math.max(0, Math.min(1, localY));
  // Don't emit('*') during drag for performance — just emit points
  emit('points');
}

/** Rename a measurement point */
export function renameMeasurementPoint(id, name) {
  const pt = _state.points[id];
  if (!pt) return;
  pt.name = name;
  emit('points');
}

/** Assign a photo to one or more points */
export function assignPhotoToPoints(photoId, pointIds) {
  const photo = _state.photos[photoId];
  if (!photo) return;
  for (const pid of pointIds) {
    if (_state.points[pid]) {
      _state.points[pid].photoId = photoId;
    }
  }
  photo.coveragePoints = [
    ...new Set([...photo.coveragePoints, ...pointIds]),
  ];
  emit('points');
  emit('photos');
}

/** Assign a photo to ALL points */
export function assignPhotoToAll(photoId) {
  assignPhotoToPoints(photoId, Object.keys(_state.points));
}

// --- Serialization ---

/** Set (or replace) the uploaded weather time series. Pass null to clear. */
export function setWeather(weather) {
  _state.weather = weather || null;
  emit('weather');
  emit('*');
}

/** Remove any uploaded weather time series. */
export function clearWeather() {
  setWeather(null);
}

/** Serialize state for save (strips computed data and large blobs optionally) */
export function serialize(includeImages = true) {
  const s = { ..._state };
  delete s._results;
  // The 8760-row weather record array is heavy; persist metadata only.
  if (s.weather && s.weather.records) {
    s.weather = { ...s.weather, records: null, recordsDropped: true };
  }
  if (!includeImages) {
    // Strip dataUrl from photos for lightweight save
    const photos = {};
    for (const [k, p] of Object.entries(s.photos)) {
      photos[k] = { ...p, dataUrl: null };
    }
    return { ...s, photos };
  }
  return JSON.parse(JSON.stringify(s));
}

/** Deserialize saved project */
export function deserialize(data) {
  return initState(data);
}

// --- Sub-panel mapping (for solar analysis) ---

/**
 * Array-global PHYSICAL position of a measurement point, in metres.
 *
 * The array is modelled as real hardware: each panel occupies panelWidth ×
 * panelHeight, and successive panels are separated by a real inter-panel
 * gutter (system.panelGap). Edge / junction positions (localX or localY of
 * exactly 0 or 1) are pushed to the centre-line of that gutter, so an
 * intersection snap genuinely lives in the gap between panels rather than on
 * one panel's edge.
 *
 * @param {{panelCol:number,panelRow:number,localX:number,localY:number}} pt
 * @returns {{x:number,y:number}} metres from the array's top-left origin
 */
export function pointMeters(pt) {
  const { panelWidth: W, panelHeight: H, panelGap: g = 0 } = _state.system;
  const sx = pt.localX === 1 ? g / 2 : pt.localX === 0 ? -g / 2 : 0;
  const sy = pt.localY === 1 ? g / 2 : pt.localY === 0 ? -g / 2 : 0;
  return {
    x: pt.panelCol * (W + g) + pt.localX * W + sx,
    y: pt.panelRow * (H + g) + pt.localY * H + sy,
  };
}

/**
 * Returns array of sub-panel objects based on diode sub-sections.
 * Each sub-panel maps to ALL measurement points within its region.
 * If none fall inside, falls back to nearest point.
 *
 * Layout: [panel0-sub0, panel0-sub1, ..., panel0-subN, panel1-sub0, ...]
 */
export function getSubPanels() {
  const { rows, cols, diodeSplit, diodeSubsections } = _state.system;
  const { panelWidth: W, panelHeight: H, panelGap: g = 0 } = _state.system;
  const nSubs = diodeSubsections || 2;
  const subs = [];
  const points = Object.values(_state.points);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let s = 0; s < nSubs; s++) {
        // Sub-panel bounds in array-global coordinates
        let x0, x1, y0, y1;
        if (diodeSplit === 'vertical') {
          x0 = c + s / nSubs;
          x1 = c + (s + 1) / nSubs;
          y0 = r;
          y1 = r + 1;
        } else { // horizontal
          x0 = c;
          x1 = c + 1;
          y0 = r + s / nSubs;
          y1 = r + (s + 1) / nSubs;
        }

        // Physical (metric) centre of this sub-panel, including the gutter
        // offset of preceding panels — used for true-distance nearest fallback.
        const mSubCX = c * (W + g) + (diodeSplit === 'vertical'
          ? (s + 0.5) / nSubs * W
          : W / 2);
        const mSubCY = r * (H + g) + (diodeSplit === 'vertical'
          ? H / 2
          : (s + 0.5) / nSubs * H);

        // Find all points inside this sub-panel region
        const inside = [];
        let nearestId = null;
        let nearestDist = Infinity;

        for (const pt of points) {
          const px = pt.panelCol + pt.localX;
          const py = pt.panelRow + pt.localY;

          // Containment is in panel-relative units (gutter-invariant): a point
          // on a shared edge / grid junction belongs to every adjacent panel.
          if (px >= x0 && px <= x1 && py >= y0 && py <= y1) {
            inside.push(pt.id);
          }

          // Nearest-point fallback uses TRUE physical distance (metres), so a
          // point on the far side of an inter-panel gutter is correctly farther.
          const m = pointMeters(pt);
          const dx = m.x - mSubCX;
          const dy = m.y - mSubCY;
          const d = dx * dx + dy * dy;
          if (d < nearestDist) {
            nearestDist = d;
            nearestId = pt.id;
          }
        }

        const ptIds = inside.length > 0 ? inside : (nearestId ? [nearestId] : []);

        subs.push({
          row: r,
          col: c,
          sub: s,
          nSubs,
          label: `${String.fromCharCode(65 + r)}${c + 1}`,
          subLabel: nSubs <= 2
            ? (s === 0 ? 'top' : 'bottom')
            : `${s + 1}/${nSubs}`,
          ptIds,
          // Strictly-contained points (empty when only the nearest fallback applies)
          // and the sub-panel's physical centre in metres — used by distance-weighted
          // shade interpolation.
          insideIds: inside.slice(),
          mX: mSubCX,
          mY: mSubCY,
        });
      }
    }
  }
  return subs;
}

/**
 * Returns the panels and sub-panels that actually USE a given set of points.
 * A panel/sub-panel "uses" a point when that point falls inside its region
 * (or is its nearest fallback) — see getSubPanels(). A point on a shared edge
 * or grid junction is therefore used by every adjacent panel.
 *
 * @param {string[]} ptIds - point IDs to look up
 * @returns {{panelKeys:Set<string>, subKeys:Set<string>}} keys are "row,col"
 *   and "row,col,sub" respectively.
 */
export function getCoverageForPoints(ptIds) {
  const set = new Set(ptIds);
  const panelKeys = new Set();
  const subKeys = new Set();
  if (set.size === 0) return { panelKeys, subKeys };
  for (const sp of getSubPanels()) {
    if (sp.ptIds.some(id => set.has(id))) {
      panelKeys.add(`${sp.row},${sp.col}`);
      subKeys.add(`${sp.row},${sp.col},${sp.sub}`);
    }
  }
  return { panelKeys, subKeys };
}

/** Backwards-compatible alias (returns 2-sub panels with ptIds arrays) */
export function getHalfPanels() {
  return getSubPanels();
}

/**
 * Merge horizon profiles from multiple points using worst-case (max elevation).
 * Within a diode sub-string, cells are in series — the most-shaded cell
 * limits current for the entire sub-string.
 *
 * Returns Float32Array(360) where each azimuth degree has the maximum
 * obstruction elevation across all input horizons.
 */
export function getMergedHorizon(ptIds, scenario = null) {
  if (!ptIds || ptIds.length === 0) return new Float32Array(360);
  if (ptIds.length === 1) return getHorizonForPoint(ptIds[0], scenario);

  const merged = new Float32Array(360);
  for (const pid of ptIds) {
    const h = getHorizonForPoint(pid, scenario);
    for (let az = 0; az < 360; az++) {
      if (h[az] > merged[az]) merged[az] = h[az];
    }
  }
  return merged;
}

/**
 * Get the horizon profile for a given point, under a given scenario.
 * Returns Float32Array(360) of elevation angles.
 */
export function getHorizonForPoint(pointId, scenario = null) {
  if (!pointId) return new Float32Array(360);
  const scn = scenario || _state.activeScenario;
  const pt = _state.points[pointId];
  if (!pt || !pt.photoId) return new Float32Array(360);
  const photo = _state.photos[pt.photoId];
  if (!photo) return new Float32Array(360);
  const trace = photo.traces[scn] || photo.traces['As-Is'];
  if (!trace) return new Float32Array(360);
  if (trace.horizonProfile) return trace.horizonProfile;
  return new Float32Array(360); // no trace drawn yet
}

/**
 * Get the photo assigned to a measurement point.
 */
export function getPhotoForPoint(pointId) {
  if (!pointId) return null;
  const pt = _state.points[pointId];
  if (!pt || !pt.photoId) return null;
  return _state.photos[pt.photoId] || null;
}

/**
 * Get the trace for a measurement point under a given scenario.
 */
export function getTraceForPoint(pointId, scenario = null) {
  const photo = getPhotoForPoint(pointId);
  if (!photo) return null;
  const scn = scenario || _state.activeScenario;
  return photo.traces[scn] || photo.traces['As-Is'] || null;
}
