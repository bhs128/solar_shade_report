/**
 * SolarScope — Shade Editor View
 * Unified ground-mask painting for equirectangular and fisheye projections.
 * Features: brush-based mask painting, sun path overlay, horizon profile mini-chart,
 * and live SVF (sky view factor) feedback from the current mask.
 */

import {
  getState, setState, addTrace, subscribe, getCoverageForPoints, getSubPanels, pointMeters
} from '../state.js';
import {
  el, qs, qsa, clearEl, imageToSky, skyToImage,
  buildFisheyeRotation, skyToFisheye, fisheyeToSky,
  sunPositionAtTime, maskLookupToHorizon, buildSkyMaskLookup,
  decodeMaskDataUrl, debounce, resolveFisheyeFov,
  MASK_OPEN, MASK_SOLID, MASK_DECIDUOUS
} from '../utils.js';
import {
  computeAllSunPaths, sunPosition, solarDeclination, computeDiffuseSVF,
  buildMergedCategoryLookupForPoints, deciduousTransmittanceByMonth,
  computeDiffuseSVFComponents, clearSkyDNI, clearSkyDHI, clearSkyGHI, poaIrradiance,
  MONTHS, MDAYS_CUM
} from '../solar-engine.js';

// ============================================================
// Module state
// ============================================================

let _container = null;
let _photoId = null;
let _traceName = null;

// Panel Shade Simulator — whole-array beam-shade preview at a chosen date/time.
// This state is module-level so it PERSISTS across photo switches / editor
// rebuilds (the simulator reflects the whole array, not the edited photo).
let _horizonCollapsed = false;
let _simCollapsed = false;
let _simDate = null;          // 'YYYY-MM-DD'
let _simTime = 12;            // hours of day (0..24), local clock
let _simPoints = null;        // per measurement point: { loc, catFn, svfOpen, svfDecid }
let _simSubs = null;          // getSubPanels() metadata (row/col/sub/insideIds/mX/mY)
let _simDataScn = null;       // scenario the cached point data was built for

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

// Equirectangular panoramas are assumed to be NORTH-centred at their native
// horizontal centre (column width/2 → azimuth 0°). The editor re-projects them
// so the photo lines up with the heading-centred grid / analysis convention:
// the canvas centre shows the `heading` direction (default 180° → SOUTH), which
// keeps the relevant sky (sun path + southern obstructions) contiguous in the
// middle instead of split across the wrap seam. Change this if a future source
// uses a different native centre.
const EQUIRECT_NATIVE_CENTER_AZ = 0;

/**
 * Draw the upper hemisphere of an equirectangular panorama, rolled horizontally
 * so that the `heading` azimuth lands at the canvas centre (assuming the source
 * image is EQUIRECT_NATIVE_CENTER_AZ-centred). Wrapping is handled by drawing the
 * image in two segments. This is a pure horizontal translation, so left/right
 * orientation is preserved and the drawn photo stays consistent with skyToImage.
 */
function drawEquirectTopHalf(ctx, img, W, H, heading) {
  const natW = img.naturalWidth;
  const srcH = img.naturalHeight / 2; // upper hemisphere only
  // Native column fraction that should map to canvas x = 0.
  let rollFrac = ((heading - EQUIRECT_NATIVE_CENTER_AZ) / 360) % 1;
  if (rollFrac < 0) rollFrac += 1;
  const srcStart = rollFrac * natW;
  if (srcStart < 1) {
    // No roll needed (heading ≈ native centre).
    ctx.drawImage(img, 0, 0, natW, srcH, 0, 0, W, H);
    return;
  }
  const firstSrcW = natW - srcStart;               // native [srcStart, natW)
  const firstCanvasW = (firstSrcW / natW) * W;
  ctx.drawImage(img, srcStart, 0, firstSrcW, srcH, 0, 0, firstCanvasW, H);
  ctx.drawImage(img, 0, 0, srcStart, srcH, firstCanvasW, 0, W - firstCanvasW, H);
}

// Brush state
let _brushTool = 'ground';   // 'ground' | 'deciduous' | 'sky'
let _brushSize = 30;
let _isPainting = false;
let _lastPaintPos = null;

// Overlays
let _showSunPaths = true;
let _showGrid = true;
let _showMask = true;

// Sun finder disc state
let _sunDisc = null;    // { cx, cy, r, foundX, foundY } in canvas coords, or null
let _draggingSun = false;
let _sunDragOffset = null;  // { dx, dy }
let _hoveringSun = false;   // cursor is over the sun disc

// Image cache to avoid reload flash when switching photos
const _imgCache = new Map();
let _isPhotoSwitch = false;

