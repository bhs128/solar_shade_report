/**
 * SolarScope — Solar calculation engine
 * JavaScript implementation of pvlib-equivalent algorithms with optional Pyodide upgrade.
 * Implements: solar position (Spencer), clear-sky (Ineichen/Perez), POA transposition,
 * weather derating, temperature model, and full energy yield computation.
 */

import { getState, getSubPanels, getMergedHorizon, getHorizonForPoint, getPhotoForPoint, getTraceForPoint, pointMeters } from './state.js';
import { decodeMaskDataUrl, buildSkyMaskLookup, buildSkyMaskCategoryLookup, buildMergedMaskLookup, MASK_OPEN, MASK_SOLID, MASK_DECIDUOUS } from './utils.js';

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
  const systemDefaults = { azimuth: state.system.azimuth, tilt: state.system.tilt, cameraFovCalibration: state.system.cameraFovCalibration };
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

/**
 * Build a merged obstruction-CATEGORY lookup for a set of point IDs.
 * Returns (az, el) => 0 | 1 | 2  (open | solid | deciduous).
 * Merge rule: solid dominates (any solid → 1); else deciduous if any → 2; else 0.
 */
export async function buildMergedCategoryLookupForPoints(ptIds, scenario) {
  const state = getState();
  const systemDefaults = { azimuth: state.system.azimuth, tilt: state.system.tilt, cameraFovCalibration: state.system.cameraFovCalibration };
  const scn = scenario || state.activeScenario;
  const cats = [];
  const seen = new Set();
  for (const pid of ptIds) {
    const photo = getPhotoForPoint(pid);
    if (!photo || seen.has(photo.id)) continue;
    seen.add(photo.id);
    const trace = photo.traces[scn] || photo.traces['As-Is'];
    if (!trace?.groundMask) continue;
    const maskData = await decodeMaskDataUrl(trace.groundMask);
    cats.push(buildSkyMaskCategoryLookup(photo, maskData, systemDefaults));
  }
  if (cats.length === 0) return () => MASK_OPEN;
  if (cats.length === 1) return cats[0];
  return (az, el) => {
    let decid = false;
    for (const fn of cats) {
      const c = fn(az, el);
      if (c === MASK_SOLID) return MASK_SOLID; // solid dominates
      if (c === MASK_DECIDUOUS) decid = true;
    }
    return decid ? MASK_DECIDUOUS : MASK_OPEN;
  };
}

/**
 * Default monthly BARE-branch BEAM transmittance (Jan..Dec) for deciduous masks.
 * Temperate maple, ~43°N: leaf-out May, full leaf Jun–Sep, leaf-drop October.
 */
export const DEFAULT_DECID_BEAM_TAU = [0.45, 0.45, 0.45, 0.42, 0.25, 0.05, 0.04, 0.04, 0.07, 0.22, 0.42, 0.45];

/**
 * Monthly deciduous-canopy TRANSMITTANCE, split into beam and diffuse, index 0=Jan..11=Dec.
 *
 * Beam τ comes straight from the configured 12-month calendar (a deciduous cell
 * transmits τ of the beam it geometrically blocks, so it loses 1−τ). Diffuse τ
 * is the beam value plus a fixed offset (bare branches admit more sky-diffuse
 * than collimated beam), clamped to [0,1]. Both arrays are shifted 6 months for
 * southern-hemisphere latitudes.
 *
 * @param {object} system - state.system (deciduousBeamTau[12], deciduousDiffuseOffset)
 * @param {number} lat - project latitude (sign selects hemisphere)
 * @returns {{beam:number[], diffuse:number[]}} transmittance fractions in [0,1]
 */
export function deciduousTransmittanceByMonth(system, lat = 45) {
  const tau = (system && system.deciduousBeamTau && system.deciduousBeamTau.length === 12)
    ? system.deciduousBeamTau : DEFAULT_DECID_BEAM_TAU;
  const offset = system?.deciduousDiffuseOffset ?? 0.15;
  const shift = lat < 0 ? 6 : 0;
  const beam = new Array(12), diffuse = new Array(12);
  for (let m = 0; m < 12; m++) {
    const b = Math.max(0, Math.min(1, tau[(m + shift) % 12] ?? 0));
    beam[m] = b;
    diffuse[m] = Math.max(0, Math.min(1, b + offset));
  }
  return { beam, diffuse };
}

/**
 * Resolve the calibrated panel-normal azimuth for a set of measurement points.
 *
 * Panel TILT is trusted from the system config (accurate by construction), but
 * the direction the panel/photo faces is taken from the per-photo orientation
 * calibration (derived from the Insta360 capture, where image zenith == panel
 * normal). This calibration is the more trustworthy azimuth for the diffuse SVF
 * weighting. Falls back to the system azimuth when a point's photo has no
 * orientation override (e.g. equirectangular panos with no panel-normal frame).
 *
 * @param {string[]} ptIds
 * @param {number} fallbackAz - system azimuth, degrees
 * @returns {number} azimuth in degrees
 */
