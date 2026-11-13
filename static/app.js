const $ = (selector) => document.querySelector(selector);

const form = $('#analysis-form');
const input = $('#image-input');
const dropZone = $('#drop-zone');
const previewList = $('#preview-list');
const analyzeButton = $('#analyze-btn');
const reportTabs = $('#report-tabs');
const reportContent = $('#report-content');

let files = [];
let previews = [];
let result = null;
let selectedReport = 0;
let running = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function listSection(title, items, uncertain = false) {
  const section = element('section', 'report-section');
  const heading = element('h4', '', title);
  section.appendChild(heading);
  const list = element('ul', `observations${uncertain ? ' uncertain' : ''}`);
  const rows = Array.isArray(items) && items.length ? items : ['Not provided by the model'];
  rows.forEach((text) => list.appendChild(element('li', '', text)));
  section.appendChild(list);
  return section;
}

function setScreen(screen) {
  ['empty', 'loading', 'error', 'success'].forEach((name) => {
    $(`#results-${name}`).hidden = name !== screen;
  });
  const state = $('#result-state');
  state.textContent = { empty: '● READY', loading: '◌ ANALYZING', error: '● ERROR', success: '● COMPLETE' }[screen];
}

function resetReport() {
  result = null;
  selectedReport = 0;
  reportTabs.replaceChildren();
  reportContent.replaceChildren();
  setScreen('empty');
}

function refreshPreviews() {
  previews.forEach((url) => URL.revokeObjectURL(url));
  previews = [];
  previewList.replaceChildren();
  files.forEach((file, index) => {
    const card = element('div', 'preview-card');
    const url = URL.createObjectURL(file);
    previews.push(url);
    const thumb = element('img');
    thumb.src = url;
    thumb.alt = `Preview of ${file.name}`;
    const info = element('div', 'preview-info');
    info.appendChild(element('strong', '', file.name));
    info.appendChild(element('small', '', `${(file.size / 1024 / 1024).toFixed(2)} MB`));
    const remove = element('button', 'preview-remove', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      if (running) return;
      files.splice(index, 1);
      refreshPreviews();
      resetReport();
    });
    card.append(thumb, info, remove);
    previewList.appendChild(card);
  });
}

function addFiles(incoming) {
  if (running) return;
  const selected = Array.from(incoming).filter(Boolean);
  if (!selected.length) return;
  for (const file of selected) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      showError('Only JPEG, PNG, and WebP images are supported.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      showError(`"${file.name}" exceeds the 8 MB limit.`);
      return;
    }
  }
  const maximum = 4;
  if (files.length + selected.length > maximum) {
    showError(`Upload at most ${maximum} images. Remove existing images first.`);
    return;
  }
  const bytes = files.reduce((n, file) => n + file.size, 0) + selected.reduce((n, file) => n + file.size, 0);
  if (bytes > 20 * 1024 * 1024) {
    showError('The total image size cannot exceed 20 MB.');
    return;
  }
  files.push(...selected);
  refreshPreviews();
  resetReport();
}

input.addEventListener('change', () => {
  addFiles(input.files);
  input.value = '';
});
dropZone.addEventListener('click', () => { if (!running) input.click(); });
dropZone.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && !running) {
    event.preventDefault();
    input.click();
  }
});
['dragenter', 'dragover'].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  dropZone.classList.add('dragging');
}));
['dragleave', 'drop'].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
}));
dropZone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));

$('#route-verified').addEventListener('change', (event) => {
  $('#distance-group').hidden = !event.target.checked;
});
$('#retry-btn').addEventListener('click', () => form.requestSubmit());

