require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const { DateTime } = require('luxon');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TZ = process.env.TZ || 'Asia/Almaty';

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Не заданы BOT_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// service_role ключ обходит RLS — этот ключ ТОЛЬКО тут, никогда не кладём его на сайт/фронтенд
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const bot = new Telegraf(BOT_TOKEN);

function todayISO() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // формат YYYY-MM-DD
}

// ---------- Привязка аккаунта ----------

bot.start(async (ctx) => {
  await ctx.reply(
    'Привет! Я бот твоего планера.\n\n' +
    'Чтобы привязать аккаунт: открой сайт → профиль → «Привязать Telegram», ' +
    'скопируй код и пришли его мне одним сообщением (например: 4F9K2A).'
  );
});

async function findProfileByChatId(chatId) {
  const { data } = await sb.from('profiles').select('*').eq('telegram_chat_id', chatId).maybeSingle();
  return data;
}

// Ловим любое текстовое сообщение, похожее на код привязки (6 симв, буквы/цифры), если юзер ещё не привязан
bot.hears(/^[A-Za-z0-9]{6}$/, async (ctx) => {
  const existing = await findProfileByChatId(ctx.chat.id);
  if (existing) return; // уже привязан, игнор — дальше сработает обычный обработчик текста

  const code = ctx.message.text.toUpperCase();
  const { data: linkRow } = await sb.from('telegram_link_codes').select('*').eq('code', code).maybeSingle();

  if (!linkRow) {
    return ctx.reply('Код не найден или уже использован. Сгенерируй новый на сайте.');
  }

  const ageMinutes = (Date.now() - new Date(linkRow.created_at).getTime()) / 60000;
  if (ageMinutes > 10) {
    await sb.from('telegram_link_codes').delete().eq('code', code);
    return ctx.reply('Код устарел (действует 10 минут). Сгенерируй новый на сайте.');
  }

  await sb.from('profiles').update({ telegram_chat_id: ctx.chat.id }).eq('id', linkRow.user_id);
  await sb.from('telegram_link_codes').delete().eq('code', code);

  ctx.reply('Готово, аккаунт привязан! Команды: /tasks, /habits, /add текст (в «Сегодня»), /later текст (в «Предстоящее»), /remind ЧЧ:ММ текст (напоминание)');
});

// ---------- Middleware: требуем привязку для остальных команд ----------

async function requireProfile(ctx, next) {
  const profile = await findProfileByChatId(ctx.chat.id);
  if (!profile) {
    return ctx.reply('Сначала привяжи аккаунт — пришли код из настроек сайта.');
  }
  ctx.profile = profile;
  return next();
}

// ---------- Задачи ----------

bot.command('tasks', requireProfile, async (ctx) => {
  const { data: tasks } = await sb
    .from('tasks')
    .select('*')
    .eq('user_id', ctx.profile.id)
    .eq('done', false)
    .order('due_date', { ascending: true });

  if (!tasks || tasks.length === 0) return ctx.reply('Активных задач нет 🎉');

  const lines = tasks.slice(0, 20).map(t => {
    const date = t.due_date ? ` — ${t.due_date}` : '';
    return `• ${t.text}${date}`;
  });
  ctx.reply(lines.join('\n'));
});

bot.command('add', requireProfile, async (ctx) => {
  const text = ctx.message.text.replace(/^\/add(@\w+)?\s*/, '').trim();
  if (!text) return ctx.reply('Использование: /add купить молоко');

  await sb.from('tasks').insert({
    user_id: ctx.profile.id,
    column_name: 'today',
    text,
    is_private: true,
  });

  ctx.reply(`Добавил в «Сегодня»: ${text}`);
});

bot.command('later', requireProfile, async (ctx) => {
  const text = ctx.message.text.replace(/^\/later(@\w+)?\s*/, '').trim();
  if (!text) return ctx.reply('Использование: /later купить подарок на день рождения');

  await sb.from('tasks').insert({
    user_id: ctx.profile.id,
    column_name: 'week',
    text,
    is_private: true,
  });

  ctx.reply(`Добавил в «Предстоящее» (без даты — дату можно выставить на сайте): ${text}`);
});

