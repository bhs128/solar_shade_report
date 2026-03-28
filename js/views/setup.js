/**
 * SolarScope — Setup View
 * Configure project name, location, panel parameters, and array dimensions.
 * Includes live array layout visualizer with diode split preview.
 */

import { getState, setState, batchUpdate, rebuildPoints, subscribe } from '../state.js';
import { el, qs, clearEl, fmtLatLon, debounce } from '../utils.js';

let _container = null;
let _vizCanvas = null;
let _vizCtx = null;
let _vizDpr = 1;

export function render(container) {
  _container = container;
  clearEl(container);

  const state = getState();
  const isPortrait = state.system.panelHeight >= state.system.panelWidth;

  container.innerHTML = `
    <div class="fade-in">
      <!-- Project Name -->
      <div class="card">
        <div class="card-header">
          <h2>Project</h2>
        </div>
        <div class="form-grid">
          <div class="form-group" style="grid-column: 1/-1; max-width:500px">
            <label>Project Name</label>
            <input type="text" id="inp-project-name" value="${esc(state.name)}" placeholder="e.g., My Solar Project">
          </div>
        </div>
      </div>

      <!-- Location -->
      <div class="card">
        <div class="card-header">
          <h2>Location</h2>
          <div>
            ${state.location.source === 'photo-exif'
              ? '<span class="tag tag-auto">Auto-detected from photo</span>'
              : '<span class="tag tag-manual">Manual entry</span>'}
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>Latitude (\u00B0N)</label>
            <input type="number" id="inp-lat" value="${state.location.lat ?? ''}" step="0.0001" placeholder="e.g. 40.0000">
            <span class="hint">Positive = North</span>
          </div>
          <div class="form-group">
            <label>Longitude (\u00B0E)</label>
            <input type="number" id="inp-lon" value="${state.location.lon ?? ''}" step="0.0001" placeholder="e.g. -90.0000">
            <span class="hint">Negative = West</span>
          </div>
          <div class="form-group">
            <label>Elevation (m)</label>
            <input type="number" id="inp-alt" value="${state.location.alt ?? ''}" step="1" placeholder="300">
          </div>
          <div class="form-group">
            <label>Address / Notes</label>
            <input type="text" id="inp-address" value="${esc(state.location.address)}" placeholder="123 Main St, Anytown, US">
          </div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
          <button class="btn btn-sm" id="btn-geolocate">&#9737; Use My Location</button>
          <span class="hint" id="geo-status"></span>
        </div>
        <p class="hint" style="margin-top:10px">
          Location can also be auto-detected from Insta360 photo GPS metadata.
          Upload a photo in the Array &amp; Photos tab.
        </p>
      </div>

      <!-- Panel Parameters -->
      <div class="card">
        <div class="card-header">
          <h2>Panel Parameters</h2>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>Panel Wattage (Wp)</label>
            <input type="number" id="inp-wp" value="${state.system.panelWp}" min="100" max="800" step="5">
          </div>
          <div class="form-group">
            <label>Panel Width (m)</label>
            <input type="number" id="inp-panel-w" value="${state.system.panelWidth}" min="0.5" max="2.5" step="0.001">
          </div>
          <div class="form-group">
            <label>Panel Height (m)</label>
            <input type="number" id="inp-panel-h" value="${state.system.panelHeight}" min="0.5" max="3" step="0.001">
          </div>
          <div class="form-group">
            <label>Orientation</label>
            <div style="display:flex;gap:6px;padding-top:4px">
              <button class="btn btn-sm${isPortrait ? ' btn-active' : ''}" id="btn-portrait">Portrait</button>
              <button class="btn btn-sm${!isPortrait ? ' btn-active' : ''}" id="btn-landscape">Landscape</button>
            </div>
          </div>
          <div class="form-group">
            <label>Inverter Type</label>
            <select id="inp-inv-type">
              <option value="micro" ${state.system.inverterType === 'micro' ? 'selected' : ''}>Microinverter</option>
              <option value="string" ${state.system.inverterType === 'string' ? 'selected' : ''}>String Inverter</option>
            </select>
          </div>
          <div class="form-group">
            <label>Inverter Per-Panel AC (W)</label>
            <input type="number" id="inp-inv-w" value="${state.system.inverterWatts}" min="100" max="2000" step="10">
          </div>
          <div class="form-group">
            <label>System Losses (%)</label>
            <input type="number" id="inp-sys-loss" value="${state.system.systemLosses}" min="0" max="40" step="0.1">
            <span class="hint">PVWatts default: 14.08%</span>
          </div>
        </div>
      </div>

      <!-- Array Configuration -->
      <div class="card">
        <div class="card-header">
          <h2>Array Layout</h2>
        </div>
        <div class="grid-2" style="gap:20px;align-items:start">
          <div>
            <div class="form-grid">
              <div class="form-group">
                <label>Rows</label>
                <input type="number" id="inp-rows" value="${state.system.rows}" min="1" max="20" step="1">
              </div>
              <div class="form-group">
                <label>Columns</label>
                <input type="number" id="inp-cols" value="${state.system.cols}" min="1" max="50" step="1">
              </div>
              <div class="form-group">
                <label>Tilt (\u00B0)</label>
                <input type="number" id="inp-tilt" value="${state.system.tilt}" min="0" max="90" step="0.5">
                <span class="hint">0 = flat, 90 = vertical</span>
              </div>
              <div class="form-group">
                <label>Azimuth (\u00B0)</label>
                <input type="number" id="inp-azimuth" value="${state.system.azimuth}" min="0" max="360" step="0.5">
                <span class="hint">180 = due south</span>
              </div>
              <div class="form-group">
                <label>Diode Split</label>
                <select id="inp-diode-split">
                  <option value="horizontal" ${state.system.diodeSplit === 'horizontal' ? 'selected' : ''}>Horizontal</option>
                  <option value="vertical" ${state.system.diodeSplit === 'vertical' ? 'selected' : ''}>Vertical</option>
                </select>
                <span class="hint">Bypass diode division</span>
              </div>
              <div class="form-group">
                <label>Diode Sub-sections</label>
                <input type="number" id="inp-diode-subs" value="${state.system.diodeSubsections}" min="1" max="6" step="1">
                <span class="hint">Usually 2 or 3</span>
              </div>
            </div>
            <div style="margin-top:16px; display:flex; flex-wrap:wrap; gap:12px; align-items:center">
              <div style="padding:10px 14px; background:var(--surface2); border-radius:var(--radius-sm)">
                <span style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px">Panels</span><br>
                <span id="setup-n-panels" style="font-size:18px;font-weight:700;font-family:'JetBrains Mono',monospace;color:var(--text)">${state.system.rows * state.system.cols}</span>
              </div>
              <div style="padding:10px 14px; background:var(--surface2); border-radius:var(--radius-sm)">
                <span style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px">DC Capacity</span><br>
                <span id="setup-dc" style="font-size:18px;font-weight:700;font-family:'JetBrains Mono',monospace;color:var(--sun)">${(state.system.rows * state.system.cols * state.system.panelWp / 1000).toFixed(1)} kW</span>
              </div>
              <div style="padding:10px 14px; background:var(--surface2); border-radius:var(--radius-sm)">
                <span style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px">AC Capacity</span><br>
                <span id="setup-ac" style="font-size:18px;font-weight:700;font-family:'JetBrains Mono',monospace;color:var(--shade)">${(state.system.rows * state.system.cols * state.system.inverterWatts / 1000).toFixed(1)} kW</span>
              </div>
              <div style="padding:10px 14px; background:var(--surface2); border-radius:var(--radius-sm)">
                <span style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px">DC/AC Ratio</span><br>
                <span id="setup-dcac" style="font-size:18px;font-weight:700;font-family:'JetBrains Mono',monospace">${(state.system.panelWp / state.system.inverterWatts).toFixed(2)}</span>
              </div>
            </div>
          </div>
          <!-- Visualizer -->
          <div>
            <div style="background:var(--surface2);border-radius:var(--radius-sm);overflow:hidden;position:relative">
              <canvas id="setup-viz-canvas" style="display:block;width:100%"></canvas>
            </div>
            <div id="setup-viz-dims" style="text-align:center;margin-top:6px;font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--text3)"></div>
          </div>
        </div>
      </div>

      <div style="text-align:center;margin-top:8px">
        <button class="btn btn-primary" id="btn-next-array" style="padding:10px 32px;font-size:14px">
          Continue to Array &amp; Photos \u2192
        </button>
      </div>
    </div>
  `;

  initViz();
  bindEvents();
}

