/**
 * SolarScope — Report View
 * Professional shade analysis report with SAV, TOF, TSRF,
 * monthly/hourly tables, scenario comparison, and array heatmap.
 */

import { getState, setState, getSubPanels, getMergedHorizon } from '../state.js';
import {
  el, qs, qsa, clearEl, savColor, fmtPct, fmtNum, fmtDeg, fmtLatLon
} from '../utils.js';
import {
  runFullAnalysis, runComparison, computeAllSunPaths,
  sunPosition, solarDeclination,
  MONTHS, MDAYS, MDAYS_CUM
} from '../solar-engine.js';

let _container = null;
let _results = null;
let _comparison = null;

// Shade-map canvas state
let _smCanvas = null;
let _smCtx = null;
let _smDpr = 1;
let _smLayout = null;   // { panelW, panelH, originX, originY, rows, cols, nSubs }
let _subHorizons = null; // Float32Array(360)[]

export function render(container) {
  _container = container;
  clearEl(container);

  const state = getState();

  if (state.location.lat == null) {
    container.innerHTML = `
      <div class="card fade-in" style="text-align:center;padding:60px 20px">
        <h2 style="font-size:16px;color:var(--text);margin-bottom:8px">Location Required</h2>
        <p class="hint" style="max-width:400px;margin:0 auto 16px">
          Set a location in the Setup tab, or upload a geotagged Insta360 photo.
        </p>
        <button class="btn btn-primary" onclick="document.querySelector('[data-view=setup]').click()">
          Go to Setup
        </button>
      </div>
    `;
    return;
  }

  // Run analysis
  _results = runFullAnalysis();

  // Check for comparison scenario
  const scenarios = getAllScenarios();
  _comparison = null;
  if (state.compareScenario && state.compareScenario !== state.activeScenario) {
    _comparison = runComparison(state.activeScenario, state.compareScenario);
  }

  buildReport();
}

function getAllScenarios() {
  const state = getState();
  const names = new Set();
  for (const photo of Object.values(state.photos)) {
    for (const name of Object.keys(photo.traces)) {
      names.add(name);
    }
  }
  return [...names];
}