// ---------- Привычки ----------

bot.command('habits', requireProfile, async (ctx) => {
  const { data: habits } = await sb.from('habits').select('*').eq('user_id', ctx.profile.id).order('created_at');
  if (!habits || habits.length === 0) return ctx.reply('Привычек пока нет.');

  const today = todayISO();
  for (const h of habits) {
    const done = !!(h.history || {})[today];
    await ctx.reply(
      `${done ? '✅' : '◻️'} ${h.name}`,
      Markup.inlineKeyboard([
        Markup.button.callback(done ? 'Снять отметку' : 'Отметить выполненной', `habit:${h.id}`),
      ])
    );
  }
});

bot.action(/^habit:(.+)$/, async (ctx) => {
  const habitId = ctx.match[1];
  const { data: habit } = await sb.from('habits').select('*').eq('id', habitId).maybeSingle();
  if (!habit) return ctx.answerCbQuery('Привычка не найдена');

  const today = todayISO();
  const history = { ...(habit.history || {}) };
  if (history[today]) delete history[today]; else history[today] = true;

  await sb.from('habits').update({ history }).eq('id', habitId);
  await ctx.answerCbQuery(history[today] ? 'Отмечено ✅' : 'Отметка снята');
  await ctx.editMessageText(`${history[today] ? '✅' : '◻️'} ${habit.name}`);
});

// ---------- Гибкие напоминания (разовые и повторяющиеся) ----------

function computeNextTrigger(hour, minute, repeatRule) {
  const now = DateTime.now().setZone(TZ);
  let dt = now.set({ hour, minute, second: 0, millisecond: 0 });
  if (dt <= now) {
    dt = repeatRule === 'weekly' ? dt.plus({ weeks: 1 }) : dt.plus({ days: 1 });
  }
  return dt.toUTC().toISO();
}

bot.command('remind', requireProfile, async (ctx) => {
  const raw = ctx.message.text.replace(/^\/remind(@\w+)?\s*/, '').trim();
  const usage =
    'Использование:\n' +
    '/remind 18:30 позвонить маме — разово, сегодня или завтра в это время\n' +
    '/remind daily 08:00 выпить витамины — каждый день\n' +
    '/remind weekly 19:00 позвонить бабушке — каждую неделю в этот же день недели';

  if (!raw) return ctx.reply(usage);

  let repeatRule = 'none';
  let rest = raw;
  if (/^daily\s+/i.test(rest)) { repeatRule = 'daily'; rest = rest.replace(/^daily\s+/i, ''); }
  else if (/^weekly\s+/i.test(rest)) { repeatRule = 'weekly'; rest = rest.replace(/^weekly\s+/i, ''); }

  const match = rest.match(/^(\d{1,2}):(\d{2})\s+(.+)$/s);
  if (!match) return ctx.reply(usage);

  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const text = match[3].trim();

  if (hour > 23 || minute > 59) return ctx.reply('Время указано неверно — используй 24-часовой формат ЧЧ:ММ.');

  const weekday = DateTime.now().setZone(TZ).weekday; // 1 (пн) .. 7 (вс)
  const nextTrigger = computeNextTrigger(hour, minute, repeatRule);
  const timeOfDay = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  await sb.from('bot_reminders').insert({
    user_id: ctx.profile.id,
    text,
    repeat_rule: repeatRule,
    weekday: repeatRule === 'weekly' ? weekday : null,
    time_of_day: timeOfDay,
    next_trigger: nextTrigger,
  });

  const when = repeatRule === 'none' ? 'разово' : repeatRule === 'daily' ? 'каждый день' : 'каждую неделю';
  ctx.reply(`Напомню (${when}) в ${timeOfDay}: ${text}`);
});

