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
let _hmBaseImage = null; // cached base heatmap for overlay efficiency
let _hmPad = { l: 40, r: 14, t: 14, b: 6 };
let _subHorizons = null; // Float32Array(360)[]
let _allPaths = null;    // precomputed sun paths

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

      <!-- Sky visibility heatmap -->
      <div class="card">
        <h2>Sky Visibility Map</h2>
        <div class="hint" style="margin-bottom:8px;margin-top:-4px">
          Fraction of sub-panels with clear view to each sky position. Blue = visible, brown = blocked.
        </div>
        ${getAllScenarios().length > 1 ? `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <label style="font-size:11px;color:var(--text2)">Shade scenario:</label>
          <select id="sm-scenario" style="background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 10px;font-size:12px">
            ${getAllScenarios().map(s => `<option value="${esc(s)}" ${s === state.activeScenario ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </div>` : ''}
        <div id="shade-map-wrap" style="position:relative;width:100%;background:var(--surface2);border-radius:var(--radius-sm);overflow:hidden">
          <canvas id="c-shade-map" width="680" height="240" style="display:block;width:100%"></canvas>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:4px">
          <span class="legend-label">E (90°)</span><span class="legend-label">SE</span><span class="legend-label">S (180°)</span><span class="legend-label">SW</span><span class="legend-label">W (270°)</span>
        </div>
        <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
            <h3 style="margin:0;font-size:14px">Time Simulator</h3>
            <span id="sm-status" style="font-size:12px;font-family:'JetBrains Mono',monospace;color:var(--sun)">drag sliders</span>
          </div>
          <div style="display:flex;gap:16px;align-items:start;flex-wrap:wrap">
            <div style="flex:1;min-width:180px">
              <div style="display:flex;justify-content:space-between;margin-bottom:3px">
                <span style="font-size:10px;color:var(--text2)">Date</span>
                <span id="sm-date-label" style="font-size:12px;font-family:'JetBrains Mono',monospace;color:var(--sun)">Jun 21</span>
              </div>
              <input type="range" id="sm-doy" min="1" max="365" value="172" style="width:100%;accent-color:var(--sun)">
            </div>
            <div style="flex:1;min-width:180px">
              <div style="display:flex;justify-content:space-between;margin-bottom:3px">
                <span style="font-size:10px;color:var(--text2)">Time</span>
                <span id="sm-time-label" style="font-size:12px;font-family:'JetBrains Mono',monospace;color:var(--sun)">12:00pm</span>
              </div>
              <input type="range" id="sm-hour" min="-90" max="90" value="0" step="1" style="width:100%;accent-color:var(--sun)">
            </div>
            <div style="min-width:100px;padding:6px 10px;background:var(--surface2);border-radius:8px;text-align:center">
              <div style="font-size:9px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:1px">Shaded</div>
              <div id="sm-shaded-count" style="font-size:18px;font-weight:700;font-family:'JetBrains Mono',monospace;color:var(--loss)">&mdash;</div>
            </div>
          </div>
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

  qs('#sm-doy', _container)?.addEventListener('input', updateSimOverlay);
  qs('#sm-hour', _container)?.addEventListener('input', updateSimOverlay);

  // Shade map scenario dropdown
  qs('#sm-scenario', _container)?.addEventListener('change', (e) => {
    const scn = e.target.value;
    const subPanels = _results.subPanels;
    _subHorizons = subPanels.map(sp => getMergedHorizon(sp.ptIds, scn));
    drawHeatmapBase();
  });
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

// ─── Sky Visibility Heatmap ───────────────────────────

function initShadeMap() {
  _smCanvas = qs('#c-shade-map', _container);
  if (!_smCanvas || !_results) return;
  _smCtx = _smCanvas.getContext('2d');

  const state = getState();
  const subPanels = _results.subPanels;
  const scn = state.activeScenario;

  // Pre-compute merged horizons for all sub-panels
  _subHorizons = subPanels.map(sp => getMergedHorizon(sp.ptIds, scn));

  // Pre-compute sun paths
  const lat = state.location.lat;
  _allPaths = lat != null ? computeAllSunPaths(lat) : [];

  drawHeatmapBase();
}

/**
 * Compute sky visibility: for each (azimuth, elevation) pixel,
 * what fraction of sub-panels have a clear view?
 */
function computeVisibility() {
  const azMin = 60, azMax = 300, elMax = 80;
  const W = azMax - azMin, H = elMax;
  const vis = new Float32Array(W * H);
  const n = _subHorizons.length;
  if (n === 0) return { vis, W, H, azMin, azMax, elMax };

  for (let by = 0; by < H; by++) {
    const elv = by + 0.5;
    for (let bx = 0; bx < W; bx++) {
      const az = azMin + bx;
      let v = 0;
      for (const h of _subHorizons) {
        if (elv > h[az % 360]) v++;
      }
      vis[by * W + bx] = v / n;
    }
  }
  return { vis, W, H, azMin, azMax, elMax };
}

/**
 * Draw the full base heatmap: visibility pixels, horizon outlines,
 * sun paths with hour labels, elevation labels, and legend.
 * Caches result as _hmBaseImage for efficient overlay updates.
 */
function drawHeatmapBase() {
  if (!_smCtx || !_smCanvas) return;

  const { vis, W: cW, H: cH, azMin, azMax, elMax } = computeVisibility();
  const can = _smCanvas;
  const ctx = _smCtx;
  const W = can.width, H = can.height;
  const pad = _hmPad;
  const dw = W - pad.l - pad.r;
  const dh = H - pad.t - pad.b;

  ctx.clearRect(0, 0, W, H);

  // Draw pixel-level visibility
  const tmp = document.createElement('canvas');
  tmp.width = cW; tmp.height = cH;
  const tc = tmp.getContext('2d');
  const id = tc.createImageData(cW, cH);
  for (let by = 0; by < cH; by++) {
    for (let bx = 0; bx < cW; bx++) {
      const v = vis[by * cW + bx];
      const py = cH - 1 - by;
      const i = (py * cW + bx) * 4;
      id.data[i]     = Math.round(60 + v * 50);   // R: 60–110
      id.data[i + 1] = Math.round(40 + v * 140);  // G: 40–180
      id.data[i + 2] = Math.round(25 + v * 205);  // B: 25–230
      id.data[i + 3] = 255;
    }
  }
  tc.putImageData(id, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, pad.l, pad.t, dw, dh);

  // Horizon outlines (all points, faint)
  const state = getState();
  const pts = Object.values(state.points);
  const scn = state.activeScenario;
  for (const pt of pts) {
    const h = getMergedHorizon([pt.id], scn);
    ctx.beginPath();
    for (let az = azMin; az < azMax; az++) {
      const x = pad.l + ((az - azMin) / (azMax - azMin)) * dw;
      const y = pad.t + dh * (1 - h[az] / elMax);
      az === azMin ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  // Sun paths
  const lat = state.location.lat;
  if (lat != null && _allPaths) {
    const kp = [
      { m: 5,  label: 'Jun solstice',  color: '#f5c842', dash: [] },
      { m: 2,  label: 'Equinox',       color: '#e0e0e0', dash: [4, 3] },
      { m: 11, label: 'Dec solstice',   color: '#f09050', dash: [] }
    ];
    const toX = az => pad.l + ((az - azMin) / (azMax - azMin)) * dw;
    const toY = el => pad.t + dh * (1 - el / elMax);

    for (const k of kp) {
      const path = _allPaths[k.m];
      if (!path || path.length < 2) continue;

      ctx.beginPath();
      ctx.setLineDash(k.dash);
      let started = false;
      for (const pt of path) {
        if (pt.azimuth < azMin || pt.azimuth > azMax) continue;
        if (started) ctx.lineTo(toX(pt.azimuth), toY(pt.elevation));
        else { ctx.moveTo(toX(pt.azimuth), toY(pt.elevation)); started = true; }
      }
      ctx.strokeStyle = k.color;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.setLineDash([]);

      // Hour dots & labels
      const doy = MDAYS_CUM[k.m] + 21;
      for (let ha = -75; ha <= 75; ha += 15) {
        const d = solarDeclination(doy);
        const sp = sunPosition(lat, d, ha);
        if (sp.elevation <= 1 || sp.azimuth < azMin + 5 || sp.azimuth > azMax - 5) continue;
        ctx.beginPath();
        ctx.arc(toX(sp.azimuth), toY(sp.elevation), 2.5, 0, Math.PI * 2);
        ctx.fillStyle = k.color;
        ctx.fill();
        if (ha % 30 === 0) {
          const hr = 12 + ha / 15;
          const h12 = hr > 12 ? hr - 12 : hr;
          const ap = hr >= 12 ? 'p' : 'a';
          ctx.fillStyle = k.color;
          ctx.font = '500 9px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(h12 + ap, toX(sp.azimuth), toY(sp.elevation) + (k.m === 5 ? -7 : 10));
        }
      }
    }

    // Legend (sun path key)
    let ly = pad.t + 8;
    for (const k of kp) {
      ctx.beginPath();
      ctx.setLineDash(k.dash);
      ctx.moveTo(W - pad.r - 130, ly);
      ctx.lineTo(W - pad.r - 112, ly);
      ctx.strokeStyle = k.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = k.color;
      ctx.font = '9px "DM Sans", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(k.label, W - pad.r - 107, ly + 3);
      ly += 14;
    }
  }

  // Elevation Y-axis labels
  ctx.fillStyle = '#8a92a4';
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  for (let el = 0; el <= elMax; el += 10) {
    ctx.fillText(el + '\u00B0', pad.l - 4, pad.t + dh * (1 - el / elMax) + 3);
  }

  // Cache base image for efficient slider overlay
  _hmBaseImage = new Image();
  _hmBaseImage.src = can.toDataURL();
  _hmBaseImage.onload = () => updateSimOverlay();
}

/**
 * Draw sun position overlay on cached base heatmap.
 * Called on slider input.
 */
function updateSimOverlay() {
  if (!_smCtx || !_smCanvas) return;

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

  const decl = solarDeclination(doy);
  const sp = sunPosition(lat, decl, ha);

  if (sp.elevation <= 0) {
    if (statusEl) { statusEl.textContent = 'Sun below horizon'; statusEl.style.color = 'var(--text2)'; }
    if (countEl) { countEl.textContent = 'night'; countEl.style.color = 'var(--text2)'; }
    if (_hmBaseImage && _hmBaseImage.complete) {
      _smCtx.clearRect(0, 0, _smCanvas.width, _smCanvas.height);
      _smCtx.drawImage(_hmBaseImage, 0, 0);
    }
    return;
  }

  if (statusEl) {
    statusEl.textContent = `Az ${sp.azimuth.toFixed(1)}\u00B0  El ${sp.elevation.toFixed(1)}\u00B0`;
    statusEl.style.color = 'var(--sun)';
  }

  // Restore base heatmap
  const ctx = _smCtx;
  const can = _smCanvas;
  if (_hmBaseImage && _hmBaseImage.complete) {
    ctx.clearRect(0, 0, can.width, can.height);
    ctx.drawImage(_hmBaseImage, 0, 0);
  }

  // Draw sun dot overlay
  const W = can.width, H = can.height;
  const pad = _hmPad;
  const dw = W - pad.l - pad.r;
  const dh = H - pad.t - pad.b;

  if (sp.azimuth >= 60 && sp.azimuth <= 300 && sp.elevation > 0 && sp.elevation < 80) {
    const sx = pad.l + ((sp.azimuth - 60) / 240) * dw;
    const sy = pad.t + dh * (1 - sp.elevation / 80);

    // Glow
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 18);
    g.addColorStop(0, 'rgba(245,166,35,0.5)');
    g.addColorStop(0.5, 'rgba(245,166,35,0.15)');
    g.addColorStop(1, 'rgba(245,166,35,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, 18, 0, Math.PI * 2);
    ctx.fill();

    // Solid dot
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#f5a623';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Rays
    for (let a = 0; a < 8; a++) {
      const an = a * Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(an) * 8, sy + Math.sin(an) * 8);
      ctx.lineTo(sx + Math.cos(an) * 12, sy + Math.sin(an) * 12);
      ctx.strokeStyle = '#f5a623';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Compute shaded count
  const az = Math.round(sp.azimuth) % 360;
  let shadedCount = 0;
  const n = _subHorizons.length;
  for (let i = 0; i < n; i++) {
    if (sp.elevation <= _subHorizons[i][az]) shadedCount++;
  }
  if (countEl) {
    countEl.textContent = `${shadedCount}/${n}`;
    countEl.style.color = shadedCount > 0 ? 'var(--loss)' : 'var(--gain)';
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

// ─── End Sky Visibility Heatmap ───────────────────────

function cfgItem(label, value) {
  return `<div style="padding:8px 12px;background:var(--surface2);border-radius:var(--radius-sm);font-size:12px">
    <span style="color:var(--text2)">${label}:</span>
    <span style="font-family:'JetBrains Mono',monospace;margin-left:4px">${value}</span>
  </div>`;
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
