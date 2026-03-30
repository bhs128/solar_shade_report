/**
 * SolarScope — Shade Editor View
 * Unified ground-mask painting for equirectangular and fisheye projections.
 * Features: brush-based mask painting, sun path overlay, horizon profile mini-chart.
 */

import {
  getState, setState, addTrace, subscribe
} from '../state.js';
import {
  el, qs, qsa, clearEl, imageToSky, skyToImage,
  buildFisheyeRotation, skyToFisheye, fisheyeToSky,
  sunPositionAtTime, maskLookupToHorizon, buildSkyMaskLookup,
  decodeMaskDataUrl, debounce, normalizeFisheyeFov
} from '../utils.js';
import { computeAllSunPaths, sunPosition, solarDeclination, MONTHS, MDAYS_CUM } from '../solar-engine.js';

// ============================================================
// Module state
// ============================================================

let _container = null;
let _photoId = null;
let _traceName = null;

// Display canvas (photo + overlays)
let _canvas = null;
let _ctx = null;
let _img = null;

// Mask canvas (off-screen, stores ground mask)
let _maskCanvas = null;
let _maskCtx = null;

// Projection state
let _isFisheye = false;
let _worldToCamera = null;
let _fov = 90;

// Brush state
let _brushTool = 'ground';   // 'ground' | 'sky'
let _brushSize = 30;
let _isPainting = false;
let _lastPaintPos = null;

// Overlays
let _showSunPaths = true;
let _showGrid = true;
let _showMask = true;

// Image cache to avoid reload flash when switching photos
const _imgCache = new Map();
let _isPhotoSwitch = false;

// ============================================================
// Public API
// ============================================================

export function render(container) {
  _container = container;
  clearEl(container);

  const state = getState();
  const photos = Object.values(state.photos);

  if (state._selectedPhotoId && state.photos[state._selectedPhotoId]) {
    _photoId = state._selectedPhotoId;
  } else if (photos.length > 0) {
    _photoId = photos[0].id;
  }

  if (photos.length === 0) {
    container.innerHTML = `
      <div class="card fade-in" style="text-align:center;padding:60px 20px">
        <div style="font-size:48px;opacity:0.3;margin-bottom:16px">&#128247;</div>
        <h2 style="font-size:16px;color:var(--text);margin-bottom:8px">No Photos Uploaded</h2>
        <p class="hint" style="max-width:400px;margin:0 auto 16px">
          Upload Insta360 or panoramic hemisphere photos in the Array &amp; Photos tab first.
        </p>
        <button class="btn btn-primary" onclick="document.querySelector('[data-view=array]').click()">
          Go to Array &amp; Photos
        </button>
      </div>
    `;
    return;
  }

  buildEditorUI();
}

export function destroy() {
  document.removeEventListener('keydown', onKeyDown);
}

// ============================================================
// UI construction
// ============================================================

function buildEditorUI() {
  const state = getState();
  const photo = state.photos[_photoId];
  if (!photo) return;

  _isFisheye = photo.projection === 'fisheye';

  if (!_traceName || !photo.traces[_traceName]) {
    _traceName = Object.keys(photo.traces)[0] || 'As-Is';
  }

  const canvasW = _isFisheye ? 800 : 1200;
  const canvasH = _isFisheye ? 800 : 600;

  _container.innerHTML = `
    <div class="${_isPhotoSwitch ? '' : 'fade-in'}">
      <div class="editor-container">
        <!-- LEFT SIDEBAR -->
        <div class="editor-sidebar">
          <!-- Photo selector -->
          <div class="card" style="padding:12px">
            <h2 style="margin-bottom:8px">Photo</h2>
            <select id="sel-photo" style="width:100%;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 8px;font-size:12px">
              ${Object.values(state.photos).map(p => {
                const _pts = (p.coveragePoints || [])
                  .map(pid => state.points[pid]).filter(Boolean)
                  .map(pt => `${String.fromCharCode(65 + pt.panelRow)}${pt.panelCol + 1} ${pt.name.replace('Point ', 'P')}`);
                const _suf = _pts.length ? ` [${_pts.join(', ')}]` : ' [unassigned]';
                return `<option value="${p.id}" ${p.id === _photoId ? 'selected' : ''}>${esc(p.filename + _suf)}</option>`;
              }).join('')}
            </select>
            <div style="margin-top:4px;font-size:10px;color:var(--text3)">
              ${_isFisheye ? '&#128065; Fisheye projection' : '&#127758; Equirectangular projection'}
            </div>
          </div>
          ${buildMiniPanelMap(state)}

          ${_isFisheye ? buildFisheyeOrientationUI(photo) : buildEquirectOrientationUI(photo)}

          <!-- Trace scenarios -->
          <div class="card" style="padding:12px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <h2 style="margin:0">Scenarios</h2>
              <button class="btn btn-sm" id="btn-add-trace">+ Add</button>
            </div>
            <div class="trace-list" id="trace-list"></div>
          </div>

          <!-- Brush tools -->
          <div class="card" style="padding:12px">
            <h2 style="margin-bottom:8px">Brush Tools</h2>
            <div style="display:flex;gap:4px;flex-wrap:wrap">
              <button class="tool-btn ${_brushTool === 'ground' ? 'active' : ''}" data-tool="ground" title="Paint ground obstructions (G)">
                &#9608; Ground
              </button>
              <button class="tool-btn ${_brushTool === 'sky' ? 'active' : ''}" data-tool="sky" title="Erase — mark as sky (S)">
                &#9675; Sky
              </button>
            </div>
            <div style="margin-top:8px">
              <label style="font-size:10px;color:var(--text2);display:block;margin-bottom:2px">
                Brush Size: <span id="lbl-brush-size">${_brushSize}</span>px
              </label>
              <input type="range" id="rng-brush-size" min="5" max="150" value="${_brushSize}" style="width:100%">
            </div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px">
              <button class="btn btn-sm" id="btn-clear-mask" title="Clear all mask in current scenario">Clear</button>
              <button class="btn btn-sm" id="btn-invert-mask" title="Invert mask: swap ground/sky">Invert</button>
            </div>
            <div style="margin-top:8px;display:flex;flex-direction:column;gap:4px">
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);cursor:pointer">
                <input type="checkbox" id="chk-sun-paths" ${_showSunPaths ? 'checked' : ''} style="accent-color:var(--sun)"> Sun paths
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);cursor:pointer">
                <input type="checkbox" id="chk-grid" ${_showGrid ? 'checked' : ''} style="accent-color:var(--sun)"> Az/El grid
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);cursor:pointer">
                <input type="checkbox" id="chk-mask" ${_showMask ? 'checked' : ''} style="accent-color:var(--sun)"> Show mask
              </label>
            </div>
          </div>

          <!-- Horizon profile mini-chart -->
          <div class="card" style="padding:12px">
            <h2 style="margin-bottom:8px">Derived Horizon Profile</h2>
            <canvas id="c-horizon-mini" width="260" height="80" style="width:100%"></canvas>
            <p class="hint" style="margin-top:4px">
              Blue line = obstruction elevation derived from mask.
            </p>
          </div>
        </div>

        <!-- MAIN CANVAS -->
        <div>
          <div class="editor-canvas-wrap" id="canvas-wrap">
            <canvas id="c-editor" width="${canvasW}" height="${canvasH}"></canvas>
          </div>
          <p class="hint" style="margin-top:6px">
            Paint obstructions (ground) on the photo. Switch between Ground (G) and Sky/Erase (S) tools.
            Use scroll wheel or [ / ] to adjust brush size. Sun paths: yellow = clear, red = blocked.
          </p>
        </div>
      </div>

      <div style="text-align:center;margin-top:12px">
        <button class="btn btn-primary" id="btn-next-report" style="padding:10px 32px;font-size:14px">
          Generate Report &rarr;
        </button>
      </div>
    </div>
  `;

  setupCanvas(photo);
  buildTraceList();
  bindEditorEvents();
  loadMaskFromState();
  prefillFisheyeCorners();
  drawMiniPanelMap();
  redraw();
  _isPhotoSwitch = false;
}

