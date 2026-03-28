/**
 * SolarScope — Array & Photos View (Canvas-based)
 * Interactive array diagram with draggable measurement points,
 * diode-split visualization, and per-point photo management.
 */

import {
  getState, setState, addPhoto, assignPhotoToPoints,
  removePhoto, subscribe,
  addMeasurementPoint, removeMeasurementPoint,
  moveMeasurementPoint, renameMeasurementPoint
} from '../state.js';
import {
  el, qs, qsa, clearEl, parsePhotoMetadata, loadImage, fmtLatLon, fmtDeg
} from '../utils.js';

// ─── Constants ────────────────────────────────────────
const PAD = 30;
const GAP = 4;
const PT_R = 7;
const MIN_PANEL_W = 28;
const LABEL_FONT = '9px "JetBrains Mono", monospace';
const PT_FONT = '10px "JetBrains Mono", monospace';

// ─── Module state ─────────────────────────────────────
let _container = null;
let _canvas = null;
let _ctx = null;
let _dpr = 1;

// Layout cache
let _panelW = 0;
let _panelH = 0;
let _originX = 0;
let _originY = 0;

// Interaction
let _selectedPtId = null;
let _hoveredPtId = null;
let _dragging = false;
let _dragCurrentPanel = null; // { row, col } while dragging
let _resizeObs = null;

// ─── Public API ───────────────────────────────────────

export function render(container) {
  _container = container;
  clearEl(container);
  _selectedPtId = null;
  _dragging = false;
  buildUI();
}

export function destroy() {
  if (_resizeObs) { _resizeObs.disconnect(); _resizeObs = null; }
}

// ─── UI Construction ──────────────────────────────────

function buildUI() {
  const state = getState();

  _container.innerHTML = `
    <div class="fade-in">
      <div class="grid-2">
        <!-- LEFT: Canvas Array -->
        <div class="card">
          <div class="card-header">
            <h2>Array Diagram</h2>
            <div style="display:flex;gap:6px">
              <button class="btn btn-sm" id="btn-add-pt">+ Add Point</button>
              <button class="btn btn-sm btn-danger" id="btn-del-pt" disabled>Delete Point</button>
            </div>
          </div>
          <p class="hint" style="margin-bottom:8px">
            Click <strong>+ Add Point</strong> to create measurement points.
            Drag to position. Select a point to assign a photo.
          </p>
          <div id="canvas-wrap" style="position:relative;width:100%;background:var(--surface2);border-radius:var(--radius-sm);overflow:hidden">
            <canvas id="array-canvas" style="display:block;width:100%"></canvas>
          </div>
          <div class="legend-row" style="justify-content:center;margin-top:10px;gap:16px">
            <span class="legend-label" style="display:flex;align-items:center;gap:4px">
              <span style="width:10px;height:10px;border-radius:50%;background:var(--text3);display:inline-block"></span> No photo
            </span>
            <span class="legend-label" style="display:flex;align-items:center;gap:4px">
              <span style="width:10px;height:10px;border-radius:50%;background:var(--shade);display:inline-block"></span> Photo
            </span>
            <span class="legend-label" style="display:flex;align-items:center;gap:4px">
              <span style="width:10px;height:10px;border-radius:50%;background:var(--gain);display:inline-block"></span> Traced
            </span>
            <span class="legend-label" style="display:flex;align-items:center;gap:4px">
              <span style="width:10px;height:10px;border-radius:50%;border:2px solid var(--sun);background:transparent;display:inline-block"></span> Selected
            </span>
          </div>
        </div>

        <!-- RIGHT: Point Detail & Photos -->
        <div class="card" id="point-panel">
          <div class="card-header">
            <h2 id="point-panel-title">Point Detail</h2>
            <span class="hint" id="photo-count">${Object.keys(state.photos).length} photo(s)</span>
          </div>
          <div id="point-detail-area"></div>

          <!-- Photo library -->
          <div id="photo-library" style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px">
            <h3 style="font-size:12px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">
              Photo Library
            </h3>
            <div class="upload-zone" id="upload-zone" style="padding:16px">
              <div class="upload-icon" style="font-size:24px">&#128247;</div>
              <div class="upload-text" style="font-size:12px">Drop photos or click to upload</div>
            </div>
            <input type="file" id="file-photo-input" accept="image/*" multiple style="display:none">
            <div class="photo-grid" id="photo-list" style="margin-top:8px"></div>
          </div>
        </div>
      </div>

      <div style="text-align:center;margin-top:8px">
        <button class="btn btn-primary" id="btn-next-editor" style="padding:10px 32px;font-size:14px">
          Continue to Shade Editor →
        </button>
      </div>
    </div>
  `;

  initCanvas();
  updatePointPanel();
  buildPhotoList();
  bindEvents();
}

