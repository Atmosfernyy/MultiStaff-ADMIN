const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieSession = require('cookie-session');
const admin = require('firebase-admin');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PROJECTS = [
  { key: 'atmosfera', label: 'Atmosfera', env: 'FIREBASE_SERVICE_ACCOUNT_JSON' },
  { key: 'karavan', label: 'Karavan', env: 'FIREBASE_KARAVAN_SERVICE_ACCOUNT_JSON' },
  { key: 'retroville', label: 'Retroville', env: 'FIREBASE_RETROVILLE_SERVICE_ACCOUNT_JSON' }
];
const allowedRoles = new Set((process.env.MANAGER_ALLOWED_ROLES || 'admin,manager')
  .split(',').map(role => role.trim().toLowerCase()).filter(Boolean));
const serviceApps = new Map();
const sessionSecret = process.env.SESSION_SECRET;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '64kb' }));
const apiRateLimit = rateLimit({
  windowMs: 60000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Забагато запитів. Зачекайте хвилину та спробуйте знову.' })
});
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Забагато спроб входу. Зачекайте до 15 хвилин перед наступною спробою.' })
});
app.use('/api/auth/login', loginRateLimit);
app.use('/api/developer/login', loginRateLimit);
app.use('/api', apiRateLimit);

if (sessionSecret) {
  app.use(cookieSession({
    name: 'multistaff_session', keys: [sessionSecret], httpOnly: true,
    secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000
  }));
}

function getFirestore(projectKey) {
  const project = PROJECTS.find(item => item.key === projectKey);
  if (!project) throw Object.assign(new Error('Невідомий кінотеатр.'), { status: 400 });
  const raw = process.env[project.env];
  if (!raw) throw Object.assign(new Error('Firebase для цього кінотеатру не налаштовано.'), { status: 503 });
  if (serviceApps.has(project.key)) return serviceApps.get(project.key).firestore();
  const serviceAccount = JSON.parse(raw);
  const appName = 'multistaff-admin-' + project.key;
  let firebaseApp;
  try { firebaseApp = admin.app(appName); }
  catch {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id
    }, appName);
  }
  serviceApps.set(project.key, firebaseApp);
  return firebaseApp.firestore();
}
function sessionCinema(req) {
  return req.session?.developerAuthenticated === true
    ? (req.session.activeCinema || req.session.cinema)
    : req.session?.cinema;
}
function requireSession(req, res, next) {
  if (req.session?.developerAuthenticated === true) {
    const cinema = sessionCinema(req);
    if (!PROJECTS.some(project => project.key === cinema)) return res.status(403).json({ error: 'Developer-сесія не має вибраного кінотеатру.' });
    return next();
  }
  if (!req.session?.userId || !req.session?.cinema) return res.status(401).json({ error: 'Потрібно увійти до системи.' });
  if (!allowedRoles.has(String(req.session.role || '').toLowerCase())) return res.status(403).json({ error: 'Недостатньо прав для цієї операції.' });
  next();
}
function dbForSession(req) { return getFirestore(sessionCinema(req)); }
function cleanText(value, max = 180) { return String(value ?? '').trim().slice(0, max); }
function safeId(value) {
  const id = cleanText(value, 128);
  if (!id || id.includes('/') || id === '.' || id === '..') throw Object.assign(new Error('Некоректний ID документа.'), { status: 400 });
  return id;
}
function numberValue(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw Object.assign(new Error('Некоректна кількість: ' + label), { status: 400 });
  return number;
}
function publicError(res, error) {
  console.error('Management API error:', error.message);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'Не вдалося виконати операцію. Перевірте логи сервера.' });
}
function toPlainDoc(doc) { return { ...doc.data(), id: doc.id }; }

app.get('/api/health', (_req, res) => {
  const configuredProjects = PROJECTS.filter(project => Boolean(process.env[project.env])).map(project => project.key);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true, service: 'multistaff-admin', sessionConfigured: Boolean(sessionSecret),
    configuredProjects,
    mode: configuredProjects.length === PROJECTS.length && sessionSecret ? 'firebase-configured' : 'setup-required'
  });
});

