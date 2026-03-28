/**
 * SolarScope — Utility functions
 * DOM helpers, EXIF/XMP metadata parsing for Insta360 & panoramic cameras,
 * image processing, coordinate mapping
 */

// ============================================================
// DOM helpers
// ============================================================

export function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of (Array.isArray(children) ? children : [children])) {
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else if (c instanceof Node) e.appendChild(c);
  }
  return e;
}

export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function clearEl(e) {
  while (e.firstChild) e.removeChild(e.firstChild);
  return e;
}

// ============================================================
// EXIF + XMP metadata parser for Insta360 / panoramic cameras
// Uses the exifr library loaded from CDN
// ============================================================

let _exifr = null;

async function loadExifr() {
  if (_exifr) return _exifr;
  try {
    // exifr full bundle with XMP, GPS, and TIFF support
    _exifr = await import('https://esm.sh/exifr@7.1.3/dist/full.esm.mjs');
    return _exifr;
  } catch (e) {
    console.warn('exifr CDN load failed, trying fallback:', e);
    try {
      _exifr = await import('https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs');
      return _exifr;
    } catch (e2) {
      console.error('Could not load exifr:', e2);
      return null;
    }
  }
}

/**
 * Parse comprehensive metadata from an image file.
 * Prioritizes Insta360/photosphere-specific fields.
 *
 * Returns: {
 *   gps: { lat, lon, alt } | null,
 *   compassHeading: number | null,   // degrees from true north
 *   pitch: number,                    // degrees
 *   roll: number,                     // degrees
 *   cameraModel: string,
 *   cameraMake: string,
 *   datetime: string | null,
 *   projectionType: string | null,    // 'equirectangular', etc.
 *   fullPanoWidth: number | null,
 *   fullPanoHeight: number | null,
 *   croppedWidth: number | null,
 *   croppedHeight: number | null,
 *   isInsta360: boolean,
 *   is360Pano: boolean,
 *   headingSource: string,            // how we got compass heading
 *   raw: object,                      // full parsed metadata
 * }
 */
