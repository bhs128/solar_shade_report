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
// Insta360 INSP dual-fisheye processing
// ============================================================

/**
 * Detect whether a file is an Insta360 INSP dual-fisheye image.
 * Checks file extension and validates it's a JPEG with dual-fisheye layout.
 */
export function isInspFile(file) {
  return /\.insp$/i.test(file.name);
}

/**
 * Read a protobuf varint from a Uint8Array at the given offset.
 * Returns { value, next } or null if invalid.
 */
function readVarint(data, offset) {
  let result = 0, shift = 0;
  while (offset < data.length) {
    const b = data[offset++];
    result |= (b & 0x7F) << shift;
    if (!(b & 0x80)) return { value: result >>> 0, next: offset };
    shift += 7;
    if (shift > 35) return null;
  }
  return null;
}

/**
 * Extract Field 60 (rotation matrix) from protobuf trailer bytes.
 * Field 60, wire type 5 (32-bit) → tag varint = (60<<3)|5 = 485 → bytes 0xE5 0x03.
 * Returns a 3×3 array or null.
 */
function parseProtobufRotationMatrix(trailer) {
  const floats = [];
  for (let i = 0; i < trailer.length - 5; i++) {
    if (trailer[i] === 0xE5 && trailer[i + 1] === 0x03) {
      const view = new DataView(trailer.buffer, trailer.byteOffset + i + 2, 4);
      floats.push(view.getFloat32(0, true));
      i += 5; // skip tag(2) + float(4) - 1 (loop increments)
    }
  }
  if (floats.length === 9) {
    return [
      [floats[0], floats[1], floats[2]],
      [floats[3], floats[4], floats[5]],
      [floats[6], floats[7], floats[8]],
    ];
  }
  return null;
}

/**
 * Parse the Insta360 proprietary binary trailer appended after JPEG data.
 * Returns lens calibration parameters for both fisheye lenses,
 * plus the Field 60 rotation matrix (gyro-stabilized camera orientation).
 */
function parseInspTrailer(arrayBuffer) {
  const data = new Uint8Array(arrayBuffer);
  // Find the last JPEG end marker (FFD9)
  let jpegEnd = -1;
  for (let i = data.length - 1; i > 0; i--) {
    if (data[i] === 0xD9 && data[i - 1] === 0xFF) {
      jpegEnd = i + 1;
      break;
    }
  }
  if (jpegEnd < 0 || jpegEnd >= data.length) return null;

  const trailer = data.slice(jpegEnd);
  // Extract ASCII strings from trailer
  const text = new TextDecoder('ascii').decode(trailer);
  // The calibration string starts with "2_" (2 lenses) and contains underscore-separated floats
  // Format: 2_cx1_cy1_r1_pitch1_roll1_fov1_cx2_cy2_r2_pitch2_roll2_fov2_totalW_totalH_...
  const calMatch = text.match(/\b(2_[\d.-]+(?:_[\d.-]+){13,})/);
  if (!calMatch) return null;

  const parts = calMatch[1].split('_');
  if (parts.length < 15) return null;

  // Extract Field 60 rotation matrix from protobuf trailer
  const rotationMatrix = parseProtobufRotationMatrix(trailer);
  if (rotationMatrix) {
    console.log('[SolarScope] Rotation matrix (Field 60):', rotationMatrix);
  }

  return {
    lens1: {
      cx: parseFloat(parts[1]),
      cy: parseFloat(parts[2]),
      radius: parseFloat(parts[3]),
      pitch: parseFloat(parts[4]),
      roll: parseFloat(parts[5]),
      fov: parseFloat(parts[6]),
    },
    lens2: {
      cx: parseFloat(parts[7]),
      cy: parseFloat(parts[8]),
      radius: parseFloat(parts[9]),
      pitch: parseFloat(parts[10]),
      roll: parseFloat(parts[11]),
      fov: parseFloat(parts[12]),
    },
    rawWidth: parseInt(parts[13]),
    rawHeight: parseInt(parts[14]),
    rotationMatrix,
  };
}

/**
 * Extract the raw MakerNote (EXIF tag 0x927C) bytes directly from a JPEG ArrayBuffer.
 * Walks JPEG APP1 → TIFF IFD0 → ExifIFD → MakerNote without relying on exifr.
 * Returns a Uint8Array of the MakerNote payload, or null.
 */