app.post('/api/auth/login', async (req, res) => {
  if (!sessionSecret) return res.status(503).json({ error: 'На сервері не налаштовано SESSION_SECRET.' });
  const userId = String(req.body?.id || '').trim();
  const password = String(req.body?.password ?? '');
  if (!/^[-a-zA-Z0-9_]{1,128}$/.test(userId) || !password || password.length > 256) {
    return res.status(400).json({ error: 'Введіть коректний ID та пароль.' });
  }
  const missingProjects = PROJECTS.filter(project => !process.env[project.env]);
  if (missingProjects.length) return res.status(503).json({ error: 'Не налаштовано Firebase для всіх кінотеатрів: ' + missingProjects.map(project => project.label).join(', ') + '.' });
  try {
    const matches = [];
    for (const project of PROJECTS) {
      const db = getFirestore(project.key);
      const snapshot = await db.collection('Cinema').doc(project.key).collection('Users').doc(userId).get();
      if (!snapshot.exists) continue;
      const user = snapshot.data() || {};
      if (String(user.password ?? '') !== password) continue;
      if (user.isBlocked === true) return res.status(403).json({ error: 'Обліковий запис заблоковано.' });
      const role = String(user.userRole || '').toLowerCase();
      if (!allowedRoles.has(role)) return res.status(403).json({ error: 'Роль цього облікового запису не має доступу до вебпанелі.' });
      matches.push({ project, user, role });
    }
    if (!matches.length) return res.status(401).json({ error: 'Неправильний ID або пароль.' });
    if (matches.length > 1) return res.status(409).json({ error: 'Цей ID і пароль збігаються в кількох кінотеатрах. Зверніться до Developer.' });
    const match = matches[0];
    req.session = {
      userId, name: String(match.user.name || userId), role: match.role,
      cinema: match.project.key, cinemaLabel: match.project.label,
      telegramId: match.user.telegramId == null ? null : String(match.user.telegramId)
    };
    return res.json({ ok: true, user: { id: userId, name: req.session.name, role: match.role, cinema: match.project.key, cinemaLabel: match.project.label } });
  } catch (error) { return publicError(res, error); }
});
app.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId || !req.session?.cinema) return res.status(401).json({ authenticated: false });
  res.set('Cache-Control', 'no-store');
  res.json({ authenticated: true, user: { id: req.session.userId, name: req.session.name, role: req.session.role, cinema: req.session.cinema, cinemaLabel: req.session.cinemaLabel } });
});
app.post('/api/auth/logout', (req, res) => { if (req.session) req.session = null; res.json({ ok: true }); });

