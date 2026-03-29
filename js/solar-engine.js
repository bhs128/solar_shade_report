/**
 * SolarScope — Solar calculation engine
 * JavaScript implementation of pvlib-equivalent algorithms with optional Pyodide upgrade.
 * Implements: solar position (Spencer), clear-sky (Ineichen/Perez), POA transposition,
 * weather derating, temperature model, and full energy yield computation.
 */

import { getState, getSubPanels, getMergedHorizon, getHorizonForPoint, getPhotoForPoint, getTraceForPoint } from './state.js';
import { decodeMaskDataUrl, buildSkyMaskLookup, buildMergedMaskLookup } from './utils.js';

const DEG = Math.PI / 180;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MDAYS_CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

// ============================================================
// Exports
// ============================================================

export { MONTHS, MDAYS, MDAYS_CUM };

// ============================================================
// Mask-based shade lookup helpers
// ============================================================

/**
 * Build a shade lookup from a photo's trace data.
 * Supports both 2D groundMask (preferred) and legacy 1D horizonProfile.
 */
async function _buildShadeLookup(photo, trace, systemDefaults) {
  if (trace?.groundMask) {
    const maskData = await decodeMaskDataUrl(trace.groundMask);
    return buildSkyMaskLookup(photo, maskData, systemDefaults);
  }
  if (trace?.horizonProfile) {
    const h = trace.horizonProfile;
    return (az, el) => el <= h[Math.round(az) % 360];
  }
  return () => false;
}

/**
 * Build merged shade lookups for a set of point IDs.
 * Returns (az, el) => boolean — shaded if ANY point's mask says so.
 */
export async function buildMergedShadeLookupForPoints(ptIds, scenario) {
  const state = getState();
  const systemDefaults = { azimuth: state.system.azimuth, tilt: state.system.tilt };
  const scn = scenario || state.activeScenario;
  const lookups = [];
  const seen = new Set();
  for (const pid of ptIds) {
    const photo = getPhotoForPoint(pid);
    if (!photo || seen.has(photo.id)) continue;
    seen.add(photo.id);
    const trace = photo.traces[scn] || photo.traces['As-Is'];
    const fn = await _buildShadeLookup(photo, trace, systemDefaults);
    lookups.push(fn);
  }
  return buildMergedMaskLookup(lookups);
}

/** Engine readiness state */
let _pyodideReady = false;
let _pyodide = null;

export function isEnginePyodide() { return _pyodideReady; }

// ============================================================
// Solar Geometry (Spencer / pvlib.solarposition equivalent)
// ============================================================

export function solarDeclination(doy) {
  return 23.45 * Math.sin(DEG * (360 / 365) * (doy - 81));
}

export function equationOfTime(doy) {
  const B = (360 / 365) * (doy - 81) * DEG;
  return 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
}

/**
 * Compute sun position for a given latitude, declination, and hour angle.
 * Returns { elevation, azimuth } in degrees.
 * Azimuth: 0=N, 90=E, 180=S, 270=W
 */
export function sunPosition(lat, decl, hourAngle) {
  const lr = lat * DEG, dr = decl * DEG, hr = hourAngle * DEG;
  const sinEl = Math.sin(lr) * Math.sin(dr) + Math.cos(lr) * Math.cos(dr) * Math.cos(hr);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl))) / DEG;

  const cosEl = Math.cos(el * DEG);
  if (cosEl < 1e-10) return { elevation: el, azimuth: 180 };

  const cosAz = (Math.sin(dr) - Math.sin(lr) * sinEl) / (Math.cos(lr) * cosEl);
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) / DEG;
  if (hourAngle > 0) az = 360 - az;

  return { elevation: el, azimuth: az };
}

/** Precompute sun paths for all 12 months (21st of each month) */
export function computeAllSunPaths(lat) {
  const paths = [];
  for (let m = 0; m < 12; m++) {
    const doy = MDAYS_CUM[m] + 21;
    const decl = solarDeclination(doy);
    const pts = [];
    for (let ha = -90; ha <= 90; ha += 0.5) {
      const p = sunPosition(lat, decl, ha);
      if (p.elevation > 0) pts.push({ ...p, ha });
    }
    paths.push(pts);
  }
  return paths;
}

// ============================================================
// Clear-sky irradiance models
// ============================================================

/**
 * Hottel clear-sky beam model (approximation of pvlib.clearsky.ineichen)
 * Returns DNI in W/m²
 */
