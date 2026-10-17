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
function requireSession(req, res, next) {
  if (!req.session?.userId || !req.session?.cinema) return res.status(401).json({ error: 'Потрібно увійти до системи.' });
  if (!allowedRoles.has(String(req.session.role || '').toLowerCase())) return res.status(403).json({ error: 'Недостатньо прав для цієї операції.' });
  next();
}
function dbForSession(req) { return getFirestore(req.session.cinema); }
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

app.use('/api/manage', requireSession);

// Staff: Cinema/{cinema}/Users/{userId}
app.get('/api/manage/staff', async (req, res) => {
  try {
    const snap = await dbForSession(req).collection('Cinema').doc(req.session.cinema).collection('Users').get();
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
    const ref = dbForSession(req).collection('Cinema').doc(req.session.cinema).collection('Users').doc(id);
    if ((await ref.get()).exists) throw Object.assign(new Error('Працівник з таким ID вже існує.'), { status: 409 });
    const data = {
      name, userRole, password, telegramId: cleanText(req.body?.telegramId, 64) || null,
      isBlocked: Boolean(req.body?.isBlocked),
      notifications: {
        alarms: req.body?.notifications?.alarms !== false,
        checklists: req.body?.notifications?.checklists !== false,
        lights: req.body?.notifications?.lights !== false
      }
    };
    await ref.set(data);
    await writeAudit(req, 'staff.create', id, { name, userRole });
    res.status(201).json({ item: { ...data, id } });
  } catch (error) { publicError(res, error); }
});
app.put('/api/manage/staff/:id', async (req, res) => {
  try {
    const id = safeId(req.params.id);
    const ref = dbForSession(req).collection('Cinema').doc(req.session.cinema).collection('Users').doc(id);
    const old = await ref.get();
    if (!old.exists) throw Object.assign(new Error('Працівника не знайдено.'), { status: 404 });
    const body = req.body || {};
    const patch = {};
    if (body.name !== undefined) patch.name = cleanText(body.name);
    if (body.userRole !== undefined) patch.userRole = cleanText(body.userRole, 60).toLowerCase();
    if (body.telegramId !== undefined) patch.telegramId = cleanText(body.telegramId, 64) || null;
    if (body.isBlocked !== undefined) patch.isBlocked = Boolean(body.isBlocked);
    if (body.password !== undefined && String(body.password) !== '') {
      if (String(body.password).length > 256) throw Object.assign(new Error('Пароль задовгий.'), { status: 400 });
      patch.password = String(body.password);
    }
    if (body.notifications && typeof body.notifications === 'object') {
      const current = old.data().notifications || {};
      patch.notifications = { ...current, ...body.notifications };
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
    if (id === req.session.userId) throw Object.assign(new Error('Не можна видалити власний обліковий запис.'), { status: 400 });
    const ref = dbForSession(req).collection('Cinema').doc(req.session.cinema).collection('Users').doc(id);
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
    const snap = await dbForSession(req).collection('Cinema').doc(req.session.cinema).collection('Recipes').get();
    res.set('Cache-Control', 'no-store');
    res.json({ items: snap.docs.map(doc => ({ ...doc.data(), documentId: doc.id, recipeId: doc.data().id || doc.id, id: doc.id })).sort((a, b) => a.id.localeCompare(b.id, 'uk')) });
  } catch (error) { publicError(res, error); }
});
app.post('/api/manage/recipes', async (req, res) => {
  try {
    const id = safeId(req.body?.id);
    const data = normalizeRecipe(req.body);
    const ref = dbForSession(req).collection('Cinema').doc(req.session.cinema).collection('Recipes').doc(id);
    if ((await ref.get()).exists) throw Object.assign(new Error('Рецепт з такою назвою вже існує.'), { status: 409 });
    await ref.set(data);
    await writeAudit(req, 'recipe.create', id, { ingredientCount: Object.keys(data).length - 1 });
    res.status(201).json({ item: { id, ...data } });
  } catch (error) { publicError(res, error); }
});
app.put('/api/manage/recipes/:id', async (req, res) => {
  try {
    const id = safeId(req.params.id);
    const ref = dbForSession(req).collection('Cinema').doc(req.session.cinema).collection('Recipes').doc(id);
    if (!(await ref.get()).exists) throw Object.assign(new Error('Рецепт не знайдено.'), { status: 404 });
    const data = normalizeRecipe({ id: req.body?.recipeId || id, recipeId: req.body?.recipeId || id, ingredients: req.body?.ingredients });
    await ref.set(data);
    await writeAudit(req, 'recipe.update', id, { ingredientCount: Object.keys(data).length - 1 });
    res.json({ ok: true, item: { id, ...data } });
  } catch (error) { publicError(res, error); }
});
app.delete('/api/manage/recipes/:id', async (req, res) => {
  try {
    const id = safeId(req.params.id);
    const db = dbForSession(req);
    const ref = db.collection('Cinema').doc(req.session.cinema).collection('Recipes').doc(id);
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
      if (key === 'id' || typeof raw !== 'number' || !Number.isFinite(raw)) continue;
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
    const snap = await dbForSession(req).collection('Cinema').doc(req.session.cinema).collection('Writeoffs').get();
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
    const items = await buildWriteoffItems(db, req.session.cinema, req.body?.items);
    const ref = db.collection('Cinema').doc(req.session.cinema).collection('Writeoffs').doc();
    const data = { createdAt: admin.firestore.FieldValue.serverTimestamp(), ...items };
    await ref.set(data);
    await writeAudit(req, 'writeoff.create', ref.id, { itemCount: items.items.length });
    res.status(201).json({ item: { id: ref.id, ...data, createdAt: new Date().toISOString() } });
  } catch (error) { publicError(res, error); }
});
app.put('/api/manage/writeoffs/:id', async (req, res) => {
  try {
    const db = dbForSession(req);
    const ref = db.collection('Cinema').doc(req.session.cinema).collection('Writeoffs').doc(safeId(req.params.id));
    const existing = await ref.get();
    if (!existing.exists) throw Object.assign(new Error('Списання не знайдено.'), { status: 404 });
    const items = await buildWriteoffItems(db, req.session.cinema, req.body?.items);
    await ref.set({ items: items.items, totalIngredients: items.totalIngredients }, { merge: true });
    await writeAudit(req, 'writeoff.update', ref.id, { itemCount: items.items.length });
    res.json({ ok: true, item: { id: ref.id, ...existing.data(), ...items } });
  } catch (error) { publicError(res, error); }
});
app.delete('/api/manage/writeoffs/:id', async (req, res) => {
  try {
    const db = dbForSession(req);
    const ref = db.collection('Cinema').doc(req.session.cinema).collection('Writeoffs').doc(safeId(req.params.id));
    if (!(await ref.get()).exists) throw Object.assign(new Error('Списання не знайдено.'), { status: 404 });
    await ref.delete();
    await writeAudit(req, 'writeoff.delete', ref.id, {});
    res.json({ ok: true });
  } catch (error) { publicError(res, error); }
});

async function writeAudit(req, action, targetId, details) {
  try {
    await dbForSession(req).collection('Cinema').doc(req.session.cinema).collection('AdminAudit').add({
      action, targetId, details, actorId: req.session.userId, actorName: req.session.name || req.session.userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) { console.error('Audit log write failed:', error.message); }
}
app.get('/api/manage/activity', async (req, res) => {
  try {
    const snap = await dbForSession(req).collection('Cinema').doc(req.session.cinema).collection('AdminAudit').orderBy('createdAt', 'desc').limit(100).get();
    res.json({ items: snap.docs.map(toPlainDoc) });
  } catch (error) { publicError(res, error); }
});

app.use(express.static(ROOT, {
  index: 'index.html', extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, etag: true
}));
app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(\`MultiStaff ADMIN listening on port \${PORT}\`));
