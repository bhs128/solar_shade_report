/**
 * SolarScope — Report View
 * Professional shade analysis report with SAV, TOF, TSRF,
 * monthly/hourly tables, scenario comparison, and array heatmap.
 */

import { getState, setState, getSubPanels } from '../state.js';
import {
  el, qs, qsa, clearEl, savColor, fmtPct, fmtNum, fmtDeg, fmtLatLon,
  maskLookupToHorizon
} from '../utils.js';
import {
  runFullAnalysis, runComparison, computeAllSunPaths,
  sunPosition, solarDeclination, buildMergedShadeLookupForPoints,
  computeShadeMatrix, shadeMatrixToCSV, runHourlyGrid,
  runPvlibProduction, isEnginePyodide,
  MONTHS, MDAYS, MDAYS_CUM
} from '../solar-engine.js';

let _container = null;
let _results = null;
let _comparison = null;
let _shadeMatrix = null;

// Shade-map canvas state
let _smCanvas = null;
let _smCtx = null;
let _smDpr = 1;
let _hmBaseImage = null; // cached base heatmap for overlay efficiency
let _hmPad = { l: 40, r: 14, t: 14, b: 6 };
let _subHorizons = null; // Float32Array(360)[] — derived from masks for heatmap
let _subLookups = null;  // mask lookup functions for visibility computation
let _allPaths = null;    // precomputed sun paths
let _prodEngine = 'js';  // selected production engine: 'js' | 'pvlib'
let _prodCache = { js: null, pvlib: null }; // last unified result per engine
let _arrayMetric = 'sav'; // selected per-panel array-map metric
let _arrayDpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
let _actual = null; // uploaded measured production: { monthlyKwh[12], annualKwh, grid[24][365], filename }
let _modeledClearGrid = { dst: null, std: null }; // cached modeled clear-sky clock-time grids (kW)
let _matchDst = true; // apply DST correction in the production-match matrix