// ============================================================
// Orientation UI builders
// ============================================================

function buildFisheyeOrientationUI(photo) {
  const state = getState();
  const sys = state.system;
  const fe = photo.fisheye || {};
  const ori = photo.orientation || {};
  const panelAz = ori.panelAzimuth ?? sys.azimuth;
  const panelTilt = ori.panelTilt ?? sys.tilt;
  const clockAngle = ori.clockAngle ?? fe.accelClockAngle ?? 0;
  const currentFov = ori.fov ?? normalizeFisheyeFov(fe.fov);
  const rawFov = fe.fov != null ? fe.fov.toFixed(1) : '—';

  // Build reference rows info
  const accelTilt = fe.accelTilt != null ? fe.accelTilt.toFixed(1) + '°' : '—';
  const accelClk = fe.accelClockAngle != null ? fe.accelClockAngle.toFixed(1) + '°' : '—';

  // Sun position from EXIF
  let sunInfo = '';
  if (photo.metadata?.datetime && state.location.lat != null) {
    const sp = sunPositionAtTime(photo.metadata.datetime, state.location.lat, state.location.lon);
    if (sp && sp.elevation > 0) {
      sunInfo = `<div style="margin-top:4px;font-size:10px;color:var(--sun)">&#9788; Sun at capture: Az ${sp.azimuth.toFixed(1)}° El ${sp.elevation.toFixed(1)}°</div>`;
    }
  }

  return `
    <div class="card" style="padding:12px">
      <h2 style="margin-bottom:8px">Orientation</h2>
      <table style="width:100%;font-size:10px;color:var(--text2);border-collapse:collapse">
        <tr><th style="text-align:left;padding:2px 4px"></th><th style="padding:2px 4px">Setup</th><th style="padding:2px 4px">Accel</th><th style="padding:2px 4px">Slider</th></tr>
        <tr>
          <td style="padding:2px 4px">Tilt</td>
          <td style="text-align:center;padding:2px 4px">${sys.tilt}°</td>
          <td style="text-align:center;padding:2px 4px">${accelTilt}</td>
          <td style="text-align:center;padding:2px 4px"><span id="lbl-ori-tilt">${panelTilt}°</span></td>
        </tr>
        <tr>
          <td style="padding:2px 4px">Azimuth</td>
          <td style="text-align:center;padding:2px 4px">${sys.azimuth}°</td>
          <td style="text-align:center;padding:2px 4px">—</td>
          <td style="text-align:center;padding:2px 4px"><span id="lbl-ori-az">${panelAz}°</span></td>
        </tr>
        <tr>
          <td style="padding:2px 4px">Clock</td>
          <td style="text-align:center;padding:2px 4px">—</td>
          <td style="text-align:center;padding:2px 4px">${accelClk}</td>
          <td style="text-align:center;padding:2px 4px"><span id="lbl-ori-clk">${clockAngle.toFixed(1)}°</span></td>
        </tr>
      </table>
      <div style="margin-top:8px">
        <label style="font-size:10px;color:var(--text2)">Panel Azimuth</label>
        <input type="range" id="rng-panel-az" min="0" max="360" step="0.5" value="${panelAz}" style="width:100%">
      </div>
      <div>
        <label style="font-size:10px;color:var(--text2)">Panel Tilt</label>
        <input type="range" id="rng-panel-tilt" min="0" max="90" step="0.5" value="${panelTilt}" style="width:100%">
      </div>
      <div>
        <label style="font-size:10px;color:var(--text2)">Clock Angle</label>
        <input type="range" id="rng-clock-angle" min="-180" max="180" step="0.5" value="${clockAngle}" style="width:100%">
      </div>
      <div>
        <label style="font-size:10px;color:var(--text2)">FOV Half-Angle: <span id="lbl-ori-fov">${currentFov.toFixed(1)}°</span>
          <span style="color:var(--text3);font-size:9px">(raw: ${rawFov})</span>
        </label>
        <input type="range" id="rng-fov" min="80" max="130" step="0.5" value="${currentFov}" style="width:100%">
        <span class="hint" style="font-size:9px">Adjust until the 0° horizon ring matches the horizon in the image</span>
      </div>
      ${sunInfo}
    </div>
  `;
}

