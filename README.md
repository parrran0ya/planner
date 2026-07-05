# Telegram-бот для планера — деплой на Railway

## 1. Подготовка

1. **Бот в Telegram**: напиши [@BotFather](https://t.me/BotFather) → `/newbot` → получишь `BOT_TOKEN`.
2. **Supabase**: зайди в Project Settings → API. Тебе нужен **service_role** ключ
   (не anon — этот ключ обходит RLS, поэтому храним его только на сервере бота, никогда не в html).
3. Выполни `migration.sql` в Supabase → SQL Editor (один раз).
4. Кнопка «Привязать Telegram» уже встроена в planner.html — она спрятана в выпадающем
   меню профиля (клик по бейджу с ником в шапке справа). Отдельно ничего добавлять не нужно
   (файл `website-snippet.js` оставлен только как справочный, на случай если понадобится
   перенести логику в другое место).

## 2. Локальная проверка (не обязательно, но полезно)

```bash
npm install
cp .env.example .env
# впиши в .env реальные BOT_TOKEN и SUPABASE_SERVICE_ROLE_KEY
npm start
```

Напиши боту `/start`, потом пришли код (сгенерированный через website-snippet.js
или вставленный вручную в таблицу `telegram_link_codes` для теста).

## 3. Деплой на Railway

### Вариант А — через GitHub (проще всего для будущих обновлений)

1. Залей папку `planner-bot` (со всеми файлами из неё — `index.js`, `package.json`,
   `migration.sql`, `.env.example`, этот README; сам `.env` с реальными ключами в репозиторий
   не кладём) в отдельный репозиторий на GitHub. Файл `planner.html` (сайт) сюда не входит —
   это отдельный проект, он как был на Netlify, так там и остаётся.
2. На [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → выбери репозиторий.
3. Railway сам увидит `package.json` и `npm start`, поставит зависимости и запустит.
4. Зайди в **Variables** созданного сервиса и добавь:
   - `BOT_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `TZ` (например `Asia/Almaty`)
5. Во вкладке **Settings** убедись, что сервис имеет тип **Worker** (без публичного домена) —
   боту не нужен входящий HTTP-трафик, он сам стучится в Telegram (long polling).
   Если Railway создал его как Web-сервис — это не страшно, просто не подключай к нему домен.

### Вариант Б — через Railway CLI (без GitHub)

```bash
npm i -g @railway/cli
railway login
cd planner-bot
railway init
railway up
railway variables set BOT_TOKEN=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... TZ=Asia/Almaty
```

## 4. Проверка после деплоя

- В логах Railway (**Deployments → View Logs**) должна появиться строка `Бот запущен. TZ = ...`.
- Напиши боту `/start` в Telegram — должен ответить.
- Пришли код привязки — профиль должен привязаться (`telegram_chat_id` появится в таблице `profiles`).
- `/tasks`, `/habits`, `/add купить хлеб` — должны работать.

## 5. Важно про безопасность

- `SUPABASE_SERVICE_ROLE_KEY` даёт полный доступ к базе в обход всех политик RLS.
  Он должен жить **только** в переменных окружения Railway — никогда не коммить его в git,
  не класть в html/JS сайта.
- `.env` уже стоит добавить в `.gitignore`, если будешь заливать репозиторий на GitHub.

## 6. Что можно доделать дальше

- Индивидуальное время напоминаний на пользователя (сейчас одно время 9:00 / 21:00 для всех,
  задаётся в `index.js` в `cron.schedule(...)`).
- Периодическая чистка просроченных кодов в `telegram_link_codes` (сейчас код просто перестаёт
  работать через 10 минут по времени создания, но строка остаётся в таблице).
- Команда для отвязки Telegram (`/unlink`).