export async function render(container) {
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

  // Run analysis (async for mask decoding)
  _results = await runFullAnalysis();

  // Invalidate cached modeled clear-sky grids (system/shade config may have changed).
  _modeledClearGrid = { dst: null, std: null };

  // 12×24 monthly-hourly beam-shading-loss matrix (PVsyst / SAM / PlantPredict)
  _shadeMatrix = await computeShadeMatrix();

  // Check for comparison scenario
  const scenarios = getAllScenarios();
  _comparison = null;
  if (state.compareScenario && state.compareScenario !== state.activeScenario) {
    _comparison = await runComparison(state.activeScenario, state.compareScenario);
  }

  await buildReport();
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

async function buildReport() {
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

      ${sectionTitle('Site Analysis & Shade Results', 'System geometry, solar-access metrics, and exports for SAM / external tools')}

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
        <div class="stat">
          <div class="stat-label">Effective Annual SVF</div>
          <div class="stat-value info">${fmtPct(r.arraySVF ?? 1)}</div>
        </div>
      </div>

      <!-- Panel array heatmap -->
      <div class="card">
        <div class="card-header">
          <h2>Panel Array — Per-Panel Shade Map</h2>
          <select id="sel-array-metric" style="background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 10px;font-size:12px">
            <option value="sav">Annual Solar Access (SAV)</option>
            <option value="savWinter">Winter SAV (Dec)</option>
            <option value="savSummer">Summer SAV (Jun)</option>
            <option value="svf">Effective Annual SVF</option>
            <option value="kwh">Production (kWh / panel)</option>
          </select>
        </div>
        <div id="report-array" style="position:relative;width:100%">
          <canvas id="c-array-map" style="display:block;width:100%"></canvas>
        </div>
        <div class="legend-row" id="array-legend" style="justify-content:center;gap:12px;margin-top:8px"></div>
      </div>

      <!-- Sky visibility heatmap -->
      <div class="card">
        <h2>Sky Visibility Map</h2>
        <div class="hint" style="margin-bottom:8px;margin-top:-4px">
          Fraction of sub-panels with clear view to each sky position. Blue = visible, brown = blocked.
          Faint line = any panel shaded; solid black line = common horizon (every panel shaded).
        </div>
        ${getAllScenarios().length > 1 ? `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <label style="font-size:11px;color:var(--text2)">Shade scenario:</label>
          <select id="sm-scenario" style="background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 10px;font-size:12px">
            ${getAllScenarios().map(s => `<option value="${esc(s)}" ${s === state.activeScenario ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </div>` : ''}
        <div id="shade-map-wrap" style="position:relative;width:100%;background:var(--surface2);border-radius:var(--radius-sm);overflow:hidden">
          <canvas id="c-shade-map" width="1020" height="360" style="display:block;width:100%"></canvas>
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

      <!-- Monthly-hourly shade matrix (12×24) -->
      <div class="card">
        <div class="card-header">
          <h2>Monthly-Hourly Shade Matrix (12&times;24)</h2>
        </div>
        <p class="hint" style="margin-bottom:8px">
          Array-average <strong>beam shading loss (%)</strong> by month (rows) and solar hour 0&ndash;23 (cols).
          0 = unshaded, 100 = beam fully blocked. The bare CSV is a 12&times;24 grid that imports directly into
          SAM (&ldquo;Month by Hour Beam Shading Losses&rdquo;) and PlantPredict monthly-hourly shading tables,
          and can seed a PVsyst shading-factor table. <em>Note: this array-average loses per-panel resolution —
          for micro-inverter arrays the pvlib engine below is more accurate.</em>
        </p>
        <div style="overflow-x:auto" id="shade-matrix-table"></div>
      </div>

      <!-- Exports hub -->
      <div class="card">
        <h2>Exports for SAM / External Tools</h2>
        <p class="hint" style="margin-bottom:10px">
          Download the shade geometry derived from your fisheye analysis to model production in SAM, PVsyst,
          or PlantPredict. (Engine production results below also offer their own hourly-AC export.)
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm btn-primary" id="btn-shade-csv" title="12×24 month-by-hour beam shading loss grid (bare numbers)">Shade Matrix CSV (SAM / PlantPredict)</button>
          <button class="btn btn-sm" id="btn-shade-csv-labeled" title="Same matrix with month/hour labels">Shade Matrix CSV (labeled)</button>
          <button class="btn btn-sm" id="btn-common-hor" title="Export the common horizon (every panel shaded) as CSV">Common Horizon HOR CSV</button>
        </div>
      </div>

      ${sectionTitle('Production Modeling', 'Pick an engine — results are shown in a consistent format. Shade analysis above feeds every engine.')}

      <!-- Production modeling (engine-selectable) -->
      <div class="card" id="production-card">
        <div class="card-header">
          <h2>Modeled Production</h2>
          <div class="seg" id="engine-seg" style="display:flex;gap:0;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden">
            <button class="seg-btn" data-engine="js" style="padding:5px 12px;font-size:12px;background:var(--accent);color:#fff;border:0;cursor:pointer">Legacy JS</button>
            <button class="seg-btn" data-engine="pvlib" style="padding:5px 12px;font-size:12px;background:var(--surface2);color:var(--text2);border:0;border-left:1px solid var(--border);cursor:pointer">pvlib (TMY)</button>
          </div>
        </div>
        <div id="prod-status" class="hint" style="margin-bottom:8px"></div>
        <div id="production-results"></div>
      </div>

      <!-- Measured vs. Modeled (actual production upload) -->
      <div class="card" id="actual-card">
        <div class="card-header">
          <h2>Measured vs. Modeled</h2>
          <label class="btn btn-sm" for="actual-file" style="cursor:pointer">Upload Actual Production CSV
            <input type="file" id="actual-file" accept=".csv,text/csv" style="display:none">
          </label>
        </div>
        <div class="hint" style="margin-bottom:8px">
          Upload a 24&times;365 hourly production CSV (same layout as the exported
          <em>Hourly AC 24&times;365</em> file) to validate the model against real-world output.
        </div>
        <div id="actual-status" class="hint"></div>
        <div id="actual-results"></div>
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
  await initShadeMap();
  buildMonthlyTable();
  buildHourlyTable(-1);
  buildShadeMatrixTable();
  bindReportEvents();
  runProductionEngine(_prodEngine);
}

function buildShadeMatrixTable() {
  const wrap = qs('#shade-matrix-table', _container);
  if (!wrap) return;
  if (!_shadeMatrix) {
    wrap.innerHTML = '<p class="hint">Shade matrix unavailable.</p>';
    return;
  }

  let html = '<table class="data-tbl" style="font-size:10px"><tr><th>Mo\\Hr</th>';
  for (let h = 0; h < 24; h++) html += `<th>${h}</th>`;
  html += '</tr>';

  for (let m = 0; m < 12; m++) {
    html += `<tr><td style="text-align:left;color:var(--text2)">${MONTHS[m]}</td>`;
    for (let h = 0; h < 24; h++) {
      const v = _shadeMatrix[m][h];
      const c = v < 1 ? 'var(--text3)'
        : v < 20 ? 'var(--gain)'
        : v < 50 ? 'var(--sun)'
        : 'var(--loss)';
      html += `<td style="color:${c}">${v < 0.5 ? '\u00b7' : Math.round(v)}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  wrap.innerHTML = html;
}

/**
 * Format an hourly AC grid (grid[hour][day], 24×365, kW) into SAM's heat-map
 * CSV layout: a "Time stamp" header of day columns "0".."365", a day-axis row,
 * then 24 hourly rows whose first data column carries the hour index (0-23).
 */
function hourlyGridToCSV(grid) {
  const DAYS = 365;
  const dayCols = [];
  for (let k = 0; k <= DAYS; k++) dayCols.push(`"${k}"`); // "0".."365"
  let csv = '"Time stamp",' + dayCols.join(',') + '\n';

  // Row "1": day-of-year axis (col "0" = 0, cols "1".."365" = day number).
  const axis = ['"1"'];
  for (let k = 0; k <= DAYS; k++) axis.push(k);
  csv += axis.join(',') + '\n';

  // Rows "2".."25": hours 0-23. Col "0" carries the hour index; cols "1".."365"
  // hold system AC power (kW) for that hour on days 1-365.
  for (let h = 0; h < 24; h++) {
    const row = [`"${h + 2}"`, h];
    for (let k = 1; k <= DAYS; k++) row.push(grid[h][k - 1].toFixed(6));
    csv += row.join(',') + '\n';
  }
  return csv;
}

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

  qs('#btn-shade-csv', _container)?.addEventListener('click', () => {
    if (!_shadeMatrix) return;
    const name = (getState().name || 'shade-matrix').replace(/[^\w.-]+/g, '_');
    downloadText(`${name}_shade_12x24.csv`, shadeMatrixToCSV(_shadeMatrix));
  });

  qs('#btn-shade-csv-labeled', _container)?.addEventListener('click', () => {
    if (!_shadeMatrix) return;
    const name = (getState().name || 'shade-matrix').replace(/[^\w.-]+/g, '_');
    downloadText(`${name}_shade_12x24_labeled.csv`, shadeMatrixToCSV(_shadeMatrix, { labels: true }));
  });

  // Production engine selector
  qsa('#engine-seg .seg-btn', _container).forEach(b => {
    b.addEventListener('click', () => {
      if (b.disabled || b.dataset.engine === _prodEngine) return;
      runProductionEngine(b.dataset.engine);
    });
  });

  // Array-map metric selector
  qs('#sel-array-metric', _container)?.addEventListener('change', (e) => {
    _arrayMetric = e.target.value;
    drawArrayMap();
  });

  // Measured production upload
  qs('#actual-file', _container)?.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) loadActualFile(file);
  });

  qs('#btn-common-hor', _container)?.addEventListener('click', () => {
    if (!_subHorizons || _subHorizons.length === 0) return;
    // Common horizon: min obstruction elevation across all sub-panels.
    // Below this line, EVERY panel is shaded (matches the solid black line).
    const commonH = new Float32Array(360);
    for (let az = 0; az < 360; az++) {
      let m = Infinity;
      for (const h of _subHorizons) {
        if (h[az] < m) m = h[az];
      }
      commonH[az] = isFinite(m) ? m : 0;
    }
    let csv = 'Azimuth (deg),Obstruction Elevation (deg)\n';
    for (let az = 0; az < 360; az++) {
      csv += `${az},${commonH[az].toFixed(1)}\n`;
    }
    const name = (getState().name || 'shade').replace(/[^\w.-]+/g, '_');
    downloadText(`${name}_common_horizon.csv`, csv);
  });

  qs('#sm-doy', _container)?.addEventListener('input', updateSimOverlay);
  qs('#sm-hour', _container)?.addEventListener('input', updateSimOverlay);

  // Shade map scenario dropdown
  qs('#sm-scenario', _container)?.addEventListener('change', async (e) => {
    const scn = e.target.value;
    const subPanels = _results.subPanels;
    _subLookups = await Promise.all(
      subPanels.map(sp => buildMergedShadeLookupForPoints(sp.ptIds, scn))
    );
    _subHorizons = _subLookups.map(fn => maskLookupToHorizon(fn));
    drawHeatmapBase();
  });
}

// --- Production modeling (engine-selectable, consistent format) ---

/** Adapt the JS runFullAnalysis result into the unified production schema. */
function jsProductionResult() {
  const r = _results;
  const dcKw = r.dcCapacity;
  return {
    engine: 'js',
    label: 'Legacy JS engine',
    sublabel: 'Clear-sky × monthly TMY-scale · isotropic-tilt diffuse · per-panel clipping',
    annualKwh: r.netKwh,
    specificYield: dcKw > 0 ? r.netKwh / dcKw : 0,
    dcCapacityKw: dcKw,
    acCapacityKw: r.acCapacity,
    monthlyKwh: Array.from(r.monthlyKwh),
    perPanelKwh: r.perPanelKwh || null,
    losses: {
      clearKwh: r.clearKwh,
      weatherLoss: r.weatherLoss,
      beamShadeLoss: r.beamShadeLoss ?? r.shadeLoss,
      diffuseShadeLoss: r.diffuseShadeLoss ?? 0,
      clipLoss: r.clipLoss,
      netKwh: r.netKwh,
    },
    poaAnnualUnshaded: null,
    hourlyKw: null,
    note: 'Always available — no weather upload required. Uses a generic mid-latitude cloud model.',
  };
}