const DEVELOPER_FEATURES = {
  admin_panel: 'Адмін-панель',
  light_reminders: 'Нагадування про світло',
  orders: 'Замовлення',
  sessions: 'Сеанси',
  statistics: 'Статистика',
  work_schedule: 'Графік роботи',
  checklists: 'Чек-листи',
  writeoffs: 'Списання'
}
function requireDeveloper(req, res, next) {
  if (req.session?.developerAuthenticated !== true) return res.status(401).json({ error: 'Потрібна окрема Developer-авторизація.' });
  next();
}
app.post('/api/developer/login', (req, res) => {
  const login = process.env.DEVELOPER_LOGIN;
  const password = process.env.DEVELOPER_PASSWORD;
  if (!login || !password) return res.status(503).json({ error: 'Налаштуйте DEVELOPER_LOGIN та DEVELOPER_PASSWORD у змінних середовища сервера.' });
  const suppliedLogin = String(req.body?.login || '');
  const suppliedPassword = String(req.body?.password || '');
  if (suppliedLogin !== login || suppliedPassword !== password) return res.status(401).json({ error: 'Неправильний Developer-логін або пароль.' });
  req.session = { ...(req.session || {}), developerAuthenticated: true, developerName: login };
  res.json({ ok: true, developer: login });
});
app.get('/api/developer/me', (req, res) => {
  if (req.session?.developerAuthenticated !== true) return res.status(401).json({ authenticated: false });
  res.set('Cache-Control', 'no-store');
  const activeCinema = sessionCinema(req);
  res.json({
    authenticated: true,
    developer: req.session.developerName || 'Developer',
    activeCinema,
    projects: PROJECTS.map(project => ({ key: project.key, label: project.label, configured: Boolean(process.env[project.env]) }))
  });
});
app.post('/api/developer/switch-cinema', requireDeveloper, (req, res) => {
  const cinema = PROJECTS.find(project => project.key === String(req.body?.cinema || ''));
  if (!cinema) return res.status(400).json({ error: 'Невідомий кінотеатр.' });
  if (!process.env[cinema.env]) return res.status(503).json({ error: 'Firebase для цього кінотеатру не налаштовано.' });
  req.session = { ...(req.session || {}), activeCinema: cinema.key, activeCinemaLabel: cinema.label };
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, cinema: cinema.key, cinemaLabel: cinema.label });
});
app.post('/api/developer/logout', (req, res) => {
  if (req.session) {
    const nextSession = { ...req.session };
    delete nextSession.developerAuthenticated;
    delete nextSession.developerName;
    req.session = Object.keys(nextSession).length ? nextSession : null;
  }
  res.json({ ok: true });
});
app.get('/api/developer/features/:cinema', requireDeveloper, async (req, res) => {
  try {
    const cinema = PROJECTS.find(project => project.key === req.params.cinema);
    if (!cinema) throw Object.assign(new Error('Невідомий кінотеатр.'), { status: 400 });
    const db = getFirestore(cinema.key);
    const ref = db.collection('Cinema').doc(cinema.key).collection('BotConfig').doc('features');
    const snap = await ref.get();
    const stored = snap.exists ? (snap.data() || {}) : {};
    const features = {};
    for (const [key, label] of Object.entries(DEVELOPER_FEATURES)) {
      features[key] = { label, enabled: typeof stored[key] === 'boolean' ? stored[key] : true };
    }
    for (const [key, value] of Object.entries(stored)) {
      if (typeof value === 'boolean' && !(key in features) && /^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(key)) {
        features[key] = { label: key, enabled: value, custom: true };
      }
    }
    res.set('Cache-Control', 'no-store');
    res.json({ cinema: cinema.key, features, configured: snap.exists });
  } catch (error) { publicError(res, error); }
});
app.put('/api/developer/features/:cinema/:feature', requireDeveloper, async (req, res) => {
  try {
    const cinema = PROJECTS.find(project => project.key === req.params.cinema);
    if (!cinema) throw Object.assign(new Error('Невідомий кінотеатр.'), { status: 400 });
    const feature = safeId(req.params.feature);
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(feature)) throw Object.assign(new Error('Некоректна назва функції.'), { status: 400 });
    if (typeof req.body?.enabled !== 'boolean') throw Object.assign(new Error('Потрібно вказати стан функції.'), { status: 400 });
    const db = getFirestore(cinema.key);
    const ref = db.collection('Cinema').doc(cinema.key).collection('BotConfig').doc('features');
    await ref.set({
      [feature]: req.body.enabled,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: req.session.developerName || 'Developer'
    }, { merge: true });
    res.json({ ok: true, cinema: cinema.key, feature, enabled: req.body.enabled });
  } catch (error) { publicError(res, error); }
});