function bindEvents() {
  const dSave = debounce(saveAll, 300);

  // All inputs trigger save
  for (const inp of _container.querySelectorAll('input, select')) {
    inp.addEventListener('input', dSave);
    inp.addEventListener('change', dSave);
  }

  // Portrait / Landscape toggle
  qs('#btn-portrait', _container).addEventListener('click', () => setOrientation('portrait'));
  qs('#btn-landscape', _container).addEventListener('click', () => setOrientation('landscape'));

  // Geolocate button
  qs('#btn-geolocate', _container).addEventListener('click', geolocate);

  // Next button
  qs('#btn-next-array', _container).addEventListener('click', () => {
    document.querySelector('[data-view="array"]').click();
  });
}

function setOrientation(mode) {
  const wInp = qs('#inp-panel-w', _container);
  const hInp = qs('#inp-panel-h', _container);
  let w = parseFloat(wInp.value) || 1.134;
  let h = parseFloat(hInp.value) || 2.278;

  if (mode === 'portrait' && h < w) { [w, h] = [h, w]; }
  else if (mode === 'landscape' && w < h) { [w, h] = [h, w]; }
  else return; // already in requested orientation

  wInp.value = w;
  hInp.value = h;

  qs('#btn-portrait', _container).classList.toggle('btn-active', mode === 'portrait');
  qs('#btn-landscape', _container).classList.toggle('btn-active', mode === 'landscape');

  saveAll();
}