function showError(message) {
  $('#error-message').textContent = message;
  setScreen('error');
}

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function lockForm(lock) {
  running = lock;
  analyzeButton.disabled = lock;
  $('#analyze-label').textContent = lock ? 'Processing images…' : 'Analyze flood images';
  form.querySelectorAll('input, button').forEach((control) => { control.disabled = lock; });
  dropZone.setAttribute('aria-disabled', String(lock));
  $('.results-panel').setAttribute('aria-busy', String(lock));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (running) return;
  if (!files.length) return showError('Upload at least one flood photograph.');
  const verified = $('#route-verified').checked;
  const distanceValue = $('#route-distance').value;
  const distance = distanceValue ? Number(distanceValue) : null;
  if (verified && (!Number.isFinite(distance) || distance <= 0 || distance > 100000)) {
    return showError('Provide the measured distance of the verified dry route (1–100,000 meters).');
  }
  lockForm(true);
  setScreen('loading');
  try {
    const images = await Promise.all(files.map(async (file) => ({ name: file.name, data: await fileBase64(file) })));
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'single',
        images,
        verified_dry_route: verified,
        dry_route_distance_m: verified ? distance : null,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Analysis failed');
    result = payload;
    selectedReport = 0;
    if (!Array.isArray(result.reports) || !result.reports.length) throw new Error('The model returned no image reports. Please retry.');
    setScreen('success');
    renderReports();
    $('#results-success').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showError(error instanceof TypeError ? 'The web server is unreachable. Start server.py and retry.' : String(error.message || error));
  } finally {
    lockForm(false);
  }
});

function metric(caption, value, detail, style = '') {
  const card = element('div', `metric-card ${style}`);
  card.appendChild(element('span', 'metric-caption', caption));
  card.appendChild(element('strong', '', value));
  card.appendChild(element('small', '', detail));
  return card;
}

function renderReports() {
  reportTabs.replaceChildren();
  if (result.reports.length > 1) {
    result.reports.forEach((_, index) => {
      const tab = element('button', `report-tab${selectedReport === index ? ' active' : ''}`, `Image ${index + 1} · ${files[index]?.name || 'Report'}`);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(selectedReport === index));
      tab.addEventListener('click', () => {
        selectedReport = index;
        renderReports();
      });
      reportTabs.appendChild(tab);
    });
  }
  const first = result.reports[selectedReport];
  if (!first) return showError('The notebook returned an empty report.');
  $('#report-time').textContent = new Date(first.timestamp_utc).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  renderReport(first);
}