// SVF sampling resolution for live feedback (higher = slower, smoother)
const SVF_AZ_STEP = 2;
const SVF_EL_STEP = 2;

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
              <button class="tool-btn ${_brushTool === 'ground' ? 'active' : ''}" data-tool="ground" title="Paint solid obstructions — blocks 100% year-round (G)">
                &#9608; Solid
              </button>
              <button class="tool-btn ${_brushTool === 'deciduous' ? 'active' : ''}" data-tool="deciduous" title="Paint deciduous trees — bare in winter, full leaf in summer (D)" style="color:#6abf69">
                &#9650; Deciduous
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

          <!-- Derived Horizon Profile card (collapsible) -->
          <div class="card" style="margin-top:12px;padding:0;overflow:hidden">
            <div class="collapse-head" data-collapse="horizon" style="display:flex;justify-content:space-between;align-items:center;padding:12px;cursor:pointer;user-select:none">
              <h2 style="margin:0">Derived Horizon Profile</h2>
              <span class="collapse-caret" style="color:var(--text3);font-size:12px">${_horizonCollapsed ? '&#9656;' : '&#9662;'}</span>
            </div>
            <div class="collapse-body" data-body="horizon" style="padding:0 12px 12px;${_horizonCollapsed ? 'display:none' : ''}">
              <canvas id="c-horizon-mini" width="600" height="120" style="width:100%"></canvas>
              <p class="hint" style="margin-top:4px">
                Blue line = obstruction elevation derived from mask.
              </p>
              <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px">
                  <div>
                    <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px">
                      <span style="color:var(--text2)">SVF (diffuse open)</span>
                      <strong id="svf-open" style="font-family:'JetBrains Mono',monospace;color:var(--gain)">--</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between;gap:8px">
                      <span style="color:var(--text2)">Diffuse loss</span>
                      <strong id="svf-loss" style="font-family:'JetBrains Mono',monospace;color:var(--loss)">--</strong>
                    </div>
                  </div>
                  <button class="btn btn-sm" id="btn-download-hor" title="Export horizon profile as CSV">Download HOR</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Panel Shade Simulator card (collapsible) -->
          <div class="card" style="margin-top:12px;padding:0;overflow:hidden">
            <div class="collapse-head" data-collapse="sim" style="display:flex;justify-content:space-between;align-items:center;padding:12px;cursor:pointer;user-select:none">
              <h2 style="margin:0">Panel Shade Simulator</h2>
              <span class="collapse-caret" style="color:var(--text3);font-size:12px">${_simCollapsed ? '&#9656;' : '&#9662;'}</span>
            </div>
            <div class="collapse-body" data-body="sim" style="padding:0 12px 12px;${_simCollapsed ? 'display:none' : ''}">
              <p class="hint" style="margin-top:0;margin-bottom:8px">
                Beam shade cast by all painted masks across the whole array at the chosen date &amp; time.
                Use it to spot-check your masks against a real photo taken at a known moment.
              </p>
              <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px">
                <label style="font-size:11px;color:var(--text2);display:flex;flex-direction:column;gap:2px">
                  Date
                  <input type="date" id="sim-date" style="background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 6px;font-size:12px">
                </label>
                <div style="flex:1;min-width:180px">
                  <label style="font-size:11px;color:var(--text2);display:flex;justify-content:space-between">
                    <span>Time of day</span>
                    <strong id="sim-time-lbl" style="font-family:'JetBrains Mono',monospace;color:var(--sun)">--:--</strong>
                  </label>
                  <input type="range" id="sim-time" min="0" max="24" step="0.083333" value="${_simTime}" style="width:100%">
                </div>
              </div>
              <div id="sim-sun-readout" style="font-size:11px;color:var(--sun);font-family:'JetBrains Mono',monospace;margin-bottom:6px">&#9788; Sun: --</div>
              <canvas id="sim-panel-map" style="width:100%;border-radius:4px"></canvas>
              <div class="hint" style="margin-top:6px;font-size:9px;display:flex;align-items:center;gap:6px">
                <span>0</span>
                <span style="flex:1;height:8px;border-radius:2px;background:linear-gradient(90deg,rgb(30,36,50),rgb(140,60,50),rgb(224,138,46),rgb(255,214,74))"></span>
                <span>full sun</span>
                <span style="margin-left:4px;color:var(--text2)">W/m&sup2; plane-of-array</span>
              </div>
              <p class="hint" style="margin-top:6px;font-size:9px">
                Each cell = clear-sky POA irradiance reaching that sub-panel now, after distance-weighted
                shade from the nearest painted masks (points inside a sub-panel are used directly; otherwise
                inverse-distance interpolation). This is irradiance, not power &mdash; a partly-shaded string
                loses more than its lit fraction due to cell mismatch (future refinement).
              </p>
            </div>
          </div>
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
  renderSimulator();
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
  const currentFov = resolveFisheyeFov(photo, sys);
  const rawFov = fe.fov != null ? fe.fov.toFixed(1) : '—';

  // Build reference rows info
  const accelTilt = fe.accelTilt != null ? fe.accelTilt.toFixed(1) + '°' : '—';
  const accelClk = fe.accelClockAngle != null ? fe.accelClockAngle.toFixed(1) + '°' : '—';
  const hasGyro = fe.gyro && (fe.gyro.gx !== 0 || fe.gyro.gy !== 0 || fe.gyro.gz !== 0);
  const gyroTag = hasGyro ? ' <span title="Gyroscope data available" style="color:var(--gain)">&#8982;</span>' : '';
  const rotTag = fe.rotationMatrix ? ' <span title="Rotation matrix (Field 60)" style="color:var(--gain)">&#9724;</span>' : '';

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
        <tr><th style="text-align:left;padding:2px 4px"></th><th style="padding:2px 4px">Setup</th><th style="padding:2px 4px">Accel${gyroTag}${rotTag}</th><th style="padding:2px 4px">Slider</th></tr>
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
      <div style="margin-top:6px;padding:6px 8px;background:var(--surface2);border-radius:var(--radius-sm);display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:10px;color:var(--text2)">\u2316 Sun Position Error</span>
        <span id="sun-error-value" style="font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600;color:var(--text3)">\u2014</span>
      </div>
      ${sunInfo}
    </div>
  `;
}

function buildEquirectOrientationUI(photo) {
  const heading = photo.metadata?.compassHeading;
  const source = photo.metadata?.headingSource;

  // Heading from photo metadata (EXIF/auto) — trusted, shown read-only.
  if (heading != null && source !== 'manual') {
    return `
      <div class="card" style="padding:12px">
        <div style="font-size:11px;color:var(--gain)">
          &#9737; Heading: ${heading.toFixed(1)}° (${source?.split('(')[0] || 'auto'})
        </div>
      </div>
    `;
  }

  // No metadata heading, or a user-entered manual value — keep it editable so
  // it can be corrected. The value is persisted to state on change and used by
  // the production engine.
  const val = heading != null ? heading.toFixed(1) : '180';
  const note = source === 'manual'
    ? '&#9737; Manual heading (used in analysis). 180 = South.'
    : '&#9888; No heading in metadata. Enter manually (180=South).';
  const noteColor = source === 'manual' ? 'var(--gain)' : 'var(--warning)';
  return `
    <div class="card" style="padding:12px">
      <label style="font-size:10px;color:var(--text2);display:block;margin-bottom:3px">Compass Heading (°)</label>
      <input type="number" id="inp-manual-heading" value="${val}" min="0" max="360" step="0.5"
        style="width:100%;background:var(--surface2);color:var(--warning);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 8px;font-family:'JetBrains Mono',monospace;font-size:12px">
      <span class="hint" style="color:${noteColor}">${note}</span>
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
  // Every panel/sub-panel that USES one of this photo's points (junction points
  // are used by all adjacent panels, not just their owner).
  const coverage = getCoverageForPoints([...currentPtIds]);

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
      const hasCurrent = coverage.panelKeys.has(`${r},${c}`);
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
// Panel Shade Simulator
// ============================================================