function extractMakerNote(arrayBuffer) {
  const data = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  if (data[0] !== 0xFF || data[1] !== 0xD8) return null; // not JPEG

  // Find APP1 (EXIF) segment
  let pos = 2;
  while (pos < data.length - 4) {
    if (data[pos] !== 0xFF) break;
    const marker = data[pos + 1];
    const segLen = view.getUint16(pos + 2, false);
    if (marker === 0xE1 &&
        data[pos + 4] === 0x45 && data[pos + 5] === 0x78 &&
        data[pos + 6] === 0x69 && data[pos + 7] === 0x66 &&
        data[pos + 8] === 0x00 && data[pos + 9] === 0x00) {
      // TIFF header at pos+10
      const tiffBase = pos + 10;
      const le = data[tiffBase] === 0x49; // 'II' = little-endian

      // IFD0
      const ifd0Off = view.getUint32(tiffBase + 4, le);
      let p = tiffBase + ifd0Off;
      const ifd0Count = view.getUint16(p, le);
      p += 2;
      let exifOff = 0;
      for (let i = 0; i < ifd0Count; i++) {
        if (view.getUint16(p, le) === 0x8769) { exifOff = view.getUint32(p + 8, le); break; }
        p += 12;
      }
      if (!exifOff) return null;

      // ExifIFD — find tag 0x927C (MakerNote)
      p = tiffBase + exifOff;
      const exifCount = view.getUint16(p, le);
      p += 2;
      for (let i = 0; i < exifCount; i++) {
        if (view.getUint16(p, le) === 0x927C) {
          const count = view.getUint32(p + 4, le);
          const offset = count <= 4 ? p + 8 : tiffBase + view.getUint32(p + 8, le);
          return new Uint8Array(arrayBuffer, offset, count);
        }
        p += 12;
      }
      return null;
    }
    pos += 2 + segLen;
  }
  return null;
}

/**
 * Parse the Insta360 MakerNote to extract accelerometer data.
 * Reads tag 0x927C directly from the JPEG EXIF structure.
 * Returns { ax, ay, az, gx, gy, gz } or null.
 */
function parseInspAccelerometer(arrayBuffer) {
  try {
    const mn = extractMakerNote(arrayBuffer);
    if (!mn) {
      console.warn('[SolarScope] MakerNote tag 0x927C not found in EXIF');
      return null;
    }
    let end = mn.length;
    for (let i = 0; i < mn.length; i++) {
      if (mn[i] < 0x20 && mn[i] !== 0x2D) { end = i; break; }
    }
    const ascii = new TextDecoder('ascii').decode(mn.slice(0, end));
    const vals = ascii.split('_').map(Number);
    if (vals.length >= 6 && vals.every(v => !isNaN(v))) {
      console.log('[SolarScope] Accelerometer parsed:', { ax: vals[0], ay: vals[1], az: vals[2], gx: vals[3], gy: vals[4], gz: vals[5] });
      return { ax: vals[0], ay: vals[1], az: vals[2], gx: vals[3], gy: vals[4], gz: vals[5] };
    }
    console.warn('[SolarScope] MakerNote found but could not parse accel. First 60 bytes:', ascii.slice(0, 60));
  } catch (e) {
    console.warn('[SolarScope] Error parsing MakerNote accelerometer:', e.message);
  }
  return null;
}

/**
 * Load an INSP file and return both fisheye halves as canvas data URLs,
 * plus calibration and accelerometer metadata.
 * @returns {{ left: {dataUrl, width, height}, right: {dataUrl, width, height}, calibration, accel }}
 */
export async function loadInspHalves(file) {
  // Read file as both ArrayBuffer (for trailer) and Image (for pixels)
  const arrayBuffer = await file.arrayBuffer();
  const calibration = parseInspTrailer(arrayBuffer);

  const accel = parseInspAccelerometer(arrayBuffer);
  const metadata = await parsePhotoMetadata(file);

  // Load as image
  const blob = new Blob([arrayBuffer], { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = url;
  });

  const fullW = img.width;   // 5952
  const halfW = Math.floor(fullW / 2); // 2976
  const h = img.height;      // 2976

  function extractHalf(xOffset) {
    const c = document.createElement('canvas');
    c.width = halfW; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, xOffset, 0, halfW, h, 0, 0, halfW, h);
    return { dataUrl: c.toDataURL('image/jpeg', 0.92), width: halfW, height: h, canvas: c };
  }

  const left = extractHalf(0);
  const right = extractHalf(halfW);
  URL.revokeObjectURL(url);

  return { left, right, calibration, accel, metadata, fullWidth: fullW, fullHeight: h };
}