bot.command('reminders', requireProfile, async (ctx) => {
  const { data } = await sb.from('bot_reminders').select('*').eq('user_id', ctx.profile.id).order('next_trigger');
  if (!data || data.length === 0) return ctx.reply('Активных напоминаний нет.');

  const labels = { none: 'разово', daily: 'ежедневно', weekly: 'еженедельно' };
  const lines = data.map(r => `#${r.id.slice(0, 6)} — ${r.time_of_day} (${labels[r.repeat_rule]}) — ${r.text}`);
  ctx.reply(lines.join('\n') + '\n\nУдалить: /delremind код');
});

bot.command('delremind', requireProfile, async (ctx) => {
  const code = ctx.message.text.replace(/^\/delremind(@\w+)?\s*/, '').trim().toLowerCase();
  if (!code) return ctx.reply('Использование: /delremind код (код см. в /reminders)');

  const { data } = await sb.from('bot_reminders').select('id').eq('user_id', ctx.profile.id);
  const found = (data || []).find(r => r.id.startsWith(code));
  if (!found) return ctx.reply('Не нашёл напоминание с таким кодом.');

  await sb.from('bot_reminders').delete().eq('id', found.id);
  ctx.reply('Удалил.');
});

async function checkReminders() {
  const nowIso = new Date().toISOString();
  const { data: due } = await sb
    .from('bot_reminders')
    .select('*, profiles!inner(telegram_chat_id)')
    .lte('next_trigger', nowIso)
    .not('profiles.telegram_chat_id', 'is', null);

  for (const r of due || []) {
    const chatId = r.profiles.telegram_chat_id;
    await bot.telegram.sendMessage(chatId, `⏰ Напоминание: ${r.text}`).catch(() => {});

    if (r.repeat_rule === 'none') {
      await sb.from('bot_reminders').delete().eq('id', r.id);
    } else {
      const prev = DateTime.fromISO(r.next_trigger, { zone: 'utc' });
      const next = r.repeat_rule === 'weekly' ? prev.plus({ weeks: 1 }) : prev.plus({ days: 1 });
      await sb.from('bot_reminders').update({ next_trigger: next.toISO() }).eq('id', r.id);
    }
  }
}

// ---------- Напоминания по расписанию ----------

async function morningReminders() {
  const today = todayISO();
  const { data: tasks } = await sb.from('tasks').select('user_id, text, profiles!inner(telegram_chat_id)')
    .eq('done', false)
    .or(`column_name.eq.today,due_date.eq.${today}`)
    .not('profiles.telegram_chat_id', 'is', null);

  const byChat = {};
  (tasks || []).forEach(t => {
    const chatId = t.profiles.telegram_chat_id;
    (byChat[chatId] ||= []).push(t.text);
  });

  for (const [chatId, texts] of Object.entries(byChat)) {
    const list = texts.map(t => `• ${t}`).join('\n');
    await bot.telegram.sendMessage(chatId, `Доброе утро! На сегодня:\n${list}`).catch(() => {});
  }
}

async function eveningReminders() {
  const { data: profiles } = await sb.from('profiles').select('id, telegram_chat_id').not('telegram_chat_id', 'is', null);
  const today = todayISO();

  for (const p of profiles || []) {
    const { data: habits } = await sb.from('habits').select('name, history').eq('user_id', p.id);
    const undone = (habits || []).filter(h => !(h.history || {})[today]);
    if (undone.length === 0) continue;
    const list = undone.map(h => `◻️ ${h.name}`).join('\n');
    await bot.telegram.sendMessage(
      p.telegram_chat_id,
      `Вечерняя проверка привычек:\n${list}\n\nОтметить — команда /habits`
    ).catch(() => {});
  }
}

cron.schedule('0 9 * * *', morningReminders, { timezone: TZ });
cron.schedule('0 21 * * *', eveningReminders, { timezone: TZ });
cron.schedule('* * * * *', checkReminders, { timezone: TZ });

// ---------- Запуск ----------

bot.launch();
console.log('Бот запущен. TZ =', TZ);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
