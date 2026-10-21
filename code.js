// Forte DS Check — main thread.
// Профили проектов, синхронизация источников (токены / стили / компоненты), проверка макета и автоисправления.

'use strict';

const STORAGE_KEY = 'forte-ds-check:v1';
const MAX_ISSUES = 3000;

const RULES = [
  { id: 'color.hardcoded', cat: 'color', sev: 'error', title: 'Цвет без токена', hint: 'Заливка или обводка задана HEX-значением, а не переменной из библиотеки токенов.' },
  { id: 'gradient.nostyle', cat: 'color', sev: 'warning', title: 'Градиент без стиля', hint: 'Градиенты берутся только из стилей библиотеки.' },
  { id: 'text.nostyle', cat: 'text', sev: 'error', title: 'Текст без стиля', hint: 'К тексту не применён текстовый стиль из библиотеки.' },
  { id: 'spacing.unbound', cat: 'layout', sev: 'warning', title: 'Отступ без переменной', hint: 'Padding или gap в auto layout задан числом, а не переменной.' },
  { id: 'radius.unbound', cat: 'layout', sev: 'warning', title: 'Радиус без переменной', hint: 'Скругление задано числом, а не переменной.' },
  { id: 'effect.nostyle', cat: 'effect', sev: 'warning', title: 'Эффект без стиля', hint: 'Тень или размытие заданы вручную, а не стилем эффекта.' },
  { id: 'token.foreign', cat: 'library', sev: 'error', title: 'Переменная из чужой библиотеки', hint: 'Переменная не входит в источники профиля. Часто это токены другой платформы или старой библиотеки.' },
  { id: 'style.foreign', cat: 'library', sev: 'error', title: 'Стиль из чужой библиотеки', hint: 'Стиль не входит в источники профиля или создан локально в файле.' },
  { id: 'token.scope', cat: 'library', sev: 'warning', title: 'Переменная не по назначению', hint: 'Скоуп переменной не разрешает это свойство. Например, отступ использован как радиус.' },
  { id: 'library.outdated', cat: 'library', sev: 'info', title: 'Устаревшая версия библиотеки', hint: 'Такой переменной нет в последней синхронизации источника. Обновите библиотеку в файле.' },
  { id: 'component.broken', cat: 'component', sev: 'error', title: 'Сломанный компонент', hint: 'Главный компонент удалён из файла (в Figma справа «Restore component»). Замените на рабочий компонент — плагин ищет похожий по имени в файле и в ДС — или создайте новый.' },
  { id: 'component.foreign', cat: 'component', sev: 'error', title: 'Компонент не из ДС', hint: 'Инстанс компонента из библиотеки, которой нет в профиле.' },
  { id: 'component.local', cat: 'component', sev: 'warning', title: 'Локальный компонент', hint: 'Компонент создан в этом файле, а не взят из ДС.' },
  { id: 'component.detached', cat: 'component', sev: 'warning', title: 'Отвязанный компонент', hint: 'Фрейм был инстансом компонента и его отвязали (detach).' },
  { id: 'slot.limits', cat: 'component', sev: 'warning', title: 'Нарушены настройки слота', hint: 'Содержимое слота не соответствует настройкам компонента: количество элементов или неразрешённый компонент.' },
  { id: 'naming.default', cat: 'naming', sev: 'off', title: 'Слой с именем по умолчанию', hint: 'Frame 12, Group 3, Rectangle 5 и т.п. Проверяются только свои слои и содержимое слотов — слои внутри компонентов ДС не трогаем. По умолчанию выключено.' }
];

const CATS = [
  { id: 'color', title: 'Цвет' },
  { id: 'text', title: 'Текст' },
  { id: 'layout', title: 'Отступы' },
  { id: 'effect', title: 'Эффекты' },
  { id: 'library', title: 'Библиотеки' },
  { id: 'component', title: 'Компоненты' },
  { id: 'naming', title: 'Нейминг' }
];

figma.showUI(__html__, { width: 400, height: 680, themeColors: true });

let state = null;
let currentRun = null;
let syncCancelled = false;

// ---------- state ----------

function emptyState() {
  return { version: 1, activeProfileId: null, profiles: [], settings: { token: '' } };
}

async function loadState() {
  try {
    const s = await figma.clientStorage.getAsync(STORAGE_KEY);
    if (s && s.version === 1) {
      if (!s.settings) s.settings = { token: '' };
      if (!Array.isArray(s.profiles)) s.profiles = [];
      return s;
    }
  } catch (e) { /* пустое хранилище */ }
  return emptyState();
}

async function saveState() {
  await figma.clientStorage.setAsync(STORAGE_KEY, state);
}

function post(type, payload) {
  figma.ui.postMessage(Object.assign({ type: type }, payload || {}));
}

function fileInfo() {
  const sel = figma.currentPage.selection;
  return {
    name: figma.root.name,
    key: figma.fileKey || null,
    page: figma.currentPage.name,
    selection: sel.length,
    items: sel.slice(0, 4).map(function (n) {
      return { id: n.id, name: n.name, type: n.type, w: Math.round(n.width || 0), h: Math.round(n.height || 0) };
    })
  };
}

// Превью выделенного экрана, чтобы дизайнер видел, что именно уходит на проверку.
let thumbTimer = null;
function scheduleThumb() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(sendThumb, 200);
}
async function sendThumb() {
  const sel = figma.currentPage.selection;
  if (!sel.length || !('exportAsync' in sel[0])) return;
  const id = sel[0].id;
  try {
    const bytes = await sel[0].exportAsync({ format: 'PNG', constraint: { type: 'WIDTH', value: 160 } });
    const now = figma.currentPage.selection[0];
    if (now && now.id === id) post('thumb', { id: id, bytes: bytes });
  } catch (e) { /* превью необязательно */ }
}

function tick() {
  return new Promise(function (r) { setTimeout(r, 0); });
}

// ---------- helpers ----------

function hex2(n) {
  const s = Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16);
  return s.length === 1 ? '0' + s : s;
}

function colorHex(c, alpha) {
  const a = alpha === undefined ? (c.a === undefined ? 1 : c.a) : alpha;
  return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + (a < 0.999 ? hex2(a) : '');
}

function normValue(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') return val;
  if (typeof val === 'object' && 'r' in val) return colorHex(val);
  return null;
}

function globToRe(p) {
  const esc = p.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$');
}

function defaultRuleSev() {
  const out = {};
  RULES.forEach(function (r) { out[r.id] = r.sev; });
  return out;
}