/**
 * Reproject a fisheye hemisphere to equirectangular projection.
 * Uses equidistant fisheye model: r = (theta / halfFov) * R
 *
 * @param {HTMLCanvasElement} fisheyeCanvas - source fisheye image (square)
 * @param {object} opts
 * @param {number} opts.cx - optical center x in fisheye pixels
 * @param {number} opts.cy - optical center y in fisheye pixels
 * @param {number} opts.radius - fisheye circle radius in pixels
 * @param {number} opts.fov - half-angle field of view in degrees (~90 for 180° lens)
 * @param {number} [opts.outWidth=3600] - output equirectangular width
 * @param {number} [opts.outHeight=1800] - output equirectangular height
 * @param {number} [opts.rotation=0] - rotation of fisheye image in degrees (for compass alignment)
 * @returns {{ dataUrl: string, width: number, height: number }}
 */
export function reprojectFisheyeToEquirect(fisheyeCanvas, opts = {}) {
  const {
    cx: rawCx, cy: rawCy, radius, fov = 90,
    outWidth = 3600, outHeight = 1800,
    rotation = 0,
  } = opts;

  // Adjust calibration coords from raw DNG frame to INSP JPEG half
  // Raw DNG is portrait 2976×5952 (per lens), INSP JPEG half is 2976×2976
  // The cx/cy from trailer are in the DNG coordinate system
  // For the JPEG: the image may be transposed. Use center if calibration unavailable.
  const fishW = fisheyeCanvas.width;
  const fishH = fisheyeCanvas.height;
  const cx = rawCx != null ? Math.min(rawCx, fishW - 1) : fishW / 2;
  const cy = rawCy != null ? Math.min(rawCy, fishH - 1) : fishH / 2;
  const R = radius || Math.min(fishW, fishH) / 2;
  const halfFovRad = (fov || 90) * Math.PI / 180;

  const fishCtx = fisheyeCanvas.getContext('2d');
  const fishData = fishCtx.getImageData(0, 0, fishW, fishH).data;

  const out = document.createElement('canvas');
  out.width = outWidth;
  out.height = outHeight;
  const outCtx = out.getContext('2d');
  const outImg = outCtx.createImageData(outWidth, outHeight);
  const od = outImg.data;

  const DEG2RAD = Math.PI / 180;
  const rotRad = rotation * DEG2RAD;

  for (let oy = 0; oy < outHeight; oy++) {
    // Elevation: top=+90 (zenith), middle=0 (horizon), bottom=-90 (nadir)
    const elevation = (0.5 - oy / outHeight) * Math.PI; // +π/2 to -π/2
    const cosEl = Math.cos(elevation);
    const sinEl = Math.sin(elevation);

    for (let ox = 0; ox < outWidth; ox++) {
      // Azimuth: 0..2π across width
      const azimuth = (ox / outWidth) * 2 * Math.PI;

      // 3D direction vector (z=up, x=east, y=north convention)
      const dx = cosEl * Math.sin(azimuth + rotRad);
      const dy = cosEl * Math.cos(azimuth + rotRad);
      const dz = sinEl;

      // In fisheye camera frame: optical axis = +Z (pointing up from panel)
      // theta = angle from optical axis
      const theta = Math.acos(Math.max(-1, Math.min(1, dz)));

      // If beyond the fisheye FOV, leave black
      if (theta > halfFovRad) continue;

      // phi = angle in the fisheye image plane
      const phi = Math.atan2(dx, dy); // 0 = up in image

      // Equidistant fisheye: r = (theta / halfFov) * R
      const r = (theta / halfFovRad) * R;

      // Fisheye pixel coordinates (negate x to correct sensor mirror)
      const fx = cx - r * Math.sin(phi);
      const fy = cy - r * Math.cos(phi);

      // Bilinear sample
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      if (ix < 0 || ix >= fishW - 1 || iy < 0 || iy >= fishH - 1) continue;

      const fx1 = fx - ix;
      const fy1 = fy - iy;
      const fx0 = 1 - fx1;
      const fy0 = 1 - fy1;

      const i00 = (iy * fishW + ix) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + fishW * 4;
      const i11 = i01 + 4;

      const oi = (oy * outWidth + ox) * 4;
      for (let c = 0; c < 3; c++) {
        od[oi + c] = Math.round(
          fishData[i00 + c] * fx0 * fy0 +
          fishData[i10 + c] * fx1 * fy0 +
          fishData[i01 + c] * fx0 * fy1 +
          fishData[i11 + c] * fx1 * fy1
        );
      }
      od[oi + 3] = 255;
    }
  }

  outCtx.putImageData(outImg, 0, 0);
  return {
    dataUrl: out.toDataURL('image/jpeg', 0.88),
    width: outWidth,
    height: outHeight,
  };
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

// ============================================================
// Fisheye projection math
// Camera sits on tilted panel: optical axis = panel normal.
// World frame: Z=up, X=east, Y=north.
// Camera frame: Z=optical axis (away from panel), X/Y = sensor plane.
// ============================================================

/**
 * Build 3×3 rotation matrix from panel orientation + clock angle.
 * panelAz: panel azimuth in degrees (compass bearing the panel faces, e.g. 180=south)
 * panelTilt: panel tilt from horizontal in degrees (0=flat, 90=vertical)
 * clockAngle: rotation of camera around optical axis in degrees
 *   (0 = "up" in fisheye image points toward the uphill/north direction of the panel)
 *
 * Returns a function that transforms world (x,y,z) → camera (cx,cy,cz).
 */
export function buildFisheyeRotation(panelAz, panelTilt, clockAngle) {
  const D = Math.PI / 180;
  // Panel normal in world coords:
  // A panel facing south (az=180) tilted at 30° has normal pointing
  // south and up at 60° from horizontal → (sin(180°)*sin(30°), cos(180°)*sin(30°), cos(30°))
  // General: normal = (sin(az)*sin(tilt), cos(az)*sin(tilt), cos(tilt))
  //
  // We build a rotation matrix R that transforms world→camera.
  // Camera Z = panel normal, Camera Y = "up" direction on panel surface, Camera X = right.
  //
  // Step 1: Rotate world so Z aligns with panel normal (azimuth then tilt)
  // Step 2: Rotate around Z by clock angle

  const az = panelAz * D;
  const tilt = panelTilt * D;
  const clk = clockAngle * D;

  // Rotation: Rz(-az) then Rx(-tilt) then Rz(-clk)
  // Rz(-az): rotate world so panel faces along +Y
  const ca = Math.cos(-az), sa = Math.sin(-az);
  // Rx(-tilt): tilt optical axis to Z
  const ct = Math.cos(-tilt), st = Math.sin(-tilt);
  // Rz(-clk): clock rotation in sensor plane
  const cc = Math.cos(-clk), sc = Math.sin(-clk);

  // Combined: Rz(-clk) * Rx(-tilt) * Rz(-az)
  // Let's compute the 3×3 matrix elements directly
  // First: A = Rz(-az)
  // [ca  sa  0]   (note: Rz(θ) = [cosθ -sinθ 0; sinθ cosθ 0; 0 0 1])
  // [-sa ca  0]   Rz(-az) = [cos(az) sin(az) 0; -sin(az) cos(az) 0; 0 0 1]
  // [0   0   1]
  //
  // B = Rx(-tilt) * A
  // Rx(θ) = [1 0 0; 0 cosθ -sinθ; 0 sinθ cosθ]
  //
  // C = Rz(-clk) * B

  // Row-major: M[row][col], transforms as [Mx, My, Mz] = M * [wx, wy, wz]
  const m = [
    [cc * ca + sc * ct * sa,   cc * sa - sc * ct * ca,  -sc * st],
    [-sc * ca + cc * ct * sa, -sc * sa - cc * ct * ca,  -cc * st],  // Hmm wait
    [st * sa,                  -st * ca,                 ct],
  ];

  // Actually let me derive this more carefully with standard rotation composition.
  // World→Camera = Rz(clk) · Rx(tilt) · Rz(az + 180°)
  // Because: panel faces azimuth direction. To align panel normal with camera Z:
  //  1. Rz(-(az)): rotate world so panel azimuth aligns with -Y direction
  //     Actually, panel azimuth = direction panel FACES. Panel normal direction.
  //     Panel at az=180 faces south, normal points south-and-up.
  //     We want to rotate world so the panel normal direction becomes Z.
  //
  // Let me think geometrically:
  // Panel normal in world frame:
  //   nx = -sin(az) * sin(tilt)    [minus because "facing south" = -Y when az=180]
  //   ny = -cos(az) * sin(tilt)    [wait, convention: az=0→N(+Y), az=90→E(+X), az=180→S(-Y)]
  //
  // Standard: direction of azimuth A from north:
  //   dx = sin(A), dy = cos(A)  (A=0→N=(0,1), A=90→E=(1,0), A=180→S=(0,-1))
  //
  // Panel faces direction (sin(az), cos(az)) horizontally, tilted up by tilt degrees.
  // Normal = sin(tilt) * (sin(az), cos(az), 0) + cos(tilt) * (0, 0, 1)
  //        = (sin(az)*sin(tilt), cos(az)*sin(tilt), cos(tilt))

  // We need rotation R such that R * normal = (0, 0, 1) and
  // the "uphill" direction on the panel maps to some direction in XY plane of camera.

  // Approach: build camera basis vectors directly.
  // Camera Z = panel normal = N
  // Camera Y = "up on panel" = direction of steepest ascent on panel surface, pointing uphill
  //   The uphill direction in world frame for a south-facing tilted panel:
  //   uphill = d(normal)/d(tilt) normalized, projected perpendicular to normal
  //   More simply: the panel surface "up" direction is the component of world-up perpendicular to normal.
  //   worldUp = (0, 0, 1)
  //   panelUp = worldUp - (worldUp · N) * N, normalized
  //     worldUp · N = cos(tilt)
  //     panelUp = (0,0,1) - cos(tilt) * N = (0,0,1) - (sin(az)*sin(tilt)*cos(tilt), cos(az)*sin(tilt)*cos(tilt), cos²(tilt))
  //             = (-sin(az)*sin(tilt)*cos(tilt), -cos(az)*sin(tilt)*cos(tilt), sin²(tilt))
  //     |panelUp| = sin(tilt)  (can verify)
  //     panelUp_hat = (-sin(az)*cos(tilt), -cos(az)*cos(tilt), sin(tilt))
  //
  // Camera X = N × panelUp (right-hand rule)

  const sinAz = Math.sin(az), cosAz = Math.cos(az);
  const sinT = Math.sin(tilt), cosT = Math.cos(tilt);
  const sinC = Math.sin(clk), cosC = Math.cos(clk);

  // Camera basis vectors in world frame (before clock rotation):
  const Nz = [sinAz * sinT, cosAz * sinT, cosT]; // panel normal = camera Z
  let Uy = [-sinAz * cosT, -cosAz * cosT, sinT]; // panel uphill = camera Y (before clk)

  // Handle edge case: tilt ≈ 0 (flat panel, uphill undefined → pick north as "up")
  if (sinT < 1e-6) {
    Uy = [0, 1, 0]; // north
  }

  // Camera X = Z × Y (right-hand: if Z=out, Y=up, X=right)
  let Ux = [
    Nz[1] * Uy[2] - Nz[2] * Uy[1],
    Nz[2] * Uy[0] - Nz[0] * Uy[2],
    Nz[0] * Uy[1] - Nz[1] * Uy[0],
  ];

  // Apply clock-angle rotation around optical axis (Z):
  // Rotated X' = cos(clk)*X + sin(clk)*Y
  // Rotated Y' = -sin(clk)*X + cos(clk)*Y
  const Rx = [
    cosC * Ux[0] + sinC * Uy[0],
    cosC * Ux[1] + sinC * Uy[1],
    cosC * Ux[2] + sinC * Uy[2],
  ];
  const Ry = [
    -sinC * Ux[0] + cosC * Uy[0],
    -sinC * Ux[1] + cosC * Uy[1],
    -sinC * Ux[2] + cosC * Uy[2],
  ];

  // World→Camera: dot product with each basis vector
  // cam_x = dot(Rx, world), cam_y = dot(Ry, world), cam_z = dot(Nz, world)
  return function worldToCamera(wx, wy, wz) {
    return {
      cx: Rx[0] * wx + Rx[1] * wy + Rx[2] * wz,
      cy: Ry[0] * wx + Ry[1] * wy + Ry[2] * wz,
      cz: Nz[0] * wx + Nz[1] * wy + Nz[2] * wz,
    };
  };
}

/**
 * Project a sky direction (azimuth, elevation in degrees) to fisheye pixel coordinates.
 *
 * @param {number} az - sky azimuth in degrees (0=N, 90=E, 180=S, 270=W)
 * @param {number} el - sky elevation in degrees (0=horizon, 90=zenith)
 * @param {Function} worldToCamera - from buildFisheyeRotation()
 * @param {number} imgSize - fisheye image size in pixels (square)
 * @param {number} fov - half-angle FOV in degrees (~90 for 180° lens)
 * @returns {{ x: number, y: number, visible: boolean }}
 *   x, y in pixel coords (0,0 = top-left), visible = within FOV
 */
export function skyToFisheye(az, el, worldToCamera, imgSize, fov = 90) {
  const D = Math.PI / 180;
  // World direction vector from sky coordinates
  const cosEl = Math.cos(el * D), sinEl = Math.sin(el * D);
  const wx = cosEl * Math.sin(az * D); // east
  const wy = cosEl * Math.cos(az * D); // north
  const wz = sinEl;                      // up

  // Transform to camera frame
  const { cx, cy, cz } = worldToCamera(wx, wy, wz);

  // Behind the camera (below panel surface)
  if (cz <= 0) return { x: -1, y: -1, visible: false };

  // Angle from optical axis
  const theta = Math.acos(Math.min(1, cz));
  const halfFov = fov * D;
  if (theta > halfFov) return { x: -1, y: -1, visible: false };

  // Equidistant fisheye model: r = (theta / halfFov) * R
  const R = imgSize / 2;
  const r = (theta / halfFov) * R;

  // Angle in sensor plane
  // Convention: camera +Y = uphill direction → maps to image top (smaller py)
  const phi = Math.atan2(cx, cy);

  const px = imgSize / 2 + r * Math.sin(phi);
  const py = imgSize / 2 - r * Math.cos(phi);

  return { x: px, y: py, visible: true };
}

/**
 * Convert fisheye pixel coordinates to sky direction (azimuth, elevation).
 * Inverse of skyToFisheye.
 *
 * @param {number} px - pixel x (0 = left)
 * @param {number} py - pixel y (0 = top)
 * @param {Function} worldToCamera - from buildFisheyeRotation()
 * @param {number} imgSize - fisheye image size in pixels (square)
 * @param {number} fov - half-angle FOV in degrees
 * @returns {{ azimuth: number, elevation: number, valid: boolean }}
 */
export function fisheyeToSky(px, py, worldToCamera, imgSize, fov = 90) {
  const D = Math.PI / 180;
  const R = imgSize / 2;
  const dx = px - R;
  const dy = -(py - R); // flip Y so up is positive

  const r = Math.sqrt(dx * dx + dy * dy);
  if (r > R * 1.01) return { azimuth: 0, elevation: 0, valid: false };

  const halfFov = fov * D;
  const theta = (r / R) * halfFov; // angle from optical axis

  // Direction in camera frame
  // Convention matches skyToFisheye: camera +Y = image up
  const phi = Math.atan2(dx, dy);
  const sinTheta = Math.sin(theta);
  const cam_x = sinTheta * Math.sin(phi);
  const cam_y = sinTheta * Math.cos(phi);
  const cam_z = Math.cos(theta);

  // We need camera→world inverse. Since rotation matrix is orthogonal, inverse = transpose.
  // worldToCamera gives us the rows of the matrix. We need columns.
  // Get the rotation matrix by probing with unit vectors.
  const rx = worldToCamera(1, 0, 0);
  const ry = worldToCamera(0, 1, 0);
  const rz = worldToCamera(0, 0, 1);
  // Row 0 = [rx.cx, ry.cx, rz.cx] etc.
  // Inverse (transpose): column i becomes row i
  // world_x = rx.cx * cam_x + rx.cy * cam_y + rx.cz * cam_z  (column 0 of original = row 0 of transpose)
  const wx = rx.cx * cam_x + rx.cy * cam_y + rx.cz * cam_z;
  const wy = ry.cx * cam_x + ry.cy * cam_y + ry.cz * cam_z;
  const wz = rz.cx * cam_x + rz.cy * cam_y + rz.cz * cam_z;

  // Sky coordinates
  const el = Math.asin(Math.max(-1, Math.min(1, wz))) / D;
  let az = Math.atan2(wx, wy) / D;
  az = ((az % 360) + 360) % 360;

  return { azimuth: az, elevation: el, valid: true };
}

/**
 * Compute camera tilt and gravity clock-angle from accelerometer data.
 * Returns { tilt: degrees from horizontal, clockAngle: degrees, valid: boolean }
 *
 * @param {{ ax: number, ay: number, az: number }} accel - accelerometer in camera frame
 */
export function accelToOrientation(accel) {
  if (!accel) return { tilt: null, clockAngle: null, valid: false };
  const { ax, ay, az: azVal } = accel;
  const mag = Math.sqrt(ax * ax + ay * ay + azVal * azVal);
  if (mag < 0.5) return { tilt: null, clockAngle: null, valid: false };

  // Camera optical axis is camera +Z.
  // If panel is flat → gravity fully in -Z → tilt=0.
  // Angle between gravity and -Z = panel tilt from horizontal.
  const cosAngle = -azVal / mag;
  const tilt = Math.acos(Math.max(-1, Math.min(1, cosAngle))) * 180 / Math.PI;

  // Clock angle: direction of "downhill" in sensor plane = direction of gravity projected into XY.
  // gravity projected into camera XY = (ax, ay) (we use convention: Y=up in image)
  // clockAngle = angle from "up in image" to gravity projection
  const clockAngle = ((Math.atan2(-ax, ay) * 180 / Math.PI) + 360) % 360;

  return { tilt, clockAngle, valid: true };
}

/**
 * Compute sun position at a specific date/time and location.
 * Uses the solar engine but takes a Date or ISO string + lat/lon.
 * Returns { azimuth, elevation } in degrees, or null if insufficient info.
 */
export function sunPositionAtTime(datetime, lat, lon) {
  if (!datetime || lat == null || lon == null) return null;
  const dt = datetime instanceof Date ? datetime : new Date(datetime);
  if (isNaN(dt.getTime())) return null;

  const doy = Math.floor((dt - new Date(dt.getFullYear(), 0, 0)) / 86400000);
  const hours = dt.getUTCHours() + dt.getUTCMinutes() / 60 + dt.getUTCSeconds() / 3600;

  // Solar calculations (Spencer)
  const B = (360 / 365) * (doy - 81) * Math.PI / 180;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const decl = 23.45 * Math.sin((Math.PI / 180) * (360 / 365) * (doy - 81));

  // Solar noon in UTC for this longitude
  const solarNoonUTC = 12 - lon / 15 - eot / 60;
  const hourAngle = (hours - solarNoonUTC) * 15; // degrees

  const DEG = Math.PI / 180;
  const lr = lat * DEG, dr = decl * DEG, hr = hourAngle * DEG;
  const sinEl = Math.sin(lr) * Math.sin(dr) + Math.cos(lr) * Math.cos(dr) * Math.cos(hr);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl))) / DEG;

  const cosEl = Math.cos(el * DEG);
  if (cosEl < 1e-10) return { azimuth: 180, elevation: el };

  const cosAz = (Math.sin(dr) - Math.sin(lr) * sinEl) / (Math.cos(lr) * cosEl);
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) / DEG;
  if (hourAngle > 0) az = 360 - az;

  return { azimuth: az, elevation: el };
}