export function clearSkyDNI(elevation) {
  if (elevation <= 0) return 0;
  const sinE = Math.sin(elevation * DEG);
  // Kasten-Young air mass
  const am = 1 / (sinE + 0.50572 * Math.pow(6.07995 + elevation, -1.6364));
  // Hottel model for mid-latitude, ~300m elevation
  const a0 = 0.4237 - 0.00821 * Math.pow(2 - 0.3, 2);
  const a1 = 0.5055 + 0.00595 * Math.pow(6.5 - 0.3, 2);
  const k = 0.2711 + 0.01858 * Math.pow(2.5 - 0.3, 2);
  const tau = a0 + a1 * Math.exp(-k * am);
  return Math.max(0, 1367 * tau);
}

/** Clear-sky diffuse horizontal irradiance */
export function clearSkyDHI(elevation, dni) {
  if (elevation <= 0) return 0;
  const sinE = Math.sin(elevation * DEG);
  return Math.max(0, (1367 * 0.1 * sinE + 20) * 1.15);
}

/** Clear-sky global horizontal irradiance */
export function clearSkyGHI(elevation, dni, dhi) {
  return dni * Math.sin(elevation * DEG) + dhi;
}

// ============================================================
// POA transposition (pvlib.irradiance.get_total_irradiance equivalent)
// ============================================================

/**
 * Compute plane-of-array irradiance components.
 * Uses isotropic diffuse model (Loutzenhiser et al. 2007).
 */
export function poaIrradiance(dni, dhi, ghi, sunEl, sunAz, tilt, panelAz) {
  if (sunEl <= 0) return { beam: 0, diffuse: 0, ground: 0, total: 0 };

  const szr = (90 - sunEl) * DEG, tr = tilt * DEG;
  const sar = sunAz * DEG, par = panelAz * DEG;

  // Angle of incidence
  const cosAOI = Math.cos(szr) * Math.cos(tr) +
                 Math.sin(szr) * Math.sin(tr) * Math.cos(sar - par);
  const beam = Math.max(0, dni * cosAOI);

  // Isotropic diffuse
  const diffuse = dhi * (1 + Math.cos(tr)) / 2;

  // Ground-reflected (albedo = 0.2)
  const ground = ghi * 0.2 * (1 - Math.cos(tr)) / 2;

  return { beam, diffuse, ground, total: beam + diffuse + ground };
}

// ============================================================
// Weather model — NREL TMY-calibrated
// Three-tier: clear / moderate / overcast
// ============================================================

function getWeatherParams(lat) {
  // Default TMY scale factors (calibrated for mid-latitude US)
  // These can be improved with location-specific TMY data
  const TMY_SCALE = [0.567, 0.544, 0.582, 0.506, 0.558, 0.574, 0.608, 0.578, 0.606, 0.536, 0.558, 0.581];
  const CLOUD_FACTOR = TMY_SCALE.map(s => Math.max(0.05, Math.min(0.65, (s - 0.234) / 0.88)));
  return { CLOUD_FACTOR, MOD_FRAC: 0.30, TIERS: [
    { dniFrac: 1.0, dhiFrac: 1.0 },
    { dniFrac: 0.45, dhiFrac: 0.85 },
    { dniFrac: 0.08, dhiFrac: 0.60 },
  ]};
}

// Monthly ambient temperature (°C) — mid-latitude continental default
// Can be overridden with location-specific data
function getAmbientTemps(lat) {
  // Simple latitude-adjusted model
  // Base: mid-latitude continental (lat ~43°)
  const base = [-7, -5, 1, 8, 15, 20, 23, 22, 17, 10, 3, -4];
  const latDiff = Math.abs(lat) - 43;
  return base.map(t => t - latDiff * 0.5);
}

/** Cell temperature model (SAPM / PVWatts equivalent) */
function cellTemp(ambC, poaWm2) {
  return ambC + poaWm2 / 800 * (49 - 20);
}

/** Temperature derating (-0.35%/°C above STC 25°C) */
function tempDerate(tCellC) {
  return Math.max(0.75, 1 + (-0.0035) * (tCellC - 25));
}

// ============================================================
// Full system computation
// ============================================================

/**
 * Compute full irradiance metrics for a single measurement point.
 * Returns monthly SAV, POA values, hourly access, and annual totals.
 *
 * @param {function} shadeLookup - (az, el) => boolean, true = shaded
 * @param {number} lat - latitude
 * @param {number} tilt - panel tilt degrees
 * @param {number} panelAz - panel azimuth degrees
 */
