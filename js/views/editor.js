/**
 * SolarScope — Shade Editor View
 * Equirectangular photo display with compass-aware tracing overlay.
 * Features: draw obstruction boundaries, multiple trace scenarios,
 * sun path overlay, horizon profile derivation.
 */

import {
  getState, setState, addTrace, updateTracePaths, subscribe
} from '../state.js';
import {
  el, qs, qsa, clearEl, imageToSky, skyToImage, pathsToHorizon,
  drawSkyGrid, debounce
} from '../utils.js';
import { computeAllSunPaths, sunPosition, solarDeclination, MONTHS } from '../solar-engine.js';

let _container = null;
let _photoId = null;       // Currently editing photo
let _traceName = null;     // Currently editing trace
let _canvas = null;
let _ctx = null;
let _img = null;           // Photo HTMLImageElement
let _drawingMode = 'polyline'; // 'polyline' | 'freehand' | 'polygon'
let _currentPath = [];     // Points being drawn [{x, y}] in normalized coords
let _isDrawing = false;
let _showSunPaths = true;
let _showGrid = true;
let _viewUpper = true;     // Show only upper hemisphere

export function render(container) {
  _container = container;
  clearEl(container);

  const state = getState();
  const photos = Object.values(state.photos);

  // Auto-select photo from array view or first available
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

function buildEditorUI() {
  const state = getState();
  const photo = state.photos[_photoId];
  if (!photo) return;

  // Select first trace if none selected
  if (!_traceName || !photo.traces[_traceName]) {
    _traceName = Object.keys(photo.traces)[0] || 'As-Is';
  }

  _container.innerHTML = `
    <div class="fade-in">
      <div class="editor-container">
        <!-- LEFT SIDEBAR -->
        <div class="editor-sidebar">
          <!-- Photo selector -->
          <div class="card" style="padding:12px">
            <h2 style="margin-bottom:8px">Photo</h2>
            <select id="sel-photo" style="width:100%;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 8px;font-size:12px">
              ${Object.values(state.photos).map(p => `
                <option value="${p.id}" ${p.id === _photoId ? 'selected' : ''}>${esc(p.filename)}</option>
              `).join('')}
            </select>
            ${photo.metadata.compassHeading != null ? `
              <div style="margin-top:6px;font-size:11px;color:var(--gain)">
                &#9737; Heading: ${photo.metadata.compassHeading.toFixed(1)}° (${photo.metadata.headingSource?.split('(')[0] || 'auto'})
              </div>
            ` : `
              <div style="margin-top:6px">
                <label style="font-size:10px;color:var(--text2);display:block;margin-bottom:3px">Compass Heading (°)</label>
                <input type="number" id="inp-manual-heading" value="180" min="0" max="360" step="0.5"
                  style="width:100%;background:var(--surface2);color:var(--warning);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 8px;font-family:'JetBrains Mono',monospace;font-size:12px">
                <span class="hint" style="color:var(--warning)">&#9888; No heading in metadata. Enter manually (180=South).</span>
              </div>
            `}
          </div>

          <!-- Trace scenarios -->
          <div class="card" style="padding:12px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <h2 style="margin:0">Traces</h2>
              <button class="btn btn-sm" id="btn-add-trace">+ Add Scenario</button>
            </div>
            <div class="trace-list" id="trace-list"></div>
          </div>

          <!-- Drawing tools -->
          <div class="card" style="padding:12px">
            <h2 style="margin-bottom:8px">Drawing Tools</h2>
            <div style="display:flex;gap:4px;flex-wrap:wrap">
              <button class="tool-btn ${_drawingMode === 'polyline' ? 'active' : ''}" data-mode="polyline" title="Click points to draw the obstruction boundary">
                &#9998; Polyline
              </button>
              <button class="tool-btn ${_drawingMode === 'freehand' ? 'active' : ''}" data-mode="freehand" title="Freehand draw the obstruction boundary">
                &#9999; Freehand
              </button>
            </div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">
              <button class="btn btn-sm" id="btn-undo-path" title="Undo last path">Undo</button>
              <button class="btn btn-sm" id="btn-clear-trace" title="Clear all paths in current trace">Clear</button>
            </div>
            <div style="margin-top:8px;display:flex;flex-direction:column;gap:4px">
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);cursor:pointer">
                <input type="checkbox" id="chk-sun-paths" ${_showSunPaths ? 'checked' : ''} style="accent-color:var(--sun)"> Sun paths
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);cursor:pointer">
                <input type="checkbox" id="chk-grid" ${_showGrid ? 'checked' : ''} style="accent-color:var(--sun)"> Az/El grid
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);cursor:pointer">
                <input type="checkbox" id="chk-upper" ${_viewUpper ? 'checked' : ''} style="accent-color:var(--sun)"> Upper hemisphere only
              </label>
            </div>
          </div>

          <!-- Horizon profile mini-chart -->
          <div class="card" style="padding:12px">
            <h2 style="margin-bottom:8px">Derived Horizon Profile</h2>
            <canvas id="c-horizon-mini" width="260" height="80" style="width:100%"></canvas>
            <p class="hint" style="margin-top:4px">
              Blue line = obstruction elevation at each azimuth. Derived from traced boundary.
            </p>
          </div>
        </div>

        <!-- MAIN CANVAS -->
        <div>
          <div class="editor-canvas-wrap" id="canvas-wrap">
            <canvas id="c-editor" width="1200" height="600"></canvas>
          </div>
          <p class="hint" style="margin-top:6px">
            ${_drawingMode === 'polyline'
              ? 'Click to place points along the obstruction boundary. Double-click or press Enter to finish a path. Press Escape to cancel.'
              : 'Click and drag to draw the obstruction boundary freehand. Release to finish.'}
            The area below the line is treated as shaded. Sun paths shown in yellow (unshaded) and red (blocked).
          </p>
        </div>
      </div>

      <div style="text-align:center;margin-top:12px">
        <button class="btn btn-primary" id="btn-next-report" style="padding:10px 32px;font-size:14px">
          Generate Report →
        </button>
      </div>
    </div>
  `;

  setupCanvas();
  buildTraceList();
  bindEditorEvents();
  redraw();
}

// --- Canvas setup ---

function setupCanvas() {
  _canvas = qs('#c-editor', _container);
  _ctx = _canvas.getContext('2d');

  // Load the photo image
  _img = new Image();
  _img.onload = () => redraw();
  _img.src = getState().photos[_photoId]?.dataUrl || '';
}

function getHeading() {
  const photo = getState().photos[_photoId];
  if (!photo) return 180;
  if (photo.metadata.compassHeading != null) return photo.metadata.compassHeading;
  const inp = qs('#inp-manual-heading', _container);
  return inp ? parseFloat(inp.value) || 180 : 180;
}

function getPitch() {
  return getState().photos[_photoId]?.metadata?.pitch || 0;
}

// --- Coordinate conversion helpers (canvas pixel ↔ normalized ↔ sky) ---

function canvasToNorm(cx, cy) {
  const w = _canvas.width, h = _canvas.height;
  if (_viewUpper) {
    // Upper hemisphere only: canvas shows top half of equirectangular
    return { x: cx / w, y: cy / h * 0.5 };
  }
  return { x: cx / w, y: cy / h };
}

function normToCanvas(nx, ny) {
  const w = _canvas.width, h = _canvas.height;
  if (_viewUpper) {
    return { x: nx * w, y: (ny / 0.5) * h };
  }
  return { x: nx * w, y: ny * h };
}

function canvasToSky(cx, cy) {
  const norm = canvasToNorm(cx, cy);
  return imageToSky(norm.x, norm.y, getHeading(), getPitch());
}

function skyToCanvas(az, el) {
  const norm = skyToImage(az, el, getHeading(), getPitch());
  return normToCanvas(norm.x, norm.y);
}

// --- Drawing / Rendering ---

function redraw() {
  if (!_ctx || !_canvas) return;
  const W = _canvas.width, H = _canvas.height;
  _ctx.clearRect(0, 0, W, H);

  const photo = getState().photos[_photoId];
  if (!photo) return;

  // Draw photo as background
  if (_img && _img.complete && _img.naturalWidth > 0) {
    if (_viewUpper) {
      // Show only upper half (above horizon)
      _ctx.drawImage(_img, 0, 0, _img.naturalWidth, _img.naturalHeight / 2, 0, 0, W, H);
    } else {
      _ctx.drawImage(_img, 0, 0, W, H);
    }
  } else {
    // No image: dark background
    _ctx.fillStyle = '#1a2030';
    _ctx.fillRect(0, 0, W, H);
  }

  // Draw compass grid
  if (_showGrid) {
    drawCompassGrid(W, H);
  }

  // Draw sun paths
  if (_showSunPaths) {
    drawSunPaths(W, H, photo);
  }

  // Draw all trace paths (dimmed for non-active traces)
  for (const [name, trace] of Object.entries(photo.traces)) {
    const isActive = name === _traceName;
    drawTracePaths(trace.paths, trace.color, isActive ? 1.0 : 0.3, isActive ? 2.5 : 1);
  }

  // Draw current in-progress path
  if (_currentPath.length > 0) {
    drawInProgressPath();
  }

  // Draw horizon line for current trace
  const trace = photo.traces[_traceName];
  if (trace?.horizonProfile) {
    drawHorizonLine(trace.horizonProfile);
  }

  // Update mini horizon chart
  updateHorizonMini();
}

function drawCompassGrid(W, H) {
  const heading = getHeading();
  const pitch = getPitch();

  _ctx.save();
  _ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  _ctx.lineWidth = 0.5;
  _ctx.font = '10px "JetBrains Mono", monospace';

  const cardinals = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

  // Elevation lines
  const maxEl = _viewUpper ? 90 : 90;
  const minEl = _viewUpper ? 0 : -90;
  for (let elev = 0; elev <= maxEl; elev += 10) {
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

  // Horizon line emphasis
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
  for (let az = 0; az < 360; az += 30) {
    const cp = skyToCanvas(az, 45);
    if (cp.x < 0 || cp.x > W) continue;
    _ctx.beginPath();
    _ctx.moveTo(cp.x, 0);
    _ctx.lineTo(cp.x, H);
    _ctx.stroke();

    const label = cardinals[az] || `${az}°`;
    _ctx.fillStyle = cardinals[az] ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.25)';
    _ctx.textAlign = 'center';
    _ctx.fillText(label, cp.x, H - 4);
  }

  _ctx.restore();
}

function drawSunPaths(W, H, photo) {
  const state = getState();
  const lat = state.location.lat;
  if (lat == null) return;

  // Get horizon profile for shading detection
  const trace = photo.traces[_traceName];
  const horizon = trace?.horizonProfile || new Float32Array(360);

  const allPaths = computeAllSunPaths(lat);
  const monthAlpha = ['44', '55', '77', '88', 'aa', 'cc', 'cc', 'aa', '88', '77', '55', '44'];

  _ctx.save();
  for (let m = 0; m < 12; m++) {
    const path = allPaths[m];
    for (let i = 1; i < path.length; i++) {
      const p0 = path[i - 1], p1 = path[i];
      const c0 = skyToCanvas(p0.azimuth, p0.elevation);
      const c1 = skyToCanvas(p1.azimuth, p1.elevation);

      if (c0.x < -50 || c0.x > W + 50 || c1.x < -50 || c1.x > W + 50) continue;
      if (c0.y < -50 || c0.y > H + 50 || c1.y < -50 || c1.y > H + 50) continue;

      const az0 = Math.round(p0.azimuth) % 360;
      const az1 = Math.round(p1.azimuth) % 360;
      const sh = p0.elevation <= horizon[az0] || p1.elevation <= horizon[az1];

      _ctx.beginPath();
      _ctx.moveTo(c0.x, c0.y);
      _ctx.lineTo(c1.x, c1.y);
      _ctx.strokeStyle = sh ? `#ef4444${monthAlpha[m]}` : `#f5a623${monthAlpha[m]}`;
      _ctx.lineWidth = sh ? 2 : 1.2;
      _ctx.stroke();
    }
  }
  _ctx.restore();
}

function drawTracePaths(paths, color, alpha, lineWidth) {
  if (!paths || paths.length === 0) return;
  _ctx.save();
  _ctx.globalAlpha = alpha;

  for (const path of paths) {
    if (path.points.length < 2) continue;

    // Draw the path line
    _ctx.beginPath();
    for (let i = 0; i < path.points.length; i++) {
      const cp = normToCanvas(path.points[i].x, path.points[i].y);
      if (i === 0) _ctx.moveTo(cp.x, cp.y);
      else _ctx.lineTo(cp.x, cp.y);
    }
    _ctx.strokeStyle = color;
    _ctx.lineWidth = lineWidth;
    _ctx.stroke();

    // Fill below the line (shade area)
    _ctx.lineTo(normToCanvas(path.points[path.points.length - 1].x, _viewUpper ? 0.5 : 1).x,
                normToCanvas(0, _viewUpper ? 0.5 : 1).y);
    _ctx.lineTo(normToCanvas(path.points[0].x, _viewUpper ? 0.5 : 1).x,
                normToCanvas(0, _viewUpper ? 0.5 : 1).y);
    _ctx.closePath();
    _ctx.fillStyle = color.replace(')', ',0.08)').replace('rgb', 'rgba');
    if (color.startsWith('#')) {
      _ctx.fillStyle = color + '14';
    }
    _ctx.fill();

    // Points
    for (const pt of path.points) {
      const cp = normToCanvas(pt.x, pt.y);
      _ctx.beginPath();
      _ctx.arc(cp.x, cp.y, 3, 0, Math.PI * 2);
      _ctx.fillStyle = color;
      _ctx.fill();
    }
  }

  _ctx.restore();
}

function drawInProgressPath() {
  if (_currentPath.length === 0) return;
  _ctx.save();

  const photo = getState().photos[_photoId];
  const trace = photo?.traces[_traceName];
  const color = trace?.color || '#3b82f6';

  _ctx.beginPath();
  for (let i = 0; i < _currentPath.length; i++) {
    const cp = normToCanvas(_currentPath[i].x, _currentPath[i].y);
    if (i === 0) _ctx.moveTo(cp.x, cp.y);
    else _ctx.lineTo(cp.x, cp.y);
  }
  _ctx.strokeStyle = color;
  _ctx.lineWidth = 2.5;
  _ctx.setLineDash([6, 3]);
  _ctx.stroke();
  _ctx.setLineDash([]);

  // Points
  for (const pt of _currentPath) {
    const cp = normToCanvas(pt.x, pt.y);
    _ctx.beginPath();
    _ctx.arc(cp.x, cp.y, 4, 0, Math.PI * 2);
    _ctx.fillStyle = '#fff';
    _ctx.fill();
    _ctx.beginPath();
    _ctx.arc(cp.x, cp.y, 2.5, 0, Math.PI * 2);
    _ctx.fillStyle = color;
    _ctx.fill();
  }

  _ctx.restore();
}

function drawHorizonLine(profile) {
  if (!profile) return;
  _ctx.save();
  _ctx.strokeStyle = 'rgba(59,130,246,0.6)';
  _ctx.lineWidth = 1.5;
  _ctx.setLineDash([4, 2]);
  _ctx.beginPath();

  let started = false;
  for (let az = 0; az < 360; az++) {
    const el = profile[az];
    if (el <= 0) continue;
    const cp = skyToCanvas(az, el);
    if (cp.x < 0 || cp.x > _canvas.width) continue;
    if (!started) { _ctx.moveTo(cp.x, cp.y); started = true; }
    else _ctx.lineTo(cp.x, cp.y);
  }
  _ctx.stroke();
  _ctx.setLineDash([]);
  _ctx.restore();
}

// --- Horizon mini chart ---

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
    mc.fillText('No trace drawn yet', W / 2, H / 2 + 4);
    return;
  }

  // Draw profile
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

  // Labels
  mc.fillStyle = '#546e7a';
  mc.font = '8px "JetBrains Mono"';
  mc.textAlign = 'center';
  const labels = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (const [az, label] of Object.entries(labels)) {
    mc.fillText(label, (az / 360) * W, H - 1);
  }
}