function buildEquirectOrientationUI(photo) {
  const heading = photo.metadata?.compassHeading;
  if (heading != null) {
    return `
      <div class="card" style="padding:12px">
        <div style="font-size:11px;color:var(--gain)">
          &#9737; Heading: ${heading.toFixed(1)}° (${photo.metadata.headingSource?.split('(')[0] || 'auto'})
        </div>
      </div>
    `;
  }
  return `
    <div class="card" style="padding:12px">
      <label style="font-size:10px;color:var(--text2);display:block;margin-bottom:3px">Compass Heading (°)</label>
      <input type="number" id="inp-manual-heading" value="180" min="0" max="360" step="0.5"
        style="width:100%;background:var(--surface2);color:var(--warning);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 8px;font-family:'JetBrains Mono',monospace;font-size:12px">
      <span class="hint" style="color:var(--warning)">&#9888; No heading in metadata. Enter manually (180=South).</span>
    </div>
  `;
}

// ============================================================
// Mini Panel Map
// ============================================================

function buildMiniPanelMap(state) {
  const { rows, cols } = state.system;
  if (rows === 0 || cols === 0 || Object.keys(state.points).length === 0) return '';
  return `
    <div class="card" style="padding:10px">
      <h2 style="margin-bottom:4px;font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px">Array Map</h2>
      <canvas id="mini-panel-map" style="width:100%;cursor:pointer;border-radius:4px"></canvas>
      <div class="hint" style="margin-top:3px;font-size:9px">
        <span style="color:#f5a623">&#9679;</span> current photo &nbsp;
        <span style="color:#60a5fa">&#9679;</span> has photo &nbsp;
        <span style="color:rgba(255,255,255,0.35)">&#9679;</span> unassigned
      </div>
    </div>
  `;
}

function drawMiniPanelMap() {
  const cvs = qs('#mini-panel-map', _container);
  if (!cvs) return;

  const state = getState();
  const { rows, cols } = state.system;
  if (rows === 0 || cols === 0) return;

  const photo = state.photos[_photoId];
  const currentPtIds = new Set(photo?.coveragePoints || []);

  const dpr = window.devicePixelRatio || 1;
  const displayW = cvs.clientWidth || 240;
  const gap = 3;
  const pad = 6;
  const pw = Math.max(18, (displayW - 2 * pad - (cols - 1) * gap) / cols);
  const ph = Math.max(14, pw * 0.55);
  const totalH = 2 * pad + rows * ph + (rows - 1) * gap;

  cvs.width = displayW * dpr;
  cvs.height = totalH * dpr;
  cvs.style.height = totalH + 'px';

  const ctx = cvs.getContext('2d');
  ctx.scale(dpr, dpr);

  // Store layout for hit testing
  cvs._miniLayout = { pad, gap, pw, ph, rows, cols };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = pad + c * (pw + gap);
      const y = pad + r * (ph + gap);

      const pts = Object.values(state.points).filter(p => p.panelRow === r && p.panelCol === c);
      const hasCurrent = pts.some(p => currentPtIds.has(p.id));
      const hasAnyPhoto = pts.some(p => p.photoId);
      const hasTrace = pts.some(p => {
        const ph2 = state.photos[p.photoId];
        return ph2 && Object.values(ph2.traces).some(t => t.paths.length > 0 || t.groundMask);
      });

      // Panel background
      ctx.fillStyle = hasCurrent ? 'rgba(245,166,35,0.18)'
        : hasTrace ? 'rgba(34,197,94,0.1)'
        : hasAnyPhoto ? 'rgba(96,165,250,0.1)'
        : 'rgba(255,255,255,0.04)';
      ctx.fillRect(x, y, pw, ph);
      ctx.strokeStyle = hasCurrent ? 'rgba(245,166,35,0.55)'
        : hasTrace ? 'rgba(34,197,94,0.35)'
        : hasAnyPhoto ? 'rgba(96,165,250,0.25)'
        : 'rgba(255,255,255,0.1)';
      ctx.lineWidth = hasCurrent ? 1.5 : 0.75;
      ctx.strokeRect(x, y, pw, ph);

      // Panel label
      ctx.save();
      ctx.font = '7px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`${String.fromCharCode(65 + r)}${c + 1}`, x + pw / 2, y + 1);
      ctx.restore();

      // Draw points
      for (const pt of pts) {
        const px = x + pt.localX * pw;
        const py = y + pt.localY * ph;
        const ptR = 3;

        const isCurrent = currentPtIds.has(pt.id);
        ctx.beginPath();
        ctx.arc(px, py, ptR, 0, Math.PI * 2);
        ctx.fillStyle = isCurrent ? 'rgba(245,166,35,0.8)'
          : pt.photoId ? 'rgba(96,165,250,0.5)'
          : 'rgba(255,255,255,0.2)';
        ctx.fill();
        ctx.strokeStyle = isCurrent ? '#f5a623'
          : pt.photoId ? '#60a5fa'
          : 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }
}

// ============================================================
// Canvas setup
// ============================================================

function setupCanvas(photo) {
  _canvas = qs('#c-editor', _container);
  _ctx = _canvas.getContext('2d');

  const W = _canvas.width;
  const H = _canvas.height;

  // Create off-screen mask canvas (same dimensions as display)
  _maskCanvas = document.createElement('canvas');
  _maskCanvas.width = W;
  _maskCanvas.height = H;
  _maskCtx = _maskCanvas.getContext('2d');

  // Build fisheye transform if needed
  if (_isFisheye && photo.fisheye) {
    const ori = photo.orientation || {};
    const sys = getState().system;
    _fov = ori.fov ?? normalizeFisheyeFov(photo.fisheye.fov);
    _worldToCamera = buildFisheyeRotation(
      ori.panelAzimuth ?? sys.azimuth,
      ori.panelTilt ?? sys.tilt,
      ori.clockAngle ?? photo.fisheye.accelClockAngle ?? 0
    );
  }

  // Load the photo image (use cache to avoid flash on switch)
  const cached = _imgCache.get(photo.id);
  if (cached && cached.complete && cached.naturalWidth > 0) {
    _img = cached;
    // redraw() will be called by the caller
  } else {
    _img = new Image();
    _img.onload = () => {
      _imgCache.set(photo.id, _img);
      redraw();
    };
    _img.src = photo.dataUrl || '';
  }
}