app.get('/api/developer/integrations/:cinema', requireDeveloper, async (req, res) => {
  try {
    const cinema = PROJECTS.find(project => project.key === req.params.cinema);
    if (!cinema) return res.status(400).json({ error: 'Невідомий кінотеатр.' });
    const db = getFirestore(cinema.key);
    const ref = db.collection('Cinema').doc(cinema.key).collection('BotConfig').doc('googleSheets');
    const snap = await ref.get();
    const stored = snap.exists ? (snap.data() || {}) : {};
    res.set('Cache-Control', 'no-store');
    res.json({
      cinema: cinema.key,
      googleSheets: {
        configured: Boolean(process.env.GOOGLE_SHEETS_WEBHOOK_URL && process.env.GOOGLE_SHEETS_SYNC_TOKEN),
        enabled: stored.enabled === true,
        spreadsheetUrl: stored.spreadsheetUrl || (cinema.key === 'atmosfera' ? 'https://docs.google.com/spreadsheets/d/18L-HkB0iwNl1kRIhSY5DjsVL0OEdlOuSfJBZb0jqyKM/edit' : ''),
        spreadsheetId: stored.spreadsheetId || (cinema.key === 'atmosfera' ? '18L-HkB0iwNl1kRIhSY5DjsVL0OEdlOuSfJBZb0jqyKM' : ''),
        tabs: stored.tabs || { ingredients: 'Сировина', items: 'Штучка' },
        mappings: Array.isArray(stored.mappings) ? stored.mappings : [],
        updatedAt: stored.updatedAt || null,
        tabName: cinema.key === 'atmosfera' ? 'Атмосфера' : cinema.key === 'karavan' ? 'Караван' : 'Retroville'
      }
    });
  } catch (error) { publicError(res, error); }
});
app.put('/api/developer/integrations/:cinema', requireDeveloper, async (req, res) => {
  try {
    const cinema = PROJECTS.find(project => project.key === req.params.cinema);
    if (!cinema) throw Object.assign(new Error('Невідомий кінотеатр.'), { status: 400 });
    const body = req.body || {};
    const spreadsheetUrl = String(body.spreadsheetUrl || '').trim();
    const spreadsheetId = (spreadsheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/) || [])[1] || '';
    if (spreadsheetUrl && !spreadsheetId) throw Object.assign(new Error('Вкажіть коректне посилання Google Sheets.'), { status: 400 });
    const mappings = Array.isArray(body.mappings) ? body.mappings.map(item => ({
      botName: cleanText(item?.botName, 180),
      sheetName: cleanText(item?.sheetName, 180),
      category: item?.category === 'items' ? 'items' : 'ingredients'
    })).filter(item => item.botName && item.sheetName) : [];
    if (mappings.length > 1000) throw Object.assign(new Error('Забагато відповідностей (максимум 1000).'), { status: 400 });
    const tabs = {
      ingredients: cleanText(body.tabs?.ingredients, 80) || 'Сировина',
      items: cleanText(body.tabs?.items, 80) || 'Штучка'
    };
    const db = getFirestore(cinema.key);
    await db.collection('Cinema').doc(cinema.key).collection('BotConfig').doc('googleSheets').set({
      enabled: body.enabled === true,
      spreadsheetUrl,
      spreadsheetId,
      tabs,
      mappings,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: req.session.developerName || 'Developer'
    }, { merge: true });
    res.json({ ok: true, cinema: cinema.key, spreadsheetId, mappings: mappings.length });
  } catch (error) { publicError(res, error); }
});

app.use('/api/manage', requireSession);