function saveAll() {
  const g = (id) => qs('#' + id, _container);

  const pw = parseFloat(g('inp-panel-w').value) || 1.134;
  const ph = parseFloat(g('inp-panel-h').value) || 2.278;

  batchUpdate({
    'name': g('inp-project-name').value,
    'location.lat': parseNum(g('inp-lat').value),
    'location.lon': parseNum(g('inp-lon').value),
    'location.alt': parseNum(g('inp-alt').value),
    'location.address': g('inp-address').value,
    'system.panelWp': parseInt(g('inp-wp').value) || 410,
    'system.panelWidth': pw,
    'system.panelHeight': ph,
    'system.inverterType': g('inp-inv-type').value,
    'system.inverterWatts': parseInt(g('inp-inv-w').value) || 320,
    'system.systemLosses': parseFloat(g('inp-sys-loss').value) || 14.08,
    'system.rows': Math.max(1, parseInt(g('inp-rows').value) || 2),
    'system.cols': Math.max(1, parseInt(g('inp-cols').value) || 10),
    'system.tilt': parseFloat(g('inp-tilt').value) || 30,
    'system.azimuth': parseFloat(g('inp-azimuth').value) || 180,
    'system.diodeSplit': g('inp-diode-split').value,
    'system.diodeSubsections': Math.max(1, parseInt(g('inp-diode-subs').value) || 2),
  });

  // Sync orientation buttons
  const isP = ph >= pw;
  qs('#btn-portrait', _container)?.classList.toggle('btn-active', isP);
  qs('#btn-landscape', _container)?.classList.toggle('btn-active', !isP);

  rebuildPoints();
  updateSummary();
  drawViz();
}

function updateSummary() {
  const s = getState().system;
  const n = s.rows * s.cols;
  const setTxt = (id, txt) => {
    const e = qs('#' + id, _container);
    if (e) e.textContent = txt;
  };
  setTxt('setup-n-panels', n);
  setTxt('setup-dc', (n * s.panelWp / 1000).toFixed(1) + ' kW');
  setTxt('setup-ac', (n * s.inverterWatts / 1000).toFixed(1) + ' kW');

  const ratio = s.panelWp / s.inverterWatts;
  const dcacEl = qs('#setup-dcac', _container);
  if (dcacEl) {
    dcacEl.textContent = ratio.toFixed(2);
    dcacEl.style.color = ratio > 1.35 ? 'var(--loss)' : ratio > 1.2 ? 'var(--sun)' : 'var(--gain)';
  }
}

// ─── Array Layout Visualizer ────────────────────────

function initViz() {
  _vizCanvas = qs('#setup-viz-canvas', _container);
  if (!_vizCanvas) return;
  _vizCtx = _vizCanvas.getContext('2d');
  _vizDpr = window.devicePixelRatio || 1;
  drawViz();
}