/** Default the date/time picker from the current photo's capture time, once. */
function initSimDefaults() {
  if (_simDate) return;
  const photo = getState().photos[_photoId];
  let dt = null;
  if (photo?.metadata?.datetime) {
    const d = new Date(photo.metadata.datetime);
    if (!isNaN(d.getTime())) dt = d;
  }
  if (!dt) dt = new Date();
  const y = dt.getFullYear();
  const mo = String(dt.getMonth() + 1).padStart(2, '0');
  const da = String(dt.getDate()).padStart(2, '0');
  _simDate = `${y}-${mo}-${da}`;
  _simTime = dt.getHours() + dt.getMinutes() / 60;
}

/** Prepare DOM, bind controls, ensure lookups, and draw the simulator. */
function renderSimulator() {
  initSimDefaults();
  const dateInp = qs('#sim-date', _container);
  const timeInp = qs('#sim-time', _container);
  if (dateInp) dateInp.value = _simDate;
  if (timeInp) timeInp.value = _simTime;
  updateSimTimeLabel();
  // Reuse cached point data across photo switches; only build if missing/stale.
  if (!_simPoints || _simDataScn !== getState().activeScenario) {
    ensureSimData().then(drawSimMap);
  } else {
    drawSimMap();
  }
}

/**
 * (Re)build the per-measurement-point shade data for the whole array (async).
 *
 * For every point that has a painted mask (in the active scenario) we cache:
 *   - loc: physical position in metres (for distance weighting)
 *   - catFn: (az,el) => 0|1|2 obstruction category at that point
 *   - svfOpen / svfDecid: that point's diffuse sky-view-factor components
 * The expensive hemispheric SVF integral is done ONCE here; the per-instant
 * beam test (catFn at the sun direction) is cheap and runs at draw time.
 */
async function ensureSimData() {
  const state = getState();
  const scn = state.activeScenario;
  const tilt = state.system.tilt;
  const subs = getSubPanels();

  const points = [];
  for (const pt of Object.values(state.points)) {
    const photo = state.photos[pt.photoId];
    if (!photo) continue;
    const tr = photo.traces[scn] || photo.traces['As-Is'];
    if (!tr?.groundMask) continue;
    const catFn = await buildMergedCategoryLookupForPoints([pt.id], scn);
    // Panel facing for this point: per-photo calibration if present, else system.
    const panelAz = photo.orientation?.panelAzimuth ?? state.system.azimuth;
    const svf = computeDiffuseSVFComponents(catFn, tilt, panelAz);
    points.push({ id: pt.id, loc: pointMeters(pt), catFn, svfOpen: svf.open, svfDecid: svf.decid });
  }

  _simPoints = points;
  _simSubs = subs;
  _simDataScn = scn;
}

/** Debounced rebuild so mask edits flow into the simulator without thrashing. */
const scheduleSimRefresh = debounce(() => {
  ensureSimData().then(drawSimMap);
}, 400);