function bindEvents() {
  qs('#btn-add-pt', _container).addEventListener('click', doAddPoint);
  qs('#btn-del-pt', _container).addEventListener('click', doDeletePoint);

  // Library upload
  const uploadZone = qs('#upload-zone', _container);
  const fileInput = qs('#file-photo-input', _container);
  uploadZone.addEventListener('click', () => fileInput.click());
  uploadZone.addEventListener('dragover', e => {
    e.preventDefault();
    uploadZone.style.borderColor = 'var(--sun)';
    uploadZone.style.background = 'var(--sun-dim)';
  });
  uploadZone.addEventListener('dragleave', () => {
    uploadZone.style.borderColor = '';
    uploadZone.style.background = '';
  });
  uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.style.borderColor = '';
    uploadZone.style.background = '';
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', e => {
    handleFiles(e.target.files);
    e.target.value = '';
  });

  qs('#btn-next-editor', _container).addEventListener('click', () => {
    document.querySelector('[data-view="editor"]').click();
  });
}

// ─── Canvas ───────────────────────────────────────────

function initCanvas() {
  _canvas = qs('#array-canvas', _container);
  _ctx = _canvas.getContext('2d');
  _dpr = window.devicePixelRatio || 1;

  _canvas.addEventListener('mousedown', onMouseDown);
  _canvas.addEventListener('mousemove', onMouseMove);
  _canvas.addEventListener('mouseup', onMouseUp);
  _canvas.addEventListener('mouseleave', onMouseLeave);

  _canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  _canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  _canvas.addEventListener('touchend', onTouchEnd);

  _resizeObs = new ResizeObserver(() => {
    computeLayout();
    drawArray();
  });
  _resizeObs.observe(_canvas.parentElement);

  computeLayout();
  drawArray();
}

function computeLayout() {
  const state = getState();
  const { rows, cols, panelWidth, panelHeight } = state.system;
  const wrap = _canvas.parentElement;
  const wrapW = wrap.clientWidth;

  const aspect = panelHeight / panelWidth;
  const availW = wrapW - 2 * PAD - (cols - 1) * GAP;
  _panelW = Math.max(MIN_PANEL_W, availW / cols);
  _panelH = _panelW * aspect;

  // Cap grid height
  const gridH = rows * _panelH + (rows - 1) * GAP;
  if (gridH > 500) {
    const scale = 500 / gridH;
    _panelH *= scale;
    _panelW *= scale;
  }

  _originX = (wrapW - (cols * _panelW + (cols - 1) * GAP)) / 2;
  _originY = PAD;

  const canvasH = _originY + rows * _panelH + (rows - 1) * GAP + PAD;
  _canvas.width = Math.round(wrapW * _dpr);
  _canvas.height = Math.round(canvasH * _dpr);
  _canvas.style.height = canvasH + 'px';
  _ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
}

// ─── Drawing ──────────────────────────────────────────