/** Adapt the pvlib Python result into the unified production schema. */
function pvlibProductionResult(res) {
  const st = getState();
  const acKw = st.system.rows * st.system.cols * st.system.inverterWatts / 1000;
  return {
    engine: 'pvlib',
    label: 'pvlib (measured TMY)',
    sublabel: 'Perez transposition · SAPM open-rack cell temp · PVWatts (γ=−0.4%/°C) · per-panel clipping',
    annualKwh: res.annualKwh,
    specificYield: res.specificYield,
    dcCapacityKw: res.dcNameplateKw,
    acCapacityKw: acKw,
    monthlyKwh: res.monthlyKwh,
    perPanelKwh: res.perPanelKwh || null,
    losses: res.losses,
    poaAnnualUnshaded: res.poaAnnualUnshaded,
    hourlyKw: res.hourlyKw || null,
    note: null,
  };
}

/** Run (or fetch cached) the selected engine and render its result. */
async function runProductionEngine(engine) {
  _prodEngine = engine;
  updateEngineSeg();
  const status = qs('#prod-status', _container);
  const out = qs('#production-results', _container);

  if (engine === 'js') {
    const u = jsProductionResult();
    _prodCache.js = u;
    if (status) status.innerHTML = `<span style="color:var(--text3)">${esc(u.note)}</span>`;
    renderProduction(u);
    return;
  }

  // pvlib path — needs runtime + weather
  const st = getState();
  const ready = isEnginePyodide();
  const hasWeather = !!(st.weather && st.weather.records && st.weather.records.length);
  if (!ready) {
    if (status) status.innerHTML = '<span style="color:var(--sun)">⏳ pvlib runtime still loading — it will be ready shortly. Try again in a moment.</span>';
    if (out) out.innerHTML = '';
    return;
  }
  if (!hasWeather) {
    if (status) status.innerHTML = '<span style="color:var(--text3)">No weather time series loaded. Upload an NSRDB / SAM TMY CSV on the Setup page, then select this engine again.</span>';
    if (out) out.innerHTML = '';
    return;
  }
  if (status) status.innerHTML = '<span style="color:var(--text3)">Running pvlib ModelChain over the full TMY series… (a few seconds)</span>';
  if (out) out.innerHTML = '';
  setSegBusy(true);
  try {
    const res = await runPvlibProduction();
    const u = pvlibProductionResult(res);
    _prodCache.pvlib = u;
    const w = st.weather;
    const where = [w.meta?.city, w.meta?.state].filter(Boolean).join(', ');
    if (status) status.innerHTML = `<span style="color:var(--gain)">✓ pvlib run complete — ${res.nTimes.toLocaleString()} records${where ? ' · ' + esc(where) : ''}.</span>`;
    renderProduction(u);
  } catch (err) {
    if (status) status.innerHTML = `<span style="color:var(--loss)">✗ ${esc(err.message || String(err))}</span>`;
  } finally {
    setSegBusy(false);
  }
}

function updateEngineSeg() {
  qsa('#engine-seg .seg-btn', _container).forEach(b => {
    const active = b.dataset.engine === _prodEngine;
    b.style.background = active ? 'var(--accent)' : 'var(--surface2)';
    b.style.color = active ? '#fff' : 'var(--text2)';
  });
}

function setSegBusy(busy) {
  qsa('#engine-seg .seg-btn', _container).forEach(b => {
    b.disabled = busy;
    b.style.opacity = busy ? '0.6' : '1';
    b.style.cursor = busy ? 'wait' : 'pointer';
  });
}

/** Render a unified production result into #production-results (same layout for every engine). */
function renderProduction(u) {
  const out = qs('#production-results', _container);
  if (!out) return;

  // Cross-engine comparison chip (vs the other engine's cached net kWh).
  const other = u.engine === 'js' ? _prodCache.pvlib : _prodCache.js;
  const otherLabel = u.engine === 'js' ? 'pvlib' : 'Legacy JS';
  let cmp = '';
  if (other && other.annualKwh > 0) {
    const dp = (u.annualKwh - other.annualKwh) / other.annualKwh * 100;
    cmp = `<div class="stat">
      <div class="stat-label">vs. ${otherLabel}</div>
      <div class="stat-value ${dp >= 0 ? 'gain' : 'loss'}">${dp >= 0 ? '+' : ''}${dp.toFixed(1)}%</div>
    </div>`;
  }

  const L = u.losses;
  const poaTile = u.poaAnnualUnshaded != null
    ? `<div class="stat">
        <div class="stat-label">POA (unshaded)</div>
        <div class="stat-value info">${fmtNum(u.poaAnnualUnshaded)}<span style="font-size:11px;color:var(--text3)"> kWh/m²</span></div>
      </div>` : '';

  out.innerHTML = `
    <p class="hint" style="margin:0 0 10px">${esc(u.label)} — ${esc(u.sublabel)}</p>

    <!-- Headline -->
    <div class="stats-row">
      <div class="stat">
        <div class="stat-label">Net Annual AC</div>
        <div class="stat-value gain">${fmtNum(u.annualKwh)}<span style="font-size:12px;color:var(--text3)"> kWh</span></div>
      </div>
      <div class="stat">
        <div class="stat-label">Specific Yield</div>
        <div class="stat-value">${fmtNum(u.specificYield)}<span style="font-size:11px;color:var(--text3)"> kWh/kWp</span></div>
      </div>
      <div class="stat">
        <div class="stat-label">DC / AC Capacity</div>
        <div class="stat-value">${u.dcCapacityKw.toFixed(1)}<span style="font-size:11px;color:var(--text3)"> / ${u.acCapacityKw.toFixed(1)} kW</span></div>
      </div>
      ${poaTile}
      ${cmp}
    </div>

    <!-- Loss waterfall -->
    <div class="stats-row">
      <div class="stat">
        <div class="stat-label">Clear-sky kWh</div>
        <div class="stat-value sun">${fmtNum(L.clearKwh)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Weather Loss</div>
        <div class="stat-value" style="color:var(--text2)">−${fmtNum(Math.abs(L.weatherLoss))}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Beam Shade Loss</div>
        <div class="stat-value loss">−${fmtNum(Math.abs(L.beamShadeLoss))}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Diffuse Shade Loss</div>
        <div class="stat-value loss">−${fmtNum(Math.abs(L.diffuseShadeLoss))}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Clip Loss</div>
        <div class="stat-value loss">−${fmtNum(Math.abs(L.clipLoss))}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Net Annual kWh</div>
        <div class="stat-value gain">${fmtNum(L.netKwh)}</div>
      </div>
    </div>

    <div class="grid-2" style="margin-top:4px">
      <div class="card" style="margin:0">
        <h2>Monthly Energy Production (kWh)</h2>
        <canvas id="c-monthly-prod" width="600" height="250" style="width:100%"></canvas>
      </div>
      <div class="card" style="margin:0">
        <div class="card-header">
          <h2>Per-Panel Annual kWh</h2>
          <button class="btn btn-sm" id="btn-hourly-csv" title="Export an hourly AC power series">Download Hourly AC</button>
        </div>
        <div id="prod-perpanel"></div>
      </div>
    </div>
  `;

  const altMonthly = (u.engine === 'js' && _comparison) ? _comparison.alternative.monthlyKwh : null;
  drawMonthlyChart(u.monthlyKwh, 'c-monthly-prod', altMonthly);
  drawPerPanelBars(u.perPanelKwh);
  bindHourlyExport(u);

  // Keep the array map in sync if it's showing per-panel production.
  if (_arrayMetric === 'kwh') drawArrayMap();

  // Refresh measured-vs-modeled comparison against the freshly selected engine.
  if (_actual) renderActualComparison();
}