/** Sun position for the picked date/time, or null if unavailable/below horizon-safe. */
function computeSimSun() {
  const state = getState();
  const { lat, lon } = state.location;
  if (lat == null || lon == null || !_simDate) return null;
  const [y, mo, d] = _simDate.split('-').map(Number);
  const total = Math.round(_simTime * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  const dt = new Date(y, (mo || 1) - 1, d || 1, hh, mm, 0);
  return sunPositionAtTime(dt, lat, lon);
}

function simMonthIndex() {
  if (!_simDate) return new Date().getMonth();
  const mo = Number(_simDate.split('-')[1]);
  return Math.max(0, Math.min(11, (mo || 1) - 1));
}

function updateSimTimeLabel() {
  const lbl = qs('#sim-time-lbl', _container);
  if (!lbl) return;
  // Round to whole minutes and carry 60→0 so a value like 18.9999 reads 19:00.
  const total = Math.round(_simTime * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  lbl.textContent = `${String(hh % 24).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function updateSimReadout(sun, poaFull) {
  const out = qs('#sim-sun-readout', _container);
  if (!out) return;
  const state = getState();
  if (state.location.lat == null || state.location.lon == null) {
    out.innerHTML = '&#9888; Set project latitude/longitude to simulate sun position.';
    out.style.color = 'var(--text3)';
    return;
  }
  if (!sun || sun.elevation <= 0) {
    out.innerHTML = '&#127769; Sun below horizon (night)';
    out.style.color = 'var(--text3)';
    return;
  }
  const full = poaFull && poaFull.total > 1
    ? ` &nbsp;&middot;&nbsp; Full POA &asymp; ${Math.round(poaFull.total)} W/m&sup2;` : '';
  out.innerHTML = `&#9788; Sun: Az ${sun.azimuth.toFixed(1)}&deg; &nbsp; El ${sun.elevation.toFixed(1)}&deg;${full}`;
  out.style.color = 'var(--sun)';
}

/**
 * Distance-weighted shade for one sub-panel from the cached point data.
 *
 * Tiered rule (matches the physical intuition):
 *   1. If measurement points fall INSIDE this sub-panel, average only those
 *      (exact local data — no interpolation, no blending with distant points).
 *   2. Otherwise inverse-distance-squared weight ALL masked points, so the
 *      nearest dominate and far competing data fades out — without averaging
 *      away accurate nearby information.
 * Returns null when no mask data exists anywhere.
 */
function interpolateSubShade(sp, sun, tauBeam) {
  if (!_simPoints || _simPoints.length === 0) return null;

  const beamClearOf = (p) => {
    const c = p.catFn(sun.azimuth, sun.elevation);
    return c === MASK_SOLID ? 0 : c === MASK_DECIDUOUS ? tauBeam : 1;
  };

  const insideSet = new Set(sp.insideIds || []);
  const inside = _simPoints.filter((p) => insideSet.has(p.id));
  const pool = inside.length ? inside : _simPoints;
  const equalWeight = inside.length > 0;

  let wSum = 0, beam = 0, so = 0, sd = 0;
  for (const p of pool) {
    let w;
    if (equalWeight) {
      w = 1;
    } else {
      const dx = p.loc.x - sp.mX, dy = p.loc.y - sp.mY;
      w = 1 / (dx * dx + dy * dy + 1e-6); // 1/d² — near-zero distance dominates
    }
    wSum += w;
    beam += w * beamClearOf(p);
    so += w * p.svfOpen;
    sd += w * p.svfDecid;
  }
  if (wSum <= 0) return null;
  return { beamClear: beam / wSum, svfOpen: so / wSum, svfDecid: sd / wSum, exact: equalWeight };
}

/** Colour ramp: 0 (deep shade) → red → orange → gold (full irradiance). */
function poaColor(frac) {
  const f = Math.max(0, Math.min(1, frac));
  const stops = [
    [0.0, [30, 36, 50]],
    [0.35, [140, 60, 50]],
    [0.7, [224, 138, 46]],
    [1.0, [255, 214, 74]],
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (f >= stops[i][0] && f <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const t = b[0] > a[0] ? (f - a[0]) / (b[0] - a[0]) : 0;
  const ch = (k) => Math.round(a[1][k] + (b[1][k] - a[1][k]) * t);
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
}

/** Draw the whole-array plane-of-array irradiance map at the simulated instant. */
function drawSimMap() {
  const canvas = qs('#sim-panel-map', _container);
  if (!canvas) return;
  const state = getState();
  const { rows, cols, diodeSplit, panelWidth, panelHeight, panelGap = 0, diodeSubsections } = state.system;
  const nSubs = diodeSubsections || 2;
  if (!rows || !cols) return;

  const sun = computeSimSun();
  const night = !sun || sun.elevation <= 0;

  // Clear-sky plane-of-array irradiance (unshaded) at this instant — the
  // "full sun" reference each sub-panel is scaled down from.
  const lat = state.location.lat ?? 45;
  const tilt = state.system.tilt || 0;
  const sysAz = state.system.azimuth ?? 180;
  const tauMonth = deciduousTransmittanceByMonth(state.system, lat);
  const tauBeam = tauMonth.beam[simMonthIndex()];
  const tauDiffuse = tauMonth.diffuse[simMonthIndex()];

  let poaFull = null;
  if (!night) {
    const dni = clearSkyDNI(sun.elevation);
    const dhi = clearSkyDHI(sun.elevation, dni);
    const ghi = clearSkyGHI(sun.elevation, dni, dhi);
    poaFull = poaIrradiance(dni, dhi, ghi, sun.elevation, sun.azimuth, tilt, sysAz);
  }
  updateSimReadout(sun, poaFull);
  const refPOA = poaFull && poaFull.total > 1 ? poaFull.total : 1000;

  // Layout (mirrors report drawArrayMap for familiarity).
  const dpr = window.devicePixelRatio || 1;
  const wrapW = canvas.clientWidth || 300;
  const PAD = 10;
  const aspect = (panelHeight || 1) / (panelWidth || 1);
  const gapFrac = panelWidth > 0 ? panelGap / panelWidth : 0.02;
  let pW = (wrapW - 2 * PAD) / (cols + (cols - 1) * gapFrac);
  let pH = pW * aspect;
  let gap = pW * gapFrac;
  const maxH = 300;
  let gridH = rows * pH + (rows - 1) * gap;
  if (gridH > maxH) { const sc = maxH / gridH; pW *= sc; pH *= sc; gap *= sc; }
  const totalW = cols * pW + (cols - 1) * gap;
  const totalH = rows * pH + (rows - 1) * gap;
  const ox = (wrapW - totalW) / 2;
  const oy = PAD;
  const canvasH = totalH + 2 * PAD;

  canvas.width = Math.round(wrapW * dpr);
  canvas.height = Math.round(canvasH * dpr);
  canvas.style.height = canvasH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, wrapW, canvasH);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = ox + c * (pW + gap);
      const py = oy + r * (pH + gap);
      const panelIdx = r * cols + c;

      for (let s = 0; s < nSubs; s++) {
        const idx = panelIdx * nSubs + s;
        const sp = _simSubs ? _simSubs[idx] : null;

        let color = '#2a2f38', label = '', frac = 0;
        if (night) {
          color = '#1a2332';
        } else {
          const sh = sp ? interpolateSubShade(sp, sun, tauBeam) : null;
          if (!sh) {
            color = '#2a2f38';                    // no mask data anywhere
          } else {
            const svfEff = sh.svfOpen + sh.svfDecid * tauDiffuse;
            const poaSub = sh.beamClear * poaFull.beam + svfEff * poaFull.diffuse + poaFull.ground;
            frac = refPOA > 0 ? poaSub / refPOA : 0;
            color = poaColor(frac);
            label = `${Math.round(poaSub)}`;
          }
        }

        let sx, sy, sw, sh2;
        if (diodeSplit === 'vertical') { sw = pW / nSubs; sh2 = pH; sx = px + s * sw; sy = py; }
        else { sw = pW; sh2 = pH / nSubs; sx = px; sy = py + s * sh2; }

        ctx.fillStyle = color;
        ctx.fillRect(sx, sy, sw - 0.5, sh2 - 0.5);

        if (label && sw > 26 && sh2 > 12) {
          ctx.fillStyle = frac > 0.45 ? 'rgba(0,0,0,0.72)' : 'rgba(255,255,255,0.85)';
          ctx.font = 'bold 8px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, sx + sw / 2, sy + sh2 / 2);
        }
      }

      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px, py, pW, pH);
      if (pW > 20 && pH > 12) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`${String.fromCharCode(65 + r)}${c + 1}`, px + 2, py + 2);
      }
    }
  }
}