const PROP_LABELS = {
  fills: 'Заливка', strokes: 'Обводка', effects: 'Эффект',
  itemSpacing: 'Gap', counterAxisSpacing: 'Gap строк',
  paddingLeft: 'Padding слева', paddingRight: 'Padding справа', paddingTop: 'Padding сверху', paddingBottom: 'Padding снизу',
  topLeftRadius: 'Радиус', topRightRadius: 'Радиус', bottomLeftRadius: 'Радиус', bottomRightRadius: 'Радиус', cornerRadius: 'Радиус',
  width: 'Ширина', height: 'Высота', minWidth: 'Мин. ширина', maxWidth: 'Макс. ширина', minHeight: 'Мин. высота', maxHeight: 'Макс. высота',
  strokeWeight: 'Толщина обводки', opacity: 'Прозрачность',
  fontSize: 'Размер шрифта', fontFamily: 'Шрифт', fontStyle: 'Начертание', fontWeight: 'Насыщенность', lineHeight: 'Межстрочный', letterSpacing: 'Трекинг',
  characters: 'Текст', visible: 'Видимость'
};

function propLabel(p) { return PROP_LABELS[p] || p; }

const PROP_SCOPES = {
  itemSpacing: ['GAP'], counterAxisSpacing: ['GAP'],
  paddingLeft: ['GAP'], paddingRight: ['GAP'], paddingTop: ['GAP'], paddingBottom: ['GAP'],
  topLeftRadius: ['CORNER_RADIUS'], topRightRadius: ['CORNER_RADIUS'], bottomLeftRadius: ['CORNER_RADIUS'], bottomRightRadius: ['CORNER_RADIUS'],
  width: ['WIDTH_HEIGHT'], height: ['WIDTH_HEIGHT'], minWidth: ['WIDTH_HEIGHT'], maxWidth: ['WIDTH_HEIGHT'], minHeight: ['WIDTH_HEIGHT'], maxHeight: ['WIDTH_HEIGHT'],
  strokeWeight: ['STROKE_FLOAT'], strokeTopWeight: ['STROKE_FLOAT'], strokeBottomWeight: ['STROKE_FLOAT'], strokeLeftWeight: ['STROKE_FLOAT'], strokeRightWeight: ['STROKE_FLOAT'],
  opacity: ['OPACITY'],
  fontSize: ['FONT_SIZE'], fontFamily: ['FONT_FAMILY'], fontStyle: ['FONT_STYLE'], fontWeight: ['FONT_WEIGHT'],
  lineHeight: ['LINE_HEIGHT'], letterSpacing: ['LETTER_SPACING'], paragraphSpacing: ['PARAGRAPH_SPACING'], paragraphIndent: ['PARAGRAPH_INDENT'],
  characters: ['TEXT_CONTENT'], strokes: ['STROKE_COLOR']
};

const FIXABLE_FLOAT = {
  itemSpacing: 1, counterAxisSpacing: 1, paddingLeft: 1, paddingRight: 1, paddingTop: 1, paddingBottom: 1,
  topLeftRadius: 1, topRightRadius: 1, bottomLeftRadius: 1, bottomRightRadius: 1,
  width: 1, height: 1, minWidth: 1, maxWidth: 1, minHeight: 1, maxHeight: 1, strokeWeight: 1, opacity: 1
};

const CORNERS = ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'];
const RADIUS_FIELDS = { cornerRadius: 1, topLeftRadius: 1, topRightRadius: 1, bottomLeftRadius: 1, bottomRightRadius: 1 };
const TEXT_FIELDS = { textStyleId: 1, fontSize: 1, fontName: 1, lineHeight: 1, letterSpacing: 1, styledTextSegments: 1 };
const TYPO_FIELDS = { fontSize: 1, fontFamily: 1, fontStyle: 1, fontWeight: 1, lineHeight: 1, letterSpacing: 1, paragraphSpacing: 1, paragraphIndent: 1 };

// Имена, которые Figma ставит сама: «Frame 2087330847», «Group 3», «Rectangle», «Auto layout» и т.д.
const DEFAULT_NAME_RE = /^(frame|group|rectangle|ellipse|vector|line|arrow|polygon|star|text|image|union|subtract|intersect|exclude|section|slice|component|instance|auto layout|container)( \d+)?$/i;

function fillScopes(node) {
  if (node.type === 'TEXT') return ['TEXT_FILL', 'ALL_FILLS'];
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE' || node.type === 'SLOT') return ['FRAME_FILL', 'ALL_FILLS'];
  return ['SHAPE_FILL', 'ALL_FILLS'];
}

function scopesFor(node, prop) {
  if (prop === 'fills') return fillScopes(node);
  return PROP_SCOPES[prop] || null;
}

function scopeOk(varScopes, need) {
  if (!varScopes || !need || !varScopes.length) return true;
  if (varScopes.indexOf('ALL_SCOPES') >= 0) return true;
  if (need.indexOf('ALL_FILLS') >= 0 && varScopes.indexOf('ALL_FILLS') >= 0) return true;
  for (let i = 0; i < need.length; i++) if (varScopes.indexOf(need[i]) >= 0) return true;
  return false;
}

// ---------- синхронизация текущего файла как источника ----------

async function collectCurrentFile() {
  syncCancelled = false;
  post('sync-progress', { text: 'Читаю переменные' });

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const vars = await figma.variables.getLocalVariablesAsync();
  const varById = {};
  vars.forEach(function (v) { varById[v.id] = v; });
  const collById = {};
  collections.forEach(function (c) { collById[c.id] = c; });

  function resolve(v, modeId, depth) {
    if (depth > 8) return null;
    const coll = collById[v.variableCollectionId];
    let val = v.valuesByMode[modeId];
    if (val === undefined && coll) val = v.valuesByMode[coll.defaultModeId];
    if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
      const t = varById[val.id];
      if (!t) return null;
      const tc = collById[t.variableCollectionId];
      const tm = t.valuesByMode[modeId] !== undefined ? modeId : (tc ? tc.defaultModeId : modeId);
      return resolve(t, tm, depth + 1);
    }
    return normValue(val);
  }

  const outColl = collections.map(function (c) {
    return { key: c.key, name: c.name, modes: c.modes.map(function (m) { return m.name; }) };
  });
  const outVars = [];
  vars.forEach(function (v) {
    const c = collById[v.variableCollectionId];
    if (!c) return;
    outVars.push({
      key: v.key, name: v.name, collectionKey: c.key, type: v.resolvedType,
      scopes: v.scopes ? v.scopes.slice() : [], hidden: !!v.hiddenFromPublishing,
      value: resolve(v, c.defaultModeId, 0)
    });
  });

  post('sync-progress', { text: 'Читаю стили' });
  const styles = [];
  const groups = [
    ['PAINT', await figma.getLocalPaintStylesAsync()],
    ['TEXT', await figma.getLocalTextStylesAsync()],
    ['EFFECT', await figma.getLocalEffectStylesAsync()],
    ['GRID', await figma.getLocalGridStylesAsync()]
  ];
  groups.forEach(function (g) {
    g[1].forEach(function (s) {
      const st = { key: s.key, name: s.name, type: g[0] };
      // Для подбора стиля к тексту без стиля: шрифт, насыщенность, размер.
      if (g[0] === 'TEXT') { st.family = s.fontName.family; st.weight = weightOf(s.fontName.style); st.size = s.fontSize; }
      styles.push(st);
    });
  });

  // Страницы грузим по одной: в больших файлах загрузка всех сразу занимает минуты.
  const pages = figma.root.children;
  const components = [];
  for (let i = 0; i < pages.length; i++) {
    if (syncCancelled) return null;
    post('sync-progress', { text: 'Компоненты: стр. ' + (i + 1) + ' из ' + pages.length });
    await pages[i].loadAsync();
    const comps = pages[i].findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] });
    comps.forEach(function (n) {
      if (n.type === 'COMPONENT' && n.parent && n.parent.type === 'COMPONENT_SET') return;
      components.push({ key: n.key, name: n.name, set: n.type === 'COMPONENT_SET' });
    });
    await tick();
  }

  return {
    name: figma.root.name,
    fileKey: figma.fileKey || null,
    via: 'file',
    syncedAt: Date.now(),
    collections: outColl,
    variables: outVars,
    styles: styles,
    components: components
  };
}