function buildReport() {
  const state = getState();
  const r = _results;
  if (!r) {
    _container.innerHTML = '<div class="card"><p class="hint">Unable to compute analysis. Check setup and traces.</p></div>';
    return;
  }

  const scenarios = getAllScenarios();

  _container.innerHTML = `
    <div class="fade-in">
      <!-- Report header -->
      <div class="card">
        <div class="report-header">
          <h1>${esc(state.name || 'Solar Shade Analysis Report')}</h1>
          <p class="report-subtitle">
            Professional metrics: SAV, TOF, TSRF &middot; Diffuse irradiance &middot; POA transposition
            &middot; ${fmtLatLon(state.location.lat, state.location.lon)}
            ${state.location.address ? ` &middot; ${esc(state.location.address)}` : ''}
          </p>
        </div>
      </div>

      <!-- Scenario selector -->
      ${scenarios.length > 1 ? `
        <div class="card" style="padding:12px">
          <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:8px">
              <label style="font-size:12px;color:var(--text2)">Scenario:</label>
              <select id="sel-scenario" style="background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 10px;font-size:12px">
                ${scenarios.map(s => `<option value="${s}" ${s === state.activeScenario ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <label style="font-size:12px;color:var(--text2)">Compare with:</label>
              <select id="sel-compare" style="background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 10px;font-size:12px">
                <option value="">None</option>
                ${scenarios.map(s => `<option value="${s}" ${s === state.compareScenario ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </div>
            <button class="btn btn-sm btn-primary" id="btn-recalc">Recalculate</button>
          </div>
        </div>
      ` : ''}

      <!-- Comparison banner -->
      ${_comparison ? `
        <div class="comparison-banner">
          <div style="flex:1">
            <div class="comp-label">Impact of "${esc(state.compareScenario)}" vs "${esc(state.activeScenario)}"</div>
          </div>
          <div style="text-align:center">
            <div class="comp-label">SAV Change</div>
            <div class="comp-value">${_comparison.delta.savDiff >= 0 ? '+' : ''}${fmtPct(_comparison.delta.savDiff)}</div>
          </div>
          <div style="text-align:center">
            <div class="comp-label">Annual kWh Change</div>
            <div class="comp-value">${_comparison.delta.kwhDiff >= 0 ? '+' : ''}${fmtNum(_comparison.delta.kwhDiff)} kWh</div>
          </div>
          <div style="text-align:center">
            <div class="comp-label">kWh Change %</div>
            <div class="comp-value">${_comparison.delta.kwhPctDiff >= 0 ? '+' : ''}${fmtPct(_comparison.delta.kwhPctDiff)}</div>
          </div>
        </div>
      ` : ''}

      <!-- System config summary -->
      <div class="card">
        <h2>System Configuration</h2>
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px">
          ${cfgItem('Tilt', fmtDeg(state.system.tilt))}
          ${cfgItem('Azimuth', fmtDeg(state.system.azimuth))}
          ${cfgItem('Panel Wp', state.system.panelWp + 'W')}
          ${cfgItem('AC Clip', state.system.inverterWatts + 'W')}
          ${cfgItem('Panels', `${r.numPanels} (${state.system.rows}×${state.system.cols})`)}
          ${cfgItem('DC Capacity', r.dcCapacity.toFixed(1) + ' kW')}
          ${cfgItem('AC Capacity', r.acCapacity.toFixed(1) + ' kW')}
          ${cfgItem('DC/AC Ratio', (state.system.panelWp / state.system.inverterWatts).toFixed(2))}
        </div>
      </div>

      <!-- Key metrics -->
      <div class="stats-row">
        <div class="stat">
          <div class="stat-label">SAV (Shade Access Value)</div>
          <div class="stat-value gain">${fmtPct(r.avgSAV)}</div>
        </div>
        <div class="stat">
          <div class="stat-label">TOF (Tilt/Orientation)</div>
          <div class="stat-value info">${fmtPct(r.tof)}</div>
        </div>
        <div class="stat">
          <div class="stat-label">TSRF (Total Solar Resource)</div>
          <div class="stat-value sun">${fmtPct(r.tsrf)}</div>
        </div>
      </div>

      <div class="stats-row">
        <div class="stat">
          <div class="stat-label">Clear-sky kWh</div>
          <div class="stat-value sun">${fmtNum(r.clearKwh)}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Weather Loss</div>
          <div class="stat-value" style="color:var(--text2)">−${fmtNum(Math.abs(r.weatherLoss))}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Shade Loss</div>
          <div class="stat-value loss">−${fmtNum(Math.abs(r.shadeLoss))}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Clip Loss</div>
          <div class="stat-value loss">−${fmtNum(Math.abs(r.clipLoss))}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Net Annual kWh</div>
          <div class="stat-value gain">${fmtNum(r.netKwh)}</div>
        </div>
      </div>

      <div class="grid-2">
        <!-- Panel array heatmap -->
        <div class="card">
          <h2>Panel Array — Solar Access per Sub-Panel</h2>
          <div class="array-container" id="report-array"></div>
          <div class="legend-row" style="justify-content:center;gap:12px;margin-top:8px">
            <span class="legend-label">Low SAV</span>
            <div class="legend-bar" style="background:linear-gradient(90deg,#ef4444,#f5a623,#22c55e)"></div>
            <span class="legend-label">100%</span>
          </div>
        </div>

        <!-- Monthly bar chart -->
        <div class="card">
          <h2>Monthly Energy Production (kWh)</h2>
          <canvas id="c-monthly-report" width="600" height="250" style="width:100%"></canvas>
        </div>
      </div>

      <!-- Interactive shade map -->
      <div class="card">
        <div class="card-header">
          <h2>Shade Map — Time Simulator</h2>
          <div id="sm-status" style="font-size:12px;font-family:'JetBrains Mono',monospace;color:var(--text2)"></div>
        </div>
        <div id="shade-map-wrap" style="position:relative;width:100%;background:var(--surface2);border-radius:var(--radius-sm);overflow:hidden">
          <canvas id="c-shade-map" style="display:block;width:100%"></canvas>
        </div>
        <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;margin-top:12px">
          <div style="flex:1;min-width:200px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
              <label style="font-size:11px;color:var(--text2)">Date</label>
              <span id="sm-date-label" style="font-size:12px;font-family:'JetBrains Mono',monospace;color:var(--sun)"></span>
            </div>
            <input type="range" id="sm-doy" min="1" max="365" value="172" style="width:100%">
          </div>
          <div style="flex:1;min-width:200px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
              <label style="font-size:11px;color:var(--text2)">Time</label>
              <span id="sm-time-label" style="font-size:12px;font-family:'JetBrains Mono',monospace;color:var(--sun)"></span>
            </div>
            <input type="range" id="sm-hour" min="-105" max="105" value="0" step="1" style="width:100%">
          </div>
          <div style="text-align:center;min-width:100px">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.4px">Shaded</div>
            <div id="sm-shaded-count" style="font-size:18px;font-weight:700;font-family:'JetBrains Mono',monospace;color:var(--loss)"></div>
          </div>
        </div>
        <div class="legend-row" style="justify-content:center;gap:16px;margin-top:10px">
          <span class="legend-label" style="display:flex;align-items:center;gap:4px">
            <span style="width:12px;height:12px;border-radius:2px;background:#22c55e;display:inline-block"></span> Full sun
          </span>
          <span class="legend-label" style="display:flex;align-items:center;gap:4px">
            <span style="width:12px;height:12px;border-radius:2px;background:#f5a623;display:inline-block"></span> Partial shade
          </span>
          <span class="legend-label" style="display:flex;align-items:center;gap:4px">
            <span style="width:12px;height:12px;border-radius:2px;background:#ef4444;display:inline-block"></span> Full shade
          </span>
          <span class="legend-label" style="display:flex;align-items:center;gap:4px">
            <span style="width:12px;height:12px;border-radius:2px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);display:inline-block"></span> Night
          </span>
        </div>
      </div>

      <!-- Monthly solar access table -->
      <div class="card">
        <h2>Monthly Solar Access Table (Array Average)</h2>
        <div style="overflow-x:auto" id="monthly-table"></div>
      </div>

      <!-- Hourly access table -->
      <div class="card">
        <h2>Hourly Solar Access</h2>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
          <label style="font-size:11px;color:var(--text2)">Month:</label>
          <select id="sel-hourly-month" style="background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 8px;font-size:12px">
            <option value="-1">Annual Average</option>
            ${MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join('')}
          </select>
        </div>
        <div style="overflow-x:auto" id="hourly-table"></div>
      </div>

      <!-- Per-panel detail -->
      <div class="card">
        <h2>Per-Panel Solar Access Detail</h2>
        <div style="overflow-x:auto" id="panel-detail-table"></div>
      </div>

      <!-- Print button -->
      <div style="text-align:center;margin-top:16px;margin-bottom:32px">
        <button class="btn btn-primary" onclick="window.print()" style="padding:10px 32px;font-size:14px">
          &#128424; Print / PDF Report
        </button>
      </div>
    </div>
  `;

  buildPanelHeatmap();
  drawMonthlyChart();
  initShadeMap();
  buildMonthlyTable();
  buildHourlyTable(-1);
  buildPanelDetailTable();
  bindReportEvents();
}

function bindReportEvents() {
  qs('#sel-scenario', _container)?.addEventListener('change', (e) => {
    setState('activeScenario', e.target.value);
  });

  qs('#sel-compare', _container)?.addEventListener('change', (e) => {
    setState('compareScenario', e.target.value || null);
  });

  qs('#btn-recalc', _container)?.addEventListener('click', () => {
    render(_container);
  });

  qs('#sel-hourly-month', _container)?.addEventListener('change', (e) => {
    buildHourlyTable(parseInt(e.target.value));
  });

  qs('#sm-doy', _container)?.addEventListener('input', updateShadeMap);
  qs('#sm-hour', _container)?.addEventListener('input', updateShadeMap);
}

// --- Panel heatmap ---

function buildPanelHeatmap() {
  const elWrap = qs('#report-array', _container);
  if (!elWrap || !_results) return;
  clearEl(elWrap);

  const state = getState();
  const { rows, cols } = state.system;
  const subPanels = _results.subPanels;
  const subResults = _results.subResults;
  const nSubs = subPanels.length > 0 ? subPanels[0].nSubs : 2;

  for (let r = 0; r < rows; r++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'array-row';

    for (let c = 0; c < cols; c++) {
      const colWrap = document.createElement('div');
      colWrap.style.display = 'flex';
      colWrap.style.flexDirection = 'column';
      colWrap.style.gap = '1px';

      for (let s = 0; s < nSubs; s++) {
        const idx = (r * cols + c) * nSubs + s;
        const sp = subPanels[idx];
        if (!sp) continue;

        const sr = subResults[idx];
        const sav = sr ? sr.sav : 1;

        const cell = document.createElement('div');
        cell.className = 'panel-cell';
        cell.style.width = '44px';
        cell.style.height = Math.round(44 / nSubs) + 'px';
        cell.style.background = savColor(sav);
        cell.style.fontSize = '8px';
        cell.title = `${sp.label} ${sp.subLabel}: SAV ${fmtPct(sav)}`;
        cell.textContent = s === 0 ? sp.label : '';
        colWrap.appendChild(cell);
      }
      rowEl.appendChild(colWrap);
    }
    elWrap.appendChild(rowEl);
  }
}

// --- Monthly chart ---

function drawMonthlyChart() {
  const canvas = qs('#c-monthly-report', _container);
  if (!canvas || !_results) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const pad = { l: 50, r: 14, t: 14, b: 28 };

  ctx.clearRect(0, 0, W, H);

  const mkwh = _results.monthlyKwh;
  const maxV = Math.max(1, ...mkwh) * 1.15;
  const bw = (W - pad.l - pad.r) / 12;

  for (let m = 0; m < 12; m++) {
    const x = pad.l + m * bw;
    const barH = (mkwh[m] / maxV) * (H - pad.t - pad.b);

    // Bar
    ctx.fillStyle = '#22c55e66';
    ctx.fillRect(x + 4, H - pad.b - barH, bw - 8, barH);

    // Value on top
    ctx.fillStyle = '#22c55ecc';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    if (mkwh[m] > 0) {
      ctx.fillText(Math.round(mkwh[m]), x + bw / 2, H - pad.b - barH - 4);
    }

    // Comparison bar
    if (_comparison) {
      const altH = (_comparison.alternative.monthlyKwh[m] / maxV) * (H - pad.t - pad.b);
      ctx.strokeStyle = '#f5a62388';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 2]);
      ctx.strokeRect(x + 6, H - pad.b - altH, bw - 12, altH);
      ctx.setLineDash([]);
    }

    // Month label
    ctx.fillStyle = '#546e7a';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(MONTHS[m], x + bw / 2, H - pad.b + 14);
  }

  // Y-axis labels
  ctx.fillStyle = '#546e7a';
  ctx.font = '9px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  for (let v = 0; v <= maxV; v += Math.ceil(maxV / 5 / 100) * 100) {
    const y = H - pad.b - (v / maxV) * (H - pad.t - pad.b);
    ctx.fillText(v, pad.l - 6, y + 3);
    ctx.strokeStyle = '#252d3d';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
  }
}