/** Horizontal per-panel kWh bars. */
function drawPerPanelBars(perPanel) {
  const wrap = qs('#prod-perpanel', _container);
  if (!wrap) return;
  if (!perPanel || !perPanel.length) {
    wrap.innerHTML = '<p class="hint">Per-panel breakdown not available for this engine.</p>';
    return;
  }
  const max = Math.max(1, ...perPanel);
  const min = Math.min(...perPanel);
  let html = '<div style="display:flex;flex-direction:column;gap:3px;max-height:230px;overflow-y:auto">';
  for (let i = 0; i < perPanel.length; i++) {
    const v = perPanel[i];
    const w = Math.round((v / max) * 100);
    // color: lowest producers redder
    const isLow = v <= min + (max - min) * 0.15;
    html += `<div style="display:flex;align-items:center;gap:6px">
      <span class="legend-label" style="width:34px;font-size:10px;text-align:right">#${i + 1}</span>
      <div style="flex:1;background:var(--surface2);border-radius:3px;height:14px;overflow:hidden">
        <div style="width:${w}%;height:100%;background:${isLow ? 'var(--loss)' : 'var(--gain)'}"></div>
      </div>
      <span class="legend-label" style="width:54px;font-size:10px;font-family:'JetBrains Mono',monospace">${fmtNum(v)}</span>
    </div>`;
  }
  html += '</div>';
  wrap.innerHTML = html;
}

// --- Measured vs. modeled (actual production upload) ---

/** Read an uploaded actual-production CSV and render the comparison. */
function loadActualFile(file) {
  const status = qs('#actual-status', _container);
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseActual24x365(String(reader.result));
      parsed.filename = file.name;
      _actual = parsed;
      if (status) status.innerHTML = `Loaded <strong>${esc(file.name)}</strong> — ${fmtNum(parsed.annualKwh)} kWh measured across ${parsed.daysWithData} days.`;
      renderActualComparison();
    } catch (err) {
      _actual = null;
      if (status) status.innerHTML = `<span style="color:var(--loss)">Could not parse file: ${esc(err.message)}</span>`;
      const out = qs('#actual-results', _container);
      if (out) out.innerHTML = '';
    }
  };
  reader.onerror = () => {
    if (status) status.innerHTML = '<span style="color:var(--loss)">Failed to read file.</span>';
  };
  reader.readAsText(file);
}

/**
 * Parse a 24×365 hourly-production CSV (same layout the app exports):
 * header "Time stamp" + day cols "0".."365"; an axis row; then 24 hour rows
 * where day-column "0" carries the hour index and cols "1".."365" hold kWh.
 * Returns { grid[24][365], monthlyKwh[12], annualKwh, daysWithData }.
 */
function parseActual24x365(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (lines.length < 3) throw new Error('not enough rows');
  const rows = lines.map(l => l.split(',').map(c => c.replace(/^"|"$/g, '').trim()));

  let start = 0;
  if (/time\s*stamp/i.test(rows[0][0])) start = 1; // skip header

  const grid = Array.from({ length: 24 }, () => new Float64Array(365));
  let matched = 0;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 367) continue;            // need label + 366 day columns
    const hour = parseInt(r[1], 10);         // day-"0" column = hour index
    // Axis row also has 367 cols but its day-"1" value is 1, day-"2" is 2 …
    // A real hour row's hour is 0..23 and its label is "2".."25".
    const label = parseInt(r[0], 10);
    if (!(hour >= 0 && hour <= 23)) continue;
    if (label === 1) continue;               // axis row
    for (let d = 0; d < 365; d++) {
      const v = parseFloat(r[d + 2]);        // cols "1".."365"
      if (isFinite(v)) grid[hour][d] = v;
    }
    matched++;
  }
  if (matched === 0) throw new Error('no hour rows found (expected 24×365 layout)');

  // Monthly + annual aggregation (non-leap calendar, days 1-365).
  const monthlyKwh = new Float64Array(12);
  let annualKwh = 0;
  const dayHas = new Array(365).fill(false);
  for (let d = 0; d < 365; d++) {
    // day index d (0-based) → month
    let m = 0, cum = 0;
    for (; m < 12; m++) { if (d < cum + MDAYS[m]) break; cum += MDAYS[m]; }
    for (let h = 0; h < 24; h++) {
      const v = grid[h][d];
      if (v) { monthlyKwh[m] += v; annualKwh += v; dayHas[d] = true; }
    }
  }
  const daysWithData = dayHas.filter(Boolean).length;
  return { grid, monthlyKwh: Array.from(monthlyKwh), annualKwh, daysWithData };
}