export async function parsePhotoMetadata(file) {
  const result = {
    gps: null,
    compassHeading: null,
    pitch: 0,
    roll: 0,
    cameraModel: '',
    cameraMake: '',
    datetime: null,
    projectionType: null,
    fullPanoWidth: null,
    fullPanoHeight: null,
    croppedWidth: null,
    croppedHeight: null,
    isInsta360: false,
    is360Pano: false,
    headingSource: 'none',
    raw: {},
  };

  const exifr = await loadExifr();
  if (!exifr) return result;

  try {
    // Parse everything: EXIF, GPS, XMP, IPTC, ICC
    const parsed = await exifr.parse(file, {
      // Enable all segments
      tiff: true,
      xmp: true,
      icc: false,
      iptc: false,
      jfif: false,
      ihdr: false,
      // GPS
      gps: true,
      // Decode all tags rather than just common ones
      translateKeys: true,
      translateValues: true,
      reviveValues: true,
      mergeOutput: true,
    });

    if (!parsed) return result;
    result.raw = parsed;

    // ── Camera identification ──
    result.cameraMake = parsed.Make || parsed.make || '';
    result.cameraModel = parsed.Model || parsed.model || '';

    // Detect Insta360 cameras (Make is "Arashi Vision" or contains "Insta360")
    const makeModel = `${result.cameraMake} ${result.cameraModel}`.toLowerCase();
    result.isInsta360 = makeModel.includes('insta360') ||
                        makeModel.includes('arashi') ||
                        makeModel.includes('one x') ||
                        makeModel.includes('one rs');

    // ── DateTime ──
    result.datetime = parsed.DateTimeOriginal || parsed.CreateDate ||
                      parsed.DateTime || parsed.ModifyDate || null;
    if (result.datetime instanceof Date) {
      result.datetime = result.datetime.toISOString();
    }

    // ── GPS coordinates ──
    if (parsed.latitude !== undefined && parsed.longitude !== undefined) {
      result.gps = {
        lat: parsed.latitude,
        lon: parsed.longitude,
        alt: parsed.GPSAltitude ?? parsed.altitude ?? null,
      };
    } else if (parsed.GPSLatitude !== undefined && parsed.GPSLongitude !== undefined) {
      // Handle array format [degrees, minutes, seconds]
      result.gps = {
        lat: dmsToDecimal(parsed.GPSLatitude, parsed.GPSLatitudeRef),
        lon: dmsToDecimal(parsed.GPSLongitude, parsed.GPSLongitudeRef),
        alt: parsed.GPSAltitude ?? null,
      };
    }

    // ── Panorama / Projection metadata (Google Photosphere XMP) ──
    result.projectionType = parsed.ProjectionType || parsed.projectionType || null;
    result.fullPanoWidth = parsed.FullPanoWidthPixels || parsed.fullPanoWidthPixels || null;
    result.fullPanoHeight = parsed.FullPanoHeightPixels || parsed.fullPanoHeightPixels || null;
    result.croppedWidth = parsed.CroppedAreaImageWidthPixels || null;
    result.croppedHeight = parsed.CroppedAreaImageHeightPixels || null;

    // Detect 360° panorama
    if (result.projectionType === 'equirectangular' ||
        (result.fullPanoWidth && result.fullPanoWidth > 3000) ||
        result.isInsta360) {
      result.is360Pano = true;
      if (!result.projectionType) result.projectionType = 'equirectangular';
    }

    // ── Compass Heading ──
    // Priority order for heading extraction:
    // 1. PoseHeadingDegrees (Google Photosphere XMP — most reliable for 360° photos)
    // 2. GPSImgDirection (standard EXIF compass bearing)
    // 3. InitialViewHeadingDegrees (Google Photosphere XMP)
    // 4. Insta360-specific XMP fields
    // 5. Compass / heading fields from various camera namespaces

    if (parsed.PoseHeadingDegrees != null) {
      result.compassHeading = normalizeAngle(parsed.PoseHeadingDegrees);
      result.headingSource = 'PoseHeadingDegrees (XMP Photosphere)';
    } else if (parsed.poseHeadingDegrees != null) {
      result.compassHeading = normalizeAngle(parsed.poseHeadingDegrees);
      result.headingSource = 'poseHeadingDegrees (XMP)';
    } else if (parsed.GPSImgDirection != null) {
      result.compassHeading = normalizeAngle(parsed.GPSImgDirection);
      result.headingSource = 'GPSImgDirection (EXIF GPS)';
    } else if (parsed.InitialViewHeadingDegrees != null) {
      result.compassHeading = normalizeAngle(parsed.InitialViewHeadingDegrees);
      result.headingSource = 'InitialViewHeadingDegrees (XMP)';
    } else if (parsed.initialViewHeadingDegrees != null) {
      result.compassHeading = normalizeAngle(parsed.initialViewHeadingDegrees);
      result.headingSource = 'initialViewHeadingDegrees (XMP)';
    } else if (parsed.CompassHeading != null) {
      result.compassHeading = normalizeAngle(parsed.CompassHeading);
      result.headingSource = 'CompassHeading';
    } else if (parsed.Heading != null) {
      result.compassHeading = normalizeAngle(parsed.Heading);
      result.headingSource = 'Heading';
    }

    // ── Pitch / Roll (camera orientation) ──
    // PosePitchDegrees and PoseRollDegrees from Photosphere XMP
    result.pitch = parsed.PosePitchDegrees ?? parsed.posePitchDegrees ??
                   parsed.CameraPitch ?? parsed.pitch ?? 0;
    result.roll = parsed.PoseRollDegrees ?? parsed.poseRollDegrees ??
                  parsed.CameraRoll ?? parsed.roll ?? 0;

    // Insta360-specific: sometimes stores as gyro-derived values
    // Look for fields like GyroData, AccelData, etc.
    if (result.isInsta360 && result.compassHeading === null) {
      // Try Insta360-specific XMP namespace fields
      for (const key of Object.keys(parsed)) {
        const lk = key.toLowerCase();
        if (lk.includes('heading') || lk.includes('compass')) {
          const val = parseFloat(parsed[key]);
          if (!isNaN(val)) {
            result.compassHeading = normalizeAngle(val);
            result.headingSource = `${key} (Insta360-specific)`;
            break;
          }
        }
      }
    }

    // ── Also check for less common Insta360 XMP fields ──
    // Insta360 firmware version, stitching info
    if (parsed.StitchingSoftware) {
      result.cameraModel += ` (${parsed.StitchingSoftware})`;
    }

  } catch (err) {
    console.warn('EXIF parse error:', err);
  }

  return result;
}

/** Convert DMS GPS coordinates to decimal degrees */
function dmsToDecimal(dms, ref) {
  if (typeof dms === 'number') return (ref === 'S' || ref === 'W') ? -dms : dms;
  if (!Array.isArray(dms)) return 0;
  let val = dms[0] + (dms[1] || 0) / 60 + (dms[2] || 0) / 3600;
  if (ref === 'S' || ref === 'W') val = -val;
  return val;
}