// --- Monthly solar access table ---

function buildMonthlyTable() {
  const wrap = qs('#monthly-table', _container);
  if (!wrap || !_results) return;

  const subPanels = _results.subPanels;
  const subResults = _results.subResults;

  let html = '<table class="data-tbl"><tr><th></th>';
  for (const m of MONTHS) html += `<th>${m}</th>`;
  html += '<th>Annual</th></tr>';

  // SAV row
  html += '<tr><td style="text-align:left;color:var(--text2)">SAV %</td>';
  let annSavSum = 0;
  for (let m = 0; m < 12; m++) {
    let savM = 0;
    for (let i = 0; i < subPanels.length; i++) {
      const r = subResults[i];
      savM += r ? r.mSAV[m] : 1;
    }
    savM /= subPanels.length;
    annSavSum += savM;
    const c = savM > 0.95 ? 'var(--gain)' : savM > 0.8 ? 'var(--sun)' : 'var(--loss)';
    html += `<td style="color:${c}">${(savM * 100).toFixed(1)}</td>`;
  }
  const annSav = annSavSum / 12;
  html += `<td style="color:var(--sun);font-weight:600">${(annSav * 100).toFixed(1)}</td></tr>`;

  // TSRF row
  html += '<tr><td style="text-align:left;color:var(--text2)">TSRF %</td>';
  for (let m = 0; m < 12; m++) {
    let savM = 0;
    for (let i = 0; i < subPanels.length; i++) {
      const r = subResults[i];
      savM += r ? r.mSAV[m] : 1;
    }
    savM /= subPanels.length;
    const tsrf = savM * _results.tof;
    const c = tsrf > 0.9 ? 'var(--gain)' : tsrf > 0.75 ? 'var(--sun)' : 'var(--loss)';
    html += `<td style="color:${c}">${(tsrf * 100).toFixed(1)}</td>`;
  }
  html += `<td style="color:var(--sun);font-weight:600">${(_results.tsrf * 100).toFixed(1)}</td></tr>`;

  // Monthly kWh row
  html += '<tr><td style="text-align:left;color:var(--text2)">kWh</td>';
  let totalKwh = 0;
  for (let m = 0; m < 12; m++) {
    totalKwh += _results.monthlyKwh[m];
    html += `<td>${Math.round(_results.monthlyKwh[m])}</td>`;
  }
  html += `<td style="font-weight:600">${fmtNum(totalKwh)}</td></tr>`;

  html += '</table>';
  wrap.innerHTML = html;
}

