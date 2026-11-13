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
  currentScreen = screen;
  const state = $('#result-state');
  state.textContent = { empty: '● READY', loading: '◌ ANALYZING', error: '● ERROR', success: '● COMPLETE' }[screen];
  translatePage();
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
  translatePage();
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
  translatePage();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (running) return;
  if (!files.length) return showError('Upload at least one flood photograph.');
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
  $('#report-time').textContent = new Date(first.timestamp_utc).toLocaleString(language === 'es' ? 'es' : 'en', { dateStyle: 'medium', timeStyle: 'short' });
  renderReport(first);
  translatePage();
}

function renderReport(report) {
  reportContent.replaceChildren();
  const analysis = report.analysis || {};
  const hazard = report.visual_hazard || {};
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

// Keep the original interface text so switching languages never alters model evidence.
let language = 'en';
try { language = localStorage.getItem('floodvision-language') === 'es' ? 'es' : 'en'; } catch {}
let currentScreen = 'empty';
const translatedNodes = new WeakMap();
const spanish = {
  'INTELLIGENCE FOR SAFER COMMUNITIES': 'INTELIGENCIA PARA COMUNIDADES MÁS SEGURAS',
  'See the water.': 'Observa el agua.',
  'Understand the impact.': 'Comprende el impacto.',
  'Turn flood photographs into clear, evidence-based assessments with local vision AI. Upload imagery, analyze visible conditions, and generate a shareable report.': 'Convierte fotografías de inundaciones en evaluaciones claras basadas en evidencia con IA visual local. Sube imágenes, analiza las condiciones visibles y genera un reporte para compartir.',
  'Research tool — not emergency guidance.': 'Herramienta de investigación — no es una guía de emergencia.',
  'The 0–100 score is a visual hazard indicator,': 'La puntuación de 0 a 100 es un indicador visual de peligro,',
  'not': 'no',
  'a probability of injury. Images cannot confirm water depth, current, or route safety. Never walk or drive through floodwater.': 'una probabilidad de lesiones. Las imágenes no pueden confirmar la profundidad, la corriente ni la seguridad de una ruta. Nunca camines ni conduzcas por zonas inundadas.',
  'INPUT DATA': 'DATOS DE ENTRADA',
  'Upload flood images': 'Subir imágenes de inundaciones',
  'Upload 1–4 photographs. Each image receives its own assessment.': 'Sube de 1 a 4 fotografías. Cada imagen recibe su propia evaluación.',
  'Flood imagery': 'Fotografías de inundaciones',
  'UP TO 4 IMAGES': 'HASTA 4 IMÁGENES',
  'Drop your flood images here': 'Arrastra aquí tus imágenes',
  'or': 'o',
  'browse files': 'selecciona archivos',
  'from your device': 'de tu dispositivo',
  'JPG, PNG, WebP · 8 MB each · 20 MB total': 'JPG, PNG, WebP · 8 MB por imagen · 20 MB en total',
  'Analyze flood images': 'Analizar imágenes de inundaciones',
  'Processing images…': 'Procesando imágenes…',
  'Images are processed by your configured GB10 server and removed from local temporary storage after each request.': 'Las imágenes se procesan en tu servidor GB10 configurado y se eliminan del almacenamiento temporal local después de cada solicitud.',
  'MODEL OUTPUT': 'RESULTADO DEL MODELO',
  'Analysis report': 'Reporte de análisis',
  'AWAITING IMAGERY': 'ESPERANDO IMÁGENES',
  'Ready when you are.': 'Todo listo para comenzar.',
  'Upload photos and select': 'Sube fotos y selecciona',
  'to see a structured visual assessment powered by Qwen3-VL.': 'para ver una evaluación visual estructurada con Qwen3-VL.',
  '● Flood extent': '● Extensión de la inundación',
  '● Hazard indicators': '● Indicadores de peligro',
  '● Visual evidence': '● Evidencia visual',
  '● Report export': '● Exportar reporte',
  'Analyzing visible conditions': 'Analizando las condiciones visibles',
  'Reading visual evidence with Qwen3-VL on your GB10 server…': 'Interpretando evidencia visual con Qwen3-VL en tu servidor GB10…',
  'Large images and multi-image requests may take longer.': 'Las imágenes grandes y las solicitudes con varias imágenes pueden tardar más.',
  'Analysis could not complete': 'No se pudo completar el análisis',
  'Try again ↗': 'Reintentar ↗',
  'ANALYSIS COMPLETE': 'ANÁLISIS COMPLETO',
  'Export this report': 'Exportar este reporte',
  'Save the assessment for your records': 'Guarda la evaluación para tus registros',
  '● READY': '● LISTO', '◌ ANALYZING': '◌ ANALIZANDO', '● ERROR': '● ERROR', '● COMPLETE': '● COMPLETO',
  'What the image shows': 'Lo que muestra la imagen',
  'Not provided by the model': 'No proporcionado por el modelo',
  'No summary was provided by the model.': 'El modelo no proporcionó un resumen.',
  'Visual hazard index': 'Índice visual de peligro',
  'Not assessable': 'No evaluable',
  'High visual hazard': 'Peligro visual alto', 'Critical visual hazard': 'Peligro visual crítico',
  'Flooding not confirmed; safety unknown': 'Inundación no confirmada; seguridad desconocida',
  'Flood extent': 'Extensión de la inundación',
  'None': 'Ninguna', 'Localized': 'Localizada', 'Widespread': 'Generalizada', 'Uncertain': 'Incierta',
  'No flooding identified in this view': 'No se identificó inundación en esta vista',
  'Flooding in part of the visible scene': 'Inundación en parte de la escena visible',
  'Flooding across much of the visible scene': 'Inundación en gran parte de la escena visible',
  'Extent cannot be determined': 'No se puede determinar la extensión',
  'How to read the score: confirmed flooding starts at 50 points. Visible hazard factors add points, capped at 100. High: 50–79; Critical: 80–100. This is not a probability or a measurement of depth. An unavailable score does not mean the scene is safe.': 'Cómo interpretar la puntuación: una inundación confirmada comienza en 50 puntos. Los factores de peligro visibles suman puntos hasta un máximo de 100. Alto: 50–79; crítico: 80–100. No es una probabilidad ni una medida de profundidad. Una puntuación no disponible no significa que la escena sea segura.',
  'Conditions at a glance': 'Resumen de condiciones',
  'Flooding visible': 'Inundación visible', 'Road or path flooded': 'Carretera o camino inundado',
  'Signs of moving water': 'Señales de agua en movimiento', 'Debris visible': 'Escombros visibles',
  'People in affected area': 'Personas en la zona afectada', 'Vehicles in affected area': 'Vehículos en la zona afectada',
  'Observed': 'Observado', 'Not observed': 'No observado', 'Unclear': 'No está claro',
  '“Not observed” means not identified in this image. “Unclear” means the image cannot establish the condition.': '«No observado» significa que no se identificó en esta imagen. «No está claro» significa que la imagen no permite determinar la condición.',
  'Potential places of refuge': 'Posibles lugares de refugio',
  'No potential refuge can be reliably identified from this image.': 'No se puede identificar con fiabilidad un posible refugio en esta imagen.',
  'Approximate model-generated locations. Numbers match the candidates below; they do not indicate verified safety or an accessible route.': 'Ubicaciones aproximadas generadas por el modelo. Los números corresponden a los candidatos de abajo; no indican seguridad verificada ni una ruta accesible.',
  'Potential refuge only. Photos cannot verify access, structural stability, or whether an area will remain dry. Do not cross floodwater or climb onto roofs based on this assessment.': 'Solo es un posible refugio. Las fotos no permiten verificar el acceso, la estabilidad estructural ni si una zona permanecerá seca. No cruces zonas inundadas ni subas a techos basándote en esta evaluación.',
  '01 / Visible evidence': '01 / Evidencia visible', '02 / Visual hazard factors': '02 / Factores visuales de peligro',
  '03 / Uncertainties & limitations': '03 / Incertidumbres y limitaciones',
  '⚠ This assessment is based on a photograph and is not a flood forecast, injury probability, depth measurement, route certification, or emergency instruction. Never cross floodwater.': '⚠ Esta evaluación se basa en una fotografía y no es un pronóstico de inundación, una probabilidad de lesiones, una medida de profundidad, una certificación de ruta ni una instrucción de emergencia. Nunca cruces zonas inundadas.',
  'Only JPEG, PNG, and WebP images are supported.': 'Solo se admiten imágenes JPEG, PNG y WebP.',
  'The total image size cannot exceed 20 MB.': 'El tamaño total de las imágenes no puede superar los 20 MB.',
  'Upload at least one flood photograph.': 'Sube al menos una fotografía de inundación.',
  'The model returned no image reports. Please retry.': 'El modelo no devolvió reportes de imágenes. Inténtalo de nuevo.',
  'The notebook returned an empty report.': 'El cuaderno devolvió un reporte vacío.',
  'The web server is unreachable. Start server.py and retry.': 'No se puede acceder al servidor web. Inicia server.py e inténtalo de nuevo.',
  'Analysis failed': 'El análisis falló',
  'Choose flood images': 'Seleccionar imágenes de inundaciones',
  'Flood analysis workspace': 'Área de análisis de inundaciones',
  'Image reports': 'Reportes de imágenes', 'Selected image assessment': 'Evaluación de la imagen seleccionada',
  'FloodVision home': 'Inicio de FloodVision',
  'Uploaded flood photograph with numbered potential refuge markers, described below.': 'Fotografía de inundación con marcadores numerados de posibles refugios descritos abajo.',
};

function translateText(text) {
  if (language !== 'es') return text;
  const trimmed = text.trim();
  let translated = spanish[trimmed];
  if (translated === undefined) {
    if (/^Image \d+ · /.test(trimmed)) translated = trimmed.replace(/^Image /, 'Imagen ').replace(/ · Uploaded image$/, ' · Imagen subida');
    else if (trimmed.startsWith('Preview of ')) translated = trimmed.replace('Preview of ', 'Vista previa de ');
    else if (trimmed.startsWith('Remove ')) translated = trimmed.replace('Remove ', 'Eliminar ');
    else if (trimmed.startsWith('Visible evidence: ')) translated = trimmed.replace('Visible evidence: ', 'Evidencia visible: ');
    else if (trimmed.startsWith('Hazards and unknowns: ')) translated = trimmed.replace('Hazards and unknowns: ', 'Peligros e incógnitas: ');
    else if (/^".*" exceeds the 8 MB limit\.$/.test(trimmed)) translated = trimmed.replace('exceeds the 8 MB limit.', 'supera el límite de 8 MB.');
    else if (trimmed === 'Upload at most 4 images. Remove existing images first.') translated = 'Sube como máximo 4 imágenes. Elimina primero las imágenes existentes.';
  }
  return translated === undefined ? text : text.replace(trimmed, translated);
}

function translatePage() {
  document.documentElement.lang = language;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement.closest('script, style, #language-toggle')) continue;
    const previous = translatedNodes.get(node);
    const original = previous && node.nodeValue === previous.translated ? previous.original : node.nodeValue;
    const translated = translateText(original);
    if (node.nodeValue !== translated) node.nodeValue = translated;
    translatedNodes.set(node, { original, translated });
  }
  document.querySelectorAll('[aria-label], img[alt]').forEach((node) => {
    if (node.id === 'language-toggle') return;
    for (const attribute of ['aria-label', 'alt']) {
      if (!node.hasAttribute(attribute)) continue;
      const key = attribute === 'alt' ? 'originalAlt' : 'originalAriaLabel';
      if (!node.dataset[key]) node.dataset[key] = node.getAttribute(attribute);
      node.setAttribute(attribute, translateText(node.dataset[key]));
    }
  });
  const toggle = $('#language-toggle');
  toggle.textContent = language === 'es' ? 'English' : 'Español';
  toggle.setAttribute('aria-label', language === 'es' ? 'Switch language to English' : 'Cambiar idioma a español');
}