function svfAzimuthForPoints(ptIds, fallbackAz) {
  for (const pid of ptIds || []) {
    const photo = getPhotoForPoint(pid);
    const a = photo?.orientation?.panelAzimuth;
    if (a != null) return a;
  }
  return fallbackAz;
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
 * US daylight-saving rule (since 2007): active from the 2nd Sunday of March to
 * the 1st Sunday of November. doy is 1-based; year defaults to 2025 (transition
 * dates drift only a few days between years — negligible for hour binning).
 */
export function usDstActive(doy, year = 2025) {
  const nthSundayDoy = (month, n) => {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const day = 1 + ((7 - first.getUTCDay()) % 7) + (n - 1) * 7; // Sunday = 0
    const d = new Date(Date.UTC(year, month - 1, day));
    return Math.floor((d - new Date(Date.UTC(year, 0, 1))) / 86400000) + 1;
  };
  const start = nthSundayDoy(3, 2);  // 2nd Sunday of March
  const end = nthSundayDoy(11, 1);   // 1st Sunday of November
  return doy >= start && doy < end;
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
// Diffuse Sky View Factor (SVF)
// ============================================================

/**
 * Compute the diffuse Sky View Factor reduction for a tilted plane from a
 * shade lookup. This is the fraction of the panel's isotropic-diffuse sky view
 * that remains UNBLOCKED — a pure-geometry value, independent of sun position.
 *
 * The returned factor multiplies the isotropic diffuse term `poa.diffuse`
 * (which already carries the unobstructed (1+cos tilt)/2 view factor), so it
 * captures diffuse loss from canopy/horizon obstructions WITHOUT touching the
 * beam channel (no double-count with the 12×24 beam shade table).
 *
 * Weighting is cosine-of-incidence about the PANEL NORMAL, consistent with the
 * isotropic transposition model in poaIrradiance(). The Insta360 fisheye photos
 * are captured with the optical axis (image zenith) aligned to the panel normal,
 * and buildSkyMaskLookup() maps world (az, el) through that camera frame, so
 * integrating in world coordinates with cos(angle-to-normal) weighting honors
 * that capture geometry directly.
 *
 * @param {function} lookup - (az, el) => boolean, true = blocked/shaded
 * @param {number} tilt - panel tilt from horizontal, degrees
 * @param {number} panelAz - panel azimuth (compass bearing it faces), degrees
 * @param {object} [opts]
 * @param {number} [opts.azStep=3] - azimuth sampling step (deg)
 * @param {number} [opts.elStep=3] - elevation sampling step (deg)
 * @returns {number} open-sky fraction in [0,1] (1 = fully open)
 */
export function computeDiffuseSVF(lookup, tilt, panelAz, opts = {}) {
  if (typeof lookup !== 'function') return 1;
  const azStep = opts.azStep ?? 3;
  const elStep = opts.elStep ?? 3;

  // Panel normal in world coords (Z=up, X=east, Y=north):
  // facing south (az=180) tilted 30° → points south and up.
  const tr = tilt * DEG, ar = panelAz * DEG;
  const nx = Math.sin(ar) * Math.sin(tr);
  const ny = Math.cos(ar) * Math.sin(tr);
  const nz = Math.cos(tr);

  let openW = 0;
  let totalW = 0;

  for (let az = azStep / 2; az < 360; az += azStep) {
    const azr = az * DEG;
    for (let el = elStep / 2; el < 90; el += elStep) {
      const er = el * DEG;
      const cosE = Math.cos(er);
      const sinE = Math.sin(er);
      // Sky direction (above true horizon → sky, not ground)
      const dx = cosE * Math.sin(azr);
      const dy = cosE * Math.cos(azr);
      const dz = sinE;
      // Cosine of incidence angle relative to the panel normal.
      const cosInc = dx * nx + dy * ny + dz * nz;
      if (cosInc <= 0) continue; // behind the panel plane → ground side, not sky diffuse
      // Diffuse weight: cos(incidence) × solid-angle element (cosE dEl dAz)
      const w = cosInc * cosE;
      totalW += w;
      if (!lookup(az, el)) openW += w;
    }
  }

  return totalW > 0 ? openW / totalW : 1;
}

/**
 * Category-aware diffuse SVF, split into open-sky and deciduous-covered weights.
 *
 * Returns { open, decid } as fractions of the panel's weighted hemisphere:
 *   - open  = directions with clear sky (always contribute diffuse)
 *   - decid = directions covered by deciduous canopy (contribute seasonally)
 * Solid-blocked directions contribute to neither.
 *
 * The effective SVF for a given month is then:
 *     SVF(month) = open + decid * (1 − deciduousOpacity(month))
 * so in summer (opacity 1) deciduous fully blocks (SVF = open), and in winter
 * (opacity = 1 − transmission) part of the canopy-covered sky is recovered.
 *
 * @param {function} catLookup - (az, el) => 0|1|2 (open|solid|deciduous)
 * @returns {{open:number, decid:number}}
 */
export function computeDiffuseSVFComponents(catLookup, tilt, panelAz, opts = {}) {
  if (typeof catLookup !== 'function') return { open: 1, decid: 0 };
  const azStep = opts.azStep ?? 3;
  const elStep = opts.elStep ?? 3;

  const tr = tilt * DEG, ar = panelAz * DEG;
  const nx = Math.sin(ar) * Math.sin(tr);
  const ny = Math.cos(ar) * Math.sin(tr);
  const nz = Math.cos(tr);

  let openW = 0, decidW = 0, totalW = 0;

  for (let az = azStep / 2; az < 360; az += azStep) {
    const azr = az * DEG;
    for (let el = elStep / 2; el < 90; el += elStep) {
      const er = el * DEG;
      const cosE = Math.cos(er);
      const sinE = Math.sin(er);
      const dx = cosE * Math.sin(azr);
      const dy = cosE * Math.cos(azr);
      const dz = sinE;
      const cosInc = dx * nx + dy * ny + dz * nz;
      if (cosInc <= 0) continue;
      const w = cosInc * cosE;
      totalW += w;
      const c = catLookup(az, el);
      if (c === MASK_OPEN) openW += w;
      else if (c === MASK_DECIDUOUS) decidW += w;
      // MASK_SOLID → blocked, contributes 0
    }
  }

  if (totalW <= 0) return { open: 1, decid: 0 };
  return { open: openW / totalW, decid: decidW / totalW };
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
export function computePointIrradiance(shadeLookup, lat, tilt, panelAz, svfAzimuth = panelAz, opts = {}) {
  const allPaths = computeAllSunPaths(lat);
  const weather = getWeatherParams(lat);

  // shadeLookup may return a boolean (true = shaded) OR a beam-transmittance
  // fraction in [0,1] (1 = fully lit). Normalise to a transmittance so callers
  // can pass distance-interpolated shade.
  const beamTransAt = (az, el) => {
    const v = shadeLookup(az, el);
    return typeof v === 'number' ? v : (v ? 0 : 1);
  };

  // Diffuse Sky View Factor: fraction of isotropic-diffuse sky view left open.
  // Pure geometry → compute once and reuse for every timestep. A caller that has
  // already interpolated the SVF can pass it in via opts.svf.
  const svf = opts.svf != null ? opts.svf : computeDiffuseSVF(shadeLookup, tilt, svfAzimuth);

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

      const beamTrans = beamTransAt(pt.azimuth, pt.elevation);

      for (let ti = 0; ti < 3; ti++) {
        const tw = tierWeights[ti];
        if (tw <= 0) continue;
        const dni = dniClear * weather.TIERS[ti].dniFrac;
        const dhi = dhiClear * weather.TIERS[ti].dhiFrac;
        const ghi = clearSkyGHI(pt.elevation, dni, dhi);
        const poa = poaIrradiance(dni, dhi, ghi, pt.elevation, pt.azimuth, tilt, panelAz);
        poaWeather += poa.total * tw;
        poaShaded += (poa.beam * beamTrans + poa.diffuse * svf + poa.ground) * tw;
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
          wSh += (poa.beam * beamTrans + poa.diffuse * svf + poa.ground) * tw;
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
    sav, weatherFactor, svf,
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

// ============================================================
// Monthly-hourly shade matrix (12×24)
// Beam shading loss table for PVsyst / SAM / PlantPredict import
// ============================================================

/**
 * Compute a 12×24 monthly-hourly beam-shading-loss matrix for the array.
 *
 * Rows = months (Jan..Dec), Columns = solar hour 0..23.
 * Each value = array-average BEAM shading loss in percent (0 = unshaded,
 * 100 = beam fully blocked), beam-irradiance weighted over the hour bin.
 *
 * This is the convention used by SAM ("Month by Hour Beam Shading Losses (%)")
 * and PlantPredict monthly-hourly shading tables, and can seed a PVsyst
 * shading-factor table.
 *
 * @param {string|null} scenario - trace scenario name (defaults to active)
 * @returns {Promise<number[][]|null>} 12×24 array of percentages, or null
 */
export async function computeShadeMatrix(scenario = null) {
  const state = getState();
  const { lat } = state.location;
  if (lat == null) return null;

  const { tilt, azimuth } = state.system;
  const scn = scenario || state.activeScenario;

  const subPanels = getSubPanels();
  // Distance-weighted shade interpolation across all masked points (same model
  // as the production engine), so the exported beam-loss table matches.
  const { pts: shadePts, subWeights } = await buildInterpolatedShade(subPanels, scn, tilt, azimuth);
  const nSub = Math.max(1, subPanels.length);

  const allPaths = computeAllSunPaths(lat);
  // Month-dependent deciduous transmittance (full leaf in summer, bare in winter).
  const decidTau = deciduousTransmittanceByMonth(state.system, lat);

  // Beam-weighted accumulation per month/hour
  const beamSum = Array.from({ length: 12 }, () => new Float64Array(24));
  const lostSum = Array.from({ length: 12 }, () => new Float64Array(24));

  for (let m = 0; m < 12; m++) {
    const opacity = 1 - decidTau.beam[m]; // fraction of beam a deciduous direction blocks this month
    for (const pt of allPaths[m]) {
      const dni = clearSkyDNI(pt.elevation);
      const dhi = clearSkyDHI(pt.elevation, dni);
      const ghi = clearSkyGHI(pt.elevation, dni, dhi);
      const poa = poaIrradiance(dni, dhi, ghi, pt.elevation, pt.azimuth, tilt, azimuth);
      const beam = poa.beam;
      if (beam <= 0) continue;

      // Solar hour of day (0..23) from hour angle (0 = solar noon)
      const solarHour = 12 + pt.ha / 15;
      const hr = ((Math.floor(solarHour) % 24) + 24) % 24;

      // Beam-loss fraction across sub-panels: solid blocks fully, deciduous blocks
      // by its monthly opacity (transparent in winter), open lets beam through.
      // Each sub-panel's category is distance-interpolated from nearby points.
      let lostFrac = 0;
      for (let i = 0; i < nSub; i++) {
        const w = subWeights[i];
        if (!w.length) continue; // no mask data → open (no loss)
        let l = 0;
        for (const { k, w: ww } of w) {
          const c = shadePts[k].catFn(pt.azimuth, pt.elevation);
          l += ww * (c === MASK_SOLID ? 1 : c === MASK_DECIDUOUS ? opacity : 0);
        }
        lostFrac += l;
      }
      lostFrac /= nSub;

      beamSum[m][hr] += beam;
      lostSum[m][hr] += beam * lostFrac;
    }
  }

  const matrix = [];
  for (let m = 0; m < 12; m++) {
    const row = new Array(24);
    for (let h = 0; h < 24; h++) {
      const b = beamSum[m][h];
      row[h] = b > 0 ? (lostSum[m][h] / b) * 100 : 0;
    }
    matrix.push(row);
  }
  return matrix;
}

/**
 * Serialize a 12×24 shade matrix to CSV text.
 *
 * @param {number[][]} matrix - from computeShadeMatrix()
 * @param {object} [opts]
 * @param {boolean} [opts.labels=false] - include month/hour header labels.
 *   Set false for direct import into SAM / PlantPredict (bare 12×24 grid).
 * @param {number} [opts.decimals=2]
 * @returns {string}
 */
export function shadeMatrixToCSV(matrix, opts = {}) {
  if (!matrix) return '';
  const { labels = false, decimals = 2 } = opts;
  const lines = [];
  if (labels) {
    const hdr = ['Month\\Hour'];
    for (let h = 0; h < 24; h++) hdr.push(String(h));
    lines.push(hdr.join(','));
  }
  for (let m = 0; m < 12; m++) {
    const cells = [];
    if (labels) cells.push(MONTHS[m]);
    for (let h = 0; h < 24; h++) cells.push(matrix[m][h].toFixed(decimals));
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

/**
 * Build distance-weighted shade interpolation over ALL masked measurement points.
 *
 * Tiered rule per sub-panel (matches the Shade Simulator):
 *   1. Points strictly INSIDE the sub-panel → averaged equally (exact local data,
 *      no interpolation, nothing blended away).
 *   2. Otherwise inverse-distance-squared weight ALL masked points, so the nearest
 *      dominate and distant competing data fades — without averaging away nearby
 *      accuracy. One photo for the whole array → it is used everywhere; a photo
 *      per sub-panel → each is used directly.
 *
 * Returns { pts, subWeights } where pts[k] = { catFn, svfOpen, svfDecid, loc } and
 * subWeights[i] is a normalised list of { k, w } (Σw = 1), or [] when there is no
 * mask data anywhere (caller then assumes open sky).
 */
async function buildInterpolatedShade(subPanels, scn, tilt, panelAz) {
  const state = getState();
  const pts = [];
  const idIndex = new Map();
  for (const pt of Object.values(state.points)) {
    const photo = getPhotoForPoint(pt.id);
    if (!photo) continue;
    const tr = photo.traces[scn] || photo.traces['As-Is'];
    if (!tr?.groundMask) continue;
    const catFn = await buildMergedCategoryLookupForPoints([pt.id], scn);
    const svf = computeDiffuseSVFComponents(catFn, tilt, svfAzimuthForPoints([pt.id], panelAz));
    idIndex.set(pt.id, pts.length);
    pts.push({ id: pt.id, loc: pointMeters(pt), catFn, svfOpen: svf.open, svfDecid: svf.decid });
  }

  const subWeights = subPanels.map((sp) => {
    if (pts.length === 0) return [];
    const insideIdx = (sp.insideIds || []).map((id) => idIndex.get(id)).filter((k) => k != null);
    if (insideIdx.length) {
      const w = 1 / insideIdx.length;
      return insideIdx.map((k) => ({ k, w }));
    }
    let sum = 0;
    const raw = pts.map((p, k) => {
      const dx = p.loc.x - sp.mX, dy = p.loc.y - sp.mY;
      const w = 1 / (dx * dx + dy * dy + 1e-6); // 1/d² — nearest dominates
      sum += w;
      return { k, w };
    });
    return sum > 0 ? raw.map((r) => ({ k: r.k, w: r.w / sum })) : [];
  });

  return { pts, subWeights };
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

  // Distance-weighted shade interpolation across ALL masked measurement points.
  // Replaces the old per-sub-panel OR-union: points inside a sub-panel are used
  // directly (exact local data); otherwise nearby points are inverse-distance
  // weighted so the closest dominate without averaging away nearby accuracy.
  const { pts: shadePts, subWeights } = await buildInterpolatedShade(subPanels, scn, tilt, azimuth);

  // Interpolated diffuse Sky View Factor components per sub-panel. Diffuse is a
  // hemispherical average (not diode-limited), so each point contributes its own
  // mask's SVF, distance-weighted. Split open/deciduous for seasonal recovery.
  const subSVFopen = new Float64Array(subPanels.length);
  const subSVFdecid = new Float64Array(subPanels.length);
  subPanels.forEach((sp, i) => {
    const w = subWeights[i];
    if (!w.length) { subSVFopen[i] = 1; subSVFdecid[i] = 0; return; }
    let o = 0, d = 0;
    for (const { k, w: ww } of w) { o += ww * shadePts[k].svfOpen; d += ww * shadePts[k].svfDecid; }
    subSVFopen[i] = o; subSVFdecid[i] = d;
  });
  // Per-panel diffuse SVF components = mean of its sub-sections'.
  const panelSVFopen = new Float64Array(numPanels);
  const panelSVFdecid = new Float64Array(numPanels);
  for (let p = 0; p < numPanels; p++) {
    let o = 0, d = 0;
    for (let k = 0; k < nSubs; k++) {
      o += subSVFopen[p * nSubs + k] ?? 1;
      d += subSVFdecid[p * nSubs + k] ?? 0;
    }
    panelSVFopen[p] = o / nSubs;
    panelSVFdecid[p] = d / nSubs;
  }

  // Interpolated beam transmittance for a sub-panel at a sky direction. The
  // per-sub-panel SAV summary keeps the legacy worst-case (deciduous opaque),
  // now spatially interpolated; the seasonal energy loop below applies month-
  // aware deciduous transmittance.
  const subBeamTransSAV = (i) => {
    const w = subWeights[i];
    if (!w.length) return () => 1; // no mask data → open sky
    return (az, el) => {
      let f = 0;
      for (const { k, w: ww } of w) {
        f += ww * (shadePts[k].catFn(az, el) === MASK_OPEN ? 1 : 0);
      }
      return f;
    };
  };

  // Per-sub-panel irradiance results (SAV / POA), using interpolated beam + SVF.
  const subResults = subPanels.map((sp, i) =>
    computePointIrradiance(subBeamTransSAV(i), lat, tilt, azimuth, svfAzimuthForPoints(sp.ptIds, azimuth), { svf: subSVFopen[i] })
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
  // Beam-only shaded total (full diffuse retained) for loss attribution:
  // separates the beam shade loss from the diffuse SVF loss.
  let totalBeamShaded = 0;
  // Total available diffuse POA energy (pre-SVF), used to derive an array-level
  // diffuse Sky View Factor that is consistent with diffuseShadeLoss.
  let totalDiffusePOA = 0;
  // Same, but weighted by each month's deciduous diffuse transmittance, so we can
  // recover the diffuse-POA-weighted annual deciduous transmittance and give the
  // per-sub-panel cells the same season-aware definition as the array total.
  let totalDiffusePOAdecid = 0;
  const monthlyKwh = new Float32Array(12);
  const perPanelKwh = new Float64Array(numPanels);

  // Monthly deciduous-canopy transmittance (beam + diffuse, season-dependent).
  const decidTau = deciduousTransmittanceByMonth(state.system, lat);

  for (let m = 0; m < 12; m++) {
    const cf = weather.CLOUD_FACTOR[m];
    const fOvc = Math.max(0, 1 - cf - weather.MOD_FRAC);
    const tierWeights = [cf, weather.MOD_FRAC, fOvc];
    const ambT = ambTemps[m];
    const path = allPaths[m];
    const dayWeight = MDAYS[m];
    // Fraction of light a deciduous direction transmits this month.
    const decidTransBeam = decidTau.beam[m];      // beam (used for sun-path gating)
    const decidTransDiffuse = decidTau.diffuse[m]; // diffuse (higher: bare branches admit more sky)

    for (const pt of path) {
      const dniClear = clearSkyDNI(pt.elevation);
      const dhiClear = clearSkyDHI(pt.elevation, dniClear);
      const ghiClear = clearSkyGHI(pt.elevation, dniClear, dhiClear);
      const poaClearPt = poaIrradiance(dniClear, dhiClear, ghiClear, pt.elevation, pt.azimuth, tilt, azimuth);
      const az = Math.round(pt.azimuth) % 360;

      for (let p = 0; p < numPanels; p++) {
        // Beam transmission per sub-section, distance-interpolated from nearby
        // masked points: solid blocks fully, deciduous blocks seasonally
        // (transmits decidTransBeam this month), open transmits fully. Averaged
        // across the panel's sub-sections (bypass-diode behaviour).
        const subBase = p * nSubs;
        let beamTransSum = 0;
        for (let s = 0; s < nSubs; s++) {
          const w = subWeights[subBase + s];
          if (!w.length) { beamTransSum += 1; continue; } // no mask → open sky
          let f = 0;
          for (const { k, w: ww } of w) {
            const c = shadePts[k].catFn(pt.azimuth, pt.elevation);
            f += ww * (c === MASK_SOLID ? 0 : c === MASK_DECIDUOUS ? decidTransBeam : 1);
          }
          beamTransSum += f;
        }
        const beamFrac = beamTransSum / nSubs;

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

          // Available diffuse POA (pre-SVF), same conversion as the loss totals.
          totalDiffusePOA += (poa.diffuse / 1000 * panelWp * sysEff * tDer) * tw * dayWeight;
          totalDiffusePOAdecid += (poa.diffuse / 1000 * panelWp * sysEff * tDer) * tw * dayWeight * decidTransDiffuse;

          // Shade impact. Beam is gated per-timestep by the sub-section masks
          // (bypass-diode behaviour, season-aware via beamFrac above); diffuse is
          // reduced by the panel's diffuse Sky View Factor. The deciduous-covered
          // part of the sky is recovered seasonally (transparent in winter).
          const svfMonth = panelSVFopen[p] + panelSVFdecid[p] * decidTransDiffuse;
          const diffuseAdj = poa.diffuse * svfMonth;
          const beamPOA = poa.beam * beamFrac;
          // Beam-only model (legacy): beam gated, full diffuse kept.
          const beamShadedPOA = beamPOA + poa.diffuse + poa.ground;
          // Full model: beam gated + diffuse reduced by SVF.
          const shadedPOA = beamPOA + diffuseAdj + poa.ground;

          const dcBeamShaded = beamShadedPOA / 1000 * panelWp * sysEff * tDer;
          totalBeamShaded += dcBeamShaded * tw * dayWeight;

          const dcShaded = shadedPOA / 1000 * panelWp * sysEff * tDer;
          totalShaded += dcShaded * tw * dayWeight;

          const clipped = Math.min(dcShaded, clipW) * invEff * tw * dayWeight;
          totalClipped += clipped;
          monthlyKwh[m] += clipped * hoursPerStep / 1000;
          perPanelKwh[p] += clipped * hoursPerStep / 1000;
        }
      }
    }
  }

  const clearKwh = totalClear * hoursPerStep * invEff / 1000;
  const weatherKwh = totalWeather * hoursPerStep * invEff / 1000;
  const beamShadedKwh = totalBeamShaded * hoursPerStep * invEff / 1000;
  const shadedKwh = totalShaded * hoursPerStep * invEff / 1000;
  const netKwh = totalClipped * hoursPerStep / 1000;

  // Loss attribution: split shade loss into beam (sun-path blocking) and
  // diffuse (sky-view-factor obstruction) components.
  const beamShadeLoss = weatherKwh - beamShadedKwh;
  const diffuseShadeLoss = beamShadedKwh - shadedKwh;

  // Array-level diffuse Sky View Factor, weighted by available diffuse POA so it
  // is exactly consistent with diffuseShadeLoss (arraySVF = 1 − loss/available).
  const diffusePOAkwh = totalDiffusePOA * hoursPerStep * invEff / 1000;
  const arraySVF = diffusePOAkwh > 0 ? 1 - diffuseShadeLoss / diffusePOAkwh : 1;

  // Diffuse-POA-weighted annual deciduous diffuse transmittance. Using it to
  // assemble each sub-panel's effective annual SVF (open + decid·weight) gives
  // the cells the SAME season-aware, per-point definition as arraySVF — so the
  // headline arraySVF is a true (equal-area) average of the displayed cells.
  const decidDiffuseWeight = totalDiffusePOA > 0 ? totalDiffusePOAdecid / totalDiffusePOA : 1;
  subResults.forEach((sr, i) => {
    sr.svf = subSVFopen[i] + subSVFdecid[i] * decidDiffuseWeight;
  });

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
    beamShadeLoss,
    diffuseShadeLoss,
    arraySVF,
    clipLoss: shadedKwh - netKwh,
    monthlyKwh,
    perPanelKwh: Array.from(perPanelKwh),
    numPanels,
    dcCapacity: numPanels * panelWp / 1000,
    acCapacity: numPanels * clipW / 1000,
    // Backwards-compat aliases
    halfPanels: subPanels,
    pointResults: Object.fromEntries(subPanels.map((sp, i) => [sp.ptIds[0] || `sub_${i}`, subResults[i]])),
  };
}

/**
 * Compute an hourly AC-power grid (24 hours × 365 days) for SAM-style export.
 *
 * NOTE: This engine is a clear-sky × monthly-TMY-scale model, NOT a true 8760
 * TMY simulation, so it cannot reproduce SAM's hour-by-hour weather. Each cell
 * is the EXPECTED AC power for that hour/day under the same physics used in the
 * report (clear-sky irradiance scaled by monthly cloud tiers, season-aware
 * deciduous shading, temperature derate, per-micro-inverter clipping). It gives
 * a smooth, directly comparable grid for diffing against a SAM export.
 *
 * @returns {Promise<{grid:number[][], hours:number, days:number}>}
 *   grid[h][d] = system AC power (kW) for hour h (0-23), day d (0-364)
 */
export async function runHourlyGrid(scenario = null, opts = {}) {
  const state = getState();
  const scn = scenario || state.activeScenario;
  const clearSky = !!opts.clearSky;
  // clockTime: index hours by local clock time (meter convention) instead of
  // solar time, applying longitude + equation-of-time and (optionally) DST.
  const clockTime = !!opts.clockTime;
  const useDst = !!opts.dst;
  const { lat, lon } = state.location;
  const tzHours = resolveTzHours(state);
  const LSTM = 15 * tzHours; // local standard-time meridian longitude (deg)
  const { tilt, azimuth, panelWp, inverterWatts, rows, cols, systemLosses, inverterEff } = state.system;
  const numPanels = rows * cols;

  const subPanels = getSubPanels();
  const nSubs = subPanels.length > 0 ? subPanels[0].nSubs : 2;

  // Distance-weighted shade interpolation across all masked points (same model
  // as runFullAnalysis / the Shade Simulator): points inside a sub-panel are used
  // directly, otherwise nearby points are inverse-distance weighted.
  const { pts: shadePts, subWeights } = await buildInterpolatedShade(subPanels, scn, tilt, azimuth);
  const subSVFopen = new Float64Array(subPanels.length);
  const subSVFdecid = new Float64Array(subPanels.length);
  subPanels.forEach((sp, i) => {
    const w = subWeights[i];
    if (!w.length) { subSVFopen[i] = 1; subSVFdecid[i] = 0; return; }
    let o = 0, d = 0;
    for (const { k, w: ww } of w) { o += ww * shadePts[k].svfOpen; d += ww * shadePts[k].svfDecid; }
    subSVFopen[i] = o; subSVFdecid[i] = d;
  });
  const panelSVFopen = new Float64Array(numPanels);
  const panelSVFdecid = new Float64Array(numPanels);
  for (let p = 0; p < numPanels; p++) {
    let o = 0, d = 0;
    for (let k = 0; k < nSubs; k++) { o += subSVFopen[p * nSubs + k] ?? 1; d += subSVFdecid[p * nSubs + k] ?? 0; }
    panelSVFopen[p] = o / nSubs;
    panelSVFdecid[p] = d / nSubs;
  }

  const weather = getWeatherParams(lat);
  const ambTemps = getAmbientTemps(lat);
  const sysEff = 1 - systemLosses / 100;
  const invEff = inverterEff / 100;
  const clipW = inverterWatts; // per-microinverter AC clip
  const decidTau = deciduousTransmittanceByMonth(state.system, lat);

  // grid[h][d] in kW; beamGrid[h][d] = array-mean beam availability (0..1).
  const grid = Array.from({ length: 24 }, () => new Float64Array(365));
  const beamGrid = Array.from({ length: 24 }, () => new Float64Array(365));
  // Scratch buffers (geometry per panel; reused each cell to avoid allocation).
  const beamFracP = new Float64Array(numPanels);
  const svfP = new Float64Array(numPanels);

  for (let d = 0; d < 365; d++) {
    const doy = d + 1;
    // Month index for this day (used for weather + deciduous season).
    let m = 11;
    for (let mm = 0; mm < 12; mm++) {
      if (doy <= MDAYS_CUM[mm] + MDAYS[mm]) { m = mm; break; }
    }
    const decl = solarDeclination(doy);
    const cf = weather.CLOUD_FACTOR[m];
    const fOvc = Math.max(0, 1 - cf - weather.MOD_FRAC);
    // clearSky envelope: ignore cloud tiers, evaluate pure clear-sky irradiance.
    const tierWeights = clearSky ? [1, 0, 0] : [cf, weather.MOD_FRAC, fOvc];
    const ambT = ambTemps[m];
    const decidTransBeam = decidTau.beam[m];
    const decidTransDiffuse = decidTau.diffuse[m];

    // Clock→solar time correction for this day (minutes): longitude offset from
    // the standard meridian + equation of time. DST (if active) shifts the meter
    // clock one hour ahead of standard time.
    const eotMin = equationOfTime(doy);
    const tcMin = 4 * (lon - LSTM) + eotMin;
    const dstShift = (clockTime && useDst && usDstActive(doy)) ? 1 : 0;

    for (let h = 0; h < 24; h++) {
      // Mid-hour solar time; hour angle 0 at solar noon.
      let ha;
      if (clockTime) {
        const clockStd = (h + 0.5) - dstShift; // local standard clock hour
        const solarTime = clockStd + tcMin / 60;
        ha = (solarTime - 12) * 15;
      } else {
        ha = (h + 0.5 - 12) * 15;
      }
      const sun = sunPosition(lat, decl, ha);
      if (sun.elevation <= 0) { grid[h][d] = 0; continue; }

      const dniClear = clearSkyDNI(sun.elevation);
      const dhiClear = clearSkyDHI(sun.elevation, dniClear);

      // Per-panel beam availability + diffuse SVF (geometry only, tier-independent).
      let beamAvail = 0;
      for (let p = 0; p < numPanels; p++) {
        const subBase = p * nSubs;
        let beamTransSum = 0;
        for (let s = 0; s < nSubs; s++) {
          const w = subWeights[subBase + s];
          if (!w.length) { beamTransSum += 1; continue; }
          let f = 0;
          for (const { k, w: ww } of w) {
            const c = shadePts[k].catFn(sun.azimuth, sun.elevation);
            f += ww * (c === MASK_SOLID ? 0 : c === MASK_DECIDUOUS ? decidTransBeam : 1);
          }
          beamTransSum += f;
        }
        const bf = beamTransSum / nSubs;
        beamFracP[p] = bf;
        beamAvail += bf;
        svfP[p] = panelSVFopen[p] + panelSVFdecid[p] * decidTransDiffuse;
      }
      beamGrid[h][d] = numPanels ? beamAvail / numPanels : 1;

      let acW = 0; // expected system AC power (W)
      for (let ti = 0; ti < 3; ti++) {
        const tw = tierWeights[ti];
        if (tw <= 0) continue;
        const dni = clearSky ? dniClear : dniClear * weather.TIERS[ti].dniFrac;
        const dhi = clearSky ? dhiClear : dhiClear * weather.TIERS[ti].dhiFrac;
        const ghi = clearSkyGHI(sun.elevation, dni, dhi);
        const poa = poaIrradiance(dni, dhi, ghi, sun.elevation, sun.azimuth, tilt, azimuth);
        const tDer = tempDerate(cellTemp(ambT, poa.total));

        let sysW = 0;
        for (let p = 0; p < numPanels; p++) {
          const shadedPOA = poa.beam * beamFracP[p] + poa.diffuse * svfP[p] + poa.ground;
          const dc = shadedPOA / 1000 * panelWp * sysEff * tDer;
          sysW += Math.min(dc, clipW) * invEff;
        }
        acW += sysW * tw;
      }
      grid[h][d] = acW / 1000; // kW
    }
  }

  return { grid, beamGrid, hours: 24, days: 365 };
}

/**
 * Resolve the standard-meridian time-zone offset (hours) for solar-time math.
 * Prefers the weather file's Time Zone, then an explicit location.tz, else
 * estimates from longitude (15° per hour).
 */
function resolveTzHours(state) {
  const w = state.weather;
  if (w && w.meta && w.meta.tz != null && !isNaN(w.meta.tz)) return Number(w.meta.tz);
  if (state.location && state.location.tz != null && !isNaN(state.location.tz)) return Number(state.location.tz);
  const lon = state.location?.lon;
  return lon != null ? Math.round(lon / 15) : 0;
}

/**
 * pvlib-powered production run over a user-uploaded TMY weather series.
 *
 * This is the "real engine": pvlib (running in Pyodide) does the irradiance
 * transposition (Perez), cell-temperature, and PVWatts DC/AC physics on the
 * measured DNI/DHI/GHI, while THIS app's fisheye-mask shade engine supplies the
 * per-panel beam-availability and diffuse sky-view-factor hooks that pvlib has
 * no concept of. Requires both Pyodide+pvlib loaded and a weather file uploaded.
 *
 * @param {string|null} scenario
 * @returns {Promise<object>} { engine:'pvlib', annualKwh, monthlyKwh[12],
 *   perPanelKwh[], poaAnnualUnshaded, specificYield, model, nTimes, tz }
 * @throws {Error} when prerequisites are missing or the Python run fails
 */
export async function runPvlibProduction(scenario = null) {
  const state = getState();
  if (!_pyodideReady || !_pyodide) {
    throw new Error('pvlib runtime not ready yet — wait for the "pvlib Ready" badge.');
  }
  const weather = state.weather;
  if (!weather || !weather.records || !weather.records.length) {
    throw new Error('No weather time series loaded — upload an NSRDB / SAM TMY CSV on the Setup page.');
  }
  const { lat, lon } = state.location;
  if (lat == null) throw new Error('Set the site latitude on the Setup page first.');

  const scn = scenario || state.activeScenario;
  const sys = state.system;
  const { tilt, azimuth, panelWp, inverterWatts, rows, cols, systemLosses, inverterEff, inverterType } = sys;
  const numPanels = rows * cols;
  const tzHours = resolveTzHours(state);
  const alt = state.location.alt ?? weather.meta?.elevation ?? 0;

  // --- Per-sub-panel shade model (mirrors runHourlyGrid) ---
  const subPanels = getSubPanels();
  const nSubs = subPanels.length > 0 ? subPanels[0].nSubs : 2;
  // Distance-weighted shade interpolation across all masked points.
  const { pts: shadePts, subWeights } = await buildInterpolatedShade(subPanels, scn, tilt, azimuth);
  const subSVFopen = new Float64Array(subPanels.length);
  const subSVFdecid = new Float64Array(subPanels.length);
  subPanels.forEach((sp, i) => {
    const w = subWeights[i];
    if (!w.length) { subSVFopen[i] = 1; subSVFdecid[i] = 0; return; }
    let o = 0, d = 0;
    for (const { k, w: ww } of w) { o += ww * shadePts[k].svfOpen; d += ww * shadePts[k].svfDecid; }
    subSVFopen[i] = o; subSVFdecid[i] = d;
  });
  const panelSVFopen = new Float64Array(numPanels);
  const panelSVFdecid = new Float64Array(numPanels);
  for (let p = 0; p < numPanels; p++) {
    let o = 0, d = 0;
    for (let k = 0; k < nSubs; k++) { o += subSVFopen[p * nSubs + k] ?? 1; d += subSVFdecid[p * nSubs + k] ?? 0; }
    panelSVFopen[p] = o / nSubs;
    panelSVFdecid[p] = d / nSubs;
  }
  const decidTau = deciduousTransmittanceByMonth(sys, lat);

  // --- Flatten the weather series + compute per-panel/per-timestep beam factors ---
  const recs = weather.records;
  const T = recs.length;
  const yr = new Array(T), mo = new Array(T), dy = new Array(T), hr = new Array(T), mi = new Array(T);
  const dni = new Array(T), dhi = new Array(T), ghi = new Array(T), tair = new Array(T), wind = new Array(T), alb = new Array(T);
  const monthOf = new Array(T);
  // Beam availability factor per panel per timestep (panel-major flatten).
  const beamFlat = new Array(numPanels * T);

  for (let t = 0; t < T; t++) {
    const r = recs[t];
    const M = (r.month ?? 1);
    const D = (r.day ?? 1);
    const H = (r.hour ?? 0);
    const Min = (r.minute ?? 0);
    yr[t] = r.year ?? 1990; mo[t] = M; dy[t] = D; hr[t] = H; mi[t] = Min;
    dni[t] = r.dni ?? 0; dhi[t] = r.dhi ?? 0; ghi[t] = r.ghi ?? 0;
    tair[t] = r.temp ?? 20; wind[t] = r.wind ?? 1;
    alb[t] = (r.albedo != null && r.albedo > 0 && r.albedo < 1) ? r.albedo : 0.2;

    const m = M - 1;
    monthOf[t] = m;
    const doy = MDAYS_CUM[m] + D;
    const decl = solarDeclination(doy);
    // True solar time from local standard time, longitude, and EoT.
    const clockH = H + Min / 60;
    const solarH = clockH + (equationOfTime(doy) + 4 * (lon - 15 * tzHours)) / 60;
    const ha = (solarH - 12) * 15;
    const sun = sunPosition(lat, decl, ha);
    const beamTransByMonth = decidTau.beam[m];

    if (sun.elevation <= 0 || (dni[t] <= 0)) {
      // No beam to gate — factor is irrelevant; store 0.
      for (let p = 0; p < numPanels; p++) beamFlat[p * T + t] = 0;
    } else {
      for (let p = 0; p < numPanels; p++) {
        const subBase = p * nSubs;
        let sum = 0;
        for (let s = 0; s < nSubs; s++) {
          const w = subWeights[subBase + s];
          if (!w.length) { sum += 1; continue; }
          let f = 0;
          for (const { k, w: ww } of w) {
            const c = shadePts[k].catFn(sun.azimuth, sun.elevation);
            f += ww * (c === MASK_SOLID ? 0 : c === MASK_DECIDUOUS ? beamTransByMonth : 1);
          }
          sum += f;
        }
        beamFlat[p * T + t] = sum / nSubs;
      }
    }
  }

  // Diffuse factor per panel per month (geometry + seasonal canopy τ).
  const diffuseMonthFlat = new Array(numPanels * 12);
  for (let p = 0; p < numPanels; p++) {
    for (let m = 0; m < 12; m++) {
      diffuseMonthFlat[p * 12 + m] = panelSVFopen[p] + panelSVFdecid[p] * decidTau.diffuse[m];
    }
  }

  const inputObj = {
    lat, lon, alt, tz: tzHours,
    tilt, azimuth,
    pdc0_panel: panelWp,
    gamma_pdc: -0.004,
    n_panels: numPanels,
    n_times: T,
    clip_w: inverterWatts,
    inv_eff: inverterEff / 100,
    sys_eff: 1 - systemLosses / 100,
    is_micro: inverterType !== 'string',
    year: yr, month: mo, day: dy, hour: hr, minute: mi,
    dni, dhi, ghi, temp_air: tair, wind, albedo: alb,
    beam: beamFlat,
    diffuse_month: diffuseMonthFlat,
  };

  // Hand inputs to Python.
  _pyodide.globals.set('PVLIB_INPUT', _pyodide.toPy(inputObj));

  let outJson;
  try {
    outJson = await _pyodide.runPythonAsync(PVLIB_PRODUCTION_PY);
  } catch (err) {
    throw new Error('pvlib run failed: ' + (err && err.message ? err.message.split('\n').slice(-3).join(' ') : String(err)));
  }

  let result;
  try {
    result = JSON.parse(outJson);
  } catch (e) {
    throw new Error('pvlib returned an unreadable result.');
  }
  result.tz = tzHours;
  return result;
}

/**
 * Python ModelChain executed in Pyodide. Reads the global PVLIB_INPUT dict that
 * runPvlibProduction populates, returns a JSON string. Kept as a module-level
 * constant so it is parsed once.
 */
const PVLIB_PRODUCTION_PY = `
import json
import numpy as np
import pandas as pd
from datetime import timezone, timedelta
import pvlib
from pvlib.temperature import TEMPERATURE_MODEL_PARAMETERS

d = PVLIB_INPUT.to_py() if hasattr(PVLIB_INPUT, 'to_py') else PVLIB_INPUT

n_panels = int(d['n_panels'])
T = int(d['n_times'])

year = np.array(d['year'], dtype=int)
month = np.array(d['month'], dtype=int)
day = np.array(d['day'], dtype=int)
hour = np.array(d['hour'], dtype=int)
minute = np.array(d['minute'], dtype=int)

idx = pd.DatetimeIndex(pd.to_datetime(dict(
    year=year, month=month, day=day, hour=hour, minute=minute)))
tz = timezone(timedelta(hours=float(d['tz'])))
try:
    idx = idx.tz_localize(tz)
except Exception:
    idx = idx.tz_localize('UTC')

dni = np.array(d['dni'], dtype=float)
dhi = np.array(d['dhi'], dtype=float)
ghi = np.array(d['ghi'], dtype=float)
temp_air = np.array(d['temp_air'], dtype=float)
wind = np.array(d['wind'], dtype=float)
albedo = np.array(d['albedo'], dtype=float)

lat = float(d['lat']); lon = float(d['lon']); alt = float(d['alt'])
tilt = float(d['tilt']); surf_az = float(d['azimuth'])
pdc0 = float(d['pdc0_panel'])
gamma = float(d['gamma_pdc'])
clip = float(d['clip_w'])
inv_eff = float(d['inv_eff'])
sys_eff = float(d['sys_eff'])
is_micro = bool(d['is_micro'])

solpos = pvlib.solarposition.get_solarposition(idx, lat, lon, altitude=alt)
zen = solpos['apparent_zenith']
saz = solpos['azimuth']
app_elev = 90.0 - zen.values

dni_extra = pvlib.irradiance.get_extra_radiation(idx)
airmass = pvlib.atmosphere.get_relative_airmass(zen.values)
airmass_s = pd.Series(airmass, index=idx)
press = float(pvlib.atmosphere.alt2pres(alt))

tparams = TEMPERATURE_MODEL_PARAMETERS['sapm']['open_rack_glass_glass']

def transpose(dni_s, ghi_s, dhi_s):
    poa = pvlib.irradiance.get_total_irradiance(
        tilt, surf_az, zen, saz,
        pd.Series(dni_s, index=idx), pd.Series(ghi_s, index=idx), pd.Series(dhi_s, index=idx),
        dni_extra=dni_extra, airmass=airmass_s, albedo=albedo, model='perez')
    return (np.nan_to_num(poa['poa_direct'].values),
            np.nan_to_num(poa['poa_sky_diffuse'].values),
            np.nan_to_num(poa['poa_ground_diffuse'].values),
            np.nan_to_num(poa['poa_global'].values))

# Measured TMY transposition
m_dir, m_sky, m_grd, m_glob = transpose(dni, ghi, dhi)

# Clear-sky reference (simplified Solis needs no external data files)
cs = pvlib.clearsky.simplified_solis(app_elev, aod700=0.1, precipitable_water=1.0,
                                     pressure=press, dni_extra=np.asarray(dni_extra))
c_dir, c_sky, c_grd, c_glob = transpose(
    np.nan_to_num(np.asarray(cs['dni'])), np.nan_to_num(np.asarray(cs['ghi'])), np.nan_to_num(np.asarray(cs['dhi'])))

beam = np.array(d['beam'], dtype=float).reshape(n_panels, T)
diffuse_month = np.array(d['diffuse_month'], dtype=float).reshape(n_panels, 12)
month_idx = month - 1

def ac_from_poa(poa_eff, clip_on):
    poa_eff = np.maximum(poa_eff, 0.0)
    tcell = pvlib.temperature.sapm_cell(
        poa_eff, temp_air, wind, tparams['a'], tparams['b'], tparams['deltaT'])
    dc = pvlib.pvsystem.pvwatts_dc(poa_eff, tcell, pdc0, gamma) * sys_eff
    dc = np.maximum(np.nan_to_num(dc), 0.0)
    if clip_on:
        return np.minimum(dc, clip) * inv_eff
    return dc * inv_eff

# Unshaded references (identical for every panel -> scale by n_panels)
ac_clear_un = ac_from_poa(c_dir + c_sky + c_grd, False)
ac_weather_un = ac_from_poa(m_dir + m_sky + m_grd, False)
E_clear = float(ac_clear_un.sum()) * n_panels / 1000.0
E_weather = float(ac_weather_un.sum()) * n_panels / 1000.0

# Per-panel shaded stages: beam-only (full diffuse), beam+diffuse, clipped net
E_beam = 0.0
E_beamdiff = 0.0
ac_net_sys = np.zeros(T)
per_panel_kwh = []
for p in range(n_panels):
    beam_p = beam[p]
    diff_p = diffuse_month[p][month_idx]
    ac_beam = ac_from_poa(m_dir * beam_p + m_sky + m_grd, False)
    ac_full = ac_from_poa(m_dir * beam_p + m_sky * diff_p + m_grd, False)
    ac_clip = ac_from_poa(m_dir * beam_p + m_sky * diff_p + m_grd, True)
    E_beam += float(ac_beam.sum())
    E_beamdiff += float(ac_full.sum())
    ac_net_sys += ac_clip
    per_panel_kwh.append(float(ac_clip.sum() / 1000.0))

E_beam = E_beam / 1000.0
E_beamdiff = E_beamdiff / 1000.0
net_kwh = float(ac_net_sys.sum() / 1000.0)

weather_loss = E_clear - E_weather
beam_shade_loss = E_weather - E_beam
diffuse_shade_loss = E_beam - E_beamdiff
clip_loss = E_beamdiff - net_kwh

monthly = [0.0] * 12
for m in range(12):
    mask = (month == (m + 1))
    monthly[m] = float(ac_net_sys[mask].sum() / 1000.0)

poa_annual = float(m_glob.sum() / 1000.0)
dc_nameplate_kw = n_panels * pdc0 / 1000.0
specific_yield = net_kwh / dc_nameplate_kw if dc_nameplate_kw > 0 else 0.0

result = {
    'engine': 'pvlib',
    'model': 'perez',
    'nTimes': T,
    'annualKwh': net_kwh,
    'monthlyKwh': monthly,
    'perPanelKwh': per_panel_kwh,
    'poaAnnualUnshaded': poa_annual,
    'specificYield': specific_yield,
    'dcNameplateKw': dc_nameplate_kw,
    'losses': {
        'clearKwh': E_clear,
        'weatherLoss': weather_loss,
        'beamShadeLoss': beam_shade_loss,
        'diffuseShadeLoss': diffuse_shade_loss,
        'clipLoss': clip_loss,
        'netKwh': net_kwh,
    },
    'hourlyKw': [round(float(x), 4) for x in (ac_net_sys / 1000.0)],
}
result_json = json.dumps(result)
result_json
`;

/**
 * Run comparative analysis between two scenarios.
 * Returns { baseline, alternative, delta }
 */
export async function runComparison(baseScenario, altScenario) {  const baseline = await runFullAnalysis(baseScenario);
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