/** Render measured vs. modeled stats + monthly comparison chart. */
function renderActualComparison() {
  const out = qs('#actual-results', _container);
  if (!out || !_actual) return;

  const modeled = _prodCache[_prodEngine];
  if (!modeled) {
    out.innerHTML = '<p class="hint">Run a production engine above to compare.</p>';
    return;
  }

  const mMonthly = Array.from(modeled.monthlyKwh, Number);
  const aMonthly = _actual.monthlyKwh;
  const mAnnual = modeled.annualKwh;
  const aAnnual = _actual.annualKwh;
  const errPct = aAnnual > 0 ? (mAnnual - aAnnual) / aAnnual * 100 : 0;

  // Monthly error metrics (only over months with measured data).
  let sumAbs = 0, sumSq = 0, n = 0, meanA = 0;
  for (let m = 0; m < 12; m++) {
    if (aMonthly[m] <= 0) continue;
    const e = mMonthly[m] - aMonthly[m];
    sumAbs += Math.abs(e); sumSq += e * e; meanA += aMonthly[m]; n++;
  }
  const mae = n ? sumAbs / n : 0;
  const rmse = n ? Math.sqrt(sumSq / n) : 0;
  const nrmse = (n && meanA) ? rmse / (meanA / n) * 100 : 0;

  out.innerHTML = `
    <div class="stats-row">
      <div class="stat">
        <div class="stat-label">Measured Annual</div>
        <div class="stat-value info">${fmtNum(aAnnual)}<span style="font-size:11px;color:var(--text3)"> kWh</span></div>
      </div>
      <div class="stat">
        <div class="stat-label">Modeled Annual (${_prodEngine === 'js' ? 'Legacy JS' : 'pvlib'})</div>
        <div class="stat-value gain">${fmtNum(mAnnual)}<span style="font-size:11px;color:var(--text3)"> kWh</span></div>
      </div>
      <div class="stat">
        <div class="stat-label">Annual Bias</div>
        <div class="stat-value ${errPct >= 0 ? 'gain' : 'loss'}">${errPct >= 0 ? '+' : ''}${errPct.toFixed(1)}%</div>
      </div>
      <div class="stat">
        <div class="stat-label">Monthly MAE</div>
        <div class="stat-value">${fmtNum(mae)}<span style="font-size:11px;color:var(--text3)"> kWh</span></div>
      </div>
      <div class="stat">
        <div class="stat-label">Monthly nRMSE</div>
        <div class="stat-value">${nrmse.toFixed(1)}<span style="font-size:11px;color:var(--text3)"> %</span></div>
      </div>
    </div>

    <div class="card" style="margin:8px 0 0">
      <div class="card-header">
        <h2>Monthly — Measured vs. Modeled</h2>
        <div class="legend-row" style="gap:10px">
          <span class="legend-label"><span style="display:inline-block;width:10px;height:10px;background:#22c55e66;border-radius:2px;vertical-align:middle"></span> Measured</span>
          <span class="legend-label"><span style="display:inline-block;width:10px;height:8px;border:2px dashed #f5a623;vertical-align:middle"></span> Modeled</span>
        </div>
      </div>
      <canvas id="c-actual-compare" width="600" height="250" style="width:100%"></canvas>
    </div>
    <p class="hint" style="margin-top:8px">
      Note: measured output reflects the actual weather of its recording year, while the model
      uses TMY / clear-sky inputs — month-to-month differences are expected. Annual bias and
      seasonal shape are the most meaningful comparison.
    </p>

    <div class="card" style="margin:8px 0 0">
      <h2>Monthly-Hourly Production Match (shortfall vs. modeled clear-sky)</h2>
      <p class="hint" style="margin:4px 0 8px">
        For each month/hour cell: the best (clearest-day) <em>measured</em> output minus the modeled
        <strong>clear-sky</strong> peak, expressed as percentage-points of that month's daily peak.
        <strong>0 = match.</strong> <span style="color:var(--loss)">Negative (red)</span> = measured
        falls short of the model (real shade the model misses);
        <span style="color:var(--shade)">positive (blue)</span> = measured exceeds the model (the model
        over-shades or under-rates that time). Normalizing to the daily peak avoids the exaggeration
        you get dividing two near-zero edge-of-day values.
        Hours are aligned to local clock time (longitude + equation-of-time corrected); toggle DST below.
      </p>
      <label class="hint" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:8px">
        <input type="checkbox" id="chk-match-dst" ${_matchDst ? 'checked' : ''}> Correct for Daylight Saving Time (US rule)
      </label>
      <div id="match-matrix"><p class="hint">Computing modeled clear-sky envelope…</p></div>
    </div>

    <div class="card" style="margin:8px 0 0">
      <h2>Unshaded-Cell Clear-Sky Check</h2>
      <p class="hint" style="margin:4px 0 8px">
        Restricted to month/hour cells where the model sees the sun <strong>unobstructed</strong>
        (no beam shading). With shade removed from the picture, any remaining gap isolates the
        <strong>clear-sky production model itself</strong> (irradiance, temperature, soiling,
        inverter/system losses) rather than shade geometry. A uniform offset points to model
        calibration; isolated low cells among unshaded neighbours suggest shade the model is missing.
      </p>
      <div id="unshaded-check"><p class="hint">Computing unshaded subset…</p></div>
    </div>
  `;

  drawMonthlyChart(aMonthly, 'c-actual-compare', mMonthly);
  buildProductionMatchMatrix();
  buildUnshadedCheck();

  // DST toggle re-renders the match matrix with the alternate clock alignment.
  qs('#chk-match-dst', _container)?.addEventListener('change', (e) => {
    _matchDst = e.target.checked;
    buildProductionMatchMatrix();
    buildUnshadedCheck();
  });
}

/**
 * Fetch (and cache, per DST setting) the modeled clear-sky clock-time grids:
 * `grid` = shaded AC peak (kW), `beam` = array-mean beam availability (0..1).
 */
async function getClearGrids() {
  const key = _matchDst ? 'dst' : 'std';
  if (!_modeledClearGrid[key]) {
    const { grid, beamGrid } = await runHourlyGrid(null, { clearSky: true, clockTime: true, dst: _matchDst });
    _modeledClearGrid[key] = { grid, beam: beamGrid };
  }
  return _modeledClearGrid[key];
}

/**
 * 12×24 month-hour matrix: best measured production per cell vs. modeled
 * clear-sky peak per cell, as a percentage. Highlights where the shade model
 * diverges from reality so the user knows which sky region to inspect.
 */