// ============================================================
// Mask load/save
// ============================================================

function loadMaskFromState() {
  const photo = getState().photos[_photoId];
  if (!photo) return;
  const trace = photo.traces[_traceName];
  if (!trace?.groundMask) return;

  const img = new Image();
  img.onload = () => {
    _maskCtx.clearRect(0, 0, _maskCanvas.width, _maskCanvas.height);
    _maskCtx.drawImage(img, 0, 0, _maskCanvas.width, _maskCanvas.height);
    prefillFisheyeCorners();
    redraw();
  };
  img.src = trace.groundMask;
}

/**
 * Fill the rectangular corners outside the fisheye circle with ground mask.
 * These areas are always below the panel and should be treated as ground.
 */
function prefillFisheyeCorners() {
  if (!_isFisheye || !_maskCanvas) return;
  const W = _maskCanvas.width, H = _maskCanvas.height;
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2;
  _maskCtx.save();
  // Fill only the corners (rect minus circle) using evenodd fill rule
  _maskCtx.beginPath();
  _maskCtx.rect(0, 0, W, H);
  _maskCtx.arc(cx, cy, R, 0, Math.PI * 2, true);
  _maskCtx.fillStyle = 'rgba(230, 60, 60, 0.85)';
  _maskCtx.fill('evenodd');
  _maskCtx.restore();
}

function saveMaskToState() {
  const photo = getState().photos[_photoId];
  if (!photo) return;
  const trace = photo.traces[_traceName];
  if (!trace) return;

  // Check if mask has any content
  const id = _maskCtx.getImageData(0, 0, _maskCanvas.width, _maskCanvas.height);
  let hasContent = false;
  for (let i = 3; i < id.data.length; i += 4) {
    if (id.data[i] > 0) { hasContent = true; break; }
  }

  trace.groundMask = hasContent ? _maskCanvas.toDataURL('image/png') : null;
  // Also derive legacy horizon for backwards compat
  updateHorizonFromMask(trace);
}

const debouncedSave = debounce(saveMaskToState, 500);

function updateHorizonFromMask(trace) {
  if (!trace.groundMask) {
    trace.horizonProfile = null;
    return;
  }
  // Build lookup and derive 1D horizon
  const photo = getState().photos[_photoId];
  const sys = getState().system;
  decodeMaskDataUrl(trace.groundMask).then(maskData => {
    const lookup = buildSkyMaskLookup(photo, maskData, { azimuth: sys.azimuth, tilt: sys.tilt });
    trace.horizonProfile = maskLookupToHorizon(lookup);
    updateHorizonMini();
  });
}

// ============================================================
// Orientation helpers
// ============================================================

function getHeading() {
  const photo = getState().photos[_photoId];
  if (!photo) return 180;
  if (photo.metadata?.compassHeading != null) return photo.metadata.compassHeading;
  const inp = qs('#inp-manual-heading', _container);
  return inp ? parseFloat(inp.value) || 180 : 180;
}

function getPitch() {
  return getState().photos[_photoId]?.metadata?.pitch || 0;
}

function getOrientation() {
  const photo = getState().photos[_photoId];
  if (!photo) return { panelAz: 180, panelTilt: 30, clockAngle: 0 };
  const sys = getState().system;
  const ori = photo.orientation || {};
  const fe = photo.fisheye || {};
  return {
    panelAz: ori.panelAzimuth ?? sys.azimuth,
    panelTilt: ori.panelTilt ?? sys.tilt,
    clockAngle: ori.clockAngle ?? fe.accelClockAngle ?? 0,
  };
}

function rebuildFisheyeTransform() {
  const o = getOrientation();
  const photo = getState().photos[_photoId];
  const ori = photo?.orientation || {};
  _fov = ori.fov ?? normalizeFisheyeFov(photo?.fisheye?.fov);
  _worldToCamera = buildFisheyeRotation(o.panelAz, o.panelTilt, o.clockAngle);
}

// ============================================================
// Coordinate conversion
// ============================================================

function skyToCanvas(az, el) {
  if (_isFisheye) {
    return skyToFisheye(az, el, _worldToCamera, Math.min(_canvas.width, _canvas.height), _fov);
  }
  // Equirect: upper hemisphere only (canvas height = half sphere)
  const norm = skyToImage(az, el, getHeading(), getPitch());
  return {
    x: norm.x * _canvas.width,
    y: (norm.y / 0.5) * _canvas.height,
    visible: el >= 0 && norm.x >= 0 && norm.x <= 1,
  };
}

function canvasToSky(cx, cy) {
  if (_isFisheye) {
    return fisheyeToSky(cx, cy, _worldToCamera, Math.min(_canvas.width, _canvas.height), _fov);
  }
  // Equirect upper hemisphere
  const xN = cx / _canvas.width;
  const yN = (cy / _canvas.height) * 0.5;
  return imageToSky(xN, yN, getHeading(), getPitch());
}

// ============================================================
// Drawing / rendering
// ============================================================

function redraw() {
  if (!_ctx || !_canvas) return;
  const W = _canvas.width, H = _canvas.height;
  _ctx.clearRect(0, 0, W, H);

  const photo = getState().photos[_photoId];
  if (!photo) return;

  // Draw photo background
  if (_img && _img.complete && _img.naturalWidth > 0) {
    if (_isFisheye) {
      _ctx.drawImage(_img, 0, 0, W, H);
    } else {
      // Upper hemisphere only
      _ctx.drawImage(_img, 0, 0, _img.naturalWidth, _img.naturalHeight / 2, 0, 0, W, H);
    }
  } else {
    _ctx.fillStyle = '#1a2030';
    _ctx.fillRect(0, 0, W, H);
  }

  // Circular clip for fisheye
  if (_isFisheye) {
    _ctx.save();
    _ctx.globalCompositeOperation = 'destination-in';
    _ctx.beginPath();
    _ctx.arc(W / 2, H / 2, W / 2, 0, Math.PI * 2);
    _ctx.fill();
    _ctx.restore();
  }

  // Draw mask overlay
  if (_showMask) {
    _ctx.save();
    _ctx.globalAlpha = 0.35;
    _ctx.drawImage(_maskCanvas, 0, 0);
    _ctx.restore();
  }

  // Grid
  if (_showGrid) {
    drawGrid(W, H);
  }

  // Sun paths
  if (_showSunPaths) {
    drawSunPaths(W, H);
  }

  // Brush cursor
  if (_lastPaintPos) {
    _ctx.save();
    _ctx.strokeStyle = _brushTool === 'ground' ? 'rgba(230,80,80,0.7)' : 'rgba(80,180,230,0.7)';
    _ctx.lineWidth = 1.5;
    _ctx.beginPath();
    _ctx.arc(_lastPaintPos.x, _lastPaintPos.y, _brushSize / 2, 0, Math.PI * 2);
    _ctx.stroke();
    _ctx.restore();
  }

  updateHorizonMini();
}

