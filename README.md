# SolarScope — Solar Shade Analysis Tool

Professional multi-point shade analysis using hemisphere photos from Insta360 cameras. Runs entirely in the browser — no server required. Can be hosted on GitHub Pages.

## Features

- **Insta360 Metadata Extraction**: Auto-reads GPS, compass heading (`PoseHeadingDegrees`), pitch/roll from EXIF/XMP metadata to orient hemisphere photos
- **Flexible Array Configuration**: Any row × column layout with configurable panel parameters
- **Multi-Point Shade Profiling**: Single photo for whole array, or per-panel individual photos
- **Photo-Based Tracing**: Draw obstruction boundaries directly on equirectangular panoramic photos with compass/elevation grid overlay
- **Alternative Scenarios**: Create named alternative traces (e.g., "Trees Removed") to model impact of removing obstructions
- **Professional Reports**: SAV, TOF, TSRF metrics; monthly/hourly access tables; panel heatmap; scenario comparison
- **pvlib Integration**: Pyodide loads Python pvlib in-browser as a progressive enhancement; JavaScript fallback engine works immediately
- **Save/Load Projects**: Full project serialization including photos

## Hosting on GitHub Pages

1. Push the `shade_app/` folder contents to a repo
2. In repo Settings → Pages → set source to `main` branch, root folder
3. The app runs entirely client-side — no server needed

## Quick Start

```bash
cd shade_app
python3 -m http.server 8000
# Open http://localhost:8000
```

## Architecture

```
shade_app/
├── index.html          # Single-page app shell
├── css/style.css       # Dark theme styles
├── js/
│   ├── main.js         # App bootstrap, navigation, save/load
│   ├── state.js        # Reactive state management
│   ├── utils.js        # DOM helpers, EXIF/XMP parser, coord mapping
│   ├── solar-engine.js # Solar calculations (JS + optional Pyodide/pvlib)
│   └── views/
│       ├── setup.js    # Project config: location, panels, array
│       ├── array.js    # Array diagram, photo upload & assignment
│       ├── editor.js   # Photo tracing with compass overlay
│       └── report.js   # Professional shade analysis report
```

## Insta360 Metadata Fields Used

| Field | Source | Purpose |
|-------|--------|---------|
| `PoseHeadingDegrees` | XMP Photosphere | Compass heading of image center |
| `GPSImgDirection` | EXIF GPS | Fallback compass heading |
| `GPSLatitude/Longitude` | EXIF GPS | Auto-fill site location |
| `PosePitchDegrees` | XMP Photosphere | Camera pitch correction |
| `PoseRollDegrees` | XMP Photosphere | Camera roll correction |
| `ProjectionType` | XMP Photosphere | Confirms equirectangular |
| `FullPanoWidthPixels` | XMP Photosphere | Full panorama dimensions |
| `Make/Model` | EXIF | Camera identification |