async function buildProductionMatchMatrix() {
  const wrap = qs('#match-matrix', _container);
  if (!wrap || !_actual) return;

  // Modeled clear-sky hourly grid in clock time (cached per DST setting).
  let modeledGrid;
  try {
    ({ grid: modeledGrid } = await getClearGrids());
  } catch (err) {
    wrap.innerHTML = `<p class="hint" style="color:var(--loss)">Could not compute modeled envelope: ${esc(err.message)}</p>`;
    return;
  }

  // Per (month, hour) peaks.
  const mMeas = Array.from({ length: 12 }, () => new Float64Array(24));
  const mMod = Array.from({ length: 12 }, () => new Float64Array(24));
  for (let d = 0; d < 365; d++) {
    let m = 0, cum = 0;
    for (; m < 12; m++) { if (d < cum + MDAYS[m]) break; cum += MDAYS[m]; }
    for (let h = 0; h < 24; h++) {
      const meas = _actual.grid[h][d];
      const mod = modeledGrid[h][d];
      if (meas > mMeas[m][h]) mMeas[m][h] = meas;
      if (mod > mMod[m][h]) mMod[m][h] = mod;
    }
  }

  let html = '<table class="data-tbl" style="font-size:10px"><tr><th>Mo\\Hr</th>';
  for (let h = 0; h < 24; h++) html += `<th>${h}</th>`;
  html += '</tr>';
  for (let m = 0; m < 12; m++) {
    // Reference = the month's modeled clear-sky daily peak (its largest cell).
    let ref = 0;
    for (let h = 0; h < 24; h++) if (mMod[m][h] > ref) ref = mMod[m][h];

    html += `<tr><td style="text-align:left;color:var(--text2)">${MONTHS[m]}</td>`;
    for (let h = 0; h < 24; h++) {
      const mod = mMod[m][h];
      const meas = mMeas[m][h];
      // Night / pre-dawn: negligible modeled output relative to the daily peak.
      if (ref < 0.01 || mod < ref * 0.02) {
        html += '<td style="color:var(--text3)">·</td>';
        continue;
      }
      // Signed shortfall as percentage-points of the day's peak (robust near 0).
      const delta = (meas - mod) / ref * 100;
      const { bg, fg } = matchDeltaColor(delta);
      const title = `${MONTHS[m]} ${h}:00 — measured ${fmtNum(meas)} kW vs modeled ${fmtNum(mod)} kW (${delta >= 0 ? '+' : ''}${delta.toFixed(0)}% of daily peak)`;
      const txt = `${delta > 0 ? '+' : ''}${Math.round(delta)}`;
      html += `<td style="background:${bg};color:${fg}" title="${title}">${txt}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  html += `<div class="legend-row" style="justify-content:center;gap:10px;margin-top:8px;flex-wrap:wrap">
    <span class="legend-label"><span style="display:inline-block;width:11px;height:11px;background:rgba(239,68,68,0.6);border-radius:2px;vertical-align:middle"></span> measured below model (real shade)</span>
    <span class="legend-label"><span style="display:inline-block;width:11px;height:11px;background:rgba(34,197,94,0.45);border-radius:2px;vertical-align:middle"></span> ±7% (match)</span>
    <span class="legend-label"><span style="display:inline-block;width:11px;height:11px;background:rgba(56,160,255,0.5);border-radius:2px;vertical-align:middle"></span> measured above model (over-shaded / under-rated)</span>
    <span class="legend-label"><span style="color:var(--text3)">·</span> no sun</span>
  </div>
  <p class="hint" style="margin-top:6px">Values are percentage-points of each month's modeled clear-sky daily peak, so dim edge-of-day hours aren't exaggerated.</p>`;
  wrap.innerHTML = html;
}

/** Color a production-match cell by its signed deviation (% of daily peak). */
function matchDeltaColor(delta) {
  const a = Math.abs(delta);
  if (a <= 7) return { bg: 'rgba(34,197,94,0.40)', fg: '#dffbe8' };
  const t = Math.min(1, (a - 7) / 43); // saturates around ±50 pts
  if (delta < 0) {
    return { bg: `rgba(239,68,68,${(0.25 + 0.5 * t).toFixed(2)})`, fg: '#fff' };
  }
  return { bg: `rgba(56,160,255,${(0.25 + 0.5 * t).toFixed(2)})`, fg: '#eaf4ff' };
}

/**
 * Clear-sky model check restricted to beam-unshaded cells. For cells where the
 * model sees the sun fully (beam availability ≈ 1), measured should equal the
 * modeled clear-sky output; residual differences isolate the clear-sky model.
 */
async function buildUnshadedCheck() {
  const wrap = qs('#unshaded-check', _container);
  if (!wrap || !_actual) return;

  let grids;
  try {
    grids = await getClearGrids();
  } catch (err) {
    wrap.innerHTML = `<p class="hint" style="color:var(--loss)">Could not compute modeled envelope: ${esc(err.message)}</p>`;
    return;
  }
  const { grid: modGrid, beam: beamGrid } = grids;

  // Per (month, hour): peak measured + the modeled peak and its beam availability
  // on the same (peak-modeled) day, so the unshaded test matches the compared cell.
  const mMeas = Array.from({ length: 12 }, () => new Float64Array(24));
  const mMod = Array.from({ length: 12 }, () => new Float64Array(24));
  const mBeam = Array.from({ length: 12 }, () => new Float64Array(24).fill(1));
  for (let d = 0; d < 365; d++) {
    let m = 0, cum = 0;
    for (; m < 12; m++) { if (d < cum + MDAYS[m]) break; cum += MDAYS[m]; }
    for (let h = 0; h < 24; h++) {
      if (_actual.grid[h][d] > mMeas[m][h]) mMeas[m][h] = _actual.grid[h][d];
      if (modGrid[h][d] > mMod[m][h]) { mMod[m][h] = modGrid[h][d]; mBeam[m][h] = beamGrid[h][d]; }
    }
  }

  const BEAM_OK = 0.99;   // ≥99% beam = effectively unshaded
  const SUN_FLOOR = 0.10; // ignore dim edge-of-day cells (<10% of daily peak)

  let sumMeas = 0, sumMod = 0, nCells = 0;
  let html = '<table class="data-tbl" style="font-size:10px"><tr><th>Mo\\Hr</th>';
  for (let h = 0; h < 24; h++) html += `<th>${h}</th>`;
  html += '</tr>';
  for (let m = 0; m < 12; m++) {
    let ref = 0;
    for (let h = 0; h < 24; h++) if (mMod[m][h] > ref) ref = mMod[m][h];

    html += `<tr><td style="text-align:left;color:var(--text2)">${MONTHS[m]}</td>`;
    for (let h = 0; h < 24; h++) {
      const mod = mMod[m][h];
      const meas = mMeas[m][h];
      if (ref < 0.01 || mod < ref * SUN_FLOOR) {            // night / dim edge
        html += '<td style="color:var(--text3)">·</td>';
        continue;
      }
      if (mBeam[m][h] < BEAM_OK) {                          // shaded → excluded
        html += '<td style="color:var(--text3);opacity:0.5" title="beam-shaded — excluded">×</td>';
        continue;
      }
      const ratio = (meas / mod) * 100;
      sumMeas += meas; sumMod += mod; nCells++;
      const { bg, fg } = matchDeltaColor(ratio - 100);
      const title = `${MONTHS[m]} ${h}:00 (unshaded) — measured ${fmtNum(meas)} kW vs modeled ${fmtNum(mod)} kW = ${Math.round(ratio)}%`;
      html += `<td style="background:${bg};color:${fg}" title="${title}">${Math.round(ratio)}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';

  if (nCells === 0) {
    wrap.innerHTML = '<p class="hint">No fully beam-unshaded daytime cells were found for this array — every modeled hour has some beam shading.</p>';
    return;
  }

  const acc = sumMod > 0 ? (sumMeas / sumMod) * 100 : 0;  // production-weighted
  const bias = acc - 100;
  const biasCls = Math.abs(bias) <= 5 ? 'gain' : 'loss';
  const verdict = Math.abs(bias) <= 5
    ? 'The clear-sky model is well-calibrated where the sun is unobstructed.'
    : bias < 0
      ? 'Measured runs below the model on clear, unshaded hours — the clear-sky model likely over-predicts (soiling, system/inverter losses, or optimistic irradiance), independent of shade.'
      : 'Measured runs above the model on clear, unshaded hours — the clear-sky model is conservative (under-rated capacity or losses) for this array.';

  let out = `
    <div class="stats-row" style="margin-bottom:8px">
      <div class="stat">
        <div class="stat-label">Unshaded Clear-Sky Accuracy</div>
        <div class="stat-value ${biasCls}">${acc.toFixed(0)}<span style="font-size:11px;color:var(--text3)"> %</span></div>
      </div>
      <div class="stat">
        <div class="stat-label">Model Bias (unshaded)</div>
        <div class="stat-value ${biasCls}">${bias >= 0 ? '+' : ''}${bias.toFixed(1)}<span style="font-size:11px;color:var(--text3)"> %</span></div>
      </div>
      <div class="stat">
        <div class="stat-label">Unshaded Cells</div>
        <div class="stat-value">${nCells}</div>
      </div>
    </div>`;
  out += html;
  out += `<div class="legend-row" style="justify-content:center;gap:10px;margin-top:8px;flex-wrap:wrap">
    <span class="legend-label"><span style="display:inline-block;width:11px;height:11px;background:rgba(239,68,68,0.6);border-radius:2px;vertical-align:middle"></span> below model</span>
    <span class="legend-label"><span style="display:inline-block;width:11px;height:11px;background:rgba(34,197,94,0.45);border-radius:2px;vertical-align:middle"></span> ±7% (match)</span>
    <span class="legend-label"><span style="display:inline-block;width:11px;height:11px;background:rgba(56,160,255,0.5);border-radius:2px;vertical-align:middle"></span> above model</span>
    <span class="legend-label"><span style="color:var(--text3)">×</span> beam-shaded (excluded)</span>
    <span class="legend-label"><span style="color:var(--text3)">·</span> no sun</span>
  </div>
  <p class="hint" style="margin-top:6px">Cells show measured ÷ modeled (%) for unshaded hours only. Accuracy is production-weighted across those cells. ${verdict}</p>`;
  wrap.innerHTML = out;
}

/** Wire the per-engine hourly AC export button. */
function bindHourlyExport(u) {
  const btn = qs('#btn-hourly-csv', _container);
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    const orig = b.textContent;
    b.disabled = true;
    b.textContent = 'Exporting…';
    try {
      const name = (getState().name || 'production').replace(/[^\w.-]+/g, '_');
      if (u.engine === 'pvlib' && u.hourlyKw) {
        downloadText(`${name}_pvlib_hourly_AC.csv`, pvlibHourlyToCSV(u.hourlyKw));
      } else {
        const { grid } = await runHourlyGrid();
        downloadText(`${name}_hourly_AC_24x365.csv`, hourlyGridToCSV(grid));
      }
    } finally {
      b.disabled = false;
      b.textContent = orig;
    }
  });
}