$('#language-toggle').addEventListener('click', () => {
  language = language === 'en' ? 'es' : 'en';
  try { localStorage.setItem('floodvision-language', language); } catch {}
  translatePage();
  if (result && currentScreen === 'success') renderReports();
});

// The browser's PDF printer preserves selectable text and embeds the original photo.
$('#download-pdf').addEventListener('click', async () => {
  if (!result?.reports[selectedReport]) return;
  const frame = document.createElement('iframe');
  frame.className = 'pdf-frame';
  frame.title = language === 'es' ? 'Reporte para guardar como PDF' : 'Report to save as PDF';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write('<!doctype html><html><head><meta charset="utf-8"><title>FloodVision</title><style>@page{size:A4;margin:16mm}body{font:12px/1.6 system-ui,sans-serif;color:#182b33}h1{font-size:24px}h3{font-size:20px}h4{font-size:15px;margin-bottom:8px}p,li{overflow-wrap:anywhere}.source-photo{display:block;max-width:100%;max-height:110mm;object-fit:contain;margin:12px auto}.score-grid{display:flex;gap:24px}.metric-card{flex:1;border:1px solid #bbb;padding:12px}.metric-card span,.metric-card strong,.metric-card small{display:block}.metric-card strong{font-size:22px}.condition-row{display:flex;justify-content:space-between;border-bottom:1px solid #ddd;padding:5px}.condition-row dd{margin:0}.refuge-image{position:relative;line-height:0}.refuge-image img{width:100%;max-width:100%}.refuge-marker{position:absolute;border:2px solid #9a6100}.refuge-marker span{background:#ffe19b;font:700 13px/1.5 system-ui;padding:2px}.refuge-figure,.refuge-candidate,.metric-card{break-inside:avoid}h3,h4,h5{break-after:avoid}.safety-footer{border:1px solid #aaa;padding:10px}.helper,figcaption{font-size:10px}.print-help{background:#eee;padding:10px}@media print{.print-help{display:none}}</style></head><body></body></html>');
  doc.close();
  doc.documentElement.lang = language;
  const name = files[selectedReport]?.name || `image-${selectedReport + 1}`;
  doc.title = `FloodVision - ${name}`;
  const help = doc.createElement('p');
  help.className = 'print-help';
  help.textContent = language === 'es' ? 'Selecciona «Guardar como PDF» en el diálogo de impresión.' : 'Select “Save as PDF” in the print dialog.';
  const heading = doc.createElement('h1');
  heading.textContent = language === 'es' ? 'FloodVision — Reporte de análisis' : 'FloodVision — Analysis report';
  const timestamp = doc.createElement('p');
  timestamp.textContent = $('#report-time').textContent;
  doc.body.append(help, heading, timestamp);
  if (previews[selectedReport]) {
    const photo = doc.createElement('img');
    photo.className = 'source-photo';
    photo.src = previews[selectedReport];
    photo.alt = name;
    doc.body.appendChild(photo);
  }
  doc.body.appendChild(doc.importNode(reportContent, true));
  try {
    await Promise.all(Array.from(doc.images, (img) => img.decode()));
    const printWindow = frame.contentWindow;
    printWindow.addEventListener('afterprint', () => frame.remove(), { once: true });
    printWindow.focus();
    printWindow.print();
  } catch {
    frame.remove();
    showError(language === 'es' ? 'No se pudo preparar el PDF. Inténtalo de nuevo.' : 'Could not prepare the PDF. Please try again.');
  }
});

setScreen('empty');