function pRect(row, col) {
  return {
    x: _originX + col * (_panelW + GAP),
    y: _originY + row * (_panelH + GAP),
    w: _panelW,
    h: _panelH,
  };
}

function ptCanvasXY(pt) {
  const r = pRect(pt.panelRow, pt.panelCol);
  return { cx: r.x + pt.localX * r.w, cy: r.y + pt.localY * r.h };
}

function drawArray() {
  if (!_ctx) return;
  const state = getState();
  const { rows, cols } = state.system;
  const w = _canvas.width / _dpr;
  const h = _canvas.height / _dpr;

  _ctx.clearRect(0, 0, w, h);

  // Panels
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      drawPanel(r, c, state);

  // Points
  drawPoints(state);
}

function drawPanel(row, col, state) {
  const { x, y, w, h } = pRect(row, col);
  const { diodeSplit, diodeSubsections } = state.system;
  const pts = Object.values(state.points).filter(p => p.panelRow === row && p.panelCol === col);

  const hasPhoto = pts.some(p => p.photoId);
  const hasTrace = pts.some(p => {
    const ph = state.photos[p.photoId];
    return ph && Object.values(ph.traces).some(t => t.paths.length > 0);
  });

  // Selected-point panel highlight
  const isSelectedPanel = _selectedPtId && state.points[_selectedPtId]
    && state.points[_selectedPtId].panelRow === row
    && state.points[_selectedPtId].panelCol === col;

  // Background
  _ctx.fillStyle = isSelectedPanel ? 'rgba(96,165,250,0.18)'
    : hasTrace ? 'rgba(34,197,94,0.12)'
    : hasPhoto ? 'rgba(96,165,250,0.12)'
    : 'rgba(255,255,255,0.05)';
  roundRect(x, y, w, h, 4);
  _ctx.fill();

  // Border
  _ctx.strokeStyle = isSelectedPanel ? 'rgba(96,165,250,0.7)'
    : hasTrace ? 'rgba(34,197,94,0.5)'
    : hasPhoto ? 'rgba(96,165,250,0.4)'
    : 'rgba(255,255,255,0.15)';
  _ctx.lineWidth = isSelectedPanel ? 1.5 : 1;
  _ctx.stroke();

  // Diode split lines
  const nSubs = diodeSubsections || 2;
  _ctx.save();
  _ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  _ctx.lineWidth = 0.5;
  _ctx.setLineDash([3, 3]);

  if (diodeSplit === 'vertical') {
    for (let s = 1; s < nSubs; s++) {
      const sx = x + (s / nSubs) * w;
      _ctx.beginPath(); _ctx.moveTo(sx, y + 2); _ctx.lineTo(sx, y + h - 2); _ctx.stroke();
    }
  } else {
    for (let s = 1; s < nSubs; s++) {
      const sy = y + (s / nSubs) * h;
      _ctx.beginPath(); _ctx.moveTo(x + 2, sy); _ctx.lineTo(x + w - 2, sy); _ctx.stroke();
    }
  }
  _ctx.restore();

  // Label
  _ctx.save();
  _ctx.font = LABEL_FONT;
  _ctx.fillStyle = 'rgba(255,255,255,0.3)';
  _ctx.textAlign = 'center';
  _ctx.textBaseline = 'top';
  _ctx.fillText(`${String.fromCharCode(65 + row)}${col + 1}`, x + w / 2, y + 3);
  _ctx.restore();
}

function drawPoints(state) {
  const points = Object.values(state.points);
  // Draw non-selected first, selected last (on top)
  for (const pt of points) {
    if (pt.id === _selectedPtId) continue;
    drawPoint(pt, false, pt.id === _hoveredPtId, state);
  }
  if (_selectedPtId && state.points[_selectedPtId]) {
    drawPoint(state.points[_selectedPtId], true, false, state);
  }
}