/** pvlib hourly AC (per TMY timestamp) → timestamp,kW CSV. */
function pvlibHourlyToCSV(hourlyKw) {
  const recs = getState().weather?.records || [];
  let csv = 'Year,Month,Day,Hour,Minute,AC_kW\n';
  for (let i = 0; i < hourlyKw.length; i++) {
    const r = recs[i] || {};
    csv += `${r.year ?? ''},${r.month ?? ''},${r.day ?? ''},${r.hour ?? ''},${r.minute ?? ''},${hourlyKw[i]}\n`;
  }
  return csv;
}

// --- Panel heatmap ---

function buildPanelHeatmap() {
  drawArrayMap();
}

/** Metric metadata: how to extract + color each sub-panel for the array map. */
function arrayMetricInfo(metric) {
  switch (metric) {
    case 'savWinter': return { kind: 'ratio', label: 'Winter SAV (Dec)', sub: (sr) => sr?.mSAV ? sr.mSAV[11] : 1 };
    case 'savSummer': return { kind: 'ratio', label: 'Summer SAV (Jun)', sub: (sr) => sr?.mSAV ? sr.mSAV[5] : 1 };
    case 'svf': return { kind: 'ratio', label: 'Effective Annual SVF', sub: (sr) => sr?.svf ?? 1 };
    case 'kwh': return { kind: 'scalar', label: 'Production (kWh / panel)', unit: 'kWh' };
    case 'sav':
    default: return { kind: 'ratio', label: 'Annual Solar Access (SAV)', sub: (sr) => sr?.sav ?? 1 };
  }
}

/**
 * Render the per-panel array map on a canvas, matching the Setup-page layout
 * (true aspect ratio, physical gutters, diode sub-sections, A1/B2 labels),
 * colored by the selected shade metric.
 */
function drawArrayMap() {
  const canvas = qs('#c-array-map', _container);
  const wrap = qs('#report-array', _container);
  if (!canvas || !wrap || !_results) return;

  const state = getState();
  const { rows, cols, panelWidth, panelHeight, panelGap = 0, diodeSplit, diodeSubsections } = state.system;
  const nSubs = diodeSubsections || 2;
  const subPanels = _results.subPanels;
  const subResults = _results.subResults;

  const info = arrayMetricInfo(_arrayMetric);

  // Per-panel scalar values (production) — normalized across the array.
  let perPanel = null, ppMin = 0, ppMax = 1;
  if (info.kind === 'scalar') {
    perPanel = (_prodCache[_prodEngine]?.perPanelKwh) || _results.perPanelKwh || null;
    if (perPanel && perPanel.length) {
      ppMin = Math.min(...perPanel);
      ppMax = Math.max(...perPanel);
    }
  }

  // Layout (mirrors setup.js drawViz, but gutters are proportional to panelGap).
  const wrapW = wrap.clientWidth || 600;
  const PAD = 16;
  const aspect = panelHeight / panelWidth;
  const gapFrac = panelWidth > 0 ? panelGap / panelWidth : 0.02; // gutter as fraction of panel width

  const availW = wrapW - 2 * PAD;
  let pW = availW / (cols + (cols - 1) * gapFrac);
  let pH = pW * aspect;
  let gap = pW * gapFrac;

  const maxH = 360;
  let gridH = rows * pH + (rows - 1) * gap;
  if (gridH > maxH) {
    const sc = maxH / gridH;
    pW *= sc; pH *= sc; gap *= sc;
  }

  const totalW = cols * pW + (cols - 1) * gap;
  const totalH = rows * pH + (rows - 1) * gap;
  const ox = (wrapW - totalW) / 2;
  const oy = PAD;
  const canvasH = totalH + 2 * PAD;

  _arrayDpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(wrapW * _arrayDpr);
  canvas.height = Math.round(canvasH * _arrayDpr);
  canvas.style.height = canvasH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(_arrayDpr, 0, 0, _arrayDpr, 0, 0);
  ctx.clearRect(0, 0, wrapW, canvasH);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = ox + c * (pW + gap);
      const py = oy + r * (pH + gap);
      const panelIdx = r * cols + c;

      // Sub-sections
      for (let s = 0; s < nSubs; s++) {
        const idx = panelIdx * nSubs + s;
        const sp = subPanels[idx];
        const sr = subResults[idx];

        let val, color, display;
        if (info.kind === 'scalar') {
          val = perPanel ? perPanel[panelIdx] : null;
          const norm = (ppMax > ppMin && val != null) ? (val - ppMin) / (ppMax - ppMin) : 1;
          color = val == null ? 'var(--surface2)' : scalarColor(norm);
          display = val == null ? '—' : fmtNum(val);
        } else {
          val = info.sub(sr);
          color = savColor(val);
          display = fmtPct(val);
        }

        // Cell geometry (split along diode direction)
        let sx, sy, sw, sh;
        if (diodeSplit === 'vertical') {
          sw = pW / nSubs; sh = pH; sx = px + s * sw; sy = py;
        } else {
          sw = pW; sh = pH / nSubs; sx = px; sy = py + s * sh;
        }

        ctx.fillStyle = color;
        ctx.fillRect(sx, sy, sw - 0.5, sh - 0.5);

        // Per-sub value text when it fits
        if (sw > 26 && sh > 12) {
          ctx.fillStyle = 'rgba(0,0,0,0.62)';
          ctx.font = 'bold 9px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(display, sx + sw / 2, sy + sh / 2 + (info.kind === 'scalar' ? 5 : 0));
        }
      }

      // Panel outline + label
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px, py, pW, pH);
      if (pW > 22 && pH > 14) {
        ctx.fillStyle = 'rgba(0,0,0,0.78)';
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`${String.fromCharCode(65 + r)}${c + 1}`, px + 3, py + 3);
      }
    }
  }

  drawArrayLegend(info, perPanel ? { min: ppMin, max: ppMax } : null);
}