// Staff: Cinema/{cinema}/Users/{userId}
app.get('/api/manage/staff', async (req, res) => {
  try {
    const snap = await dbForSession(req).collection('Cinema').doc(sessionCinema(req)).collection('Users').get();
    res.set('Cache-Control', 'no-store');
    res.json({ items: snap.docs.map(toPlainDoc).sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'uk')) });
  } catch (error) { publicError(res, error); }
});
app.post('/api/manage/staff', async (req, res) => {
  try {
    const id = safeId(req.body?.id);
    const name = cleanText(req.body?.name);
    const userRole = cleanText(req.body?.userRole, 60).toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!name || !userRole) throw Object.assign(new Error('Вкажіть ім’я та роль працівника.'), { status: 400 });
    if (!password || password.length > 256) throw Object.assign(new Error('Для нового працівника потрібен пароль.'), { status: 400 });
    const ref = dbForSession(req).collection('Cinema').doc(sessionCinema(req)).collection('Users').doc(id);
    if ((await ref.get()).exists) throw Object.assign(new Error('Працівник з таким ID вже існує.'), { status: 409 });
    const data = {
      name, userRole, password,
      telegramId: req.body?.telegramId === '' || req.body?.telegramId == null ? null : String(req.body.telegramId).trim(),
      isBlocked: Boolean(req.body?.isBlocked),
      airAlertNotifications: req.body?.airAlertNotifications !== false,
      checklistNotifications: req.body?.checklistNotifications !== false,
      lightReminders: req.body?.lightReminders === true,
      userColor: cleanText(req.body?.userColor, 40) || 'dark_red'
    };
    await ref.set(data);
    await writeAudit(req, 'staff.create', id, { name, userRole });
    res.status(201).json({ item: { ...data, id } });
  } catch (error) { publicError(res, error); }
});
app.put('/api/manage/staff/:id', async (req, res) => {
  try {
    const id = safeId(req.params.id);
    const ref = dbForSession(req).collection('Cinema').doc(sessionCinema(req)).collection('Users').doc(id);
    const old = await ref.get();
    if (!old.exists) throw Object.assign(new Error('Працівника не знайдено.'), { status: 404 });
    const body = req.body || {};
    const patch = {};
    if (body.name !== undefined) patch.name = cleanText(body.name);
    if (body.userRole !== undefined) patch.userRole = cleanText(body.userRole, 60).toLowerCase();
    if (body.telegramId !== undefined) patch.telegramId = body.telegramId === '' || body.telegramId == null ? null : String(body.telegramId).trim();
    if (body.isBlocked !== undefined) patch.isBlocked = Boolean(body.isBlocked);
    if (body.airAlertNotifications !== undefined) patch.airAlertNotifications = Boolean(body.airAlertNotifications);
    if (body.checklistNotifications !== undefined) patch.checklistNotifications = Boolean(body.checklistNotifications);
    if (body.lightReminders !== undefined) patch.lightReminders = Boolean(body.lightReminders);
    if (body.lightOffNotifications !== undefined) patch.lightOffNotifications = Boolean(body.lightOffNotifications);
    if (body.lightOnNotifications !== undefined) patch.lightOnNotifications = Boolean(body.lightOnNotifications);
    if (body.userColor !== undefined) patch.userColor = cleanText(body.userColor, 40);
    if (body.password !== undefined && String(body.password) !== '') {
      if (String(body.password).length > 256) throw Object.assign(new Error('Пароль задовгий.'), { status: 400 });
      patch.password = String(body.password);
    }
    if (!Object.keys(patch).length) throw Object.assign(new Error('Немає змін для збереження.'), { status: 400 });
    await ref.set(patch, { merge: true });
    await writeAudit(req, 'staff.update', id, { fields: Object.keys(patch).filter(key => key !== 'password') });
    res.json({ ok: true, item: { id, ...(await ref.get()).data() } });
  } catch (error) { publicError(res, error); }
});
app.delete('/api/manage/staff/:id', async (req, res) => {
  try {
    const id = safeId(req.params.id);
    if (req.session?.developerAuthenticated !== true && id === req.session.userId) throw Object.assign(new Error('Не можна видалити власний обліковий запис.'), { status: 400 });
    const ref = dbForSession(req).collection('Cinema').doc(sessionCinema(req)).collection('Users').doc(id);
    const doc = await ref.get();
    if (!doc.exists) throw Object.assign(new Error('Працівника не знайдено.'), { status: 404 });
    await ref.delete();
    await writeAudit(req, 'staff.delete', id, { name: doc.data().name || id });
    res.json({ ok: true });
  } catch (error) { publicError(res, error); }
});