/** Draw an X on the photo canvas at the simulator's sun position. */
function drawSimSunMarker(W, H) {
  if (_simCollapsed || !_ctx) return;
  const sun = computeSimSun();
  if (!sun || sun.elevation <= 0) return;
  const c = skyToCanvas(sun.azimuth, sun.elevation);
  if (!c || c.visible === false) return;
  if (c.x < 0 || c.x > W || c.y < 0 || c.y > H) return;

  const s = 9;
  _ctx.save();
  // Soft halo for visibility over any background.
  _ctx.beginPath();
  _ctx.arc(c.x, c.y, s + 5, 0, Math.PI * 2);
  _ctx.fillStyle = 'rgba(255, 210, 60, 0.18)';
  _ctx.fill();
  // Dark contrast outline, then the gold X.
  _ctx.lineCap = 'round';
  _ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  _ctx.lineWidth = 4.5;
  _ctx.beginPath();
  _ctx.moveTo(c.x - s, c.y - s); _ctx.lineTo(c.x + s, c.y + s);
  _ctx.moveTo(c.x + s, c.y - s); _ctx.lineTo(c.x - s, c.y + s);
  _ctx.stroke();
  _ctx.strokeStyle = '#ffd23c';
  _ctx.lineWidth = 2.5;
  _ctx.beginPath();
  _ctx.moveTo(c.x - s, c.y - s); _ctx.lineTo(c.x + s, c.y + s);
  _ctx.moveTo(c.x + s, c.y - s); _ctx.lineTo(c.x - s, c.y + s);
  _ctx.stroke();
  // Label.
  _ctx.fillStyle = '#ffd23c';
  _ctx.font = 'bold 9px "JetBrains Mono", monospace';
  _ctx.textAlign = 'center';
  _ctx.lineWidth = 3;
  _ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  _ctx.strokeText('sim sun', c.x, c.y - s - 6);
  _ctx.fillText('sim sun', c.x, c.y - s - 6);
  _ctx.restore();
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
    _fov = resolveFisheyeFov(photo, sys);
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
    // Init sun disc if switching photos
    if (_isFisheye) { _sunDisc = null; initSunDisc(); }
    // redraw() will be called by the caller
  } else {
    _img = new Image();
    _img.onload = () => {
      _imgCache.set(photo.id, _img);
      if (_isFisheye) { _sunDisc = null; initSunDisc(); }
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
    // Derive the horizon profile immediately so the mini-chart + SVF reflect the
    // loaded mask without waiting for the first edit.
    refreshHorizonFromCanvas();
    redraw();
  };
  img.src = trace.groundMask;
}

/**
 * Derive the 1D horizon profile from whatever is currently on the mask canvas
 * (including fisheye corner prefill) and update the trace + mini-chart.
 */
function refreshHorizonFromCanvas() {
  const photo = getState().photos[_photoId];
  const trace = photo?.traces[_traceName];
  if (!trace || !_maskCtx || !_maskCanvas) return;
  const sys = getState().system;
  const maskData = _maskCtx.getImageData(0, 0, _maskCanvas.width, _maskCanvas.height);
  const lookup = buildSkyMaskLookup(photo, maskData, {
    azimuth: sys.azimuth, tilt: sys.tilt, cameraFovCalibration: sys.cameraFovCalibration,
  });
  trace.horizonProfile = maskLookupToHorizon(lookup);
  updateHorizonMini();
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
  // Flow the edit into the whole-array shade simulator.
  scheduleSimRefresh();
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
    const lookup = buildSkyMaskLookup(photo, maskData, { azimuth: sys.azimuth, tilt: sys.tilt, cameraFovCalibration: sys.cameraFovCalibration });
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
  _fov = resolveFisheyeFov(photo, getState().system);
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

/**
 * Get image pixel luminance data from the visible canvas.
 * Renders the image alone onto a temp canvas and returns ImageData.
 */
function getImagePixels() {
  if (!_img || !_img.complete || !_img.naturalWidth) return null;
  const W = _canvas.width, H = _canvas.height;
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const tctx = tmp.getContext('2d');
  if (_isFisheye) {
    tctx.drawImage(_img, 0, 0, W, H);
  } else {
    drawEquirectTopHalf(tctx, _img, W, H, getHeading());
  }
  try {
    return tctx.getImageData(0, 0, W, H);
  } catch (e) {
    console.warn('[SolarScope] getImageData failed (CORS?):', e.message);
    return null;
  }
}

/**
 * Find the brightest region in the image for initial sun disc placement.
 * Uses a coarse grid scan with a box blur kernel, then refines.
 */
function findBrightestRegion(imgData, W, H, searchRadius) {
  const d = imgData.data;
  const step = Math.max(2, Math.floor(searchRadius / 3));
  let bestX = W / 2, bestY = H / 2, bestVal = -1;
  const cx = W / 2, cy = H / 2, maxR = W / 2;

  for (let y = searchRadius; y < H - searchRadius; y += step) {
    for (let x = searchRadius; x < W - searchRadius; x += step) {
      // For fisheye, skip outside the circle
      if (_isFisheye) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > maxR * maxR) continue;
      }
      // Average luminance in a small box
      let sum = 0, count = 0;
      const hs = Math.floor(searchRadius / 2);
      for (let dy = -hs; dy <= hs; dy += 2) {
        for (let dx = -hs; dx <= hs; dx += 2) {
          const idx = ((y + dy) * W + (x + dx)) * 4;
          sum += d[idx] * 0.299 + d[idx + 1] * 0.587 + d[idx + 2] * 0.114;
          count++;
        }
      }
      const avg = sum / count;
      if (avg > bestVal) { bestVal = avg; bestX = x; bestY = y; }
    }
  }
  return { x: bestX, y: bestY };
}

/**
 * Gradient-descent-like search to find the brightest point within a disc.
 * Uses luminance with Gaussian weighting toward center.
 */