// --- Hourly access table ---

function buildHourlyTable(month) {
  const wrap = qs('#hourly-table', _container);
  if (!wrap || !_results) return;

  const subResults = _results.subResults;
  const hours = ['6a', '7a', '8a', '9a', '10a', '11a', '12p', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p'];

  let html = '<table class="data-tbl"><tr><th>Hour</th>';
  for (const h of hours) html += `<th>${h}</th>`;
  html += '</tr>';

  html += '<tr><td style="text-align:left;color:var(--text2)">SAV %</td>';
  for (let hi = 0; hi < 15; hi++) {
    let num = 0, den = 0;
    if (month === -1) {
      for (let mm = 0; mm < 12; mm++) {
        for (const r of subResults) {
          if (!r) continue;
          num += r.hourlyIrrad_shaded[mm * 15 + hi];
          den += r.hourlyIrrad_noshade[mm * 15 + hi];
        }
      }
    } else {
      for (const r of subResults) {
        if (!r) continue;
        num += r.hourlyIrrad_shaded[month * 15 + hi];
        den += r.hourlyIrrad_noshade[month * 15 + hi];
      }
    }
    const sav = den > 0 ? num / den : 1;
    const c = den < 1 ? 'var(--text3)' : sav > 0.95 ? 'var(--gain)' : sav > 0.8 ? 'var(--sun)' : 'var(--loss)';
    html += `<td style="color:${c}">${den < 1 ? '\u2014' : (sav * 100).toFixed(0)}</td>`;
  }
  html += '</tr></table>';
  wrap.innerHTML = html;
}

// --- Per-panel detail table ---

function buildPanelDetailTable() {
  const wrap = qs('#panel-detail-table', _container);
  if (!wrap || !_results) return;

  const state = getState();
  const { rows, cols } = state.system;
  const subPanels = _results.subPanels;
  const subResults = _results.subResults;
  const nSubs = subPanels.length > 0 ? subPanels[0].nSubs : 2;

  let html = '<table class="data-tbl"><tr><th>Panel</th><th>Section</th><th>SAV</th><th>Points</th><th>Photo</th><th>Traced</th></tr>';

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let s = 0; s < nSubs; s++) {
        const idx = (r * cols + c) * nSubs + s;
        const sp = subPanels[idx];
        if (!sp) continue;
        const sr = subResults[idx];
        const sav = sr ? sr.sav : 1;
        const nPts = sp.ptIds.length;

        // Check if any linked point has a photo/trace
        let hasPhoto = false, hasTrace = false;
        for (const pid of sp.ptIds) {
          const pt = state.points[pid];
          if (pt?.photoId && state.photos[pt.photoId]) {
            hasPhoto = true;
            const ph = state.photos[pt.photoId];
            if (Object.values(ph.traces).some(t => t.paths.length > 0)) hasTrace = true;
          }
        }

        const savC = sav > 0.95 ? 'var(--gain)' : sav > 0.8 ? 'var(--sun)' : 'var(--loss)';
        html += `<tr>
          <td>${sp.label}</td>
          <td>${sp.subLabel}</td>
          <td style="color:${savC}">${fmtPct(sav)}</td>
          <td>${nPts}</td>
          <td>${hasPhoto ? '&#10003;' : '\u2014'}</td>
          <td>${hasTrace ? '&#10003;' : '\u2014'}</td>
        </tr>`;
      }
    }
  }

  html += '</table>';
  wrap.innerHTML = html;
}