function drawPoint(pt, selected, hovered, state) {
  const { cx, cy } = ptCanvasXY(pt);
  const r = PT_R;

  let fill = 'rgba(255,255,255,0.25)';
  let stroke = 'rgba(255,255,255,0.4)';

  if (pt.photoId) {
    const photo = state.photos[pt.photoId];
    const traced = photo && Object.values(photo.traces).some(t => t.paths.length > 0);
    if (traced) {
      fill = 'rgba(34,197,94,0.6)'; stroke = '#22c55e';
    } else {
      fill = 'rgba(96,165,250,0.5)'; stroke = '#60a5fa';
    }
  }

  // Selection glow
  if (selected) {
    _ctx.beginPath(); _ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
    _ctx.fillStyle = 'rgba(245,166,35,0.25)'; _ctx.fill();
    stroke = '#f5a623';
  }
  if (hovered && !selected) {
    _ctx.beginPath(); _ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
    _ctx.fillStyle = 'rgba(255,255,255,0.1)'; _ctx.fill();
  }

  // Circle
  _ctx.beginPath(); _ctx.arc(cx, cy, r, 0, Math.PI * 2);
  _ctx.fillStyle = fill; _ctx.fill();
  _ctx.strokeStyle = stroke; _ctx.lineWidth = selected ? 2 : 1; _ctx.stroke();

  // Name label
  _ctx.save();
  _ctx.font = PT_FONT;
  _ctx.fillStyle = selected ? '#f5a623' : 'rgba(255,255,255,0.7)';
  _ctx.textAlign = 'center';
  _ctx.textBaseline = 'bottom';
  _ctx.fillText(pt.name, cx, cy - r - 2);
  _ctx.restore();
}

/** Canvas-safe roundRect (fallback for older browsers) */
function roundRect(x, y, w, h, r) {
  _ctx.beginPath();
  if (_ctx.roundRect) {
    _ctx.roundRect(x, y, w, h, r);
  } else {
    _ctx.moveTo(x + r, y);
    _ctx.lineTo(x + w - r, y); _ctx.arcTo(x + w, y, x + w, y + r, r);
    _ctx.lineTo(x + w, y + h - r); _ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    _ctx.lineTo(x + r, y + h); _ctx.arcTo(x, y + h, x, y + h - r, r);
    _ctx.lineTo(x, y + r); _ctx.arcTo(x, y, x + r, y, r);
    _ctx.closePath();
  }
}

// ─── Hit Testing ──────────────────────────────────────

function mousePos(e) {
  const r = _canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function pointAtPos(mx, my) {
  const state = getState();
  const pts = Object.values(state.points);
  const hitR = PT_R + 5;
  for (let i = pts.length - 1; i >= 0; i--) {
    const { cx, cy } = ptCanvasXY(pts[i]);
    const dx = mx - cx, dy = my - cy;
    if (dx * dx + dy * dy <= hitR * hitR) return pts[i].id;
  }
  return null;
}

function panelAtPos(mx, my) {
  const { rows, cols } = getState().system;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rect = pRect(r, c);
      if (mx >= rect.x && mx <= rect.x + rect.w &&
          my >= rect.y && my <= rect.y + rect.h)
        return { row: r, col: c };
    }
  }
  return null;
}

function toLocal(mx, my, row, col) {
  const r = pRect(row, col);
  return { lx: (mx - r.x) / r.w, ly: (my - r.y) / r.h };
}

// ─── Mouse / Touch ────────────────────────────────────

function onMouseDown(e) {
  const pos = mousePos(e);
  const ptId = pointAtPos(pos.x, pos.y);

  if (ptId) {
    _selectedPtId = ptId;
    _dragging = true;
    const pt = getState().points[ptId];
    _dragCurrentPanel = { row: pt.panelRow, col: pt.panelCol };
    _canvas.style.cursor = 'grabbing';
  } else {
    _selectedPtId = null;
    _dragging = false;
  }

  updatePointPanel();
  syncDeleteBtn();
  drawArray();
}