/**
 * Extract horizon profile from a ground mask on a fisheye image.
 * Scans radially from center outward for each azimuth degree.
 * The horizon = last ground→sky transition along each radial.
 *
 * @param {Uint8Array|ImageData} mask - ground mask (non-zero = ground)
 * @param {number} maskWidth - mask width in pixels
 * @param {number} maskHeight - mask height in pixels
 * @param {Function} worldToCamera - from buildFisheyeRotation()
 * @param {number} imgSize - fisheye image size
 * @param {number} fov - half-angle FOV in degrees
 * @returns {Float32Array} - elevation at each azimuth degree (0-359)
 */
export function fisheyeMaskToHorizon(mask, maskWidth, maskHeight, worldToCamera, imgSize, fov = 90) {
  const horizon = new Float32Array(360);
  const D = Math.PI / 180;
  const R = imgSize / 2;
  const halfFov = fov * D;

  // For each azimuth degree, scan from horizon (el=0) upward to find the
  // highest ground pixel = obstruction elevation at that azimuth
  for (let azDeg = 0; azDeg < 360; azDeg++) {
    let maxEl = 0;
    // Scan in 0.5° steps from 0 to 85
    for (let elDeg = 0; elDeg <= 85; elDeg += 0.5) {
      const fp = skyToFisheye(azDeg, elDeg, worldToCamera, imgSize, fov);
      if (!fp.visible) continue;
      // Check mask at this pixel
      const mx = Math.round(fp.x * maskWidth / imgSize);
      const my = Math.round(fp.y * maskHeight / imgSize);
      if (mx < 0 || mx >= maskWidth || my < 0 || my >= maskHeight) continue;
      const idx = my * maskWidth + mx;
      if (mask[idx] > 0) {
        maxEl = elDeg;
      }
    }
    horizon[azDeg] = maxEl;
  }

  // Smooth single-degree gaps
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
// 2D sky mask shade lookup (Option B)
// ============================================================

/**
 * Decode a mask data URL into raw pixel data for fast lookup.
 * @param {string} dataUrl - PNG data URL from canvas.toDataURL()
 * @returns {Promise<{data: Uint8ClampedArray, width: number, height: number}>}
 */
export async function decodeMaskDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const id = ctx.getImageData(0, 0, c.width, c.height);
      resolve({ data: id.data, width: c.width, height: c.height });
    };
    img.onerror = () => reject(new Error('Failed to decode mask'));
    img.src = dataUrl;
  });
}