function drawGrid(W, H) {
  _ctx.save();
  _ctx.font = '10px "JetBrains Mono", monospace';

  if (_isFisheye) {
    // Elevation rings (include 0° horizon)
    for (let el = 0; el <= 80; el += 10) {
      const isHorizon = el === 0;
      _ctx.beginPath();
      _ctx.strokeStyle = isHorizon ? 'rgba(255,200,0,0.4)' : 'rgba(255,255,255,0.35)';
      _ctx.lineWidth = isHorizon ? 2 : 1;
      let started = false;
      for (let az = 0; az < 360; az += 2) {
        const p = skyToCanvas(az, el);
        if (p.visible) {
          if (started) _ctx.lineTo(p.x, p.y);
          else { _ctx.moveTo(p.x, p.y); started = true; }
        } else {
          started = false; // break the path at invisible gaps
        }
      }
      // Close ring only if the full circle is visible (no gaps)
      const pLast = skyToCanvas(358, el);
      const pFirst = skyToCanvas(0, el);
      if (pLast.visible && pFirst.visible) {
        _ctx.lineTo(pFirst.x, pFirst.y);
      }
      _ctx.stroke();

      // Label
      if (el % 20 === 0) {
        const lp = skyToCanvas(0, el);
        if (lp.visible) {
          _ctx.fillStyle = 'rgba(255,255,255,0.55)';
          _ctx.textAlign = 'center';
          _ctx.fillText(`${el}°`, lp.x, lp.y - 3);
        }
      }
    }

    // Azimuth radials
    const cardinals = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let az = 0; az < 360; az += 30) {
      const p0 = skyToCanvas(az, 0);
      const p1 = skyToCanvas(az, 85);
      if (p0.visible && p1.visible) {
        _ctx.beginPath();
        _ctx.moveTo(p0.x, p0.y);
        _ctx.lineTo(p1.x, p1.y);
        _ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        _ctx.lineWidth = 1;
        _ctx.stroke();
      }
      const label = cardinals[az] || `${az}°`;
      const lp = skyToCanvas(az, 2);
      if (lp.visible) {
        _ctx.fillStyle = cardinals[az] ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.4)';
        _ctx.textAlign = 'center';
        _ctx.fillText(label, lp.x, lp.y + 12);
      }
    }
  } else {
    // Equirectangular grid (same as original)
    const heading = getHeading();
    _ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    _ctx.lineWidth = 0.5;

    // Elevation lines
    for (let elev = 0; elev <= 90; elev += 10) {
      const cp = skyToCanvas(heading, elev);
      if (cp.y < 0 || cp.y > H) continue;
      _ctx.beginPath();
      _ctx.moveTo(0, cp.y);
      _ctx.lineTo(W, cp.y);
      _ctx.stroke();
      _ctx.fillStyle = 'rgba(255,255,255,0.3)';
      _ctx.textAlign = 'left';
      _ctx.fillText(`${elev}°`, 4, cp.y - 2);
    }

    // Horizon emphasis
    const hp = skyToCanvas(heading, 0);
    if (hp.y >= 0 && hp.y <= H) {
      _ctx.beginPath();
      _ctx.moveTo(0, hp.y);
      _ctx.lineTo(W, hp.y);
      _ctx.strokeStyle = 'rgba(255,200,0,0.4)';
      _ctx.lineWidth = 2;
      _ctx.stroke();
      _ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      _ctx.lineWidth = 0.5;
    }

    // Azimuth lines
    const cardinals = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let az = 0; az < 360; az += 30) {
      const cp = skyToCanvas(az, 45);
      if (cp.x < 0 || cp.x > W) continue;
      _ctx.beginPath();
      _ctx.moveTo(cp.x, 0);
      _ctx.lineTo(cp.x, H);
      _ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      _ctx.lineWidth = 0.5;
      _ctx.stroke();
      const label = cardinals[az] || `${az}°`;
      _ctx.fillStyle = cardinals[az] ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.25)';
      _ctx.textAlign = 'center';
      _ctx.fillText(label, cp.x, H - 4);
    }
  }

  _ctx.restore();
}