function findSunCenter(imgData, W, discCx, discCy, discR) {
  const d = imgData.data;
  const H = imgData.height;
  const r = Math.max(5, Math.floor(discR));

  // First: find the peak pixel in the disc
  let bestX = discCx, bestY = discCy, bestLum = -1;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const px = Math.round(discCx + dx), py = Math.round(discCy + dy);
      if (px < 0 || px >= W || py < 0 || py >= H) continue;
      const idx = (py * W + px) * 4;
      const lum = d[idx] * 0.299 + d[idx + 1] * 0.587 + d[idx + 2] * 0.114;
      if (lum > bestLum) { bestLum = lum; bestX = px; bestY = py; }
    }
  }

  // Refine: weighted centroid of pixels within 90% of peak luminance
  const threshold = bestLum * 0.90;
  let wx = 0, wy = 0, wt = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const px = Math.round(discCx + dx), py = Math.round(discCy + dy);
      if (px < 0 || px >= W || py < 0 || py >= H) continue;
      const idx = (py * W + px) * 4;
      const lum = d[idx] * 0.299 + d[idx + 1] * 0.587 + d[idx + 2] * 0.114;
      if (lum >= threshold) {
        const w = lum * lum;  // weight brighter pixels more
        wx += px * w; wy += py * w; wt += w;
      }
    }
  }
  if (wt > 0) { bestX = wx / wt; bestY = wy / wt; }
  return { x: bestX, y: bestY };
}

/**
 * Initialize the sun disc from the brightest region, or recalc found position.
 */
function initSunDisc() {
  const imgData = getImagePixels();
  if (!imgData) { console.warn('[SolarScope] initSunDisc: no image pixels'); return; }
  const W = _canvas.width, H = _canvas.height;
  const defaultR = Math.round(W * 0.06);  // ~48px on 800px canvas

  if (!_sunDisc) {
    const bright = findBrightestRegion(imgData, W, H, defaultR);
    _sunDisc = { cx: bright.x, cy: bright.y, r: defaultR, foundX: 0, foundY: 0 };
    console.log('[SolarScope] Sun disc initialized at', bright.x.toFixed(0), bright.y.toFixed(0));
  }
  const found = findSunCenter(imgData, W, _sunDisc.cx, _sunDisc.cy, _sunDisc.r);
  _sunDisc.foundX = found.x;
  _sunDisc.foundY = found.y;
}

/**
 * Recompute found sun center (after drag/resize) without reinitializing disc position.
 */
function updateSunFound() {
  const imgData = getImagePixels();
  if (!imgData || !_sunDisc) return;
  const found = findSunCenter(imgData, _canvas.width, _sunDisc.cx, _sunDisc.cy, _sunDisc.r);
  _sunDisc.foundX = found.x;
  _sunDisc.foundY = found.y;
}

/**
 * Compute angular error between the found sun pixel and the computed sun position.
 * Returns degrees, or null if either is unavailable.
 */
function computeSunError() {
  if (!_sunDisc || !_isFisheye) return null;
  const photo = getState().photos[_photoId];
  if (!photo?.metadata?.datetime) return null;
  const state = getState();
  if (state.location.lat == null) return null;

  const sp = sunPositionAtTime(photo.metadata.datetime, state.location.lat, state.location.lon);
  if (!sp || sp.elevation <= 0) return null;

  // Found sun → sky coords
  const foundSky = canvasToSky(_sunDisc.foundX, _sunDisc.foundY);
  if (!foundSky || foundSky.valid === false) return null;

  // Angular distance using spherical law of cosines
  const D = Math.PI / 180;
  const el1 = sp.elevation * D, az1 = sp.azimuth * D;
  const el2 = foundSky.elevation * D, az2 = foundSky.azimuth * D;
  const cosD = Math.sin(el1) * Math.sin(el2) + Math.cos(el1) * Math.cos(el2) * Math.cos(az1 - az2);
  return Math.acos(Math.max(-1, Math.min(1, cosD))) / D;
}

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
      // Upper hemisphere only, rolled so SOUTH (heading) is centred.
      drawEquirectTopHalf(_ctx, _img, W, H, getHeading());
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

  // Simulated-sun marker — where the Panel Shade Simulator places the sun for
  // the chosen date/time (independent of the sun-path overlay toggle).
  drawSimSunMarker(W, H);

  // Brush cursor
  if (_lastPaintPos) {
    _ctx.save();
    _ctx.strokeStyle = _brushTool === 'ground' ? 'rgba(230,80,80,0.7)'
      : _brushTool === 'deciduous' ? 'rgba(80,200,80,0.8)'
      : 'rgba(80,180,230,0.7)';
    _ctx.lineWidth = 1.5;
    _ctx.beginPath();
    _ctx.arc(_lastPaintPos.x, _lastPaintPos.y, _brushSize / 2, 0, Math.PI * 2);
    _ctx.stroke();
    _ctx.restore();
  }

  // Sun finder disc overlay
  if (_sunDisc && _isFisheye) {
    _ctx.save();
    const hover = _hoveringSun || _draggingSun;
    // Semi-transparent yellow disc
    _ctx.beginPath();
    _ctx.arc(_sunDisc.cx, _sunDisc.cy, _sunDisc.r, 0, Math.PI * 2);
    _ctx.fillStyle = hover ? 'rgba(255, 240, 120, 0.25)' : 'rgba(255, 240, 120, 0.12)';
    _ctx.fill();
    _ctx.strokeStyle = hover ? 'rgba(255, 220, 60, 0.9)' : 'rgba(255, 220, 60, 0.4)';
    _ctx.lineWidth = hover ? 2 : 1.5;
    _ctx.setLineDash(hover ? [] : [4, 4]);
    _ctx.stroke();
    _ctx.setLineDash([]);

    // X marker at found sun center
    const fx = _sunDisc.foundX, fy = _sunDisc.foundY;
    const xSize = 6;
    _ctx.strokeStyle = '#ff3333';
    _ctx.lineWidth = 2;
    _ctx.beginPath();
    _ctx.moveTo(fx - xSize, fy - xSize); _ctx.lineTo(fx + xSize, fy + xSize);
    _ctx.moveTo(fx + xSize, fy - xSize); _ctx.lineTo(fx - xSize, fy + xSize);
    _ctx.stroke();

    // Small label
    _ctx.fillStyle = hover ? 'rgba(255, 220, 60, 1)' : 'rgba(255, 220, 60, 0.7)';
    _ctx.font = '9px "JetBrains Mono", monospace';
    _ctx.textAlign = 'center';
    _ctx.fillText(hover ? 'drag to move \u00b7 scroll to resize' : 'sun', _sunDisc.cx, _sunDisc.cy - _sunDisc.r - 4);
    _ctx.restore();
  }

  // Update sun error display in sidebar
  updateSunErrorDisplay();

  updateHorizonMini();
  scheduleSvfUpdate();
}