function onMouseMove(e) {
  const pos = mousePos(e);

  if (_dragging && _selectedPtId) {
    const panel = panelAtPos(pos.x, pos.y);

    if (panel) {
      // Cursor is inside a panel — move point there
      _dragCurrentPanel = panel;
      const { lx, ly } = toLocal(pos.x, pos.y, panel.row, panel.col);
      moveMeasurementPoint(_selectedPtId, panel.col, panel.row,
        clamp(lx, 0.05, 0.95), clamp(ly, 0.05, 0.95));
    } else if (_dragCurrentPanel) {
      // Cursor outside panels — clamp to current panel edge
      const { lx, ly } = toLocal(pos.x, pos.y, _dragCurrentPanel.row, _dragCurrentPanel.col);
      moveMeasurementPoint(_selectedPtId, _dragCurrentPanel.col, _dragCurrentPanel.row,
        clamp(lx, 0.05, 0.95), clamp(ly, 0.05, 0.95));
    }

    drawArray();
    updatePointCoords();
    return;
  }

  // Hover
  const ptId = pointAtPos(pos.x, pos.y);
  if (ptId !== _hoveredPtId) {
    _hoveredPtId = ptId;
    _canvas.style.cursor = ptId ? 'grab' : 'default';
    drawArray();
  }
}

function onMouseUp() {
  if (_dragging) {
    _dragging = false;
    _dragCurrentPanel = null;
    _canvas.style.cursor = _hoveredPtId ? 'grab' : 'default';
    // Full panel rebuild after drag ends
    updatePointPanel();
  }
}

function onMouseLeave() {
  if (_dragging) return; // keep dragging even if cursor leaves momentarily
  if (_hoveredPtId) {
    _hoveredPtId = null;
    _canvas.style.cursor = 'default';
    drawArray();
  }
}

function onTouchStart(e) {
  e.preventDefault();
  const t = e.touches[0];
  onMouseDown({ clientX: t.clientX, clientY: t.clientY });
}
function onTouchMove(e) {
  e.preventDefault();
  const t = e.touches[0];
  onMouseMove({ clientX: t.clientX, clientY: t.clientY });
}
function onTouchEnd() { onMouseUp(); }

// ─── Point Operations ─────────────────────────────────

function doAddPoint() {
  const state = getState();
  const { rows, cols } = state.system;
  const points = Object.values(state.points);

  // Find first panel without any point
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!points.some(p => p.panelRow === r && p.panelCol === c)) {
        selectNew(addMeasurementPoint(c, r, 0.5, 0.5));
        return;
      }
    }
  }
  // All panels have points — add to first panel offset
  selectNew(addMeasurementPoint(0, 0, 0.3 + Math.random() * 0.4, 0.3 + Math.random() * 0.4));
}

function selectNew(id) {
  _selectedPtId = id;
  updatePointPanel();
  syncDeleteBtn();
  drawArray();
}

function doDeletePoint() {
  if (!_selectedPtId) return;
  removeMeasurementPoint(_selectedPtId);
  _selectedPtId = null;
  updatePointPanel();
  syncDeleteBtn();
  drawArray();
}

function syncDeleteBtn() {
  const btn = qs('#btn-del-pt', _container);
  if (btn) btn.disabled = !_selectedPtId;
}

// ─── Point Detail Panel ──────────────────────────────