function drawSunPaths(W, H) {
  const state = getState();
  const lat = state.location.lat;
  if (lat == null) {
    // Show a note so user knows why sun paths are missing
    _ctx.save();
    _ctx.fillStyle = 'rgba(245,168,35,0.8)';
    _ctx.font = '12px "JetBrains Mono", monospace';
    _ctx.textAlign = 'center';
    _ctx.fillText('Set location in Setup to show sun paths', W / 2, _isFisheye ? 30 : 16);
    _ctx.restore();
    return;
  }

  // Get mask data for shading detection
  const maskId = _maskCtx.getImageData(0, 0, _maskCanvas.width, _maskCanvas.height);

  // Build 4 sun paths: June solstice, Equinox, December solstice, + photo capture date
  const pathDefs = [
    { doy: MDAYS_CUM[5] + 21,  label: 'Jun solstice', color: '#f5c842', alpha: 'cc', lw: 1.5, dash: [] },
    { doy: MDAYS_CUM[2] + 21,  label: 'Equinox',      color: '#e0e0e0', alpha: 'aa', lw: 1.2, dash: [4, 3] },
    { doy: MDAYS_CUM[11] + 21, label: 'Dec solstice',  color: '#f09050', alpha: 'cc', lw: 1.5, dash: [] },
  ];

  // Add photo capture date path
  const photo = getState().photos[_photoId];
  let photoDoy = null;
  if (photo?.metadata?.datetime) {
    const dt = photo.metadata.datetime instanceof Date
      ? photo.metadata.datetime : new Date(photo.metadata.datetime);
    if (!isNaN(dt.getTime())) {
      photoDoy = Math.floor((dt - new Date(dt.getFullYear(), 0, 0)) / 86400000);
      pathDefs.push({ doy: photoDoy, label: 'Photo date', color: '#4ade80', alpha: 'dd', lw: 2, dash: [] });
    }
  }

  _ctx.save();
  for (const pd of pathDefs) {
    const decl = solarDeclination(pd.doy);
    const pts = [];
    for (let ha = -90; ha <= 90; ha += 0.5) {
      const p = sunPosition(lat, decl, ha);
      if (p.elevation > 0) pts.push({ ...p, ha });
    }

    _ctx.setLineDash(pd.dash);
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1], p1 = pts[i];
      const c0 = skyToCanvas(p0.azimuth, p0.elevation);
      const c1 = skyToCanvas(p1.azimuth, p1.elevation);

      // Skip if either endpoint is outside visible area
      if (!c0.visible || !c1.visible) continue;
      if (c0.x < -50 || c0.x > W + 50 || c1.x < -50 || c1.x > W + 50) continue;
      if (c0.y < -50 || c0.y > H + 50 || c1.y < -50 || c1.y > H + 50) continue;

      // Check mask at these positions for shade coloring
      const sh0 = isMaskPixelGround(maskId, Math.round(c0.x), Math.round(c0.y));
      const sh1 = isMaskPixelGround(maskId, Math.round(c1.x), Math.round(c1.y));
      const sh = sh0 || sh1;

      _ctx.beginPath();
      _ctx.moveTo(c0.x, c0.y);
      _ctx.lineTo(c1.x, c1.y);
      _ctx.strokeStyle = sh ? `#ef4444${pd.alpha}` : `${pd.color}${pd.alpha}`;
      _ctx.lineWidth = sh ? pd.lw + 0.5 : pd.lw;
      _ctx.stroke();
    }
    _ctx.setLineDash([]);

    // Hour labels along path
    for (let ha = -75; ha <= 75; ha += 15) {
      const p = sunPosition(lat, solarDeclination(pd.doy), ha);
      if (p.elevation <= 1) continue;
      const c = skyToCanvas(p.azimuth, p.elevation);
      if (!c.visible) continue;
      if (ha % 30 === 0) {
        const hr = 12 + ha / 15;
        const h12 = hr > 12 ? hr - 12 : hr;
        const ap = hr >= 12 ? 'p' : 'a';
        _ctx.fillStyle = pd.color;
        _ctx.font = '500 9px "JetBrains Mono", monospace';
        _ctx.textAlign = 'center';
        _ctx.fillText(h12 + ap, c.x, c.y - 6);
      }
      // Small dot at each hour
      _ctx.beginPath();
      _ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2);
      _ctx.fillStyle = pd.color;
      _ctx.fill();
    }
  }

  // Draw current sun position icon (from EXIF capture time)
  if (photo?.metadata?.datetime && lat != null) {
    const sp = sunPositionAtTime(photo.metadata.datetime, lat, state.location.lon);
    if (sp && sp.elevation > 0) {
      const sc = skyToCanvas(sp.azimuth, sp.elevation);
      if (sc.visible) {
        // Glow
        const g = _ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, 16);
        g.addColorStop(0, 'rgba(245,200,66,0.5)');
        g.addColorStop(1, 'rgba(245,200,66,0)');
        _ctx.fillStyle = g;
        _ctx.beginPath();
        _ctx.arc(sc.x, sc.y, 16, 0, Math.PI * 2);
        _ctx.fill();

        // Sun disc
        _ctx.beginPath();
        _ctx.arc(sc.x, sc.y, 8, 0, Math.PI * 2);
        _ctx.fillStyle = '#f5c842';
        _ctx.fill();
        _ctx.strokeStyle = '#fff';
        _ctx.lineWidth = 1.5;
        _ctx.stroke();

        // Rays
        for (let a = 0; a < 8; a++) {
          const an = a * Math.PI / 4;
          _ctx.beginPath();
          _ctx.moveTo(sc.x + Math.cos(an) * 11, sc.y + Math.sin(an) * 11);
          _ctx.lineTo(sc.x + Math.cos(an) * 15, sc.y + Math.sin(an) * 15);
          _ctx.strokeStyle = '#f5c842';
          _ctx.lineWidth = 1.5;
          _ctx.stroke();
        }
      }
    }
  }

  _ctx.restore();
}

function isMaskPixelGround(maskId, x, y) {
  if (x < 0 || x >= maskId.width || y < 0 || y >= maskId.height) return false;
  return maskId.data[(y * maskId.width + x) * 4 + 3] > 128;
}

// ============================================================
// Horizon mini-chart
// ============================================================

function updateHorizonMini() {
  const miniCanvas = qs('#c-horizon-mini', _container);
  if (!miniCanvas) return;
  const mc = miniCanvas.getContext('2d');
  const W = miniCanvas.width, H = miniCanvas.height;
  mc.clearRect(0, 0, W, H);

  const photo = getState().photos[_photoId];
  const trace = photo?.traces[_traceName];
  const profile = trace?.horizonProfile;

  if (!profile) {
    mc.fillStyle = '#546e7a';
    mc.font = '10px "JetBrains Mono"';
    mc.textAlign = 'center';
    mc.fillText('No mask painted yet', W / 2, H / 2 + 4);
    return;
  }

  const maxEl = Math.max(1, ...profile);
  mc.fillStyle = '#3b82f618';
  mc.strokeStyle = '#3b82f6';
  mc.lineWidth = 1.5;
  mc.beginPath();
  mc.moveTo(0, H);
  for (let az = 0; az < 360; az++) {
    const x = (az / 360) * W;
    const y = H - (profile[az] / maxEl) * (H - 10);
    mc.lineTo(x, y);
  }
  mc.lineTo(W, H);
  mc.closePath();
  mc.fill();
  mc.beginPath();
  for (let az = 0; az < 360; az++) {
    const x = (az / 360) * W;
    const y = H - (profile[az] / maxEl) * (H - 10);
    if (az === 0) mc.moveTo(x, y);
    else mc.lineTo(x, y);
  }
  mc.stroke();

  mc.fillStyle = '#546e7a';
  mc.font = '8px "JetBrains Mono"';
  mc.textAlign = 'center';
  const labels = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (const [az, label] of Object.entries(labels)) {
    mc.fillText(label, (az / 360) * W, H - 1);
  }
}