export function computePointIrradiance(shadeLookup, lat, tilt, panelAz) {
  const allPaths = computeAllSunPaths(lat);
  const weather = getWeatherParams(lat);

  const mPOA_clear = new Float32Array(12);
  const mPOA_weather = new Float32Array(12);
  const mPOA_shaded = new Float32Array(12);
  const mSAV = new Float32Array(12);
  const hourlyAccess = new Float32Array(12 * 15);
  const hourlyIrrad_noshade = new Float32Array(12 * 15);
  const hourlyIrrad_shaded = new Float32Array(12 * 15);

  for (let m = 0; m < 12; m++) {
    const cf = weather.CLOUD_FACTOR[m];
    const fOvc = Math.max(0, 1 - cf - weather.MOD_FRAC);
    const tierWeights = [cf, weather.MOD_FRAC, fOvc];
    let poaClear = 0, poaWeather = 0, poaShaded = 0;
    const hNoshade = new Float32Array(15);
    const hShaded = new Float32Array(15);

    const path = allPaths[m];
    for (const pt of path) {
      const dniClear = clearSkyDNI(pt.elevation);
      const dhiClear = clearSkyDHI(pt.elevation, dniClear);
      const ghiClear = clearSkyGHI(pt.elevation, dniClear, dhiClear);
      const poaClearPt = poaIrradiance(dniClear, dhiClear, ghiClear, pt.elevation, pt.azimuth, tilt, panelAz);
      poaClear += poaClearPt.total;

      const isShaded = shadeLookup(pt.azimuth, pt.elevation);

      for (let ti = 0; ti < 3; ti++) {
        const tw = tierWeights[ti];
        if (tw <= 0) continue;
        const dni = dniClear * weather.TIERS[ti].dniFrac;
        const dhi = dhiClear * weather.TIERS[ti].dhiFrac;
        const ghi = clearSkyGHI(pt.elevation, dni, dhi);
        const poa = poaIrradiance(dni, dhi, ghi, pt.elevation, pt.azimuth, tilt, panelAz);
        poaWeather += poa.total * tw;
        if (isShaded) {
          poaShaded += (poa.diffuse + poa.ground) * tw;
        } else {
          poaShaded += poa.total * tw;
        }
      }

      const solarHour = 12 + pt.ha / 15;
      const hi = Math.floor(solarHour) - 6;
      if (hi >= 0 && hi < 15) {
        let wNs = 0, wSh = 0;
        for (let ti = 0; ti < 3; ti++) {
          const tw = tierWeights[ti];
          if (tw <= 0) continue;
          const dni = dniClear * weather.TIERS[ti].dniFrac;
          const dhi = dhiClear * weather.TIERS[ti].dhiFrac;
          const ghi = clearSkyGHI(pt.elevation, dni, dhi);
          const poa = poaIrradiance(dni, dhi, ghi, pt.elevation, pt.azimuth, tilt, panelAz);
          wNs += poa.total * tw;
          wSh += (isShaded ? (poa.diffuse + poa.ground) : poa.total) * tw;
        }
        hNoshade[hi] += wNs;
        hShaded[hi] += wSh;
      }
    }

    mPOA_clear[m] = poaClear;
    mPOA_weather[m] = poaWeather;
    mPOA_shaded[m] = poaShaded;
    mSAV[m] = poaWeather > 0 ? poaShaded / poaWeather : 1;

    for (let hi = 0; hi < 15; hi++) {
      hourlyIrrad_noshade[m * 15 + hi] = hNoshade[hi];
      hourlyIrrad_shaded[m * 15 + hi] = hShaded[hi];
      hourlyAccess[m * 15 + hi] = hNoshade[hi] > 0 ? hShaded[hi] / hNoshade[hi] : 1;
    }
  }

  const annualClear = mPOA_clear.reduce((a, b) => a + b, 0);
  const annualWeather = mPOA_weather.reduce((a, b) => a + b, 0);
  const annualShaded = mPOA_shaded.reduce((a, b) => a + b, 0);
  const sav = annualWeather > 0 ? annualShaded / annualWeather : 1;
  const weatherFactor = annualClear > 0 ? annualWeather / annualClear : 1;

  return {
    mSAV, mPOA_clear, mPOA_weather, mPOA_shaded,
    hourlyAccess, hourlyIrrad_noshade, hourlyIrrad_shaded,
    annualClear, annualWeather, annualShaded,
    sav, weatherFactor,
  };
}

/**
 * Compute TOF (Tilt Orientation Factor).
 * Ratio of actual tilt/azimuth POA to optimal (tilt=latitude, azimuth=180).
 */
