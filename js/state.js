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

/** Initialize the state store */
export function initState(saved = null) {
  if (saved) {
    _state = { ...defaultProject(), ...saved, _results: null };
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
    coveragePoints: photoData.coveragePoints || [],
    traces: photoData.traces || {
      'As-Is': {
        name: 'As-Is',
        isDefault: true,
        color: '#3b82f6',
        paths: [],
        horizonProfile: null,
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

/** Serialize state for save (strips computed data and large blobs optionally) */
export function serialize(includeImages = true) {
  const s = { ..._state };
  delete s._results;
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
 * Returns array of sub-panel objects based on diode sub-sections.
 * Each sub-panel maps to ALL measurement points within its region.
 * If none fall inside, falls back to nearest point.
 *
 * Layout: [panel0-sub0, panel0-sub1, ..., panel0-subN, panel1-sub0, ...]
 */
export function getSubPanels() {
  const { rows, cols, diodeSplit, diodeSubsections } = _state.system;
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
        const subCX = (x0 + x1) / 2;
        const subCY = (y0 + y1) / 2;

        // Find all points inside this sub-panel region
        const inside = [];
        let nearestId = null;
        let nearestDist = Infinity;

        for (const pt of points) {
          const px = pt.panelCol + pt.localX;
          const py = pt.panelRow + pt.localY;

          // Check if point falls within sub-panel bounds
          if (px >= x0 && px <= x1 && py >= y0 && py <= y1) {
            inside.push(pt.id);
          }

          // Also track nearest for fallback
          const dx = px - subCX;
          const dy = py - subCY;
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
        });
      }
    }
  }
  return subs;
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