function updatePointPanel() {
  const area = qs('#point-detail-area', _container);
  if (!area) return;

  const state = getState();
  const pt = _selectedPtId ? state.points[_selectedPtId] : null;

  if (!pt) {
    area.innerHTML = `
      <div style="text-align:center;padding:24px;color:var(--text3)">
        <div style="font-size:32px;opacity:0.3;margin-bottom:8px">\u25CE</div>
        <p style="margin:0;font-size:13px">Select a point on the array, or click <strong>+ Add Point</strong>.</p>
      </div>
    `;
    qs('#point-panel-title', _container).textContent = 'Point Detail';
    return;
  }

  const panelLabel = `${String.fromCharCode(65 + pt.panelRow)}${pt.panelCol + 1}`;
  const photo = pt.photoId ? state.photos[pt.photoId] : null;

  qs('#point-panel-title', _container).textContent = pt.name;

  area.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="form-grid" style="gap:8px">
        <div class="form-group" style="grid-column:1/-1">
          <label>Name</label>
          <input type="text" id="inp-pt-name" value="${esc(pt.name)}" style="font-size:14px;font-weight:600">
        </div>
        <div class="form-group">
          <label>Panel</label>
          <div style="font-family:'JetBrains Mono',monospace;font-size:14px;padding:6px 0">${panelLabel}</div>
        </div>
        <div class="form-group">
          <label>Position</label>
          <div id="point-coords" style="font-family:'JetBrains Mono',monospace;font-size:12px;padding:6px 0;color:var(--text2)">
            x: ${(pt.localX * state.system.panelWidth).toFixed(3)}m, y: ${(pt.localY * state.system.panelHeight).toFixed(3)}m
          </div>
        </div>
      </div>
      ${photo ? photoDetailHTML(photo) : photoUploadHTML()}
    </div>
  `;

  // Bind name input
  const nameInp = qs('#inp-pt-name', area);
  nameInp.addEventListener('input', () => {
    renameMeasurementPoint(_selectedPtId, nameInp.value);
    qs('#point-panel-title', _container).textContent = nameInp.value;
    drawArray();
  });

  // Bind photo actions
  if (photo) {
    qs('#btn-pt-editor', area)?.addEventListener('click', () => {
      setState('_selectedPhotoId', photo.id);
      document.querySelector('[data-view="editor"]').click();
    });
    qs('#btn-pt-unassign', area)?.addEventListener('click', () => {
      const p = state.points[_selectedPtId];
      if (p) {
        p.photoId = null;
        const ph = state.photos[photo.id];
        if (ph) ph.coveragePoints = ph.coveragePoints.filter(id => id !== _selectedPtId);
      }
      updatePointPanel();
      drawArray();
    });
  } else {
    // Point-specific upload
    const upZone = qs('#pt-upload-zone', area);
    const upInput = qs('#pt-file-input', area);
    if (upZone && upInput) {
      upZone.addEventListener('click', () => upInput.click());
      upZone.addEventListener('dragover', e => { e.preventDefault(); upZone.style.borderColor = 'var(--sun)'; });
      upZone.addEventListener('dragleave', () => { upZone.style.borderColor = ''; });
      upZone.addEventListener('drop', e => {
        e.preventDefault();
        upZone.style.borderColor = '';
        handleFilesForPoint(e.dataTransfer.files);
      });
      upInput.addEventListener('change', e => { handleFilesForPoint(e.target.files); e.target.value = ''; });
    }
  }
}

function photoDetailHTML(photo) {
  const meta = photo.metadata;
  const traceCount = Object.values(photo.traces).reduce((n, t) => n + (t.paths.length > 0 ? 1 : 0), 0);
  return `
    <div style="border-top:1px solid var(--border);padding-top:12px">
      <h3 style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">
        Assigned Photo
      </h3>
      <div style="display:flex;gap:12px;align-items:flex-start">
        <img src="${photo.dataUrl}" style="width:100px;height:60px;object-fit:cover;border-radius:4px;flex-shrink:0">
        <div style="font-size:11px;min-width:0">
          <div style="font-weight:600;word-break:break-all">${esc(photo.filename)}</div>
          ${meta.compassHeading != null
            ? `<div style="color:var(--gain);margin-top:2px">Heading: ${meta.compassHeading.toFixed(1)}\u00B0</div>`
            : '<div style="color:var(--sun);margin-top:2px">No compass heading</div>'}
          <div style="color:var(--text3);margin-top:2px">${traceCount} trace(s) drawn</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="btn btn-sm" id="btn-pt-editor">Open in Editor \u2192</button>
        <button class="btn btn-sm" id="btn-pt-unassign">Unassign</button>
      </div>
    </div>
  `;
}

function photoUploadHTML() {
  return `
    <div style="border-top:1px solid var(--border);padding-top:12px">
      <h3 style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">
        Photo
      </h3>
      <div id="pt-upload-zone" class="upload-zone" style="padding:12px;cursor:pointer">
        <div style="font-size:18px;opacity:0.4">&#128247;</div>
        <div class="upload-text" style="font-size:11px">Drop photo or click to upload</div>
      </div>
      <input type="file" id="pt-file-input" accept="image/*" style="display:none">
      <p class="hint" style="margin-top:6px;font-size:10px">
        Or click a photo in the library below to assign it.
      </p>
    </div>
  `;
}

function updatePointCoords() {
  const coordEl = qs('#point-coords', _container);
  if (!coordEl || !_selectedPtId) return;
  const state = getState();
  const pt = state.points[_selectedPtId];
  if (pt) coordEl.textContent = `x: ${(pt.localX * state.system.panelWidth).toFixed(3)}m, y: ${(pt.localY * state.system.panelHeight).toFixed(3)}m`;
}

// ─── File Handling ────────────────────────────────────

async function handleFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    await processFile(file, false);
  }
  buildPhotoList();
  drawArray();
}

async function handleFilesForPoint(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    await processFile(file, true);
  }
  updatePointPanel();
  buildPhotoList();
  drawArray();
}

async function processFile(file, assignToSelected) {
  try {
    const metadata = await parsePhotoMetadata(file);
    const imgData = await loadImage(file, 4096);
    const ar = imgData.width / imgData.height;
    const is360 = metadata.is360Pano || (ar > 1.8 && ar < 2.2);

    const photoId = addPhoto({
      filename: file.name,
      dataUrl: imgData.dataUrl,
      width: imgData.width,
      height: imgData.height,
      projection: is360 ? 'equirectangular' : 'fisheye',
      metadata,
      coveragePoints: assignToSelected && _selectedPtId ? [_selectedPtId] : [],
    });

    if (assignToSelected && _selectedPtId) {
      assignPhotoToPoints(photoId, [_selectedPtId]);
    }
  } catch (err) {
    console.error('Error processing photo:', err);
  }
}

// ─── Photo Library ────────────────────────────────────

function buildPhotoList() {
  const listEl = qs('#photo-list', _container);
  if (!listEl) return;
  clearEl(listEl);

  const state = getState();
  const photos = Object.values(state.photos);
  const countEl = qs('#photo-count', _container);
  if (countEl) countEl.textContent = `${photos.length} photo(s)`;

  if (photos.length === 0) return;

  for (const photo of photos) {
    const card = el('div', { class: 'photo-card' });
    card.style.cursor = 'pointer';

    const img = el('img');
    img.src = photo.dataUrl;
    img.alt = photo.filename;
    card.appendChild(img);

    const info = el('div', { class: 'photo-info' });
    info.innerHTML = `
      <div class="photo-name">${esc(photo.filename)}</div>
      <div class="photo-meta">
        <span style="font-size:10px;color:var(--text3)">${photo.coveragePoints.length} pt(s)</span>
      </div>
    `;
    card.appendChild(info);

    // Click to assign
    card.addEventListener('click', () => {
      if (_selectedPtId) {
        assignPhotoToPoints(photo.id, [_selectedPtId]);
        updatePointPanel();
        drawArray();
        buildPhotoList();
      }
    });

    card.title = _selectedPtId
      ? 'Click to assign to selected point'
      : 'Select a point first to assign';

    listEl.appendChild(card);
  }
}

// ─── Helpers ──────────────────────────────────────────

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
