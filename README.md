# MultiStaff ADMIN

Початкова основа Developer-панелі для керування MultiStaff Telegram-ботом.

## Уже є
- Адаптивний темний інтерфейс українською.
- Навігація: огляд, функції бота, працівники, дані кінотеатру, діагностика, журнал дій.
- Node.js / Express API та endpoint `GET /api/health`.
- Dockerfile для Northflank.

## Ще не підключено
Firebase, Developer-авторизація та реальні операції з даними бота. Поточна панель демонстраційна: вона не змінює Firestore.

## Запуск
Потрібен Node.js 20+.

```bash
npm install
npm run dev
```

Відкрити `http://localhost:3000`. Перевірка синтаксису: `npm run check`.

## Наступні етапи
1. Firebase Admin SDK на сервері.
2. Справжня авторизація Developer і перевірка ролі на кожному endpoint.
3. Захищений вибір Atmosfera / Karavan / Retroville.
4. Керування `Cinema/{cinema}/BotConfig/features` із сайту.
5. Працівники, інші дані, журнал аудиту.

Не кладіть Firebase service-account JSON, bot token або session secret у `public/`. Секрети мають зберігатися лише в змінних середовища хостингу. Не довіряйте ролі або вибраному кінотеатру, які надсилає браузер: сервер має сам перевіряти доступ.