function computeCurrentSVF() {
  if (!_maskCtx || !_maskCanvas) return null;
  const photo = getState().photos[_photoId];
  if (!photo) return null;

  const maskData = _maskCtx.getImageData(0, 0, _maskCanvas.width, _maskCanvas.height);
  const sys = getState().system;
  const lookup = buildSkyMaskLookup(photo, maskData, { azimuth: sys.azimuth, tilt: sys.tilt, cameraFovCalibration: sys.cameraFovCalibration });

  // Panel-normal-weighted diffuse SVF, identical to the production engine.
  // (Insta360 photos are captured with image zenith == panel normal.)
  // Tilt is trusted from the system config; the facing azimuth uses this
  // photo's orientation calibration when available.
  const svfAz = photo.orientation?.panelAzimuth ?? sys.azimuth;
  const svf = computeDiffuseSVF(lookup, sys.tilt, svfAz, {
    azStep: SVF_AZ_STEP,
    elStep: SVF_EL_STEP,
  });

  return {
    svf,
    diffuseLoss: 1 - svf,
  };
}

function updateSVFReadout() {
  const openEl = qs('#svf-open', _container);
  const lossEl = qs('#svf-loss', _container);
  if (!openEl || !lossEl) return;

  const stats = computeCurrentSVF();
  if (!stats) {
    openEl.textContent = '--';
    lossEl.textContent = '--';
    return;
  }

  openEl.textContent = `${(stats.svf * 100).toFixed(1)}%`;
  lossEl.textContent = `${(stats.diffuseLoss * 100).toFixed(1)}%`;
}

const scheduleSvfUpdate = debounce(updateSVFReadout, 160);

/**
 * Export horizon profile as HOR (CSV with Azimuth, Obstruction Elevation).
 */
function exportHorizonProfile() {
  const state = getState();
  const photo = state.photos[_photoId];
  if (!photo || !_traceName) return;

  const trace = photo.traces[_traceName];
  if (!trace || !trace.horizonProfile) {
    alert('No horizon profile available for this scenario.');
    return;
  }

  const profile = trace.horizonProfile;
  const profileEl = (az) => {
    if (Array.isArray(profile) || ArrayBuffer.isView(profile)) {
      return Number(profile[az] || 0);
    }
    return Number(profile[az] ?? profile[String(az)] ?? 0);
  };
  let csv = 'Azimuth (deg),Obstruction Elevation (deg)\n';
  
  for (let az = 0; az < 360; az++) {
    const el = profileEl(az);
    csv += `${az},${el.toFixed(1)}\n`;
  }

  const photoName = photo.filename.replace(/\.[^.]+$/, '');
  const traceName = _traceName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const filename = `${state.projectName || 'shade'}_horizon_${photoName}_${traceName}.csv`;
  
  downloadText(filename, csv);
}

/**
 * Trigger a browser download of text data.
 */
function downloadText(filename, text, mime = 'text/csv') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Update the sun error readout in the sidebar.
 */
function updateSunErrorDisplay() {
  const el = qs('#sun-error-value', _container);
  if (!el) return;
  const err = computeSunError();
  if (err != null) {
    el.textContent = err.toFixed(1) + '°';
    el.style.color = err < 3 ? 'var(--gain)' : err < 8 ? 'var(--sun)' : 'var(--loss)';
  } else {
    el.textContent = '—';
    el.style.color = 'var(--text3)';
  }
}

