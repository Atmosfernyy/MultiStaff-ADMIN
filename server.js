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
const allowedRoles = new Set(
  (process.env.MANAGER_ALLOWED_ROLES || 'admin,manager')
    .split(',').map(role => role.trim().toLowerCase()).filter(Boolean)
);
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
app.use(express.json({ limit: '32kb' }));
app.use('/api', rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }));

if (sessionSecret) {
  app.use(cookieSession({
    name: 'multistaff_session',
    keys: [sessionSecret],
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  }));
}

function getFirestore(project) {
  const raw = process.env[project.env];
  if (!raw) return null;
  if (serviceApps.has(project.key)) return serviceApps.get(project.key).firestore();
  const serviceAccount = JSON.parse(raw);
  const appName = 'multistaff-admin-' + project.key;
  let firebaseApp;
  try {
    firebaseApp = admin.app(appName);
  } catch {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id
    }, appName);
  }
  serviceApps.set(project.key, firebaseApp);
  return firebaseApp.firestore();
}

app.get('/api/health', (_req, res) => {
  const configuredProjects = PROJECTS.filter(project => Boolean(process.env[project.env])).map(project => project.key);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: 'multistaff-admin',
    sessionConfigured: Boolean(sessionSecret),
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
  if (missingProjects.length) {
    return res.status(503).json({ error: 'Не налаштовано Firebase для всіх кінотеатрів: ' + missingProjects.map(project => project.label).join(', ') + '.' });
  }

  try {
    const matches = [];
    for (const project of PROJECTS) {
      const db = getFirestore(project);
      if (!db) continue;
      const snapshot = await db.collection('Cinema').doc(project.key).collection('Users').doc(userId).get();
      if (!snapshot.exists) continue;
      const user = snapshot.data() || {};
      if (String(user.password ?? '') !== password) continue;
      if (user.isBlocked === true) return res.status(403).json({ error: 'Обліковий запис заблоковано.' });
      const role = String(user.userRole || '').toLowerCase();
      if (!allowedRoles.has(role)) return res.status(403).json({ error: 'Роль цього облікового запису не має доступу до вебпанелі.' });
      matches.push({ project, user, role });
    }

    if (matches.length === 0) return res.status(401).json({ error: 'Неправильний ID або пароль.' });
    if (matches.length > 1) return res.status(409).json({ error: 'Цей ID і пароль збігаються в кількох кінотеатрах. Зверніться до Developer.' });

    const match = matches[0];
    req.session = {
      userId,
      name: String(match.user.name || userId),
      role: match.role,
      cinema: match.project.key,
      cinemaLabel: match.project.label,
      telegramId: match.user.telegramId == null ? null : String(match.user.telegramId)
    };
    return res.json({ ok: true, user: { id: userId, name: req.session.name, role: match.role, cinema: match.project.key, cinemaLabel: match.project.label } });
  } catch (error) {
    console.error('Login/Firebase error:', error.message);
    return res.status(503).json({ error: 'Не вдалося перевірити Firebase. Перевірте Secrets і логи сервера.' });
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId || !req.session?.cinema) return res.status(401).json({ authenticated: false });
  res.set('Cache-Control', 'no-store');
  res.json({ authenticated: true, user: { id: req.session.userId, name: req.session.name, role: req.session.role, cinema: req.session.cinema, cinemaLabel: req.session.cinemaLabel } });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session) req.session = null;
  res.json({ ok: true });
});

// All future management API endpoints must use req.session.cinema and re-check permissions.
// Never accept the active cinema or role from the browser as an authority.
app.use(express.static(ROOT, {
  index: 'index.html',
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  etag: true
}));
app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`MultiStaff ADMIN listening on port ${PORT}`));