// ---------- проверка ----------

function buildAllowed(profile) {
  const a = {
    collections: {}, vars: {}, styles: {}, components: {}, hasVars: {},
    hasComponents: false, floatVars: [], colorVars: [], textStyles: [], textStylesNoDetails: false, ignore: [],
    rules: Object.assign(defaultRuleSev(), profile.rules || {})
  };
  (profile.sources || []).forEach(function (s) {
    (s.collections || []).forEach(function (c) { a.collections[c.key] = { name: c.name, source: s.name, modes: c.modes }; });
    (s.variables || []).forEach(function (v) {
      a.vars[v.key] = v;
      a.hasVars[v.collectionKey] = true;
      if (v.hidden) return;
      if (v.type === 'FLOAT' && typeof v.value === 'number') a.floatVars.push(v);
      if (v.type === 'COLOR' && typeof v.value === 'string') a.colorVars.push(v);
    });
    (s.styles || []).forEach(function (st) {
      a.styles[st.key] = st;
      if (st.type !== 'TEXT') return;
      if (typeof st.size === 'number' && st.weight) a.textStyles.push(st);
      else a.textStylesNoDetails = true;
    });
    (s.components || []).forEach(function (c) { a.components[c.key] = Object.assign({ source: s.name }, c); a.hasComponents = true; });
  });
  a.ignore = (profile.ignore || []).map(function (p) { return String(p).trim(); }).filter(Boolean).map(globToRe);
  return a;
}

function isIgnored(a, name) {
  const n = String(name || '').trim().toLowerCase();
  for (let i = 0; i < a.ignore.length; i++) if (a.ignore[i].test(n)) return true;
  return false;
}

// Пул переменных под свойство: сначала те, у кого в скоупе явно есть нужное свойство
// (Space/* для gap, Radius/* для радиуса, Border/* для обводки). Переменные с ALL_SCOPES
// (например Font/Size/*) берём, только если специальных нет совсем — иначе отступ привязался бы к размеру шрифта.
function explicitScope(v, need) {
  const sc = v.scopes || [];
  for (let i = 0; i < need.length; i++) if (sc.indexOf(need[i]) >= 0) return true;
  return false;
}
function poolFor(list, need) {
  const ex = list.filter(function (v) { return explicitScope(v, need); });
  return ex.length ? ex : list.filter(function (v) { return scopeOk(v.scopes, need); });
}

// При равных кандидатах первым ставим тот, чьё имя соответствует свойству.
const NAME_HINTS = {
  GAP: /^space\//i, CORNER_RADIUS: /^radius\//i, TEXT_FILL: /^text\//i,
  STROKE_COLOR: /^border\//i, FRAME_FILL: /^background\//i, SHAPE_FILL: /^(icon|elements)\//i
};
function rankByHint(list, need) {
  const re = NAME_HINTS[need[0]];
  if (!re) return list;
  return list.slice().sort(function (x, y) { return (re.test(y.name) ? 1 : 0) - (re.test(x.name) ? 1 : 0); });
}

// Подбор переменной для числа: точное совпадение, иначе ближайшее значение не дальше SNAP_MAX px (17 → 16).
// 0 и «круглые» 999 в ближайшие не берём. vars отсортированы — первая и есть исправление.
const SNAP_MAX = 4;
function snapFloat(a, need, value) {
  const pool = poolFor(a.floatVars, need);
  const exact = pool.filter(function (v) { return v.value === value; });
  if (exact.length) return { vars: rankByHint(exact, need), exact: true };
  let best = null;
  pool.forEach(function (v) {
    if (v.value <= 0 || v.value >= 999) return;
    const d = Math.abs(v.value - value);
    if (!best || d < best.d || (d === best.d && v.value < best.v)) best = { d: d, v: v.value };
  });
  if (!best || best.d > SNAP_MAX) return { vars: [], exact: false };
  return { vars: rankByHint(pool.filter(function (v) { return v.value === best.v; }), need), exact: false };
}

// Цвет: точное совпадение среди «своих» по скоупу, затем среди ALL_SCOPES, затем ближайший оттенок
// не дальше COLOR_SNAP по любому каналу (0–255).
const COLOR_SNAP = 12;
function rgba(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4, 6].map(function (i) { return i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255; });
}
function colorDist(h1, h2) {
  const a1 = rgba(h1), a2 = rgba(h2);
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.abs(a1[i] - a2[i]));
  return m;
}
function snapColor(a, need, hex) {
  const h = hex.toLowerCase();
  const explicit = a.colorVars.filter(function (v) { return explicitScope(v, need); });
  let vars = explicit.filter(function (v) { return v.value.toLowerCase() === h; });
  if (!vars.length) vars = a.colorVars.filter(function (v) { return !explicitScope(v, need) && scopeOk(v.scopes, need) && v.value.toLowerCase() === h; });
  if (vars.length) return { vars: rankByHint(vars, need), exact: true };
  const pool = explicit.length ? explicit : a.colorVars.filter(function (v) { return scopeOk(v.scopes, need); });
  let best = null;
  pool.forEach(function (v) {
    const d = colorDist(h, v.value.toLowerCase());
    if (!best || d < best.d) best = { d: d, value: v.value.toLowerCase() };
  });
  if (!best || best.d > COLOR_SNAP) return { vars: [], exact: false };
  return { vars: rankByHint(pool.filter(function (v) { return v.value.toLowerCase() === best.value; }), need), exact: false };
}
function colorFix(snap, target, index) {
  if (!snap.vars.length) return { suggest: [], fix: null };
  const opts = snap.vars.slice(0, 6).map(function (v) { return { key: v.key, name: v.name }; });
  return {
    suggest: [opts[0].name + (snap.exact ? '' : ' (' + snap.vars[0].value.toUpperCase() + ')')],
    fix: { kind: 'paint', target: target, index: index, key: opts[0].key, name: opts[0].name, approx: !snap.exact, options: opts.length > 1 ? opts : null }
  };
}