/** Normalize angle to 0-360 */
function normalizeAngle(deg) {
  return ((deg % 360) + 360) % 360;
}

// ============================================================
// Image loading and sizing
// ============================================================

/**
 * Load an image file and return { dataUrl, width, height }
 * Optionally constrains max dimension for performance.
 */
export function loadImage(file, maxDim = 4096) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        if (img.width <= maxDim && img.height <= maxDim) {
          resolve({ dataUrl: reader.result, width: img.width, height: img.height, img });
        } else {
          // Downscale for performance
          const scale = maxDim / Math.max(img.width, img.height);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve({
            dataUrl: canvas.toDataURL('image/jpeg', 0.85),
            width: canvas.width,
            height: canvas.height,
            img,
          });
        }
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ============================================================
// Equirectangular projection coordinate mapping
// ============================================================

/**
 * Convert normalized image coordinates (0-1) to sky azimuth/elevation
 * using the camera's compass heading, pitch, and roll.
 *
 * For equirectangular 360° images:
 * - x: 0 (left edge) to 1 (right edge) = 360° of azimuth
 * - y: 0 (top, zenith) to 1 (bottom, nadir) = 180° of elevation
 * - Center of image (x=0.5) points in the compassHeading direction
 *
 * @param {number} xNorm - normalized x (0-1)
 * @param {number} yNorm - normalized y (0-1)
 * @param {number} compassHeading - degrees from north where image center points
 * @param {number} pitch - camera pitch offset in degrees
 * @param {number} roll - camera roll offset in degrees
 * @returns {{ azimuth: number, elevation: number }}
 */
export function imageToSky(xNorm, yNorm, compassHeading = 180, pitch = 0, roll = 0) {
  // Base mapping (no pitch/roll correction)
  // x=0 → heading - 180°, x=0.5 → heading, x=1 → heading + 180°
  let az = compassHeading + (xNorm - 0.5) * 360;
  az = ((az % 360) + 360) % 360;

  // y=0 → +90° (zenith), y=0.5 → 0° (horizon), y=1 → -90° (nadir)
  let elev = (0.5 - yNorm) * 180;

  // Apply pitch correction
  elev += pitch;

  // Clamp
  elev = Math.max(-90, Math.min(90, elev));

  return { azimuth: az, elevation: elev };
}

/**
 * Convert sky azimuth/elevation to normalized image coordinates.
 * Inverse of imageToSky.
 */
export function skyToImage(azimuth, elevation, compassHeading = 180, pitch = 0) {
  // Reverse the pitch
  const elev = elevation - pitch;

  // x: how far from center heading
  let deltaAz = azimuth - compassHeading;
  // Wrap to [-180, 180]
  if (deltaAz > 180) deltaAz -= 360;
  if (deltaAz < -180) deltaAz += 360;
  const xNorm = 0.5 + deltaAz / 360;

  // y: elevation to vertical position
  const yNorm = 0.5 - elev / 180;

  return { x: xNorm, y: yNorm };
}

/**
 * Build a horizon profile (Float32Array of 360 elevation values)
 * from a set of traced paths on a photo.
 *
 * @param {Array} paths - array of path objects, each with { points: [{x, y}] }
 *     where x,y are normalized image coordinates (0-1)
 * @param {number} compassHeading - photo's compass heading
 * @param {number} pitch - photo's pitch offset
 * @returns {Float32Array} - elevation at each integer azimuth degree (0-359)
 */