export function computeTOF(lat, tilt, panelAz) {
  const allPaths = computeAllSunPaths(lat);
  const weather = getWeatherParams(lat);
  let poaActual = 0, poaOptimal = 0;

  for (let m = 0; m < 12; m++) {
    const cf = weather.CLOUD_FACTOR[m];
    for (const pt of allPaths[m]) {
      const dni = clearSkyDNI(pt.elevation) * cf;
      const dhi = clearSkyDHI(pt.elevation, dni) * cf;
      const ghi = clearSkyGHI(pt.elevation, dni, dhi);
      poaActual += poaIrradiance(dni, dhi, ghi, pt.elevation, pt.azimuth, tilt, panelAz).total;
      poaOptimal += poaIrradiance(dni, dhi, ghi, pt.elevation, pt.azimuth, lat, 180).total;
    }
  }
  return poaOptimal > 0 ? poaActual / poaOptimal : 1;
}

/**
 * Run full system analysis.
 * Returns comprehensive results for all half-panels, monthly/hourly tables,
 * and system-level kWh estimates.
 */
export async function runFullAnalysis(scenario = null) {
  const state = getState();
  const { lat, lon } = state.location;
  if (lat == null) return null;

  const { tilt, azimuth, panelWp, inverterWatts, rows, cols, systemLosses, inverterEff } = state.system;
  const numPanels = rows * cols;
  const scn = scenario || state.activeScenario;

  // Sub-panel mapping (respects diode sub-sections)
  const subPanels = getSubPanels();
  const nSubs = subPanels.length > 0 ? subPanels[0].nSubs : 2;

  // Pre-build shade lookups for each sub-panel (supports 2D masks + legacy horizons)
  const subLookups = await Promise.all(
    subPanels.map(sp => buildMergedShadeLookupForPoints(sp.ptIds, scn))
  );

  // Per-sub-panel irradiance results
  const subResults = subPanels.map((sp, i) =>
    computePointIrradiance(subLookups[i], lat, tilt, azimuth)
  );

  const tof = computeTOF(lat, tilt, azimuth);

  // Aggregate SAV
  let savSum = 0;
  for (const sr of subResults) {
    savSum += sr.sav;
  }
  const avgSAV = savSum / subPanels.length;
  const tsrf = avgSAV * tof;

  // Full energy yield calculation
  const allPaths = computeAllSunPaths(lat);
  const weather = getWeatherParams(lat);
  const ambTemps = getAmbientTemps(lat);
  const sysEff = 1 - systemLosses / 100;
  const invEff = inverterEff / 100;
  const hoursPerStep = 0.5 / 15; // integration time step
  const clipW = inverterWatts;

  let totalClear = 0, totalWeather = 0, totalShaded = 0, totalClipped = 0;
  const monthlyKwh = new Float32Array(12);

  for (let m = 0; m < 12; m++) {
    const cf = weather.CLOUD_FACTOR[m];
    const fOvc = Math.max(0, 1 - cf - weather.MOD_FRAC);
    const tierWeights = [cf, weather.MOD_FRAC, fOvc];
    const ambT = ambTemps[m];
    const path = allPaths[m];
    const dayWeight = MDAYS[m];

    for (const pt of path) {
      const dniClear = clearSkyDNI(pt.elevation);
      const dhiClear = clearSkyDHI(pt.elevation, dniClear);
      const ghiClear = clearSkyGHI(pt.elevation, dniClear, dhiClear);
      const poaClearPt = poaIrradiance(dniClear, dhiClear, ghiClear, pt.elevation, pt.azimuth, tilt, azimuth);
      const az = Math.round(pt.azimuth) % 360;

      for (let p = 0; p < numPanels; p++) {
        // Count how many sub-sections are shaded for this panel
        const subBase = p * nSubs;
        let shadedSubs = 0;
        for (let s = 0; s < nSubs; s++) {
          if (subLookups[subBase + s](pt.azimuth, pt.elevation)) shadedSubs++;
        }

        const dcClearMax = poaClearPt.total / 1000 * panelWp * sysEff;
        totalClear += dcClearMax * dayWeight;

        for (let ti = 0; ti < 3; ti++) {
          const tw = tierWeights[ti];
          if (tw <= 0) continue;
          const dni = dniClear * weather.TIERS[ti].dniFrac;
          const dhi = dhiClear * weather.TIERS[ti].dhiFrac;
          const ghi = clearSkyGHI(pt.elevation, dni, dhi);
          const poa = poaIrradiance(dni, dhi, ghi, pt.elevation, pt.azimuth, tilt, azimuth);

          const tCell = cellTemp(ambT, poa.total);
          const tDer = tempDerate(tCell);

          const dcWeather = poa.total / 1000 * panelWp * sysEff * tDer;
          totalWeather += dcWeather * tw * dayWeight;

          // Shade impact: proportional to fraction of sub-sections shaded
          // With bypass diodes, shaded sub-sections lose beam but keep diffuse
          let shadedPOA;
          if (shadedSubs === 0) {
            shadedPOA = poa.total;
          } else if (shadedSubs === nSubs) {
            shadedPOA = poa.diffuse + poa.ground;
          } else {
            const unshadedFrac = (nSubs - shadedSubs) / nSubs;
            shadedPOA = unshadedFrac * poa.total + (1 - unshadedFrac) * (poa.diffuse + poa.ground);
          }

          const dcShaded = shadedPOA / 1000 * panelWp * sysEff * tDer;
          totalShaded += dcShaded * tw * dayWeight;

          const clipped = Math.min(dcShaded, clipW) * invEff * tw * dayWeight;
          totalClipped += clipped;
          monthlyKwh[m] += clipped * hoursPerStep / 1000;
        }
      }
    }
  }

  const clearKwh = totalClear * hoursPerStep * invEff / 1000;
  const weatherKwh = totalWeather * hoursPerStep * invEff / 1000;
  const shadedKwh = totalShaded * hoursPerStep * invEff / 1000;
  const netKwh = totalClipped * hoursPerStep / 1000;

  return {
    subPanels,
    subResults,
    tof,
    avgSAV,
    tsrf,
    clearKwh,
    weatherKwh,
    shadedKwh,
    netKwh,
    weatherLoss: clearKwh * invEff - weatherKwh,
    shadeLoss: weatherKwh - shadedKwh,
    clipLoss: shadedKwh - netKwh,
    monthlyKwh,
    numPanels,
    dcCapacity: numPanels * panelWp / 1000,
    acCapacity: numPanels * clipW / 1000,
    // Backwards-compat aliases
    halfPanels: subPanels,
    pointResults: Object.fromEntries(subPanels.map((sp, i) => [sp.ptIds[0] || `sub_${i}`, subResults[i]])),
  };
}