function snapLabel(value, snap) {
  if (!snap.vars.length) return '';
  return snap.exact ? snap.vars[0].name : snap.vars[0].name + ' (' + value + ' → ' + snap.vars[0].value + ')';
}

const WEIGHTS = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400,
  medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900
};
function weightOf(style) {
  const k = String(style || '').toLowerCase().replace(/italic|oblique/g, '').replace(/[\s_-]/g, '');
  return WEIGHTS[k] || 400;
}

// Подбор текстового стиля ДС по насыщенности и размеру шрифта (Regular 14 → Caption2).
// Точный размер, иначе ближайший в пределах 2 px. Возвращает { style, exact } или { many } или null.
function textStyleFor(a, node) {
  if (!a.textStyles.length || node.fontName === figma.mixed || node.fontSize === figma.mixed) return null;
  const w = weightOf(node.fontName.style), size = node.fontSize, fam = node.fontName.family;
  // Оценка похожести: разница в размере + насыщенность (на ступень 100 → 1,5) + чуть-чуть за другой шрифт.
  // Так шрифт чужой ДС (Inter Medium 15) находит ближайший наш стиль (Open Sans SemiBold 14).
  const scored = [];
  a.textStyles.forEach(function (st) {
    const ds = Math.abs(st.size - size), dw = Math.abs(st.weight - w) / 100;
    if (ds > 4 || dw > 2) return;
    scored.push({ st: st, sc: ds + dw * 1.5 + (st.family === fam ? 0 : 0.25) });
  });
  if (!scored.length) return null;
  scored.sort(function (x, y) { return x.sc - y.sc || y.st.weight - x.st.weight || y.st.size - x.st.size; });
  const exact = scored[0].sc === 0 && (scored.length === 1 || scored[1].sc > 0);
  return { styles: exact ? [scored[0].st] : scored.slice(0, 4).map(function (x) { return x.st; }), exact: scored[0].sc === 0 };
}

const WEIGHT_NAMES = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

function textFix(a, node) {
  const m = textStyleFor(a, node);
  if (!m) return { suggest: [], fix: null };
  const st = m.styles[0];
  const label = st.name + (m.exact ? '' : ' (' + st.family + ' ' + (WEIGHT_NAMES[st.weight] || st.weight) + ' ' + st.size + ')');
  const opts = m.styles.length > 1 ? m.styles.map(function (x) {
    return { key: x.key, name: x.name + ' · ' + (WEIGHT_NAMES[x.weight] || x.weight) + ' ' + x.size };
  }) : null;
  return { suggest: [label], fix: { kind: 'textStyle', key: st.key, name: st.name, approx: !m.exact, options: opts } };
}

function pathOf(node) {
  const names = [];
  let c = node.parent;
  while (c && c.type !== 'PAGE' && c.type !== 'DOCUMENT') {
    if (c.type !== 'SECTION') names.unshift(c.name);
    c = c.parent;
  }
  if (names.length <= 3) return names.join(' / ');
  return names[0] + ' / … / ' + names.slice(-2).join(' / ');
}

const OWN = { kind: 'own', fields: null, has: function () { return true; } };
function slotCtx() { return { kind: 'slot', fields: null, has: function () { return true; } }; }
function overrideCtx(fields) {
  return { kind: 'override', fields: fields, has: function (f) { return fields.indexOf(f) >= 0; } };
}

function overrideCovers(ctx, prop) {
  if (ctx.kind !== 'override') return true;
  if (RADIUS_FIELDS[prop]) return Object.keys(RADIUS_FIELDS).some(function (f) { return ctx.has(f); });
  if (PROP_SCOPES[prop] && PROP_SCOPES[prop][0].indexOf('FONT') === 0) return ctx.has(prop) || ctx.has('fontName') || ctx.has('styledTextSegments');
  return ctx.has(prop);
}

function addIssue(run, rule, node, ctx, extra) {
  const sev = run.a.rules[rule];
  if (!sev || sev === 'off') return;
  const dedupe = rule + '|' + node.id + '|' + (extra && extra.sub ? extra.sub : '');
  if (run.seen[dedupe]) return;
  run.seen[dedupe] = 1;
  if (run.issues.length >= MAX_ISSUES) { run.truncated = true; return; }
  const issue = {
    id: 'i' + run.issues.length,
    rule: rule,
    sev: sev,
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    path: pathOf(node),
    ctx: ctx.kind,
    prop: '', value: '', note: '', suggest: [], fix: null
  };
  Object.keys(extra || {}).forEach(function (k) { if (k !== 'sub') issue[k] = extra[k]; });
  run.issues.push(issue);
  return issue;
}

async function varInfo(run, id) {
  if (run.varCache[id] !== undefined) return run.varCache[id];
  let info = null;
  try {
    const v = await figma.variables.getVariableByIdAsync(id);
    if (v) {
      const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
      info = {
        key: v.key, name: v.name, scopes: v.scopes, type: v.resolvedType, remote: v.remote,
        collKey: c ? c.key : null, collName: c ? c.name : '—'
      };
    }
  } catch (e) { info = null; }
  run.varCache[id] = info;
  return info;
}

async function styleInfo(run, id) {
  if (run.styleCache[id] !== undefined) return run.styleCache[id];
  let info = null;
  try {
    const s = await figma.getStyleByIdAsync(id);
    if (s) info = { key: s.key, name: s.name, remote: s.remote, type: s.type };
  } catch (e) { info = null; }
  run.styleCache[id] = info;
  return info;
}

async function checkStyle(run, node, styleId, ctx, prop) {
  const info = await styleInfo(run, styleId);
  if (!info) return;
  if (run.a.styles[info.key]) return;
  const f = prop === 'text' && node.type === 'TEXT' && node.textStyleId !== figma.mixed ? textFix(run.a, node) : { suggest: [], fix: null };
  addIssue(run, 'style.foreign', node, ctx, {
    sub: 'style-' + prop + '-' + info.key,
    prop: propLabel(prop) === prop ? 'Стиль' : propLabel(prop),
    value: info.name,
    note: info.remote ? 'внешняя библиотека' : 'локальный стиль файла',
    suggest: f.suggest, fix: f.fix
  });
}