function renderReport(report) {
  reportContent.replaceChildren();
  const analysis = report.analysis || {};
  const hazard = report.visual_hazard || {};
  const travel = report.dry_route_time;
  reportContent.appendChild(element('p', 'report-context', `Image ${selectedReport + 1} · ${files[selectedReport]?.name || 'Uploaded image'}`));
  reportContent.appendChild(element('h3', 'report-title', 'What the image shows'));
  reportContent.appendChild(element('p', 'report-summary', analysis.summary || 'No summary was provided by the model.'));
  const grid = element('div', 'score-grid');
  const hasScore = Number.isFinite(hazard.score);
  const score = hasScore ? `${hazard.score}/100` : 'Not assessable';
  const hazardStyle = hazard.level === 'Critical' ? 'hazard-critical' : 'hazard-high';
  const hazardCard = metric('Visual hazard index', score, hasScore ? `${hazard.level} visual hazard` : 'Flooding not confirmed; safety unknown', 'score-card');
  hazardCard.querySelector('strong').className = hasScore ? hazardStyle : 'hazard-unavailable';
  grid.appendChild(hazardCard);
  const extent = String(analysis.flood_extent || 'uncertain');
  grid.appendChild(metric('Flood extent', extent[0].toUpperCase() + extent.slice(1), ({ none: 'No flooding identified in this view', localized: 'Flooding in part of the visible scene', widespread: 'Flooding across much of the visible scene', uncertain: 'Extent cannot be determined' })[extent] || 'Extent cannot be determined'));
  reportContent.appendChild(grid);
  reportContent.appendChild(element('p', 'score-explainer', 'How to read the score: confirmed flooding starts at 50 points. Visible hazard factors add points, capped at 100. High: 50–79; Critical: 80–100. This is not a probability or a measurement of depth. An unavailable score does not mean the scene is safe.'));

  const findings = element('section', 'report-section');
  findings.appendChild(element('h4', '', 'Conditions at a glance'));
  const rows = element('dl', 'condition-list');
  [['Flooding visible', 'flooding_visible'], ['Road or path flooded', 'road_or_path_flooded'], ['Signs of moving water', 'moving_water_cues'], ['Debris visible', 'visible_debris'], ['People in affected area', 'people_exposed'], ['Vehicles in affected area', 'vehicles_exposed']].forEach(([label, key]) => {
    const value = analysis[key];
    const row = element('div', 'condition-row');
    row.append(element('dt', '', label), element('dd', `finding-${value === 'yes' ? 'yes' : value === 'no' ? 'no' : 'uncertain'}`, value === 'yes' ? 'Observed' : value === 'no' ? 'Not observed' : 'Unclear'));
    rows.appendChild(row);
  });
  findings.appendChild(rows);
  findings.appendChild(element('p', 'helper', '“Not observed” means not identified in this image. “Unclear” means the image cannot establish the condition.'));
  reportContent.appendChild(findings);

  const refuge = element('section', 'report-section refuge-section');
  refuge.appendChild(element('h4', '', 'Potential places of refuge'));
  refuge.appendChild(element('p', 'subsection-note', analysis.refuge_assessment || 'No potential refuge can be reliably identified from this image.'));
  const candidates = Array.isArray(analysis.potential_refuges) ? analysis.potential_refuges.filter((candidate) => {
    const box = candidate?.bbox;
    return Array.isArray(box) && box.length === 4 && box.every((v) => Number.isFinite(v) && v >= 0 && v <= 1000) && box[0] < box[2] && box[1] < box[3];
  }).slice(0, 3) : [];
  if (candidates.length && previews[selectedReport]) {
    const figure = element('figure', 'refuge-figure');
    const imageWrap = element('div', 'refuge-image');
    const image = element('img');
    image.src = previews[selectedReport];
    image.alt = 'Uploaded flood photograph with numbered potential refuge markers, described below.';
    imageWrap.appendChild(image);
    candidates.forEach((candidate, index) => {
      const [left, top, right, bottom] = candidate.bbox;
      const marker = element('div', 'refuge-marker');
      marker.style.left = `${left / 10}%`;
      marker.style.top = `${top / 10}%`;
      marker.style.width = `${(right - left) / 10}%`;
      marker.style.height = `${(bottom - top) / 10}%`;
      marker.appendChild(element('span', '', index + 1));
      marker.setAttribute('aria-hidden', 'true');
      imageWrap.appendChild(marker);
    });
    figure.append(imageWrap, element('figcaption', 'helper', 'Approximate model-generated locations. Numbers match the candidates below; they do not indicate verified safety or an accessible route.'));
    refuge.appendChild(figure);
  }
  candidates.forEach((candidate, index) => {
    const card = element('div', 'refuge-candidate');
    card.appendChild(element('h5', '', `${index + 1}. ${candidate.label}`));
    card.appendChild(element('p', '', `Visible evidence: ${candidate.evidence}`));
    card.appendChild(element('p', 'subsection-note', `Hazards and unknowns: ${candidate.limitations}`));
    refuge.appendChild(card);
  });
  refuge.appendChild(element('p', 'safety-footer', 'Potential refuge only. Photos cannot verify access, structural stability, or whether an area will remain dry. Do not cross floodwater or climb onto roofs based on this assessment.'));
  reportContent.appendChild(refuge);

  const route = element('div', 'info-strip');
  route.textContent = travel
    ? `⏱ Estimated walk on independently verified dry route: ${travel.min_minutes}–${travel.max_minutes} minutes (${travel.distance_m} m), assuming 0.6–1.2 m/s. Not an evacuation time.`
    : '⏱ Walking time unavailable without an independently verified dry route and known distance.';
  reportContent.appendChild(route);

  reportContent.appendChild(listSection('01 / Visible evidence', analysis.observations));
  reportContent.appendChild(listSection('02 / Visual hazard factors', hazard.reasons));
  reportContent.appendChild(listSection('03 / Uncertainties & limitations', analysis.uncertainties, true));
  reportContent.appendChild(element('div', 'safety-footer', '⚠ This assessment is based on a photograph and is not a flood forecast, injury probability, depth measurement, route certification, or emergency instruction. Never cross floodwater.'));
}

function downloadFile(filename, content, contentType) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

$('#download-json').addEventListener('click', () => {
  if (result) downloadFile('floodvision_report.json', JSON.stringify(result, null, 2), 'application/json');
});
$('#download-markdown').addEventListener('click', () => {
  if (result) downloadFile('floodvision_report.md', (result.markdown || []).join('\n\n---\n\n'), 'text/markdown');
});

setScreen('empty');
