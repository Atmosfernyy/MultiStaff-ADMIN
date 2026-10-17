const pages = {
  overview: ['Панель керування', 'Огляд', 'Єдиний центр керування MultiStaff та його кінотеатрами.'],
  features: ['Функції бота', 'Функції бота', 'Управління доступністю розділів Telegram-бота.'],
  staff: ['Працівники', 'Працівники', 'Користувачі, ролі, Telegram ID та права доступу.'],
  data: ['Дані кінотеатру', 'Дані кінотеатру', 'Рецепти та списання вибраного кінотеатру.'],
  diagnostics: ['Діагностика', 'Діагностика', 'Стан сервера, Firebase та оновлення даних.'],
  activity: ['Журнал дій', 'Журнал дій', 'Історія змін у панелі керування.']
};
let currentUser = null;
let currentPage = 'overview';
let dataTab = 'recipes';
let staffCache = [];
let recipesCache = [];
let writeoffsCache = [];
let editingStaffId = null;
let editingRecipeId = null;
let editingWriteoffId = null;
let developerUnlocked = false;
let featureCinema = 'atmosfera';

function toast(msg) {
  const el = document.querySelector('#toast');
  if (!el) return;
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 3000);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function numberText(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : '0';
}
function formatDate(value) {
  if (!value) return '—';
  let date;
  if (value._seconds) date = new Date(value._seconds * 1000);
  else if (value.seconds) date = new Date(value.seconds * 1000);
  else date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('uk-UA');
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Accept': 'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) },
    cache: 'no-store'
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error('Сервер повернув неочікувану відповідь. Перевірте логи Northflank.'); }
  if (response.status === 401 && !url.startsWith('/api/developer/')) { showLogin('Сесія завершилася. Увійдіть ще раз.'); throw new Error(data.error || 'Потрібно увійти.'); }
  if (!response.ok) throw new Error(data.error || 'Не вдалося виконати операцію.');
  return data;
}
function showLogin(message = '') {
  document.querySelector('#loginScreen').hidden = false;
  document.querySelector('.shell').style.display = 'none';
  document.querySelector('#loginError').textContent = message;
}
function showDashboard(user) {
  currentUser = user;
  document.querySelector('#loginScreen').hidden = true;
  document.querySelector('.shell').style.display = '';
  const access = document.querySelector('.access');
  if (access) access.innerHTML = '<i></i><div><b>' + escapeHtml(user.name) + '</b><small>' + escapeHtml(user.cinemaLabel) + ' · ' + escapeHtml(user.role) + '</small></div>';
  const cinema = document.querySelector('#cinema');
  if (cinema) { cinema.innerHTML = ''; const option = document.createElement('option'); option.value = user.cinema; option.textContent = user.cinemaLabel; cinema.append(option); cinema.disabled = true; }
  const notice = document.querySelector('.notice');
  if (notice) { notice.querySelector('strong').textContent = 'Firebase підключено'; notice.querySelector('p').textContent = 'Вхід виконано. Панель прив’язана до ' + user.cinemaLabel + '. Дані змінюються у відповідному проєкті Firebase.'; }
  const firebase = document.querySelector('#firebase');
  if (firebase) firebase.textContent = 'Секрети налаштовано';
  showPage(currentPage);
}
function setOverviewVisible(visible) {
  document.querySelectorAll('.content > .notice, .content > .sectionhead, .content > .stats, .content > .modules, .content > .bottomgrid, .content > footer').forEach(el => {
    el.style.display = visible ? '' : 'none';
  });
}
function showPage(key) {
  currentPage = pages[key] ? key : 'overview';
  const p = pages[currentPage];
  document.querySelector('#title').textContent = p[0];
  document.querySelector('#crumb').textContent = p[1];
  document.querySelector('#description').textContent = p[2];
  document.querySelectorAll('.nav[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === currentPage));
  document.querySelector('#sidebar').classList.remove('open');
  const workspace = document.querySelector('#workspace');
  if (currentPage === 'overview') {
    workspace.hidden = true;
    setOverviewVisible(true);
    return;
  }
  setOverviewVisible(false);
  workspace.hidden = false;
  workspace.innerHTML = '<div class="panel"><p>Завантаження…</p></div>';
  if (currentPage === 'staff') loadStaff();
  else if (currentPage === 'data') renderDataPage();
  else if (currentPage === 'activity') loadActivity();
  else if (currentPage === 'features') openDeveloperFeatures();
  else if (currentPage === 'diagnostics') loadDiagnostics();
}

function developerGate() {
  let overlay = document.querySelector('#developerGate');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'developerGate';
    overlay.className = 'developer-gate';
    overlay.innerHTML = '<form id="developerLoginForm" class="developer-card"><button type="button" class="gate-close" aria-label="Закрити" data-action="developer-close">×</button><div class="brand login-brand"><span class="logo">M</span><span><b>MULTISTAFF</b><small>DEVELOPER ACCESS</small></span></div><p class="eyebrow red">PRIVILEGED WORKSPACE</p><h2>Developer-авторизація</h2><p class="muted">Основна панель залишиться позаду. Повторно введіть окремий Developer-логін і пароль, щоб керувати функціями ботів у різних кінотеатрах.</p><label for="developerLogin">Developer-логін</label><input id="developerLogin" name="login" autocomplete="username" required maxlength="128"><label for="developerPassword">Пароль</label><input id="developerPassword" name="password" type="password" autocomplete="current-password" required maxlength="256"><p id="developerLoginError" class="login-error" role="alert"></p><button class="login-submit" type="submit">Відкрити керування</button><small class="login-footnote">Доступ перевіряється сервером. Облікові дані не зберігаються у браузері.</small></form>';
    document.body.appendChild(overlay);
    overlay.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      const errorEl = form.querySelector('#developerLoginError');
      button.disabled = true; button.textContent = 'Перевіряємо…'; errorEl.textContent = '';
      try {
        await api('/api/developer/login', { method: 'POST', body: JSON.stringify({ login: form.elements.login.value, password: form.elements.password.value }) });
        developerUnlocked = true;
        form.reset();
        overlay.remove();
        document.body.classList.remove('developer-locked');
        await loadBotFeatures(featureCinema);
      } catch (error) { errorEl.textContent = error.message; }
      finally { if (button.isConnected) { button.disabled = false; button.textContent = 'Відкрити керування'; } }
    });
  }
  document.body.classList.add('developer-locked');
  overlay.hidden = false;
  setTimeout(() => overlay.querySelector('input[name="login"]')?.focus(), 0);
}
async function openDeveloperFeatures() {
  if (!developerUnlocked) {
    try {
      const state = await api('/api/developer/me');
      developerUnlocked = state.authenticated === true;
    } catch { developerUnlocked = false; }
  }
  if (developerUnlocked) return loadBotFeatures(featureCinema);
  workspace().innerHTML = '<section class="panel"><h2>Функції бота</h2><p class="muted">Цей розділ потребує окремого Developer-входу.</p><button class="primary" data-action="developer-login">Увійти як Developer</button></section>';
  developerGate();
}
async function loadBotFeatures(cinema) {
  featureCinema = cinema || featureCinema;
  try {
    const result = await api('/api/developer/features/' + encodeURIComponent(featureCinema));
    const entries = Object.entries(result.features || {});
    workspace().innerHTML = '<section class="panel">' +
      '<div class="workspace-head"><div><h2>Глобальне керування ботом</h2><p class="muted">Окремий Developer-доступ · зміни зберігаються у Firebase вибраного кінотеатру.</p></div><button data-action="developer-logout">Вийти з Developer</button></div>' +
      '<div class="feature-toolbar"><label for="featureCinema">Кінотеатр</label><select id="featureCinema"><option value="atmosfera" ' + (featureCinema === 'atmosfera' ? 'selected' : '') + '>Atmosfera</option><option value="karavan" ' + (featureCinema === 'karavan' ? 'selected' : '') + '>Karavan</option><option value="retroville" ' + (featureCinema === 'retroville' ? 'selected' : '') + '>Retroville</option></select><span class="pill ' + (result.configured ? 'success' : 'warning') + '">' + (result.configured ? 'Конфігурацію знайдено' : 'Створюється під час першої зміни') + '</span></div>' +
      '<div class="feature-list">' + entries.map(([key, feature]) => '<article class="feature-row"><div><b>' + escapeHtml(feature.label || key) + '</b><small><code>' + escapeHtml(key) + '</code></small></div><label class="switch"><input type="checkbox" data-action="bot-toggle" data-feature="' + escapeHtml(key) + '" ' + (feature.enabled ? 'checked' : '') + '><span></span></label><strong class="feature-state ' + (feature.enabled ? 'on' : 'off') + '">' + (feature.enabled ? 'Увімкнено' : 'Вимкнено') + '</strong></article>').join('') + '</div>' +
      '<p class="muted small">Прапорці записуються в <code>Cinema/' + escapeHtml(featureCinema) + '/BotConfig/features</code>. Щоб перемикання реально впливали на Telegram-бот, бот має читати ці самі ключі.</p></section>';
    document.querySelector('#featureCinema').addEventListener('change', event => loadBotFeatures(event.target.value));
  } catch (error) {
    workspace().innerHTML = '<section class="panel"><h2>Не вдалося завантажити функції</h2><p class="form-error">' + escapeHtml(error.message) + '</p><button data-action="developer-login">Повторити вхід</button></section>';
    if (error.message.includes('Developer-авторизація')) { developerUnlocked = false; developerGate(); }
  }
}