function bindingsOf(node) {
  const list = [];
  const bv = node.boundVariables || {};
  Object.keys(bv).forEach(function (prop) {
    if (prop === 'fills' || prop === 'strokes' || prop === 'effects' || prop === 'componentProperties' || prop === 'layoutGrids') return;
    const b = bv[prop];
    const arr = Array.isArray(b) ? b : [b];
    arr.forEach(function (x) { if (x && x.id) list.push({ prop: prop, id: x.id }); });
  });
  ['fills', 'strokes'].forEach(function (t) {
    if (!(t in node)) return;
    const ps = node[t];
    if (!Array.isArray(ps)) return;
    ps.forEach(function (p, i) {
      if (p.boundVariables && p.boundVariables.color) list.push({ prop: t, id: p.boundVariables.color.id, index: i, paint: p });
    });
  });
  if ('effects' in node && Array.isArray(node.effects)) {
    node.effects.forEach(function (e) {
      if (!e.boundVariables) return;
      Object.keys(e.boundVariables).forEach(function (k) {
        const x = e.boundVariables[k];
        if (x && x.id) list.push({ prop: 'effects', id: x.id });
      });
    });
  }
  return list;
}

function foreignFix(a, node, b, info) {
  if (info.type === 'FLOAT' && FIXABLE_FLOAT[b.prop] && typeof node[b.prop] === 'number') {
    const snap = snapFloat(a, scopesFor(node, b.prop), node[b.prop]);
    const label = snapLabel(node[b.prop], snap);
    if (snap.vars.length) {
      const v = snap.vars[0];
      return { suggest: [label], fix: { kind: 'float', approx: !snap.exact, fields: [{ field: b.prop, key: v.key, name: v.name }] } };
    }
    return { suggest: [], fix: null };
  }
  if (info.type === 'COLOR' && b.paint && b.paint.type === 'SOLID') {
    const hex = colorHex(b.paint.color, b.paint.opacity === undefined ? 1 : b.paint.opacity);
    const need = b.prop === 'fills' ? fillScopes(node) : ['STROKE_COLOR'];
    return colorFix(snapColor(a, need, hex), b.prop, b.index);
  }
  return { suggest: [], fix: null };
}

async function checkBindings(run, node, ctx) {
  const a = run.a;
  const list = bindingsOf(node);
  // У текста со стилем привязки шрифта приходят из самого стиля — их проверяет style.foreign.
  const styledText = node.type === 'TEXT' && !!node.textStyleId;
  const foreignTypo = [];   // чужие переменные шрифта у текста без стиля — одно нарушение на слой
  const foreignTypoColl = [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (styledText && TYPO_FIELDS[b.prop]) continue;
    if (!overrideCovers(ctx, b.prop)) continue;
    const info = await varInfo(run, b.id);
    if (!info) continue;
    const sub = b.prop + (b.index !== undefined ? b.index : '') + info.key;
    if (!info.collKey || !a.collections[info.collKey]) {
      if (node.type === 'TEXT' && TYPO_FIELDS[b.prop]) {
        if (foreignTypo.indexOf(info.name) < 0) foreignTypo.push(info.name);
        if (foreignTypoColl.indexOf(info.collName) < 0) foreignTypoColl.push(info.collName);
        continue;
      }
      const f = foreignFix(a, node, b, info);
      addIssue(run, 'token.foreign', node, ctx, {
        sub: sub, prop: propLabel(b.prop), value: info.name, note: 'коллекция «' + info.collName + '»',
        suggest: f.suggest, fix: f.fix
      });
      continue;
    }
    if (a.hasVars[info.collKey] && !a.vars[info.key]) {
      addIssue(run, 'library.outdated', node, ctx, {
        sub: sub, prop: propLabel(b.prop), value: info.name, note: 'коллекция «' + a.collections[info.collKey].name + '»'
      });
    }
    const need = scopesFor(node, b.prop);
    const known = a.vars[info.key];
    const scopes = known && known.scopes && known.scopes.length ? known.scopes : info.scopes;
    if (need && !scopeOk(scopes, need)) {
      addIssue(run, 'token.scope', node, ctx, {
        sub: 'scope' + sub, prop: propLabel(b.prop), value: info.name, note: 'скоуп не включает это свойство'
      });
    }
  }
  if (foreignTypo.length) {
    const f = textFix(a, node);
    addIssue(run, 'token.foreign', node, ctx, {
      sub: 'typo', prop: 'Шрифт', value: foreignTypo.join(', '),
      note: 'коллекция «' + foreignTypoColl.join('», «') + '» · ' + fontDesc(node),
      suggest: f.suggest, fix: f.fix
    });
  }
}

function fontDesc(node) {
  const fn = node.fontName;
  const fs = node.fontSize;
  const f = fn === figma.mixed ? 'разные шрифты' : fn.family + ' ' + fn.style;
  const s = fs === figma.mixed ? '' : ' ' + fs;
  return f + s;
}

function effectLabel(e) {
  if (e.type === 'DROP_SHADOW') return 'тень';
  if (e.type === 'INNER_SHADOW') return 'внутренняя тень';
  if (e.type === 'LAYER_BLUR') return 'размытие';
  if (e.type === 'BACKGROUND_BLUR') return 'размытие фона';
  return e.type.toLowerCase();
}

function hasVisiblePaint(node) {
  const f = 'fills' in node && Array.isArray(node.fills) && node.fills.some(function (p) { return p.visible !== false; });
  const s = 'strokes' in node && Array.isArray(node.strokes) && node.strokes.some(function (p) { return p.visible !== false; });
  return f || s || node.clipsContent === true;
}

async function checkPaints(run, node, ctx) {
  const a = run.a;
  const targets = ['fills', 'strokes'];
  for (let t = 0; t < targets.length; t++) {
    const target = targets[t];
    if (!(target in node)) continue;
    const styleProp = target === 'fills' ? 'fillStyleId' : 'strokeStyleId';
    if (!ctx.has(target) && !ctx.has(styleProp)) continue;
    const paints = node[target];
    if (!Array.isArray(paints)) continue;
    const styleId = node[styleProp];
    if (typeof styleId === 'string' && styleId) {
      await checkStyle(run, node, styleId, ctx, target);
      continue;
    }
    paints.forEach(function (pt, i) {
      if (pt.visible === false) return;
      if (pt.type === 'SOLID') {
        if (pt.boundVariables && pt.boundVariables.color) return;
        const hex = colorHex(pt.color, pt.opacity === undefined ? 1 : pt.opacity);
        const need = target === 'fills' ? fillScopes(node) : ['STROKE_COLOR'];
        const f = colorFix(snapColor(a, need, hex), target, i);
        addIssue(run, 'color.hardcoded', node, ctx, {
          sub: target + i, prop: propLabel(target), value: hex.toUpperCase(), swatch: hex,
          suggest: f.suggest, fix: f.fix
        });
      } else if (pt.type.indexOf('GRADIENT') === 0) {
        addIssue(run, 'gradient.nostyle', node, ctx, { sub: target + i, prop: propLabel(target), value: 'градиент' });
      }
    });
  }
}