function drawGrid(W, H) {
  _ctx.save();
  _ctx.font = '10px "JetBrains Mono", monospace';

  if (_isFisheye) {
    // Elevation rings (include 0° horizon)
    for (let el = 0; el <= 80; el += 10) {
      const isHorizon = el === 0;
      _ctx.beginPath();
      _ctx.strokeStyle = isHorizon ? 'rgba(255,200,0,0.6)' : 'rgba(255,255,255,0.5)';
      _ctx.lineWidth = isHorizon ? 2.5 : 1;
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
        _ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        _ctx.lineWidth = 1;
        _ctx.stroke();
      }
      const label = cardinals[az] || `${az}°`;
      const lp = skyToCanvas(az, 2);
      if (lp.visible) {
        _ctx.fillStyle = cardinals[az] ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.55)';
        _ctx.textAlign = 'center';
        _ctx.fillText(label, lp.x, lp.y + 12);
      }
    }
  } else {
    // Equirectangular grid (same as original)
    const heading = getHeading();
    _ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    _ctx.lineWidth = 1;

    // Elevation lines
    for (let elev = 0; elev <= 90; elev += 10) {
      const cp = skyToCanvas(heading, elev);
      if (cp.y < 0 || cp.y > H) continue;
      _ctx.beginPath();
      _ctx.moveTo(0, cp.y);
      _ctx.lineTo(W, cp.y);
      _ctx.stroke();
      _ctx.fillStyle = 'rgba(255,255,255,0.6)';
      _ctx.textAlign = 'left';
      _ctx.fillText(`${elev}°`, 4, cp.y - 2);
    }

    // Horizon emphasis
    const hp = skyToCanvas(heading, 0);
    if (hp.y >= 0 && hp.y <= H) {
      _ctx.beginPath();
      _ctx.moveTo(0, hp.y);
      _ctx.lineTo(W, hp.y);
      _ctx.strokeStyle = 'rgba(255,200,0,0.6)';
      _ctx.lineWidth = 2.5;
      _ctx.stroke();
      _ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      _ctx.lineWidth = 1;
    }

    // Azimuth lines
    const cardinals = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let az = 0; az < 360; az += 30) {
      const cp = skyToCanvas(az, 45);
      if (cp.x < 0 || cp.x > W) continue;
      _ctx.beginPath();
      _ctx.moveTo(cp.x, 0);
      _ctx.lineTo(cp.x, H);
      _ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      _ctx.lineWidth = 1;
      _ctx.stroke();
      const label = cardinals[az] || `${az}°`;
      _ctx.fillStyle = cardinals[az] ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.45)';
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

  const getProfileEl = (az) => {
    if (Array.isArray(profile) || ArrayBuffer.isView(profile)) {
      return Number(profile[az] || 0);
    }
    return Number(profile[az] ?? profile[String(az)] ?? 0);
  };

  let maxEl = 1;
  for (let az = 0; az < 360; az++) {
    maxEl = Math.max(maxEl, getProfileEl(az));
  }
  mc.fillStyle = '#3b82f618';
  mc.strokeStyle = '#3b82f6';
  mc.lineWidth = 1.5;
  mc.beginPath();
  mc.moveTo(0, H);
  for (let az = 0; az < 360; az++) {
    const x = (az / 360) * W;
    const y = H - (getProfileEl(az) / maxEl) * (H - 10);
    mc.lineTo(x, y);
  }
  mc.lineTo(W, H);
  mc.closePath();
  mc.fill();
  mc.beginPath();
  for (let az = 0; az < 360; az++) {
    const x = (az / 360) * W;
    const y = H - (getProfileEl(az) / maxEl) * (H - 10);
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
  if (_brushTool === 'ground' || _brushTool === 'deciduous') {
    _maskCtx.fillStyle = _brushTool === 'deciduous'
      ? 'rgba(60, 180, 60, 0.85)'   // green = deciduous (seasonal)
      : 'rgba(230, 60, 60, 0.85)';  // red = solid (year-round)
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
  qs('#inp-manual-heading', _container)?.addEventListener('change', (e) => {
    const photo = getState().photos[_photoId];
    if (photo) {
      const v = parseFloat(e.target.value);
      if (!Number.isNaN(v)) {
        if (!photo.metadata) photo.metadata = {};
        photo.metadata.compassHeading = ((v % 360) + 360) % 360;
        photo.metadata.headingSource = 'manual';
      }
    }
    redraw();
  });

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

  // HOR download button
  qs('#btn-download-hor', _container)?.addEventListener('click', () => {
    exportHorizonProfile();
  });

  // Collapsible card headers (Horizon Profile + Panel Shade Simulator)
  for (const head of qsa('.collapse-head', _container)) {
    head.addEventListener('click', () => {
      const key = head.dataset.collapse;
      const collapsed = key === 'horizon' ? (_horizonCollapsed = !_horizonCollapsed)
        : (_simCollapsed = !_simCollapsed);
      const body = qs(`.collapse-body[data-body="${key}"]`, _container);
      if (body) body.style.display = collapsed ? 'none' : '';
      const caret = head.querySelector('.collapse-caret');
      if (caret) caret.innerHTML = collapsed ? '&#9656;' : '&#9662;';
      // Canvases sized to clientWidth need a redraw once revealed.
      if (!collapsed) {
        if (key === 'horizon') updateHorizonMini();
        else drawSimMap();
      }
      // Show/hide the simulated-sun marker on the photo canvas.
      if (key === 'sim') redraw();
    });
  }

  // Panel Shade Simulator — date picker + time-of-day slider
  qs('#sim-date', _container)?.addEventListener('change', (e) => {
    if (e.target.value) _simDate = e.target.value;
    drawSimMap();
    redraw();
  });
  qs('#sim-time', _container)?.addEventListener('input', (e) => {
    _simTime = parseFloat(e.target.value);
    updateSimTimeLabel();
    drawSimMap();
    redraw();
  });

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

  /** Is the canvas point inside the sun disc? */
  function isOverSunDisc(cx, cy) {
    if (!_sunDisc || !_isFisheye) return false;
    const dx = cx - _sunDisc.cx, dy = cy - _sunDisc.cy;
    return dx * dx + dy * dy <= _sunDisc.r * _sunDisc.r;
  }

  _canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const { cx, cy } = getPos(e);

    // Check if clicking on sun disc
    if (isOverSunDisc(cx, cy)) {
      _draggingSun = true;
      _sunDragOffset = { dx: _sunDisc.cx - cx, dy: _sunDisc.cy - cy };
      return;
    }

    _isPainting = true;
    paintAt(cx, cy);
    _lastPaintPos = { x: cx, y: cy };
    redraw();
  });

  _canvas.addEventListener('mousemove', (e) => {
    const { cx, cy } = getPos(e);

    if (_draggingSun && _sunDisc) {
      _sunDisc.cx = cx + _sunDragOffset.dx;
      _sunDisc.cy = cy + _sunDragOffset.dy;
      updateSunFound();
      redraw();
      return;
    }

    // Track hover state for visual feedback
    const overSun = isOverSunDisc(cx, cy);
    if (overSun !== _hoveringSun) {
      _hoveringSun = overSun;
      _canvas.style.cursor = overSun ? 'grab' : 'crosshair';
    }

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
      // Redraw to update cursor circle / hover state
      redraw();
    }
  });

  _canvas.addEventListener('mouseup', () => {
    if (_draggingSun) {
      _draggingSun = false;
      _sunDragOffset = null;
      _canvas.style.cursor = _hoveringSun ? 'grab' : 'crosshair';
      return;
    }
    if (_isPainting) {
      _isPainting = false;
      debouncedSave();
    }
  });

  _canvas.addEventListener('mouseleave', () => {
    if (_draggingSun) {
      _draggingSun = false;
      _sunDragOffset = null;
    }
    if (_isPainting) {
      _isPainting = false;
      debouncedSave();
    }
    _hoveringSun = false;
    _canvas.style.cursor = 'crosshair';
    _lastPaintPos = null;
    redraw();
  });

  // Scroll wheel: sun disc resize if hovering over disc, else brush size
  _canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { cx, cy } = getPos(e);

    if (isOverSunDisc(cx, cy)) {
      _sunDisc.r = Math.max(10, Math.min(200, _sunDisc.r + (e.deltaY > 0 ? -4 : 4)));
      updateSunFound();
      redraw();
      return;
    }

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
  } else if (e.key === 'd' || e.key === 'D') {
    _brushTool = 'deciduous';
    qsa('.tool-btn[data-tool]', _container).forEach(b =>
      b.classList.toggle('active', b.dataset.tool === 'deciduous')
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