/**
 * Normalize a fisheye FOV value to half-angle in degrees.
 * INSP trailer may store the value in radians, as full-FOV, or as half-FOV.
 * @param {number|null|undefined} fov - raw FOV value from calibration
 * @returns {number} half-angle FOV in degrees (typically ~90 for 180° Insta360 lenses)
 */
export function normalizeFisheyeFov(fov) {
  if (fov == null || fov <= 0) return 104;
  if (fov < 10) {
    // Likely in radians (e.g. π/2 ≈ 1.5708 for 90° half-angle)
    fov = fov * 180 / Math.PI;
  } else if (fov > 140) {
    // Likely full FOV in degrees (e.g. 208° → half = 104°)
    fov = fov / 2;
  }
  // Insta360 and similar fisheye lenses are >180° total (half-angle >90°)
  return Math.max(80, Math.min(130, fov));
}

/**
 * Build a shade lookup function from a photo and its decoded mask pixel data.
 * Returns (az, el) => boolean — true means the sun at (az, el) is shaded (ground).
 *
 * @param {object} photo - photo object from state (needs .projection, .metadata, .fisheye, .orientation)
 * @param {{data: Uint8ClampedArray, width: number, height: number}} maskData - decoded mask pixels
 * @param {object} systemDefaults - { azimuth, tilt } from state.system for fisheye fallback
 * @returns {function(number, number): boolean}
 */