// --- Trace list ---

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
    item.innerHTML = `
      <span class="trace-color" style="background:${trace.color}"></span>
      <span class="trace-name">${esc(name)} ${trace.isDefault ? '(default)' : ''}</span>
      <span style="font-size:10px;color:var(--text3)">${trace.paths.length} path(s)</span>
      ${!trace.isDefault ? `<button class="btn btn-sm btn-ghost btn-danger" data-del="${name}" title="Delete trace" style="padding:2px 6px">&#10005;</button>` : ''}
    `;
    item.addEventListener('click', (e) => {
      if (e.target.dataset.del) {
        delete photo.traces[e.target.dataset.del];
        if (_traceName === e.target.dataset.del) {
          _traceName = Object.keys(photo.traces)[0];
        }
        buildTraceList();
        redraw();
        return;
      }
      _traceName = name;
      buildTraceList();
      redraw();
    });
    list.appendChild(item);
  }
}

// --- Event binding ---

function bindEditorEvents() {
  // Photo selector
  qs('#sel-photo', _container)?.addEventListener('change', (e) => {
    _photoId = e.target.value;
    _traceName = null;
    _currentPath = [];
    buildEditorUI();
  });

  // Manual heading input
  qs('#inp-manual-heading', _container)?.addEventListener('change', () => {
    recomputeHorizons();
    redraw();
  });

  // Add trace
  qs('#btn-add-trace', _container)?.addEventListener('click', () => {
    const name = prompt('Name for new trace scenario:', 'Trees Removed');
    if (!name || !name.trim()) return;
    addTrace(_photoId, name.trim());
    _traceName = name.trim();
    buildTraceList();
    redraw();
  });

  // Drawing tools
  for (const btn of qsa('.tool-btn[data-mode]', _container)) {
    btn.addEventListener('click', () => {
      _drawingMode = btn.dataset.mode;
      qsa('.tool-btn[data-mode]', _container).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _currentPath = [];
      redraw();
    });
  }

  // Undo
  qs('#btn-undo-path', _container)?.addEventListener('click', () => {
    const photo = getState().photos[_photoId];
    const trace = photo?.traces[_traceName];
    if (trace && trace.paths.length > 0) {
      trace.paths.pop();
      recomputeHorizons();
      redraw();
    }
  });

  // Clear trace
  qs('#btn-clear-trace', _container)?.addEventListener('click', () => {
    const photo = getState().photos[_photoId];
    const trace = photo?.traces[_traceName];
    if (trace) {
      trace.paths = [];
      trace.horizonProfile = null;
      redraw();
    }
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
  qs('#chk-upper', _container)?.addEventListener('change', (e) => {
    _viewUpper = e.target.checked;
    _canvas.height = _viewUpper ? 600 : 1200;
    redraw();
  });

  // Canvas drawing events
  bindCanvasEvents();

  // Next button
  qs('#btn-next-report', _container)?.addEventListener('click', () => {
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

  if (_drawingMode === 'polyline') {
    _canvas.addEventListener('click', (e) => {
      const { cx, cy } = getPos(e);
      const norm = canvasToNorm(cx, cy);
      _currentPath.push(norm);
      redraw();
    });

    _canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      finishPath();
    });
  }

  // Freehand mode
  _canvas.addEventListener('mousedown', (e) => {
    if (_drawingMode !== 'freehand') return;
    e.preventDefault();
    _isDrawing = true;
    _currentPath = [];
    const { cx, cy } = getPos(e);
    _currentPath.push(canvasToNorm(cx, cy));
  });

  _canvas.addEventListener('mousemove', (e) => {
    if (!_isDrawing || _drawingMode !== 'freehand') return;
    const { cx, cy } = getPos(e);
    const norm = canvasToNorm(cx, cy);
    // Downsample: only add if moved enough
    const last = _currentPath[_currentPath.length - 1];
    const dist = Math.hypot(norm.x - last.x, norm.y - last.y);
    if (dist > 0.003) {
      _currentPath.push(norm);
      redraw();
    }
  });

  _canvas.addEventListener('mouseup', () => {
    if (_isDrawing && _drawingMode === 'freehand') {
      _isDrawing = false;
      finishPath();
    }
  });

  _canvas.addEventListener('mouseleave', () => {
    if (_isDrawing && _drawingMode === 'freehand') {
      _isDrawing = false;
      finishPath();
    }
  });

  // Touch support
  _canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (_drawingMode === 'freehand') {
      _isDrawing = true;
      _currentPath = [];
      const touch = e.touches[0];
      const rect = _canvas.getBoundingClientRect();
      const cx = (touch.clientX - rect.left) * (_canvas.width / rect.width);
      const cy = (touch.clientY - rect.top) * (_canvas.height / rect.height);
      _currentPath.push(canvasToNorm(cx, cy));
    } else {
      const touch = e.touches[0];
      const rect = _canvas.getBoundingClientRect();
      const cx = (touch.clientX - rect.left) * (_canvas.width / rect.width);
      const cy = (touch.clientY - rect.top) * (_canvas.height / rect.height);
      _currentPath.push(canvasToNorm(cx, cy));
      redraw();
    }
  }, { passive: false });

  _canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (_drawingMode !== 'freehand' || !_isDrawing) return;
    const touch = e.touches[0];
    const rect = _canvas.getBoundingClientRect();
    const cx = (touch.clientX - rect.left) * (_canvas.width / rect.width);
    const cy = (touch.clientY - rect.top) * (_canvas.height / rect.height);
    const norm = canvasToNorm(cx, cy);
    const last = _currentPath[_currentPath.length - 1];
    if (Math.hypot(norm.x - last.x, norm.y - last.y) > 0.003) {
      _currentPath.push(norm);
      redraw();
    }
  }, { passive: false });

  _canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (_isDrawing && _drawingMode === 'freehand') {
      _isDrawing = false;
      finishPath();
    }
  }, { passive: false });

  // Show cursor position as sky coordinates
  _canvas.addEventListener('mousemove', (e) => {
    const { cx, cy } = getPos(e);
    const sky = canvasToSky(cx, cy);
    _canvas.title = `Az: ${sky.azimuth.toFixed(1)}°  El: ${sky.elevation.toFixed(1)}°`;
  });
}

function finishPath() {
  if (_currentPath.length < 2) {
    _currentPath = [];
    redraw();
    return;
  }

  const photo = getState().photos[_photoId];
  const trace = photo?.traces[_traceName];
  if (!trace) return;

  trace.paths.push({ points: [..._currentPath] });
  _currentPath = [];
  recomputeHorizons();
  redraw();
  buildTraceList();
}

function recomputeHorizons() {
  const photo = getState().photos[_photoId];
  if (!photo) return;
  const heading = getHeading();
  const pitch = getPitch();

  for (const trace of Object.values(photo.traces)) {
    if (trace.paths.length > 0) {
      trace.horizonProfile = pathsToHorizon(trace.paths, heading, pitch);
    } else {
      trace.horizonProfile = null;
    }
  }
}

function onKeyDown(e) {
  if (e.key === 'Enter') {
    finishPath();
  } else if (e.key === 'Escape') {
    _currentPath = [];
    redraw();
  } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
    // Undo last point in current path
    if (_currentPath.length > 0) {
      _currentPath.pop();
      redraw();
    }
  }
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

export function destroy() {
  document.removeEventListener('keydown', onKeyDown);
}