// --- Helpers ---

// ─── Interactive Shade Map ────────────────────────────

function initShadeMap() {
  _smCanvas = qs('#c-shade-map', _container);
  if (!_smCanvas || !_results) return;
  _smCtx = _smCanvas.getContext('2d');
  _smDpr = window.devicePixelRatio || 1;

  const state = getState();
  const { rows, cols } = state.system;
  const subPanels = _results.subPanels;
  const nSubs = subPanels.length > 0 ? subPanels[0].nSubs : 2;

  // Pre-compute merged horizons for all sub-panels
  const scn = state.activeScenario;
  _subHorizons = subPanels.map(sp => getMergedHorizon(sp.ptIds, scn));

  computeShadeMapLayout();
  updateShadeMap();

  // Observe resize
  new ResizeObserver(() => {
    computeShadeMapLayout();
    updateShadeMap();
  }).observe(_smCanvas.parentElement);
}

function computeShadeMapLayout() {
  if (!_smCanvas) return;
  const state = getState();
  const { rows, cols, panelWidth, panelHeight, diodeSplit, diodeSubsections } = state.system;
  const nSubs = diodeSubsections || 2;
  const wrap = _smCanvas.parentElement;
  const wrapW = wrap.clientWidth;

  const SM_PAD = 30;
  const SM_GAP = 4;
  const aspect = panelHeight / panelWidth;
  const availW = wrapW - 2 * SM_PAD - (cols - 1) * SM_GAP;
  let pW = Math.max(28, availW / cols);
  let pH = pW * aspect;

  const gridH = rows * pH + (rows - 1) * SM_GAP;
  if (gridH > 400) {
    const s = 400 / gridH;
    pW *= s;
    pH *= s;
  }

  const totalW = cols * pW + (cols - 1) * SM_GAP;
  const originX = (wrapW - totalW) / 2;
  const originY = SM_PAD;
  const canvasH = originY + rows * pH + (rows - 1) * SM_GAP + SM_PAD;

  _smCanvas.width = Math.round(wrapW * _smDpr);
  _smCanvas.height = Math.round(canvasH * _smDpr);
  _smCanvas.style.height = canvasH + 'px';
  _smCtx.setTransform(_smDpr, 0, 0, _smDpr, 0, 0);

  _smLayout = { panelW: pW, panelH: pH, originX, originY, rows, cols, nSubs, gap: SM_GAP, diodeSplit };
}