export function buildSkyMaskLookup(photo, maskData, systemDefaults = {}) {
  if (!maskData || !maskData.data) return () => false;
  const { data, width, height } = maskData;

  if (photo.projection === 'fisheye' && photo.fisheye) {
    const ori = photo.orientation || {};
    const panelAz = ori.panelAzimuth ?? systemDefaults.azimuth ?? 180;
    const panelTilt = ori.panelTilt ?? systemDefaults.tilt ?? 30;
    const clockAngle = ori.clockAngle ?? photo.fisheye.accelClockAngle ?? 0;
    const worldToCamera = buildFisheyeRotation(panelAz, panelTilt, clockAngle);
    const fov = ori.fov ?? normalizeFisheyeFov(photo.fisheye.fov);
    const imgSize = Math.min(width, height);
    const D = Math.PI / 180;

    return (az, el) => {
      const fp = skyToFisheye(az, el, worldToCamera, imgSize, fov);
      if (!fp.visible) {
        // Direction is outside camera FOV.
        // If it's behind the panel plane (below panel surface), it's physically
        // blocked by the panel/roof structure → treat as shaded.
        const cosEl = Math.cos(el * D), sinEl = Math.sin(el * D);
        const wx = cosEl * Math.sin(az * D);
        const wy = cosEl * Math.cos(az * D);
        const wz = sinEl;
        return worldToCamera(wx, wy, wz).cz <= 0;
      }
      const ix = Math.max(0, Math.min(width - 1, Math.round(fp.x)));
      const iy = Math.max(0, Math.min(height - 1, Math.round(fp.y)));
      return data[(iy * width + ix) * 4 + 3] > 128;
    };
  } else {
    // Equirectangular — mask canvas represents upper hemisphere only
    // (elevation 0° at bottom, 90° at top), so yNorm 0..0.5 maps to full canvas height
    const heading = photo.metadata?.compassHeading ?? 180;
    const pitch = photo.metadata?.pitch ?? 0;

    return (az, el) => {
      const norm = skyToImage(az, el, heading, pitch);
      const ix = Math.round(norm.x * (width - 1));
      // Map yNorm (0..0.5 for upper hemisphere) to full canvas height
      const iy = Math.round((norm.y / 0.5) * (height - 1));
      if (ix < 0 || ix >= width || iy < 0 || iy >= height) return false;
      return data[(iy * width + ix) * 4 + 3] > 128;
    };
  }
}

/**
 * Build a merged shade lookup from multiple points' masks (OR logic).
 * Sun is shaded if ANY covering photo's mask marks it as ground at (az, el).
 *
 * @param {Array<function>} lookups - array of (az, el) => boolean functions
 * @returns {function(number, number): boolean}
 */
export function buildMergedMaskLookup(lookups) {
  if (!lookups || lookups.length === 0) return () => false;
  if (lookups.length === 1) return lookups[0];
  return (az, el) => {
    for (const fn of lookups) {
      if (fn(az, el)) return true;
    }
    return false;
  };
}

/**
 * Derive a 1D horizon profile from a 2D mask lookup function.
 * Useful for mini-chart visualization.
 * @param {function} maskLookup - (az, el) => boolean
 * @returns {Float32Array} - horizon elevation per azimuth degree (0-359)
 */
export function maskLookupToHorizon(maskLookup) {
  const horizon = new Float32Array(360);
  for (let az = 0; az < 360; az++) {
    let maxEl = 0;
    for (let el = 0; el <= 85; el += 0.5) {
      if (maskLookup(az, el)) maxEl = el;
    }
    horizon[az] = maxEl;
  }
  return horizon;
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