function workspace() { return document.querySelector('#workspace'); }
function panelHeader(title, subtitle, actionLabel, action) {
  return '<div class="workspace-head"><div><h2>' + escapeHtml(title) + '</h2><p class="muted">' + escapeHtml(subtitle) + '</p></div>' +
    (actionLabel ? '<button class="primary" data-action="' + action + '">' + escapeHtml(actionLabel) + '</button>' : '') + '</div>';
}
function emptyState(text) { return '<div class="empty-state">' + escapeHtml(text) + '</div>'; }
function moneyMap(map) {
  if (!map || typeof map !== 'object' || !Object.keys(map).length) return '<span class="muted">Немає компонентів</span>';
  return '<div class="ingredient-list">' + Object.entries(map).map(([name, amount]) => '<div><span>' + escapeHtml(name) + '</span><b>' + escapeHtml(numberText(amount)) + '</b></div>').join('') + '</div>';
}
async function loadStaff() {
  try {
    const result = await api('/api/manage/staff');
    staffCache = result.items || [];
    renderStaff();
  } catch (error) { workspace().innerHTML = '<section class="panel">' + escapeHtml(error.message) + '</section>'; }
}
function renderStaff() {
  workspace().innerHTML = panelHeader('Працівники', 'Кінотеатр: ' + currentUser.cinemaLabel + ' · ' + staffCache.length + ' записів', '＋ Додати працівника', 'staff-new') +
    (staffCache.length ? '<div class="record-list">' + staffCache.map(person => {
      const blocked = person.isBlocked === true;
      const notifs = { alarms: person.airAlertNotifications, checklists: person.checklistNotifications, lights: person.lightReminders };
      return '<article class="record-card"><div class="record-top"><div class="avatar">' + escapeHtml((person.name || person.id).slice(0,1).toUpperCase()) + '</div><div class="record-title"><b>' + escapeHtml(person.name || person.id) + '</b><small>' + escapeHtml(person.userRole || 'Без ролі') + ' · ID ' + escapeHtml(person.id) + '</small></div><span class="pill ' + (blocked ? 'danger' : 'success') + '">' + (blocked ? 'Заблокований' : 'Активний') + '</span></div><div class="record-meta"><div><small>Telegram ID</small><b>' + escapeHtml(person.telegramId || '—') + '</b></div><div><small>Доступ</small><b>' + (blocked ? 'Заблоковано' : 'Дозволено') + '</b></div></div><div class="muted small">Сповіщення: тривоги ' + (notifs.alarms === false ? 'ні' : 'так') + ' · чек-листи ' + (notifs.checklists === false ? 'ні' : 'так') + ' · світло ' + (notifs.lights === false ? 'ні' : 'так') + '</div><div class="button-row"><button data-action="staff-edit" data-id="' + escapeHtml(person.id) + '">✎ Редагувати</button><button data-action="staff-block" data-id="' + escapeHtml(person.id) + '">' + (blocked ? 'Розблокувати' : 'Заблокувати') + '</button><button class="danger-button" data-action="staff-delete" data-id="' + escapeHtml(person.id) + '">Видалити</button></div></article>';
    }).join('') + '</div>' : emptyState('У цьому кінотеатрі поки немає працівників.'));
}
function staffForm(person = {}) {
  editingStaffId = person.id || null;
  const n = person.notifications || {};
  workspace().innerHTML = '<section class="panel form-panel"><div class="workspace-head"><div><h2>' + (editingStaffId ? 'Редагувати працівника' : 'Новий працівник') + '</h2><p class="muted">Зміни будуть збережені у Cinema/' + escapeHtml(currentUser.cinema) + '/Users.</p></div><button data-action="staff-cancel">← Назад</button></div><form id="staffForm" class="data-form"><div class="form-grid"><label>ID документа / логін *<input name="id" required maxlength="128" ' + (editingStaffId ? 'value="' + escapeHtml(person.id) + '" readonly' : '') + ' value="' + escapeHtml(person.id || '') + '"></label><label>Ім’я та прізвище *<input name="name" required value="' + escapeHtml(person.name || '') + '"></label><label>Роль *<select name="userRole"><option value="employee" ' + (person.userRole === 'employee' ? 'selected' : '') + '>Працівник</option><option value="manager" ' + (person.userRole === 'manager' ? 'selected' : '') + '>Менеджер</option><option value="admin" ' + (person.userRole === 'admin' ? 'selected' : '') + '>Адміністратор</option><option value="cashier" ' + (person.userRole === 'cashier' ? 'selected' : '') + '>Касир</option></select></label><label>Telegram ID<input name="telegramId" value="' + escapeHtml(person.telegramId || '') + '"></label><label>Колір працівника<select name="userColor"><option value="dark_red" ' + ((person.userColor || 'dark_red') === 'dark_red' ? 'selected' : '') + '>Темно-червоний</option><option value="blue" ' + (person.userColor === 'blue' ? 'selected' : '') + '>Синій</option><option value="green" ' + (person.userColor === 'green' ? 'selected' : '') + '>Зелений</option><option value="purple" ' + (person.userColor === 'purple' ? 'selected' : '') + '>Фіолетовий</option></select></label><label class="wide">Пароль ' + (editingStaffId ? '(залиште порожнім, щоб не змінювати)' : '*') + '<input name="password" type="password" maxlength="256" ' + (!editingStaffId ? 'required' : '') + ' autocomplete="new-password"></label></div><label class="checkline"><input type="checkbox" name="isBlocked" ' + (person.isBlocked ? 'checked' : '') + '> Заблокувати працівника</label><div class="notification-box"><h3>Особисті сповіщення</h3><label class="checkline"><input type="checkbox" name="alarmNotify" ' + (n.alarms !== false ? 'checked' : '') + '> Повітряні тривоги</label><label class="checkline"><input type="checkbox" name="checklistNotify" ' + (n.checklists !== false ? 'checked' : '') + '> Чек-листи</label><label class="checkline"><input type="checkbox" name="lightNotify" ' + (n.lights !== false ? 'checked' : '') + '> Нагадування про світло</label><p class="muted small">Зберігаються в airAlertNotifications, checklistNotifications і lightReminders — у тих самих полях, які використовує Firebase.</p></div><div class="button-row"><button class="primary" type="submit">Зберегти працівника</button><button type="button" data-action="staff-cancel">Скасувати</button></div><p id="formError" class="form-error"></p></form></section>';
  document.querySelector('#staffForm').addEventListener('submit', saveStaff);
}
async function saveStaff(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const value = name => form.elements[name]?.value ?? '';
  const checked = name => Boolean(form.elements[name]?.checked);
  const body = {
    id: value('id').trim(), name: value('name').trim(), userRole: value('userRole'),
    telegramId: value('telegramId').trim(), password: value('password'),
    isBlocked: checked('isBlocked'),
    airAlertNotifications: checked('alarmNotify'), checklistNotifications: checked('checklistNotify'), lightReminders: checked('lightNotify'),
    userColor: value('userColor') || 'dark_red'
  };
  try {
    if (editingStaffId) await api('/api/manage/staff/' + encodeURIComponent(editingStaffId), { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/manage/staff', { method: 'POST', body: JSON.stringify(body) });
    toast('Дані працівника збережено'); await loadStaff();
  } catch (error) { form.querySelector('#formError').textContent = error.message; }
}
async function renderDataPage() {
  workspace().innerHTML = '<div class="data-tabs"><button data-action="data-tab" data-tab="recipes" class="' + (dataTab === 'recipes' ? 'selected' : '') + '">Рецепти</button><button data-action="data-tab" data-tab="writeoffs" class="' + (dataTab === 'writeoffs' ? 'selected' : '') + '">Списання</button></div><div id="dataContent" class="panel"><p>Завантаження…</p></div>';
  if (dataTab === 'recipes') await loadRecipes(); else await loadWriteoffs();
}
async function loadRecipes() {
  try {
    recipesCache = (await api('/api/manage/recipes')).items || [];
    document.querySelector('#dataContent').innerHTML = panelHeader('Рецепти', 'Cinema/' + currentUser.cinema + '/Recipes · ' + recipesCache.length + ' рецептів', '＋ Створити рецепт', 'recipe-new') +
      (recipesCache.length ? '<div class="record-list">' + recipesCache.map(recipe => {
        const ingredients = Object.fromEntries(Object.entries(recipe).filter(([key, value]) => key !== 'id' && typeof value === 'number'));
        return '<article class="record-card"><div class="record-top"><div class="record-title"><b>' + escapeHtml(recipe.id) + '</b><small>Recipe ID: ' + escapeHtml(recipe.recipeId || recipe.id) + '</small></div><span class="pill">' + Object.keys(ingredients).length + ' компонентів</span></div>' + moneyMap(ingredients) + '<div class="button-row"><button data-action="recipe-edit" data-id="' + escapeHtml(recipe.id) + '">✎ Редагувати</button><button class="danger-button" data-action="recipe-delete" data-id="' + escapeHtml(recipe.id) + '">Видалити</button></div></article>';
      }).join('') + '</div>' : emptyState('Рецептів поки немає.'));
  } catch (error) { document.querySelector('#dataContent').innerHTML = '<p class="form-error">' + escapeHtml(error.message) + '</p>'; }
}
function parseIngredientLines(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.lastIndexOf('=');
    if (index < 1) throw new Error('Кожен компонент введіть у форматі: Назва = кількість');
    const name = trimmed.slice(0, index).trim();
    const value = Number(trimmed.slice(index + 1).trim().replace(',', '.'));
    if (!name || !Number.isFinite(value) || value < 0) throw new Error('Перевірте назву та кількість компонента: ' + name);
    result[name] = value;
  }
  return result;
}
function recipeForm(recipe = {}) {
  editingRecipeId = recipe.id || null;
  const ingredients = Object.entries(recipe).filter(([key, value]) => key !== 'id' && typeof value === 'number').map(([key, value]) => key + ' = ' + value).join('\n');
  workspace().querySelector('#dataContent').innerHTML = '<section class="form-panel"><div class="workspace-head"><div><h2>' + (editingRecipeId ? 'Редагувати рецепт' : 'Новий рецепт') + '</h2><p class="muted">Поля з кількістю зберігаються як числові поля у Firestore.</p></div><button data-action="recipe-cancel">← Назад</button></div><form id="recipeForm" class="data-form"><label>Назва документа *<input name="id" required value="' + escapeHtml(recipe.id || '') + '" ' + (editingRecipeId ? 'readonly' : '') + ' placeholder="Наприклад, Сир"></label><label>ID рецепта<input name="recipeId" value="' + escapeHtml(recipe.recipeId || recipe.id || '') + '" placeholder="Наприклад, cheese"></label><label>Інгредієнти *<textarea name="ingredients" rows="9" required placeholder="ГОТОВИЙ ПРОДУКТ = 1.76&#10;Добавка сыр = 0.16">' + escapeHtml(ingredients) + '</textarea><small class="muted">Один компонент на рядок: назва = кількість. Значення мають бути числовими.</small></label><div class="button-row"><button class="primary" type="submit">Зберегти рецепт</button><button type="button" data-action="recipe-cancel">Скасувати</button></div><p id="formError" class="form-error"></p></form></section>';
  document.querySelector('#recipeForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const id = form.elements.id.value.trim();
      const body = { id, recipeId: form.elements.recipeId.value.trim() || id, ingredients: parseIngredientLines(form.elements.ingredients.value) };
      if (editingRecipeId) await api('/api/manage/recipes/' + encodeURIComponent(editingRecipeId), { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/manage/recipes', { method: 'POST', body: JSON.stringify(body) });
      toast('Рецепт збережено'); await loadRecipes();
    } catch (error) { form.querySelector('#formError').textContent = error.message; }
  });
}
async function loadWriteoffs() {
  try {
    writeoffsCache = (await api('/api/manage/writeoffs')).items || [];
    document.querySelector('#dataContent').innerHTML = panelHeader('Списання', 'Cinema/' + currentUser.cinema + '/Writeoffs · ' + writeoffsCache.length + ' записів', '＋ Нове списання', 'writeoff-new') +
      (writeoffsCache.length ? '<div class="record-list">' + writeoffsCache.map(item => '<article class="record-card"><div class="record-top"><div class="record-title"><b>Списання #' + escapeHtml(item.id.slice(0, 8)) + '</b><small>' + escapeHtml(formatDate(item.createdAt)) + '</small></div><span class="pill">' + ((item.items || []).length) + ' продуктів</span></div><div class="writeoff-items">' + (item.items || []).map(product => '<div><span>' + escapeHtml(product.name) + ' × ' + escapeHtml(numberText(product.weight)) + '</span><small>' + Object.keys(product.ingredients || {}).length + ' компонентів</small></div>').join('') + '</div><details><summary>Загальний розрахунок інгредієнтів</summary>' + moneyMap(item.totalIngredients) + '</details><div class="button-row"><button data-action="writeoff-edit" data-id="' + escapeHtml(item.id) + '">✎ Редагувати</button><button class="danger-button" data-action="writeoff-delete" data-id="' + escapeHtml(item.id) + '">Видалити</button></div></article>').join('') + '</div>' : emptyState('Списань поки немає.'));
  } catch (error) { document.querySelector('#dataContent').innerHTML = '<p class="form-error">' + escapeHtml(error.message) + '</p>'; }
}
function writeoffForm(item = {}) {
  editingWriteoffId = item.id || null;
  const lines = (item.items || []).map(product => product.name + ' = ' + product.weight).join('\n');
  workspace().querySelector('#dataContent').innerHTML = '<section class="form-panel"><div class="workspace-head"><div><h2>' + (editingWriteoffId ? 'Редагувати списання' : 'Нове списання') + '</h2><p class="muted">Розрахунок компонентів буде виконано з актуальних рецептів.</p></div><button data-action="writeoff-cancel">← Назад</button></div><form id="writeoffForm" class="data-form"><label>Продукти та вага *<textarea name="items" rows="7" required placeholder="Бекон = 1&#10;Карамель = 2">' + escapeHtml(lines) + '</textarea><small class="muted">Один продукт на рядок: точна назва документа рецепта = вага. Вага множить кількості компонентів рецепта.</small></label><div class="button-row"><button class="primary" type="submit">Розрахувати та зберегти</button><button type="button" data-action="writeoff-cancel">Скасувати</button></div><p id="formError" class="form-error"></p></form></section>';
  document.querySelector('#writeoffForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const items = form.elements.items.value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
        const index = line.lastIndexOf('=');
        if (index < 1) throw new Error('Формат рядка: назва продукту = вага');
        const name = line.slice(0, index).trim();
        const weight = Number(line.slice(index + 1).trim().replace(',', '.'));
        if (!name || !Number.isFinite(weight) || weight < 0) throw new Error('Перевірте продукт і вагу: ' + name);
        return { name, weight };
      });
      const body = { items };
      if (editingWriteoffId) await api('/api/manage/writeoffs/' + encodeURIComponent(editingWriteoffId), { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/manage/writeoffs', { method: 'POST', body: JSON.stringify(body) });
      toast('Списання збережено'); await loadWriteoffs();
    } catch (error) { form.querySelector('#formError').textContent = error.message; }
  });
}
async function loadActivity() {
  try {
    const result = await api('/api/manage/activity');
    const items = result.items || [];
    workspace().innerHTML = '<section class="panel">' + panelHeader('Журнал дій', 'Останні адміністративні операції', '', '') + (items.length ? '<div class="record-list">' + items.map(item => '<article class="record-card"><div class="record-top"><div class="record-title"><b>' + escapeHtml(item.action) + '</b><small>' + escapeHtml(formatDate(item.createdAt)) + '</small></div></div><div class="muted small">Користувач: ' + escapeHtml(item.actorName || item.actorId) + ' · Документ: ' + escapeHtml(item.targetId) + '</div></article>').join('') + '</div>' : emptyState('Журнал ще порожній.')) + '</section>';
  } catch (error) { workspace().innerHTML = '<section class="panel form-error">' + escapeHtml(error.message) + '</section>'; }
}
async function loadDiagnostics() {
  try {
    const health = await api('/api/health');
    workspace().innerHTML = '<section class="panel"><h2>Діагностика</h2><div class="record-meta"><div><small>API</small><b>' + (health.ok ? 'Онлайн' : 'Недоступний') + '</b></div><div><small>SESSION_SECRET</small><b>' + (health.sessionConfigured ? 'Налаштовано' : 'Відсутній') + '</b></div><div><small>Firebase проєкти</small><b>' + health.configuredProjects.length + ' із 3</b></div></div><div class="record-list">' + ['atmosfera','karavan','retroville'].map(key => '<article class="record-card"><b>' + escapeHtml(key) + '</b><span class="pill ' + (health.configuredProjects.includes(key) ? 'success' : 'danger') + '">' + (health.configuredProjects.includes(key) ? 'Налаштовано' : 'Немає конфігурації') + '</span></article>').join('') + '</div></section>';
  } catch (error) { workspace().innerHTML = '<section class="panel form-error">' + escapeHtml(error.message) + '</section>'; }
}
async function handleAction(button) {
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === 'developer-login') return developerGate();
  if (action === 'developer-close') {
    document.querySelector('#developerGate')?.remove();
    document.body.classList.remove('developer-locked');
    return;
  }
  if (action === 'developer-logout') {
    try { await api('/api/developer/logout', { method: 'POST' }); } catch {}
    developerUnlocked = false;
    return openDeveloperFeatures();
  }
  if (action === 'staff-new') return staffForm();
  if (action === 'staff-cancel') return loadStaff();
  if (action === 'staff-edit') return staffForm(staffCache.find(x => x.id === id) || {});
  if (action === 'staff-block') {
    const person = staffCache.find(x => x.id === id);
    if (!person) return;
    try { await api('/api/manage/staff/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ isBlocked: !person.isBlocked }) }); toast('Статус працівника змінено'); await loadStaff(); }
    catch (error) { toast(error.message); }
  }
  if (action === 'staff-delete') {
    if (!confirm('Видалити працівника ' + id + '? Цю дію не можна скасувати.')) return;
    try { await api('/api/manage/staff/' + encodeURIComponent(id), { method: 'DELETE' }); toast('Працівника видалено'); await loadStaff(); }
    catch (error) { toast(error.message); }
  }
  if (action === 'data-tab') { dataTab = button.dataset.tab; return renderDataPage(); }
  if (action === 'recipe-new') return recipeForm();
  if (action === 'recipe-cancel') return loadRecipes();
  if (action === 'recipe-edit') return recipeForm(recipesCache.find(x => x.id === id) || {});
  if (action === 'recipe-delete') {
    if (!confirm('Видалити рецепт «' + id + '»? Старі списання залишаться без змін, але нові розрахунки цього рецепта будуть неможливі.')) return;
    try { await api('/api/manage/recipes/' + encodeURIComponent(id), { method: 'DELETE' }); toast('Рецепт видалено'); await loadRecipes(); }
    catch (error) { toast(error.message); }
  }
  if (action === 'writeoff-new') return writeoffForm();
  if (action === 'writeoff-cancel') return loadWriteoffs();
  if (action === 'writeoff-edit') return writeoffForm(writeoffsCache.find(x => x.id === id) || {});
  if (action === 'writeoff-delete') {
    if (!confirm('Видалити списання #' + id.slice(0, 8) + '? Цю дію не можна скасувати.')) return;
    try { await api('/api/manage/writeoffs/' + encodeURIComponent(id), { method: 'DELETE' }); toast('Списання видалено'); await loadWriteoffs(); }
    catch (error) { toast(error.message); }
  }
}
async function health() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!r.ok) throw Error('HTTP ' + r.status);
    const d = await r.json();
    document.querySelector('#health').textContent = '● Сервер відповідає';
    document.querySelector('#server').textContent = 'Онлайн';
    document.querySelector('#serverdetail').textContent = 'API відповідає коректно';
    document.querySelector('#firebase').textContent = d.mode === 'firebase-configured' ? 'Три проєкти налаштовано' : d.configuredProjects.length + ' із 3 проєктів налаштовано';
  } catch {
    document.querySelector('#health').textContent = '● Немає зв’язку';
    document.querySelector('#server').textContent = 'Недоступний';
    document.querySelector('#serverdetail').textContent = 'Не вдалося перевірити API';
    document.querySelector('#firebase').textContent = 'Не перевірено';
  }
}
async function checkSession() {
  try { const d = await api('/api/auth/me'); showDashboard(d.user); }
  catch { showLogin(); }
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (button && button.dataset.action !== 'bot-toggle') handleAction(button);
  const nav = event.target.closest('[data-page]');
  if (nav) showPage(nav.dataset.page);
});
document.addEventListener('change', async event => {
  const toggle = event.target.closest('input[data-action="bot-toggle"]');
  if (!toggle) return;
  const feature = toggle.dataset.feature;
  const enabled = toggle.checked;
  toggle.disabled = true;
  try {
    await api('/api/developer/features/' + encodeURIComponent(featureCinema) + '/' + encodeURIComponent(feature), {
      method: 'PUT', body: JSON.stringify({ enabled })
    });
    toast('Функцію ' + (enabled ? 'увімкнено' : 'вимкнено'));
    await loadBotFeatures(featureCinema);
  } catch (error) {
    toast(error.message);
    toggle.checked = !enabled;
  } finally { if (toggle.isConnected) toggle.disabled = false; }
});
document.addEventListener('DOMContentLoaded', () => {
  const content = document.querySelector('.content');
  const workspaceEl = document.createElement('div');
  workspaceEl.id = 'workspace'; workspaceEl.hidden = true;
  const heading = content.querySelector('.heading');
  heading.insertAdjacentElement('afterend', workspaceEl);
  document.querySelector('#refresh').addEventListener('click', () => { health(); if (currentPage !== 'overview') showPage(currentPage); toast('Оновлюю дані…'); });
  document.querySelector('#menu').addEventListener('click', () => document.querySelector('#sidebar').classList.toggle('open'));
  document.querySelector('#loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true; button.textContent = 'Перевіряємо…';
    document.querySelector('#loginError').textContent = '';
    try {
      const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ id: form.elements.id.value.trim(), password: form.elements.password.value }) });
      form.reset(); showDashboard(data.user); health();
    } catch (error) { document.querySelector('#loginError').textContent = error.message || 'Помилка входу'; }
    finally { button.disabled = false; button.textContent = 'Увійти до панелі'; }
  });
  health(); checkSession();
});