/** Map a 0..1 normalized scalar to a red→amber→green color (kWh metric). */
function scalarColor(norm) {
  const n = Math.max(0, Math.min(1, norm));
  // red (239,68,68) → amber (245,166,35) → green (34,197,94)
  let r, g, b;
  if (n < 0.5) {
    const t = n / 0.5;
    r = 239 + (245 - 239) * t; g = 68 + (166 - 68) * t; b = 68 + (35 - 68) * t;
  } else {
    const t = (n - 0.5) / 0.5;
    r = 245 + (34 - 245) * t; g = 166 + (197 - 166) * t; b = 35 + (94 - 35) * t;
  }
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

/** Update the array-map legend for the active metric. */
function drawArrayLegend(info, range) {
  const leg = qs('#array-legend', _container);
  if (!leg) return;
  if (info.kind === 'scalar' && range) {
    leg.innerHTML = `
      <span class="legend-label">${fmtNum(range.min)} ${info.unit || ''}</span>
      <div class="legend-bar" style="background:linear-gradient(90deg,#ef4444,#f5a623,#22c55e)"></div>
      <span class="legend-label">${fmtNum(range.max)} ${info.unit || ''}</span>`;
  } else {
    leg.innerHTML = `
      <span class="legend-label">Low</span>
      <div class="legend-bar" style="background:linear-gradient(90deg,#ef4444,#f5a623,#22c55e)"></div>
      <span class="legend-label">100%</span>`;
  }
}

// --- Monthly chart ---

function drawMonthlyChart(mkwh, canvasId = 'c-monthly-prod', altMonthly = null) {
  const canvas = qs('#' + canvasId, _container);
  if (!canvas || !mkwh) return;
  const ctx = canvas.getContext('2d');

  // Crisp rendering: size the backing store to the CSS box × devicePixelRatio.
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 600;
  const H = 250;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const pad = { l: 50, r: 14, t: 14, b: 28 };

  ctx.clearRect(0, 0, W, H);

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

    // Comparison bar (JS scenario compare only)
    if (altMonthly) {
      const altH = (altMonthly[m] / maxV) * (H - pad.t - pad.b);
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

// --- Helpers ---

// ─── Sky Visibility Heatmap ───────────────────────────

async function initShadeMap() {
  _smCanvas = qs('#c-shade-map', _container);
  if (!_smCanvas || !_results) return;
  _smCtx = _smCanvas.getContext('2d');

  const state = getState();
  const subPanels = _results.subPanels;
  const scn = state.activeScenario;

  // Pre-build shade lookups and derive 1D horizons for heatmap rendering
  _subLookups = await Promise.all(
    subPanels.map(sp => buildMergedShadeLookupForPoints(sp.ptIds, scn))
  );
  _subHorizons = _subLookups.map(fn => maskLookupToHorizon(fn));

  // Pre-compute sun paths
  const lat = state.location.lat;
  _allPaths = lat != null ? computeAllSunPaths(lat) : [];

  drawHeatmapBase();
}

/**
 * Compute sky visibility: for each (azimuth, elevation) pixel,
 * what fraction of sub-panels have a clear view?
 * Uses 2D mask lookups when available, falls back to 1D horizons.
 */
function computeVisibility() {
  const azMin = 60, azMax = 300, elMax = 80;
  const SCALE = 3; // samples per degree for smoother rendering
  const W = (azMax - azMin) * SCALE, H = elMax * SCALE;
  const vis = new Float32Array(W * H);
  const n = _subLookups ? _subLookups.length : (_subHorizons ? _subHorizons.length : 0);
  if (n === 0) return { vis, W, H, azMin, azMax, elMax };

  for (let by = 0; by < H; by++) {
    const elv = (by + 0.5) / SCALE;
    for (let bx = 0; bx < W; bx++) {
      const az = azMin + (bx + 0.5) / SCALE;
      let v = 0;
      if (_subLookups) {
        for (const fn of _subLookups) {
          if (!fn(az, elv)) v++;
        }
      } else {
        for (const h of _subHorizons) {
          if (elv > h[Math.round(az) % 360]) v++;
        }
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

  // Horizon outlines — use freshly computed sub-horizons (not stored profiles
  // which may be stale if FOV was previously miscalculated)
  const state = getState();
  if (_subHorizons && _subHorizons.length > 0) {
    // Aggregate: max elevation across all sub-panel horizons.
    // Below this line, AT LEAST ONE panel is shaded ("any panel shaded").
    const aggH = new Float32Array(360);
    // Common horizon: min elevation across all sub-panel horizons.
    // Below this line, EVERY panel is shaded ("all panels shaded").
    const commonH = new Float32Array(360);
    for (let az = 0; az < 360; az++) commonH[az] = Infinity;
    for (const h of _subHorizons) {
      for (let az = 0; az < 360; az++) {
        if (h[az] > aggH[az]) aggH[az] = h[az];
        if (h[az] < commonH[az]) commonH[az] = h[az];
      }
    }
    for (let az = 0; az < 360; az++) {
      if (!isFinite(commonH[az])) commonH[az] = 0;
    }

    // "Any panel shaded" boundary (faint).
    ctx.beginPath();
    for (let az = azMin; az < azMax; az++) {
      const x = pad.l + ((az - azMin) / (azMax - azMin)) * dw;
      const y = pad.t + dh * (1 - aggH[az] / elMax);
      az === azMin ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 0.6;
    ctx.stroke();

    // "All panels shaded" common horizon (solid black).
    ctx.beginPath();
    for (let az = azMin; az < azMax; az++) {
      const x = pad.l + ((az - azMin) / (azMax - azMin)) * dw;
      const y = pad.t + dh * (1 - commonH[az] / elMax);
      az === azMin ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 1.4;
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

    // Add photo capture date path if available
    let photoDoy = null;
    for (const photo of Object.values(state.photos)) {
      if (photo.metadata?.datetime) {
        const dt = photo.metadata.datetime instanceof Date
          ? photo.metadata.datetime : new Date(photo.metadata.datetime);
        if (!isNaN(dt.getTime())) {
          photoDoy = Math.floor((dt - new Date(dt.getFullYear(), 0, 0)) / 86400000);
          break;
        }
      }
    }

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

    // Photo date sun path
    if (photoDoy != null) {
      const decl = solarDeclination(photoDoy);
      const pts = [];
      for (let ha = -90; ha <= 90; ha += 0.5) {
        const sp = sunPosition(lat, decl, ha);
        if (sp.elevation > 0 && sp.azimuth >= azMin && sp.azimuth <= azMax) pts.push(sp);
      }
      if (pts.length > 1) {
        ctx.beginPath();
        ctx.moveTo(toX(pts[0].azimuth), toY(pts[0].elevation));
        for (let i = 1; i < pts.length; i++) ctx.lineTo(toX(pts[i].azimuth), toY(pts[i].elevation));
        ctx.strokeStyle = '#4ade80';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      kp.push({ label: 'Photo date', color: '#4ade80', dash: [] });
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

function sectionTitle(title, sub) {
  return `<div style="margin:26px 2px 6px;padding-bottom:6px;border-bottom:2px solid var(--border)">
    <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--sun);font-weight:700">${esc(title)}</div>
    ${sub ? `<div class="hint" style="margin-top:2px">${esc(sub)}</div>` : ''}
  </div>`;
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