async function checkText(run, node, ctx) {
  if (node.type !== 'TEXT') return;
  if (ctx.kind === 'override' && !Object.keys(TEXT_FIELDS).some(function (f) { return ctx.has(f); })) return;
  const ts = node.textStyleId;
  if (ts === figma.mixed) {
    const segs = node.getStyledTextSegments(['textStyleId']);
    let missing = false;
    for (let i = 0; i < segs.length; i++) {
      if (!segs[i].textStyleId) missing = true;
      else await checkStyle(run, node, segs[i].textStyleId, ctx, 'text');
    }
    if (missing) addIssue(run, 'text.nostyle', node, ctx, { prop: 'Текст', value: 'часть текста без стиля' });
  } else if (!ts) {
    const f = textFix(run.a, node);
    addIssue(run, 'text.nostyle', node, ctx, { prop: 'Текст', value: fontDesc(node), suggest: f.suggest, fix: f.fix });
  } else {
    await checkStyle(run, node, ts, ctx, 'text');
  }
}

async function checkEffects(run, node, ctx) {
  if (!('effects' in node) || !Array.isArray(node.effects)) return;
  if (!ctx.has('effects') && !ctx.has('effectStyleId')) return;
  const es = node.effectStyleId;
  if (typeof es === 'string' && es) { await checkStyle(run, node, es, ctx, 'effects'); return; }
  const vis = node.effects.filter(function (e) { return e.visible !== false; });
  if (!vis.length) return;
  const allBound = vis.every(function (e) { return e.boundVariables && Object.keys(e.boundVariables).length > 0; });
  if (allBound) return;
  addIssue(run, 'effect.nostyle', node, ctx, { prop: 'Эффект', value: vis.map(effectLabel).join(', ') });
}

function checkSpacing(run, node, ctx) {
  if (!('layoutMode' in node) || (node.layoutMode !== 'HORIZONTAL' && node.layoutMode !== 'VERTICAL')) return;
  const a = run.a;
  const bv = node.boundVariables || {};
  const fields = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing'];
  if (node.layoutWrap === 'WRAP') fields.push('counterAxisSpacing');
  const visibleChildren = 'children' in node ? node.children.filter(function (c) { return c.visible !== false && c.layoutPositioning !== 'ABSOLUTE'; }).length : 0;
  const bad = [];
  fields.forEach(function (f) {
    if (!ctx.has(f)) return;
    const v = node[f];
    if (typeof v !== 'number' || v <= 0 || bv[f]) return;
    if ((f === 'itemSpacing' || f === 'counterAxisSpacing') && (node.primaryAxisAlignItems === 'SPACE_BETWEEN' || visibleChildren < 2)) return;
    bad.push({ field: f, value: v });
  });
  if (!bad.length) return;

  const fixFields = [];
  const suggest = [];
  let approx = false;
  bad.forEach(function (b) {
    const snap = snapFloat(a, ['GAP'], b.value);
    const label = snapLabel(b.value, snap);
    if (label && suggest.indexOf(label) < 0) suggest.push(label);
    if (snap.vars.length) {
      fixFields.push({ field: b.field, key: snap.vars[0].key, name: snap.vars[0].name });
      if (!snap.exact) approx = true;
    }
  });

  const pads = bad.filter(function (b) { return b.field.indexOf('padding') === 0; });
  const parts = [];
  if (pads.length) {
    const same = pads.every(function (p) { return p.value === pads[0].value; });
    parts.push('padding ' + (same ? pads[0].value : pads.map(function (p) { return p.value; }).join(' ')));
  }
  bad.forEach(function (b) { if (b.field === 'itemSpacing') parts.push('gap ' + b.value); if (b.field === 'counterAxisSpacing') parts.push('gap строк ' + b.value); });

  addIssue(run, 'spacing.unbound', node, ctx, {
    prop: 'Auto layout', value: parts.join(' · '), suggest: suggest,
    fix: fixFields.length ? { kind: 'float', fields: fixFields, partial: fixFields.length < bad.length, approx: approx } : null
  });
}

function checkRadius(run, node, ctx) {
  if (['FRAME', 'RECTANGLE', 'COMPONENT', 'INSTANCE', 'SLOT'].indexOf(node.type) < 0) return;
  if (!('topLeftRadius' in node)) return;
  if (ctx.kind === 'override' && !Object.keys(RADIUS_FIELDS).some(function (f) { return ctx.has(f); })) return;
  if (!hasVisiblePaint(node)) return;
  const a = run.a;
  const bv = node.boundVariables || {};
  const unbound = CORNERS.filter(function (c) { return (node[c] || 0) > 0 && !bv[c]; });
  if (!unbound.length) return;
  const vals = unbound.map(function (c) { return node[c]; });
  const uniform = vals.every(function (v) { return v === vals[0]; });
  const fixFields = [];
  const suggest = [];
  let approx = false;
  unbound.forEach(function (c) {
    const snap = snapFloat(a, ['CORNER_RADIUS'], node[c]);
    const label = snapLabel(node[c], snap);
    if (label && suggest.indexOf(label) < 0) suggest.push(label);
    if (snap.vars.length) {
      fixFields.push({ field: c, key: snap.vars[0].key, name: snap.vars[0].name });
      if (!snap.exact) approx = true;
    }
  });
  addIssue(run, 'radius.unbound', node, ctx, {
    prop: 'Радиус',
    value: uniform ? String(vals[0]) : CORNERS.map(function (c) { return node[c]; }).join(' '),
    suggest: suggest,
    fix: fixFields.length ? { kind: 'float', fields: fixFields, partial: fixFields.length < unbound.length, approx: approx } : null
  });
}

async function checkNode(run, node, ctx) {
  await checkBindings(run, node, ctx);
  await checkPaints(run, node, ctx);
  await checkText(run, node, ctx);
  await checkEffects(run, node, ctx);
  checkSpacing(run, node, ctx);
  checkRadius(run, node, ctx);
}

function reachesDocument(n) {
  let c = n;
  while (c) { if (c.type === 'DOCUMENT') return true; c = c.parent; }
  return false;
}

// ---------- замена сломанных компонентов ----------