export function pathsToHorizon(paths, compassHeading = 180, pitch = 0) {
  const horizon = new Float32Array(360);

  for (const path of paths) {
    if (!path.points || path.points.length < 2) continue;

    // Convert each path segment to sky coordinates and interpolate
    for (let i = 0; i < path.points.length - 1; i++) {
      const p0 = path.points[i];
      const p1 = path.points[i + 1];
      const sky0 = imageToSky(p0.x, p0.y, compassHeading, pitch);
      const sky1 = imageToSky(p1.x, p1.y, compassHeading, pitch);

      // Only care about above-horizon
      if (sky0.elevation <= 0 && sky1.elevation <= 0) continue;

      // Interpolate between the two points
      let az0 = sky0.azimuth, az1 = sky1.azimuth;

      // Handle wrap-around (e.g., 350° to 10°)
      let deltaAz = az1 - az0;
      if (deltaAz > 180) deltaAz -= 360;
      if (deltaAz < -180) deltaAz += 360;

      const steps = Math.max(1, Math.ceil(Math.abs(deltaAz)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        let az = az0 + deltaAz * t;
        az = ((az % 360) + 360) % 360;
        const el = sky0.elevation + (sky1.elevation - sky0.elevation) * t;
        const azIdx = Math.round(az) % 360;
        if (el > horizon[azIdx]) {
          horizon[azIdx] = el;
        }
      }
    }
  }

  // Smooth tiny gaps (1-2 degree) that can appear from rasterization
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < 360; i++) {
      if (horizon[i] === 0) {
        const prev = horizon[(i - 1 + 360) % 360];
        const next = horizon[(i + 1) % 360];
        if (prev > 0 && next > 0) {
          horizon[i] = (prev + next) / 2;
        }
      }
    }
  }

  return horizon;
}

// ============================================================
// Canvas drawing helpers
// ============================================================

/** Draw an azimuth/elevation grid overlay on a canvas */
export function drawSkyGrid(ctx, w, h, compassHeading, pitch, options = {}) {
  const {
    azRange = [0, 360],  // visible azimuth range
    elRange = [0, 90],   // only upper hemisphere
    azStep = 30,
    elStep = 10,
    color = 'rgba(255,255,255,0.15)',
    labelColor = 'rgba(255,255,255,0.4)',
    fontSize = 10,
    showCardinals = true,
  } = options;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.5;
  ctx.font = `${fontSize}px "JetBrains Mono", monospace`;
  ctx.fillStyle = labelColor;

  const cardinals = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

  // Draw elevation lines
  for (let el = elRange[0]; el <= elRange[1]; el += elStep) {
    const normY = skyToImage(compassHeading, el, compassHeading, pitch).y;
    // Map normY to canvas, but only the upper hemisphere portion (y: 0 to 0.5 of full pano)
    // For upper-hemisphere-only view: y goes from 0 (top=90°) to h (bottom=0°)
    const canvasY = h * (1 - (el - elRange[0]) / (elRange[1] - elRange[0]));
    if (canvasY < 0 || canvasY > h) continue;
    ctx.beginPath();
    ctx.moveTo(0, canvasY);
    ctx.lineTo(w, canvasY);
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillText(`${el}°`, 4, canvasY - 2);
  }

  // Draw azimuth lines
  for (let az = 0; az < 360; az += azStep) {
    const pos = skyToImage(az, 45, compassHeading, pitch);
    const canvasX = pos.x * w;
    if (canvasX < 0 || canvasX > w) continue;
    ctx.beginPath();
    ctx.moveTo(canvasX, 0);
    ctx.lineTo(canvasX, h);
    ctx.stroke();

    if (showCardinals && cardinals[az]) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(cardinals[az], canvasX, h - 4);
      ctx.fillStyle = labelColor;
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(`${az}°`, canvasX, h - 4);
    }
  }

  // Horizon line (elevation = 0)
  const horizY = h; // bottom = 0° elevation in upper-hemisphere view
  ctx.beginPath();
  ctx.moveTo(0, horizY);
  ctx.lineTo(w, horizY);
  ctx.strokeStyle = 'rgba(255,200,0,0.4)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore();
}

/** Color interpolation for SAV heatmap */
export function savColor(sav) {
  const t = Math.min(Math.max(0, (1 - sav) / 0.3), 1);
  if (t < 0.5) {
    const u = t * 2;
    return `rgb(${Math.round(34 + u * 211)},${Math.round(197 - u * 50)},${Math.round(94 + u * 2)})`;
  } else {
    const u = (t - 0.5) * 2;
    return `rgb(${Math.round(245 - u * 6)},${Math.round(147 - u * 78)},${Math.round(96 - u * 28)})`;
  }
}

// ============================================================
// Formatting helpers
// ============================================================

export function fmtPct(v, decimals = 1) { return (v * 100).toFixed(decimals) + '%'; }
export function fmtNum(v) { return Math.round(v).toLocaleString(); }
export function fmtDeg(v, decimals = 1) { return v.toFixed(decimals) + '°'; }

export function fmtLatLon(lat, lon) {
  if (lat == null || lon == null) return '—';
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lon).toFixed(4)}°${lonDir}`;
}

// ============================================================
// Debounce / throttle
// ============================================================

export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function throttle(fn, ms = 100) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    }
  };
}