// Recipes: Cinema/{cinema}/Recipes/{recipeDocumentId}. Numeric fields are recipe ingredients.
app.get('/api/manage/recipes', async (req, res) => {
  try {
    const snap = await dbForSession(req).collection('Cinema').doc(sessionCinema(req)).collection('Recipes').get();
    res.set('Cache-Control', 'no-store');
    res.json({ items: snap.docs.map(doc => ({ ...doc.data(), documentId: doc.id, recipeId: doc.data().id || doc.id, id: doc.id })).sort((a, b) => a.id.localeCompare(b.id, 'uk')) });
  } catch (error) { publicError(res, error); }
});
app.post('/api/manage/recipes', async (req, res) => {
  try {
    const id = safeId(req.body?.id);
    const data = normalizeRecipe(req.body);
    const ref = dbForSession(req).collection('Cinema').doc(sessionCinema(req)).collection('Recipes').doc(id);
    if ((await ref.get()).exists) throw Object.assign(new Error('Рецепт з такою назвою вже існує.'), { status: 409 });
    await ref.set(data);
    await writeAudit(req, 'recipe.create', id, { ingredientCount: Object.keys(data).length - 1 });
    res.status(201).json({ item: { ...data, id } });
  } catch (error) { publicError(res, error); }
});
app.put('/api/manage/recipes/:id', async (req, res) => {
  try {
    const id = safeId(req.params.id);
    const ref = dbForSession(req).collection('Cinema').doc(sessionCinema(req)).collection('Recipes').doc(id);
    if (!(await ref.get()).exists) throw Object.assign(new Error('Рецепт не знайдено.'), { status: 404 });
    const data = normalizeRecipe({ id: req.body?.recipeId || id, recipeId: req.body?.recipeId || id, ingredients: req.body?.ingredients });
    await ref.set(data);
    await writeAudit(req, 'recipe.update', id, { ingredientCount: Object.keys(data).length - 1 });
    res.json({ ok: true, item: { ...data, id } });
  } catch (error) { publicError(res, error); }
});
app.delete('/api/manage/recipes/:id', async (req, res) => {
  try {
    const id = safeId(req.params.id);
    const db = dbForSession(req);
    const ref = db.collection('Cinema').doc(sessionCinema(req)).collection('Recipes').doc(id);
    if (!(await ref.get()).exists) throw Object.assign(new Error('Рецепт не знайдено.'), { status: 404 });
    await ref.delete();
    await writeAudit(req, 'recipe.delete', id, {});
    res.json({ ok: true });
  } catch (error) { publicError(res, error); }
});
function normalizeRecipe(body) {
  const id = safeId(body?.id);
  const input = body?.ingredients && typeof body.ingredients === 'object' ? body.ingredients : {};
  const data = { id: cleanText(body?.recipeId || id, 128) };
  for (const [key, value] of Object.entries(input)) {
    const name = cleanText(key, 180);
    if (!name || name === 'id') continue;
    data[name] = numberValue(value, name);
  }
  return data;
}