function drawViz() {
  if (!_vizCtx) return;
  const state = getState();
  const { rows, cols, panelWidth, panelHeight, diodeSplit, diodeSubsections, azimuth } = state.system;
  const nSubs = diodeSubsections || 2;
  const wrap = _vizCanvas.parentElement;
  const wrapW = wrap.clientWidth;

  const VIZ_PAD = 20;
  const VIZ_GAP = 3;
  const aspect = panelHeight / panelWidth;

  const availW = wrapW - 2 * VIZ_PAD - (cols - 1) * VIZ_GAP;
  let pW = availW / cols;
  let pH = pW * aspect;

  // Limit to reasonable height
  const gridH = rows * pH + (rows - 1) * VIZ_GAP;
  const maxH = 320;
  if (gridH > maxH) {
    const sc = maxH / gridH;
    pW *= sc;
    pH *= sc;
  }

  const totalW = cols * pW + (cols - 1) * VIZ_GAP;
  const totalH = rows * pH + (rows - 1) * VIZ_GAP;
  const ox = (wrapW - totalW) / 2;
  const azLabel = `Az ${azimuth}\u00B0`;
  const canvasH = totalH + 2 * VIZ_PAD + 16;

  _vizCanvas.width = Math.round(wrapW * _vizDpr);
  _vizCanvas.height = Math.round(canvasH * _vizDpr);
  _vizCanvas.style.height = canvasH + 'px';
  _vizCtx.setTransform(_vizDpr, 0, 0, _vizDpr, 0, 0);

  const ctx = _vizCtx;
  const oy = VIZ_PAD;

  ctx.clearRect(0, 0, wrapW, canvasH);

  // Azimuth indicator arrow at bottom
  ctx.save();
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.textAlign = 'center';
  const arrowY = oy + totalH + 14;
  ctx.fillText('\u2193 ' + azLabel + ' (facing)', wrapW / 2, arrowY);
  ctx.restore();

  // Draw panels
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = ox + c * (pW + VIZ_GAP);
      const py = oy + r * (pH + VIZ_GAP);

      // Panel background
      ctx.fillStyle = 'rgba(96,165,250,0.1)';
      vizRoundRect(ctx, px, py, pW, pH, 3);
      ctx.fill();

      // Panel border
      ctx.strokeStyle = 'rgba(96,165,250,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Diode split lines
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([2, 2]);

      if (diodeSplit === 'vertical') {
        for (let s = 1; s < nSubs; s++) {
          const sx = px + (s / nSubs) * pW;
          ctx.beginPath(); ctx.moveTo(sx, py + 2); ctx.lineTo(sx, py + pH - 2); ctx.stroke();
        }
      } else {
        for (let s = 1; s < nSubs; s++) {
          const sy = py + (s / nSubs) * pH;
          ctx.beginPath(); ctx.moveTo(px + 2, sy); ctx.lineTo(px + pW - 2, sy); ctx.stroke();
        }
      }
      ctx.restore();

      // Panel label
      if (pW > 20 && pH > 14) {
        ctx.save();
        ctx.font = pW > 40 ? '9px "JetBrains Mono", monospace' : '7px "JetBrains Mono", monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${String.fromCharCode(65 + r)}${c + 1}`, px + pW / 2, py + pH / 2);
        ctx.restore();
      }
    }
  }

  // Dimensions label
  const dimsEl = qs('#setup-viz-dims', _container);
  if (dimsEl) {
    const arrW = (cols * panelWidth).toFixed(1);
    const arrH = (rows * panelHeight).toFixed(1);
    dimsEl.textContent = `${arrW}m \u00D7 ${arrH}m \u2022 ${cols}\u00D7${rows} = ${cols * rows} panels`;
  }
}

function vizRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }
}

function geolocate() {
  const status = qs('#geo-status', _container);
  if (!navigator.geolocation) {
    status.textContent = 'Geolocation not supported';
    return;
  }
  status.textContent = 'Requesting location...';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      qs('#inp-lat', _container).value = pos.coords.latitude.toFixed(4);
      qs('#inp-lon', _container).value = pos.coords.longitude.toFixed(4);
      if (pos.coords.altitude != null) {
        qs('#inp-alt', _container).value = Math.round(pos.coords.altitude);
      }
      status.textContent = 'Location updated';
      batchUpdate({
        'location.lat': pos.coords.latitude,
        'location.lon': pos.coords.longitude,
        'location.alt': pos.coords.altitude,
        'location.source': 'browser-geolocation',
      });
    },
    (err) => {
      status.textContent = `Error: ${err.message}`;
    },
    { enableHighAccuracy: true }
  );
}

function parseNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