function normName(s) { return String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').trim(); }
function nameScore(x, y) {
  const a = normName(x), b = normName(y);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 0.8;
  const ta = a.split(' '), tb = b.split(' ');
  const inter = ta.filter(function (t) { return tb.indexOf(t) >= 0; }).length;
  return inter / Math.max(ta.length, tb.length);
}
function idNum(id) { const p = String(id).split(':'); return (parseInt(p[0], 10) || 0) * 1e7 + (parseInt(p[1], 10) || 0); }

// Ищем рабочие компоненты с похожим именем: сначала в этом файле (по всем страницам), затем в библиотеках профиля.
// Свои локальные идут первыми — сломанный компонент был локальным, а у ДС может быть одноимённый, но другой.
async function findReplacements(run) {
  const local = [];
  const pages = figma.root.children;
  for (let i = 0; i < pages.length; i++) {
    if (run.cancelled) return;
    post('check-progress', { count: run.count, text: 'Ищу замену сломанным компонентам: стр. ' + (i + 1) + ' из ' + pages.length });
    await pages[i].loadAsync();
    pages[i].findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] }).forEach(function (n) {
      if (n.type === 'COMPONENT' && n.parent && n.parent.type === 'COMPONENT_SET') return;
      local.push({ ref: 'local:' + n.id, name: n.name, where: 'стр. «' + pages[i].name.trim() + '»', order: idNum(n.id), lib: false });
    });
    await tick();
  }
  const lib = Object.keys(run.a.components).map(function (k) {
    const c = run.a.components[k];
    return { ref: (c.set ? 'libset:' : 'lib:') + c.key, name: c.name, where: c.source || 'библиотека ДС', order: 0, lib: true };
  });
  const all = local.concat(lib);
  run.broken.forEach(function (issue) {
    const scored = all.map(function (c) { return { c: c, s: nameScore(issue.value, c.name) }; })
      .filter(function (x) { return x.s >= 0.6; });
    scored.sort(function (x, y) { return y.s - x.s || (x.c.lib ? 1 : 0) - (y.c.lib ? 1 : 0) || y.c.order - x.c.order; });
    const opts = scored.slice(0, 6).map(function (x) { return { key: x.c.ref, name: x.c.name + ' — ' + x.c.where }; });
    if (opts.length) {
      issue.fix = { kind: 'swap', key: opts[0].key, name: opts[0].name, options: opts.length > 1 ? opts : null, variant: issue.variant };
      issue.suggest = [opts[0].name];
    } else {
      issue.note += ' · похожих компонентов нет — создайте новый';
    }
  });
}

async function checkInstance(run, node, ctx) {
  const a = run.a;
  let mc = null;
  try { mc = await node.getMainComponentAsync(); } catch (e) { mc = null; }
  if (!mc) return;
  const set = mc.parent && mc.parent.type === 'COMPONENT_SET' ? mc.parent : null;
  const key = set ? set.key : mc.key;
  const name = set ? set.name : mc.name;
  // Главный компонент удалён из файла: у локального компонента цепочка родителей не доходит до документа.
  if (!mc.remote && !reachesDocument(mc)) {
    const issue = addIssue(run, 'component.broken', node, ctx, {
      prop: 'Компонент', value: name, note: 'главный компонент удалён из файла', variant: set ? mc.name : ''
    });
    if (issue) run.broken.push(issue);
    return;
  }
  if (isIgnored(a, name) || isIgnored(a, node.name)) return;
  if (a.components[key] || a.components[mc.key]) return;
  if (mc.remote) {
    if (a.hasComponents) addIssue(run, 'component.foreign', node, ctx, { prop: 'Компонент', value: name, note: 'библиотека не входит в профиль' });
  } else {
    addIssue(run, 'component.local', node, ctx, { prop: 'Компонент', value: name, note: 'создан в этом файле' });
  }
}

async function walk(run, node) {
  if (run.cancelled) return;
  if (node.visible === false) return;
  run.count++;
  if (run.count % 120 === 0) {
    post('check-progress', { count: run.count });
    await tick();
  }

  if (node.type === 'INSTANCE') {
    run.instances++;
    await checkInstance(run, node, run.scopeCtx || OWN);

    // Overrides: дизайнер поменял что-то внутри инстанса.
    const ovs = node.overrides || [];
    for (let i = 0; i < ovs.length; i++) {
      const ov = ovs[i];
      let target = ov.id === node.id ? node : null;
      if (!target) {
        try { target = await figma.getNodeByIdAsync(ov.id); } catch (e) { target = null; }
      }
      if (!target || target.visible === false || target.type === 'SLOT') continue;
      run.overrides++;
      await checkNode(run, target, overrideCtx(ov.overriddenFields || []));
    }

    // Слоты: содержимое кладёт дизайнер, поэтому проверяем его как обычный макет.
    let slots = [];
    try { slots = node.findAllWithCriteria({ types: ['SLOT'] }); } catch (e) { slots = []; }
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot.visible === false) continue;
      run.slots++;
      if (slot.limitViolations && slot.limitViolations.length) {
        const map = { BELOW_MIN: 'меньше минимума элементов', ABOVE_MAX: 'больше максимума элементов', HAS_NON_PREFERRED: 'неразрешённый компонент' };
        addIssue(run, 'slot.limits', slot, slotCtx(), {
          prop: 'Слот', value: slot.limitViolations.map(function (v) { return map[v] || v; }).join(', ')
        });
      }
      const prev = run.scopeCtx;
      run.scopeCtx = slotCtx();
      for (let j = 0; j < slot.children.length; j++) await walkWithCtx(run, slot.children[j], slotCtx());
      run.scopeCtx = prev;
    }
    return;
  }

  if (node.type === 'FRAME' && node.detachedInfo && !isIgnored(run.a, node.name)) {
    addIssue(run, 'component.detached', node, run.scopeCtx || OWN, {
      prop: 'Источник', value: node.detachedInfo.type === 'library' ? 'компонент из библиотеки' : 'локальный компонент'
    });
  }

  if (run.a.rules['naming.default'] !== 'off' && DEFAULT_NAME_RE.test(node.name.trim()) && !isIgnored(run.a, node.name)) {
    addIssue(run, 'naming.default', node, run.scopeCtx || OWN, { prop: 'Имя', value: node.name, note: node.type.toLowerCase() });
  }

  if (node.type !== 'COMPONENT_SET' && node.type !== 'SECTION' && node.type !== 'GROUP') {
    await checkNode(run, node, run.scopeCtx || OWN);
  }
  if ('children' in node) {
    const kids = node.children;
    for (let i = 0; i < kids.length; i++) await walk(run, kids[i]);
  }
}

async function walkWithCtx(run, node, ctx) {
  const prev = run.scopeCtx;
  run.scopeCtx = ctx;
  await walk(run, node);
  run.scopeCtx = prev;
}

async function runCheck(profileId) {
  const profile = state.profiles.find(function (p) { return p.id === profileId; });
  if (!profile) { post('check-error', { message: 'Профиль не найден' }); return; }
  if (!profile.sources || !profile.sources.length) { post('check-error', { message: 'В профиле нет источников. Добавьте файл токенов и файл ДС.' }); return; }

  const sel = figma.currentPage.selection;
  if (!sel.length) { post('check-error', { message: 'Выделите экран на холсте' }); return; }
  const roots = sel.slice();
  const run = {
    a: buildAllowed(profile), issues: [], seen: {}, varCache: {}, styleCache: {},
    count: 0, instances: 0, overrides: 0, slots: 0, truncated: false, cancelled: false, scopeCtx: null, broken: []
  };
  currentRun = run;
  const t0 = Date.now();
  post('check-progress', { count: 0 });
  for (let i = 0; i < roots.length; i++) {
    await walk(run, roots[i]);
    if (run.cancelled) break;
  }
  if (run.broken.length && !run.cancelled) await findReplacements(run);
  currentRun = null;
  post('check-done', {
    result: {
      profileId: profile.id,
      scopeLabel: sel.length === 1 ? sel[0].name : sel[0].name + ' и ещё ' + (sel.length - 1),
      count: run.count, instances: run.instances, overrides: run.overrides, slots: run.slots,
      ms: Date.now() - t0, truncated: run.truncated, cancelled: run.cancelled,
      hasComponents: run.a.hasComponents,
      textStylesNoDetails: run.a.textStylesNoDetails && !run.a.textStyles.length,
      issues: run.issues
    }
  });
}