// Writeoffs: preserve existing schema: createdAt, items[{name, weight, ingredients}], totalIngredients.
function roundQuantity(value) { return Math.round((value + Number.EPSILON) * 1000000) / 1000000; }
async function buildWriteoffItems(db, cinemaKey, inputItems) {
  if (!Array.isArray(inputItems) || !inputItems.length || inputItems.length > 100) {
    throw Object.assign(new Error('Додайте щонайменше один продукт для списання.'), { status: 400 });
  }
  const recipes = await db.collection('Cinema').doc(cinemaKey).collection('Recipes').get();
  const byName = new Map(recipes.docs.map(doc => [doc.id, doc.data()]));
  const items = [];
  const totals = {};
  for (const input of inputItems) {
    const name = cleanText(input?.name, 180);
    if (!name || !byName.has(name)) throw Object.assign(new Error('Не знайдено рецепт для продукту: ' + (name || '(без назви)')), { status: 400 });
    const weight = numberValue(input?.weight, name);
    const recipe = byName.get(name);
    const ingredients = {};
    for (const [key, raw] of Object.entries(recipe)) {
      const normalizedKey = key.toLocaleLowerCase('uk-UA').replace(/ё/g, 'е');
      if (key === 'id' || normalizedKey.includes('готовий продукт') || normalizedKey.includes('готовый продукт') || typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      const amount = roundQuantity(raw * weight);
      ingredients[key] = amount;
      totals[key] = roundQuantity((totals[key] || 0) + amount);
    }
    items.push({ name, weight, ingredients });
  }
  return { items, totalIngredients: totals };
}
app.get('/api/manage/writeoffs', async (req, res) => {
  try {
    const snap = await dbForSession(req).collection('Cinema').doc(sessionCinema(req)).collection('Writeoffs').get();
    const items = snap.docs.map(toPlainDoc).sort((a, b) => {
      const at = a.createdAt?.toMillis ? a.createdAt.toMillis() : new Date(a.createdAt || 0).getTime();
      const bt = b.createdAt?.toMillis ? b.createdAt.toMillis() : new Date(b.createdAt || 0).getTime();
      return bt - at;
    });
    res.set('Cache-Control', 'no-store');
    res.json({ items });
  } catch (error) { publicError(res, error); }
});
app.post('/api/manage/writeoffs', async (req, res) => {
  try {
    const db = dbForSession(req);
    const items = await buildWriteoffItems(db, sessionCinema(req), req.body?.items);
    const ref = db.collection('Cinema').doc(sessionCinema(req)).collection('Writeoffs').doc();
    const data = { createdAt: admin.firestore.FieldValue.serverTimestamp(), ...items };
    await ref.set(data);
    await writeAudit(req, 'writeoff.create', ref.id, { itemCount: items.items.length });
    res.status(201).json({ item: { id: ref.id, ...data, createdAt: new Date().toISOString() } });
  } catch (error) { publicError(res, error); }
});
app.put('/api/manage/writeoffs/:id', async (req, res) => {
  try {
    const db = dbForSession(req);
    const ref = db.collection('Cinema').doc(sessionCinema(req)).collection('Writeoffs').doc(safeId(req.params.id));
    const existing = await ref.get();
    if (!existing.exists) throw Object.assign(new Error('Списання не знайдено.'), { status: 404 });
    const items = await buildWriteoffItems(db, sessionCinema(req), req.body?.items);
    await ref.set({ items: items.items, totalIngredients: items.totalIngredients }, { merge: true });
    await writeAudit(req, 'writeoff.update', ref.id, { itemCount: items.items.length });
    res.json({ ok: true, item: { id: ref.id, ...existing.data(), ...items } });
  } catch (error) { publicError(res, error); }
});
app.delete('/api/manage/writeoffs/:id', async (req, res) => {
  try {
    const db = dbForSession(req);
    const ref = db.collection('Cinema').doc(sessionCinema(req)).collection('Writeoffs').doc(safeId(req.params.id));
    if (!(await ref.get()).exists) throw Object.assign(new Error('Списання не знайдено.'), { status: 404 });
    await ref.delete();
    await writeAudit(req, 'writeoff.delete', ref.id, {});
    res.json({ ok: true });
  } catch (error) { publicError(res, error); }
});

async function writeAudit(req, action, targetId, details) {
  try {
    await dbForSession(req).collection('Cinema').doc(sessionCinema(req)).collection('AdminAudit').add({
      action, targetId, details, actorId: req.session.developerAuthenticated === true ? ('developer:' + (req.session.developerName || 'Developer')) : req.session.userId,
      actorName: req.session.developerAuthenticated === true ? (req.session.developerName || 'Developer') : (req.session.name || req.session.userId),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) { console.error('Audit log write failed:', error.message); }
}
app.get('/api/manage/activity', async (req, res) => {
  try {
    const snap = await dbForSession(req).collection('Cinema').doc(sessionCinema(req)).collection('AdminAudit').orderBy('createdAt', 'desc').limit(100).get();
    res.json({ items: snap.docs.map(toPlainDoc) });
  } catch (error) { publicError(res, error); }
});

app.use(express.static(ROOT, {
  index: 'index.html', extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, etag: true
}));
app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));


// Google Sheets sync: listen directly to Firestore so website and bot writeoffs are covered.
// Atmosfera and Karavan write to separate tabs in the same spreadsheet.
function writeoffDateKey(data) {
  const value = data?.createdAt;
  let date = null;
  if (value && typeof value.toDate === 'function') date = value.toDate();
  else if (value instanceof Date) date = value;
  else if (value && typeof value.seconds === 'number') date = new Date(value.seconds * 1000);
  else if (typeof value === 'string' || typeof value === 'number') date = new Date(value);
  if (!date || Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  return part('year') + '-' + part('month') + '-' + part('day');
}

async function postWriteoffTotalsToSheets(cinema, date, ingredients, items, sheetsConfig = null) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  const token = process.env.GOOGLE_SHEETS_SYNC_TOKEN;
  if (!url || !token) throw new Error('Google Sheets sync environment variables are missing.');

  const payload = sheetsConfig?.enabled === true
    ? {
        token, cinema, date, ingredients, items,
        config: {
          spreadsheetId: sheetsConfig.spreadsheetId,
          tabs: sheetsConfig.tabs || { ingredients: 'Сировина', items: 'Штучка' },
          mappings: Array.isArray(sheetsConfig.mappings) ? sheetsConfig.mappings : []
        }
      }
    : { token, cinema, date, ingredients };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000)
  });
  const bodyText = await response.text();
  let result;
  try { result = JSON.parse(bodyText); }
  catch { throw new Error('Google Sheets returned a non-JSON response (HTTP ' + response.status + ').'); }
  if (!response.ok || result.ok !== true) {
    throw new Error('Google Sheets sync failed: ' + (result.error || ('HTTP ' + response.status)));
  }
  if (Array.isArray(result.issues) && result.issues.length) {
    console.error('[Sheets sync] ' + cinema + ' ' + date + ' issues:', JSON.stringify(result.issues));
  }
  console.log('[Sheets sync] ' + cinema + ' (' + (result.sheets || result.sheet || 'Google Sheets') + ') ' + date +
    ': updated ' + (result.updated ?? 0) + ' rows; issues ' + (result.issues?.length || 0) + '.');
}