// ============================================================
// Painting
// ============================================================

function paintAt(cx, cy) {
  const r = _brushSize / 2;
  if (_brushTool === 'ground') {
    _maskCtx.fillStyle = 'rgba(230, 60, 60, 0.85)';
    _maskCtx.beginPath();
    _maskCtx.arc(cx, cy, r, 0, Math.PI * 2);
    _maskCtx.fill();
  } else {
    _maskCtx.save();
    _maskCtx.globalCompositeOperation = 'destination-out';
    _maskCtx.beginPath();
    _maskCtx.arc(cx, cy, r, 0, Math.PI * 2);
    _maskCtx.fill();
    _maskCtx.restore();
  }
}

function paintLine(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / (_brushSize * 0.3)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    paintAt(x0 + dx * t, y0 + dy * t);
  }
}

// ============================================================
// Trace list
// ============================================================

function buildTraceList() {
  const list = qs('#trace-list', _container);
  if (!list) return;
  clearEl(list);

  const photo = getState().photos[_photoId];
  if (!photo) return;

  for (const [name, trace] of Object.entries(photo.traces)) {
    const item = el('div', {
      class: `trace-item ${name === _traceName ? 'active' : ''}`,
    });
    const hasMask = trace.groundMask ? '&#9632;' : '&#9633;';
    item.innerHTML = `
      <span class="trace-color" style="background:${trace.color}"></span>
      <span class="trace-name">${esc(name)} ${trace.isDefault ? '(default)' : ''}</span>
      <span style="font-size:10px;color:var(--text3)">${hasMask} mask</span>
      ${!trace.isDefault ? `<button class="btn btn-sm btn-ghost btn-danger" data-del="${name}" title="Delete trace" style="padding:2px 6px">&#10005;</button>` : ''}
    `;
    item.addEventListener('click', (e) => {
      if (e.target.dataset.del) {
        delete photo.traces[e.target.dataset.del];
        if (_traceName === e.target.dataset.del) {
          _traceName = Object.keys(photo.traces)[0];
        }
        buildTraceList();
        loadMaskFromState();
        redraw();
        return;
      }
      // Save current mask before switching
      saveMaskToState();
      _traceName = name;
      buildTraceList();
      loadMaskFromState();
      redraw();
    });
    list.appendChild(item);
  }
}

// ============================================================
// Event binding
// ============================================================

function bindEditorEvents() {
  // Photo selector
  qs('#sel-photo', _container)?.addEventListener('change', (e) => {
    saveMaskToState();
    _photoId = e.target.value;
    _traceName = null;
    _isPhotoSwitch = true;
    buildEditorUI();
  });

  // Mini panel map click — switch to the photo assigned to the clicked point
  qs('#mini-panel-map', _container)?.addEventListener('click', (e) => {
    const cvs = e.currentTarget;
    const rect = cvs.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const L = cvs._miniLayout;
    if (!L) return;
    const state = getState();
    for (let r = 0; r < L.rows; r++) {
      for (let c = 0; c < L.cols; c++) {
        const x = L.pad + c * (L.pw + L.gap);
        const y = L.pad + r * (L.ph + L.gap);
        if (mx >= x && mx <= x + L.pw && my >= y && my <= y + L.ph) {
          const pts = Object.values(state.points).filter(p => p.panelRow === r && p.panelCol === c);
          let best = null, bestD = Infinity;
          for (const pt of pts) {
            const d = Math.hypot(mx - (x + pt.localX * L.pw), my - (y + pt.localY * L.ph));
            if (d < bestD) { bestD = d; best = pt; }
          }
          if (best && best.photoId && best.photoId !== _photoId) {
            saveMaskToState();
            _photoId = best.photoId;
            _traceName = null;
            _isPhotoSwitch = true;
            buildEditorUI();
          }
          return;
        }
      }
    }
  });

  // Manual heading
  qs('#inp-manual-heading', _container)?.addEventListener('change', () => redraw());

  // Fisheye orientation sliders
  for (const id of ['rng-panel-az', 'rng-panel-tilt', 'rng-clock-angle', 'rng-fov']) {
    qs(`#${id}`, _container)?.addEventListener('input', (e) => {
      const photo = getState().photos[_photoId];
      if (!photo) return;
      if (!photo.orientation) photo.orientation = {};
      const v = parseFloat(e.target.value);
      if (id === 'rng-panel-az') {
        photo.orientation.panelAzimuth = v;
        const lbl = qs('#lbl-ori-az', _container);
        if (lbl) lbl.textContent = v + '°';
      } else if (id === 'rng-panel-tilt') {
        photo.orientation.panelTilt = v;
        const lbl = qs('#lbl-ori-tilt', _container);
        if (lbl) lbl.textContent = v + '°';
      } else if (id === 'rng-fov') {
        photo.orientation.fov = v;
        const lbl = qs('#lbl-ori-fov', _container);
        if (lbl) lbl.textContent = v.toFixed(1) + '°';
      } else {
        photo.orientation.clockAngle = v;
        const lbl = qs('#lbl-ori-clk', _container);
        if (lbl) lbl.textContent = v.toFixed(1) + '°';
      }
      rebuildFisheyeTransform();
      redraw();
    });
  }

  // Add trace
  qs('#btn-add-trace', _container)?.addEventListener('click', () => {
    const name = prompt('Name for new trace scenario:', 'Trees Removed');
    if (!name || !name.trim()) return;
    addTrace(_photoId, name.trim());
    _traceName = name.trim();
    _maskCtx.clearRect(0, 0, _maskCanvas.width, _maskCanvas.height);
    buildTraceList();
    redraw();
  });

  // Brush tool buttons
  for (const btn of qsa('.tool-btn[data-tool]', _container)) {
    btn.addEventListener('click', () => {
      _brushTool = btn.dataset.tool;
      qsa('.tool-btn[data-tool]', _container).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  }

  // Brush size slider
  qs('#rng-brush-size', _container)?.addEventListener('input', (e) => {
    _brushSize = parseInt(e.target.value, 10);
    qs('#lbl-brush-size', _container).textContent = _brushSize;
  });

  // Clear mask
  qs('#btn-clear-mask', _container)?.addEventListener('click', () => {
    _maskCtx.clearRect(0, 0, _maskCanvas.width, _maskCanvas.height);
    saveMaskToState();
    redraw();
  });

  // Invert mask
  qs('#btn-invert-mask', _container)?.addEventListener('click', () => {
    const W = _maskCanvas.width, H = _maskCanvas.height;
    const id = _maskCtx.getImageData(0, 0, W, H);
    for (let i = 0; i < id.data.length; i += 4) {
      if (id.data[i + 3] > 128) {
        id.data[i + 3] = 0;
      } else {
        id.data[i] = 230;
        id.data[i + 1] = 60;
        id.data[i + 2] = 60;
        id.data[i + 3] = 217;
      }
    }
    _maskCtx.putImageData(id, 0, 0);
    saveMaskToState();
    redraw();
  });

  // Overlay toggles
  qs('#chk-sun-paths', _container)?.addEventListener('change', (e) => {
    _showSunPaths = e.target.checked;
    redraw();
  });
  qs('#chk-grid', _container)?.addEventListener('change', (e) => {
    _showGrid = e.target.checked;
    redraw();
  });
  qs('#chk-mask', _container)?.addEventListener('change', (e) => {
    _showMask = e.target.checked;
    redraw();
  });

  // Canvas paint events
  bindCanvasEvents();

  // Next button
  qs('#btn-next-report', _container)?.addEventListener('click', () => {
    saveMaskToState();
    document.querySelector('[data-view="report"]').click();
  });

  // Keyboard
  document.addEventListener('keydown', onKeyDown);
}

function bindCanvasEvents() {
  if (!_canvas) return;

  const getPos = (e) => {
    const rect = _canvas.getBoundingClientRect();
    const scaleX = _canvas.width / rect.width;
    const scaleY = _canvas.height / rect.height;
    return {
      cx: (e.clientX - rect.left) * scaleX,
      cy: (e.clientY - rect.top) * scaleY,
    };
  };

  _canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    _isPainting = true;
    const { cx, cy } = getPos(e);
    paintAt(cx, cy);
    _lastPaintPos = { x: cx, y: cy };
    redraw();
  });

  _canvas.addEventListener('mousemove', (e) => {
    const { cx, cy } = getPos(e);

    if (_isPainting && _lastPaintPos) {
      paintLine(_lastPaintPos.x, _lastPaintPos.y, cx, cy);
      _lastPaintPos = { x: cx, y: cy };
      redraw();
    } else {
      _lastPaintPos = { x: cx, y: cy };
      // Show sky coords in title
      const sky = canvasToSky(cx, cy);
      if (sky && sky.valid !== false) {
        _canvas.title = `Az: ${(sky.azimuth ?? 0).toFixed(1)}° El: ${(sky.elevation ?? 0).toFixed(1)}°`;
      }
      // Redraw to update cursor circle
      redraw();
    }
  });

  _canvas.addEventListener('mouseup', () => {
    if (_isPainting) {
      _isPainting = false;
      debouncedSave();
    }
  });

  _canvas.addEventListener('mouseleave', () => {
    if (_isPainting) {
      _isPainting = false;
      debouncedSave();
    }
    _lastPaintPos = null;
    redraw();
  });

  // Scroll wheel = brush size
  _canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    _brushSize = Math.max(5, Math.min(150, _brushSize + (e.deltaY > 0 ? -3 : 3)));
    const slider = qs('#rng-brush-size', _container);
    if (slider) slider.value = _brushSize;
    const lbl = qs('#lbl-brush-size', _container);
    if (lbl) lbl.textContent = _brushSize;
    redraw();
  }, { passive: false });

  // Touch support
  _canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    _isPainting = true;
    const touch = e.touches[0];
    const rect = _canvas.getBoundingClientRect();
    const cx = (touch.clientX - rect.left) * (_canvas.width / rect.width);
    const cy = (touch.clientY - rect.top) * (_canvas.height / rect.height);
    paintAt(cx, cy);
    _lastPaintPos = { x: cx, y: cy };
    redraw();
  }, { passive: false });

  _canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!_isPainting) return;
    const touch = e.touches[0];
    const rect = _canvas.getBoundingClientRect();
    const cx = (touch.clientX - rect.left) * (_canvas.width / rect.width);
    const cy = (touch.clientY - rect.top) * (_canvas.height / rect.height);
    if (_lastPaintPos) {
      paintLine(_lastPaintPos.x, _lastPaintPos.y, cx, cy);
    }
    _lastPaintPos = { x: cx, y: cy };
    redraw();
  }, { passive: false });

  _canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    _isPainting = false;
    debouncedSave();
  }, { passive: false });
}

function onKeyDown(e) {
  // G = ground tool, S = sky tool
  if (e.key === 'g' || e.key === 'G') {
    _brushTool = 'ground';
    qsa('.tool-btn[data-tool]', _container).forEach(b =>
      b.classList.toggle('active', b.dataset.tool === 'ground')
    );
  } else if (e.key === 's' || e.key === 'S') {
    _brushTool = 'sky';
    qsa('.tool-btn[data-tool]', _container).forEach(b =>
      b.classList.toggle('active', b.dataset.tool === 'sky')
    );
  } else if (e.key === '[') {
    _brushSize = Math.max(5, _brushSize - 5);
    const slider = qs('#rng-brush-size', _container);
    if (slider) slider.value = _brushSize;
    const lbl = qs('#lbl-brush-size', _container);
    if (lbl) lbl.textContent = _brushSize;
    redraw();
  } else if (e.key === ']') {
    _brushSize = Math.min(150, _brushSize + 5);
    const slider = qs('#rng-brush-size', _container);
    if (slider) slider.value = _brushSize;
    const lbl = qs('#lbl-brush-size', _container);
    if (lbl) lbl.textContent = _brushSize;
    redraw();
  }
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