/**
 * Run comparative analysis between two scenarios.
 * Returns { baseline, alternative, delta }
 */
export async function runComparison(baseScenario, altScenario) {
  const baseline = await runFullAnalysis(baseScenario);
  const alternative = await runFullAnalysis(altScenario);
  if (!baseline || !alternative) return null;

  return {
    baseline,
    alternative,
    delta: {
      savDiff: alternative.avgSAV - baseline.avgSAV,
      tsrfDiff: alternative.tsrf - baseline.tsrf,
      kwhDiff: alternative.netKwh - baseline.netKwh,
      kwhPctDiff: baseline.netKwh > 0
        ? (alternative.netKwh - baseline.netKwh) / baseline.netKwh
        : 0,
      monthlyDiff: new Float32Array(12).map((_, m) =>
        alternative.monthlyKwh[m] - baseline.monthlyKwh[m]
      ),
    },
  };
}

/**
 * Check if a sun position is shaded at a given measurement point.
 * Async: decodes mask if needed. Falls back to legacy horizon profile.
 */
export async function isSunShaded(pointId, sunAz, sunEl, scenario = null) {
  const lookup = await buildMergedShadeLookupForPoints([pointId], scenario);
  return lookup(sunAz, sunEl);
}

// ============================================================
// Pyodide / pvlib integration (progressive enhancement)
// ============================================================

/**
 * Attempt to load Pyodide and pvlib.
 * Calls onProgress with status messages.
 * Returns true if successful.
 */
export async function initPyodide(onProgress = () => {}) {
  try {
    onProgress('Loading Python runtime...');
    const pyodideModule = await import('https://cdn.jsdelivr.net/pyodide/v0.27.4/full/pyodide.mjs');
    onProgress('Initializing Python...');
    _pyodide = await pyodideModule.loadPyodide({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.4/full/',
    });

    onProgress('Installing pvlib...');
    await _pyodide.loadPackage('micropip');
    await _pyodide.runPythonAsync(`
      import micropip
      await micropip.install('pvlib')
    `);

    onProgress('pvlib ready');
    _pyodideReady = true;
    return true;
  } catch (err) {
    console.warn('Pyodide/pvlib load failed:', err);
    onProgress('Using JS engine (pvlib unavailable)');
    return false;
  }
}