function updateShadeMap() {
  if (!_smCtx || !_smLayout || !_results) return;
  const state = getState();
  const lat = state.location.lat;
  if (lat == null) return;

  const doySlider = qs('#sm-doy', _container);
  const hourSlider = qs('#sm-hour', _container);
  if (!doySlider || !hourSlider) return;

  const doy = +doySlider.value;
  const ha = +hourSlider.value;

  // Update labels
  const dateEl = qs('#sm-date-label', _container);
  const timeEl = qs('#sm-time-label', _container);
  const statusEl = qs('#sm-status', _container);
  const countEl = qs('#sm-shaded-count', _container);

  if (dateEl) dateEl.textContent = doyToStr(doy);
  if (timeEl) timeEl.textContent = haToStr(ha);

  // Compute sun position
  const decl = solarDeclination(doy);
  const sun = sunPosition(lat, decl, ha);

  const isNight = sun.elevation <= 0;

  if (statusEl) {
    statusEl.textContent = isNight
      ? 'Below horizon'
      : `Az ${sun.azimuth.toFixed(1)}\u00B0  El ${sun.elevation.toFixed(1)}\u00B0`;
  }

  // Per-sub-panel shade check
  const { rows, cols, nSubs } = _smLayout;
  const subPanels = _results.subPanels;
  const subResults = _results.subResults;
  const az = Math.round(sun.azimuth) % 360;
  const totalSubs = subPanels.length;
  const shadeState = new Uint8Array(totalSubs); // 0=shaded, 1=lit

  if (!isNight) {
    for (let i = 0; i < totalSubs; i++) {
      const h = _subHorizons[i];
      shadeState[i] = sun.elevation > h[az] ? 1 : 0;
    }
  }

  // Count panel shade status (0 subs shaded, some, all)
  let shadedPanelCount = 0;
  for (let p = 0; p < rows * cols; p++) {
    let shadedSubs = 0;
    for (let s = 0; s < nSubs; s++) {
      if (!shadeState[p * nSubs + s]) shadedSubs++;
    }
    if (shadedSubs > 0) shadedPanelCount++;
  }

  if (countEl) {
    countEl.textContent = isNight
      ? '\u2014'
      : `${shadedPanelCount} / ${rows * cols}`;
  }

  // Draw
  drawShadeMapCanvas(sun, isNight, shadeState, subResults);
}

