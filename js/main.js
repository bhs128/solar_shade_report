/**
 * SolarScope — Main entry point
 * Navigation, save/load, Pyodide initialization, app bootstrap.
 */

import { initState, getState, rebuildPoints, serialize, deserialize, subscribe } from './state.js';
import { qs, qsa } from './utils.js';
import { initPyodide, isEnginePyodide } from './solar-engine.js';
import * as setupView from './views/setup.js';
import * as arrayView from './views/array.js';
import * as editorView from './views/editor.js';
import * as reportView from './views/report.js';

// ============================================================
// View registry
// ============================================================

const views = {
  setup: { module: setupView, container: null },
  array: { module: arrayView, container: null },
  editor: { module: editorView, container: null },
  report: { module: reportView, container: null },
};

let _currentView = 'setup';

// ============================================================
// Navigation
// ============================================================

function navigate(viewName) {
  if (!views[viewName]) return;

  // Destroy previous view if it has a destroy method
  const prev = views[_currentView];
  if (prev.module.destroy) prev.module.destroy();

  _currentView = viewName;

  // Update nav tabs
  qsa('.nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.view === viewName);
  });

  // Update view visibility
  for (const [name, v] of Object.entries(views)) {
    v.container.classList.toggle('active', name === viewName);
  }

  // Render the view
  views[viewName].module.render(views[viewName].container);
}

// ============================================================
// Save / Load project
// ============================================================

function saveProject() {
  const data = serialize(true);
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${data.name || 'solarscope-project'}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function loadProject() {
  qs('#file-load-project').click();
}

function handleLoadFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      deserialize(data);
      rebuildPoints();
      navigate(_currentView);
    } catch (err) {
      console.error('Failed to load project:', err);
      alert('Failed to load project file. Check the console for details.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ============================================================
// Pyodide loading (background)
// ============================================================

async function loadEngine() {
  const statusEl = qs('#engine-status');
  const progressEl = qs('#loading-progress');
  const msgEl = qs('#loading-message');
  const overlay = qs('#loading-overlay');
  const skipBtn = qs('#btn-skip-loading');

  // Show skip button after 5 seconds
  setTimeout(() => {
    if (skipBtn) skipBtn.style.display = 'inline-flex';
  }, 5000);

  skipBtn?.addEventListener('click', () => {
    overlay?.classList.add('hidden');
    statusEl.textContent = 'JS Engine';
    statusEl.className = 'status-badge fallback';
  });

  // Hide overlay immediately and load Pyodide in background
  // The app is fully functional with JS engine
  setTimeout(() => {
    overlay?.classList.add('hidden');
  }, 800);

  if (progressEl) progressEl.style.width = '30%';
  if (msgEl) msgEl.textContent = 'App ready. Loading pvlib in background...';

  statusEl.textContent = 'JS Engine (loading pvlib...)';
  statusEl.className = 'status-badge loading';

  const success = await initPyodide((msg) => {
    if (msgEl) msgEl.textContent = msg;
    if (msg.includes('Installing')) {
      if (progressEl) progressEl.style.width = '60%';
    } else if (msg.includes('ready')) {
      if (progressEl) progressEl.style.width = '100%';
    }
  });

  if (success) {
    statusEl.textContent = 'pvlib Ready';
    statusEl.className = 'status-badge ready';
  } else {
    statusEl.textContent = 'JS Engine';
    statusEl.className = 'status-badge fallback';
  }
}

// ============================================================
// Bootstrap
// ============================================================

function init() {
  // Initialize state
  initState();
  rebuildPoints();

  // Cache view containers
  for (const [name, v] of Object.entries(views)) {
    v.container = qs(`#view-${name}`);
  }

  // Navigation event listeners
  qsa('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => navigate(tab.dataset.view));
  });

  // Save / Load
  qs('#btn-save-project').addEventListener('click', saveProject);
  qs('#btn-load-project').addEventListener('click', loadProject);
  qs('#file-load-project').addEventListener('change', handleLoadFile);

  // Render initial view
  navigate('setup');

  // Load Pyodide in background
  loadEngine();
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