// ---------- исправления ----------

async function findVariableByKey(cache, key) {
  if (cache[key]) return cache[key];
  let v = null;
  try { v = await figma.variables.importVariableByKeyAsync(key); } catch (e) { v = null; }
  if (!v) {
    const locals = await figma.variables.getLocalVariablesAsync();
    v = locals.find(function (x) { return x.key === key; }) || null;
  }
  if (v) cache[key] = v;
  return v;
}

async function findTextStyleByKey(cache, key) {
  const ck = 'style:' + key;
  if (cache[ck]) return cache[ck];
  let st = null;
  try { st = await figma.importStyleByKeyAsync(key); } catch (e) { st = null; }
  if (!st) {
    const locals = await figma.getLocalTextStylesAsync();
    st = locals.find(function (x) { return x.key === key; }) || null;
  }
  if (st) cache[ck] = st;
  return st;
}

async function loadNodeFonts(node) {
  const fonts = node.fontName === figma.mixed ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName];
  for (let k = 0; k < fonts.length; k++) await figma.loadFontAsync(fonts[k]);
}

function parseVariant(name) {
  const o = {};
  String(name || '').split(',').forEach(function (p) {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().toLowerCase();
  });
  return o;
}

async function resolveComponent(ref) {
  const i = ref.indexOf(':');
  const kind = ref.slice(0, i), id = ref.slice(i + 1);
  if (kind === 'local') {
    const n = await figma.getNodeByIdAsync(id);
    let p = n; while (p && p.type !== 'PAGE') p = p.parent;
    if (p) await p.loadAsync();
    return n;
  }
  if (kind === 'libset') return figma.importComponentSetByKeyAsync(id);
  return figma.importComponentByKeyAsync(id);
}

// Для набора вариантов берём тот же вариант, что был у сломанного (Редактировать=Off, Заполнено=-),
// иначе вариант с наибольшим числом совпавших свойств, иначе вариант по умолчанию.
function pickVariant(target, variantName) {
  if (!target) throw new Error('компонент для замены не найден');
  if (target.type === 'COMPONENT') return target;
  if (target.type !== 'COMPONENT_SET') throw new Error('это не компонент');
  const kids = target.children.filter(function (c) { return c.type === 'COMPONENT'; });
  const same = kids.find(function (c) { return c.name === variantName; });
  if (same) return same;
  const want = parseVariant(variantName);
  let best = null, bs = 0;
  kids.forEach(function (c) {
    const have = parseVariant(c.name);
    let sc = 0;
    Object.keys(want).forEach(function (k) { if (have[k] === want[k]) sc++; });
    if (sc > bs) { bs = sc; best = c; }
  });
  return best || target.defaultVariant || kids[0];
}

async function applyFixes(issues) {
  const cache = {};
  const fixed = [];
  const failed = [];
  for (let i = 0; i < issues.length; i++) {
    const it = issues[i];
    try {
      const node = await figma.getNodeByIdAsync(it.nodeId);
      if (!node) throw new Error('слой не найден');
      const fix = it.fix;
      if (fix.kind === 'float') {
        for (let j = 0; j < fix.fields.length; j++) {
          const f = fix.fields[j];
          const v = await findVariableByKey(cache, f.key);
          if (!v) throw new Error('переменная ' + f.name + ' недоступна');
          node.setBoundVariable(f.field, v);
        }
      } else if (fix.kind === 'swap') {
        if (node.type !== 'INSTANCE') throw new Error('слой не инстанс');
        const comp = pickVariant(await resolveComponent(fix.key), fix.variant);
        node.swapComponent(comp);
      } else if (fix.kind === 'textStyle') {
        if (node.type !== 'TEXT') throw new Error('слой не текстовый');
        const st = await findTextStyleByKey(cache, fix.key);
        if (!st) throw new Error('стиль ' + fix.name + ' недоступен');
        await loadNodeFonts(node);
        await figma.loadFontAsync(st.fontName);
        await node.setTextStyleIdAsync(st.id);
      } else if (fix.kind === 'paint') {
        if (node.type === 'TEXT') await loadNodeFonts(node);
        const v = await findVariableByKey(cache, fix.key);
        if (!v) throw new Error('переменная ' + fix.name + ' недоступна');
        const paints = node[fix.target].slice();
        paints[fix.index] = figma.variables.setBoundVariableForPaint(paints[fix.index], 'color', v);
        node[fix.target] = paints;
      }
      fixed.push(it.id);
    } catch (e) {
      failed.push({ id: it.id, reason: e && e.message ? e.message : String(e) });
    }
    if (i % 40 === 39) await tick();
  }
  post('fix-done', { fixed: fixed, failed: failed });
}

// ---------- выделение ----------

async function selectNode(id) {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') { post('toast', { text: 'Слой не найден — возможно, его удалили' }); return; }
  let page = node.parent;
  while (page && page.type !== 'PAGE') page = page.parent;
  if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}

// ---------- сообщения ----------

figma.on('selectionchange', function () { post('file', { file: fileInfo() }); scheduleThumb(); });
figma.on('currentpagechange', function () { post('file', { file: fileInfo() }); scheduleThumb(); });

figma.ui.onmessage = async function (msg) {
  try {
    if (msg.type === 'init') {
      state = await loadState();
      post('init', { state: state, rules: RULES, cats: CATS, file: fileInfo() });
      scheduleThumb();
    } else if (msg.type === 'save-state') {
      state = msg.state;
      await saveState();
    } else if (msg.type === 'sync-file') {
      const source = await collectCurrentFile();
      if (source) post('sync-done', { profileId: msg.profileId, source: source });
      else post('sync-cancelled');
    } else if (msg.type === 'cancel-sync') {
      syncCancelled = true;
    } else if (msg.type === 'check') {
      await runCheck(msg.profileId);
    } else if (msg.type === 'cancel') {
      if (currentRun) currentRun.cancelled = true;
    } else if (msg.type === 'select') {
      await selectNode(msg.nodeId);
    } else if (msg.type === 'fix') {
      await applyFixes(msg.issues);
    } else if (msg.type === 'resize') {
      figma.ui.resize(400, Math.max(480, Math.min(900, msg.height)));
    } else if (msg.type === 'close') {
      figma.closePlugin();
    }
  } catch (e) {
    post('error', { message: e && e.message ? e.message : String(e), during: msg.type });
  }
};