function drawShadeMapCanvas(sun, isNight, shadeState, subResults) {
  const ctx = _smCtx;
  const L = _smLayout;
  const w = _smCanvas.width / _smDpr;
  const h = _smCanvas.height / _smDpr;

  ctx.clearRect(0, 0, w, h);

  const { rows, cols, nSubs, panelW, panelH, originX, originY, gap, diodeSplit } = L;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = originX + c * (panelW + gap);
      const py = originY + r * (panelH + gap);

      // Draw sub-panels
      for (let s = 0; s < nSubs; s++) {
        const idx = (r * cols + c) * nSubs + s;
        const sr = subResults[idx];
        const sav = sr ? sr.sav : 1;
        const isLit = shadeState[idx];

        let sx, sy, sw, sh;
        if (diodeSplit === 'vertical') {
          sw = panelW / nSubs;
          sh = panelH;
          sx = px + s * sw;
          sy = py;
        } else {
          sw = panelW;
          sh = panelH / nSubs;
          sx = px;
          sy = py + s * sh;
        }

        // Fill color depends on mode
        if (isNight) {
          ctx.fillStyle = 'rgba(255,255,255,0.04)';
        } else if (isLit) {
          // Lit — tint by SAV (green to yellow)
          ctx.fillStyle = savToLitColor(sav);
        } else {
          // Shaded — orange to red based on SAV
          ctx.fillStyle = savToShadedColor(sav);
        }

        smRoundRect(ctx, sx, sy, sw, sh, 2);
        ctx.fill();

        // Border
        ctx.strokeStyle = isNight
          ? 'rgba(255,255,255,0.06)'
          : isLit ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }

      // Diode split lines
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([2, 2]);
      if (diodeSplit === 'vertical') {
        for (let s = 1; s < nSubs; s++) {
          const lx = px + (s / nSubs) * panelW;
          ctx.beginPath(); ctx.moveTo(lx, py + 1); ctx.lineTo(lx, py + panelH - 1); ctx.stroke();
        }
      } else {
        for (let s = 1; s < nSubs; s++) {
          const ly = py + (s / nSubs) * panelH;
          ctx.beginPath(); ctx.moveTo(px + 1, ly); ctx.lineTo(px + panelW - 1, ly); ctx.stroke();
        }
      }
      ctx.restore();

      // Panel label
      if (panelW > 22) {
        ctx.save();
        ctx.font = panelW > 40
          ? '9px "JetBrains Mono", monospace'
          : '7px "JetBrains Mono", monospace';
        ctx.fillStyle = isNight ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.4)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${String.fromCharCode(65 + r)}${c + 1}`, px + panelW / 2, py + panelH / 2);
        ctx.restore();
      }
    }
  }
}

function savToLitColor(sav) {
  // Full sun: high SAV = bright green, lower = yellow-green
  const g = Math.round(140 + sav * 57);    // 140–197
  const r = Math.round(34 + (1 - sav) * 180); // 34–214
  const b = Math.round(94 * sav);          // 0–94
  return `rgba(${r},${g},${b},0.45)`;
}

function savToShadedColor(sav) {
  // Shaded: lower SAV = redder, higher = orange
  const r = Math.round(200 + (1 - sav) * 45);  // 200–245
  const g = Math.round(sav * 130);               // 0–130
  const b = Math.round(sav * 50);                // 0–50
  return `rgba(${r},${g},${b},0.5)`;
}

function smRoundRect(ctx, x, y, w, h, r) {
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

function doyToStr(d) {
  let m = 0;
  while (m < 11 && d > MDAYS_CUM[m + 1]) m++;
  return MONTHS[m] + ' ' + (d - MDAYS_CUM[m]);
}

function haToStr(ha) {
  const sh = 12 + ha / 15;
  const h = Math.floor(sh);
  const m = Math.round((sh - h) * 60);
  return (h > 12 ? h - 12 : (h || 12)) + ':' + String(m).padStart(2, '0') + (h >= 12 ? 'pm' : 'am');
}

// ─── End Shade Map ────────────────────────────────────

function cfgItem(label, value) {
  return `<div style="padding:8px 12px;background:var(--surface2);border-radius:var(--radius-sm);font-size:12px">
    <span style="color:var(--text2)">${label}:</span>
    <span style="font-family:'JetBrains Mono',monospace;margin-left:4px">${value}</span>
  </div>`;
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