function startWriteoffSheetsSync() {
  if (!process.env.GOOGLE_SHEETS_WEBHOOK_URL || !process.env.GOOGLE_SHEETS_SYNC_TOKEN) {
    console.log('[Sheets sync] Disabled: webhook URL or sync token is missing.');
    return;
  }

  for (const cinema of ['atmosfera', 'karavan']) {
    try {
      const writeoffsRef = getFirestore(cinema)
        .collection('Cinema').doc(cinema).collection('Writeoffs');
      let syncQueue = Promise.resolve();

      writeoffsRef.onSnapshot(snapshot => {
        const affectedDates = new Set();
        for (const change of snapshot.docChanges()) {
          // For removed docs Firestore still supplies the document's last data.
          const date = writeoffDateKey(change.doc.data());
          if (date) affectedDates.add(date);
        }
        if (!affectedDates.size) return;

        // Serialize snapshots per cinema so stale totals cannot overtake newer ones.
        syncQueue = syncQueue.then(async () => {
          for (const date of affectedDates) {
            const totals = {};
            const itemTotals = {};
            for (const doc of snapshot.docs) {
              const data = doc.data() || {};
              if (writeoffDateKey(data) !== date) continue;
              const ingredients = data.totalIngredients;
              if (!ingredients || typeof ingredients !== 'object' || Array.isArray(ingredients)) continue;
              for (const [name, rawAmount] of Object.entries(ingredients)) {
                const amount = Number(rawAmount);
                if (!Number.isFinite(amount)) continue;
                totals[name] = (totals[name] || 0) + amount;
              }
              for (const item of (Array.isArray(data.items) ? data.items : [])) {
                const name = String(item?.name || '').trim();
                const amount = Number(item?.weight);
                if (!name || !Number.isFinite(amount)) continue;
                itemTotals[name] = (itemTotals[name] || 0) + amount;
              }
            }
            const configSnap = await getFirestore(cinema).collection('Cinema').doc(cinema).collection('BotConfig').doc('googleSheets').get();
            const sheetsConfig = configSnap.exists ? (configSnap.data() || {}) : null;
            await postWriteoffTotalsToSheets(cinema, date, totals, itemTotals, sheetsConfig);
          }
        }).catch(error => {
          console.error('[Sheets sync] ' + cinema + ' listener processing failed:', error.message);
        });
      }, error => {
        console.error('[Sheets sync] ' + cinema + ' Firestore listener failed:', error.message);
      });

      console.log('[Sheets sync] Firestore listener started for ' + cinema + '.');
    } catch (error) {
      console.error('[Sheets sync] Could not start Firestore listener for ' + cinema + ':', error.message);
    }
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('MultiStaff ADMIN listening on port ' + PORT);
  startWriteoffSheetsSync();
});
