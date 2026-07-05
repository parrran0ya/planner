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

function isoFromOffset(offsetDays) {
  return DateTime.now().setZone(TZ).plus({ days: offsetDays }).toISODate();
}

function computeStreak(historyObj) {
  let streak = 0, offset = 0;
  while (historyObj[isoFromOffset(-offset)]) { streak++; offset++; }
  return streak;
}

function computeBestStreak(historyObj) {
  const days = Object.keys(historyObj).filter(k => historyObj[k]).sort();
  if (days.length === 0) return 0;
  let best = 1, cur = 1;
  for (let i = 1; i < days.length; i++) {
    const diff = Math.round(
      (new Date(days[i] + 'T00:00:00') - new Date(days[i - 1] + 'T00:00:00')) / 86400000
    );
    cur = diff === 1 ? cur + 1 : 1;
    if (cur > best) best = cur;
  }
  return best;
}

function countTotalDone(historyObj) {
  return Object.values(historyObj).filter(Boolean).length;
}

function findByShortCode(list, code) {
  const c = (code || '').trim().toLowerCase();
  return (list || []).find(item => item.id.toLowerCase().startsWith(c));
}

// ---------- Привязка аккаунта ----------

bot.start(async (ctx) => {
  await ctx.reply(
    'Привет! Я бот твоего планера.\n\n' +
    'Чтобы привязать аккаунт: открой сайт → профиль → «Привязать Telegram», ' +
    'скопируй код и пришли его мне одним сообщением (например: 4F9K2A).\n\n' +
    'Список всех команд после привязки — /help'
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

  ctx.reply('Готово, аккаунт привязан! Список всех команд: /help');
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

bot.command('help', async (ctx) => {
  ctx.reply(
    'Задачи:\n' +
    '/tasks — список · /add текст (в «Сегодня») · /later текст (в «Предстоящее»)\n' +
    '/done код · /deltask код · /taskprivate код\n' +
    '/taskdate код ГГГГ-ММ-ДД · /taskrepeat код none|daily|weekly\n\n' +
    'Привычки:\n' +
    '/habits — список с кнопками · /newhabit название · /habitprivate код · /streak код\n\n' +
    'Друзья:\n' +
    '/addfriend юзернейм · /requests · /accept код · /friends\n' +
    '/friendinfo юзернейм · /leaderboard\n\n' +
    'Финансы:\n' +
    '/spend сумма текст · /income сумма текст · /setbudget сумма · /budget\n\n' +
    'Напоминания:\n' +
    '/remind ЧЧ:ММ текст · /remind daily ЧЧ:ММ текст · /remind weekly ЧЧ:ММ текст\n' +
    '/reminders · /delremind код'
  );
});

// ---------- Задачи ----------

bot.command('tasks', requireProfile, async (ctx) => {
  const { data: tasks } = await sb
    .from('tasks')
    .select('*')
    .eq('user_id', ctx.profile.id)
    .eq('done', false)
    .order('due_date', { ascending: true, nullsFirst: true });

  if (!tasks || tasks.length === 0) return ctx.reply('Активных задач нет 🎉');

  const lines = tasks.slice(0, 30).map(t => {
    const where = t.column_name === 'today' ? 'Сегодня' : 'Предстоящее';
    const date = t.due_date ? ` · ${t.due_date}` : '';
    const rep = t.repeat_rule && t.repeat_rule !== 'none' ? ` 🔁${t.repeat_rule === 'daily' ? 'день' : 'нед'}` : '';
    const lock = t.is_private ? '🔒' : '🌐';
    return `#${t.id.slice(0, 6)} ${lock} [${where}${date}]${rep} — ${t.text}`;
  });

  ctx.reply(
    lines.join('\n') +
    '\n\nКоманды: /done код · /deltask код · /taskprivate код · /taskdate код ГГГГ-ММ-ДД (или "-" чтобы убрать) · /taskrepeat код none|daily|weekly'
  );
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

async function getMyTasks(userId) {
  const { data } = await sb.from('tasks').select('*').eq('user_id', userId).eq('done', false);
  return data || [];
}

bot.command('done', requireProfile, async (ctx) => {
  const code = ctx.message.text.replace(/^\/done(@\w+)?\s*/, '').trim();
  if (!code) return ctx.reply('Использование: /done код (код см. в /tasks)');

  const tasks = await getMyTasks(ctx.profile.id);
  const task = findByShortCode(tasks, code);
  if (!task) return ctx.reply('Не нашёл задачу с таким кодом.');

  await sb.from('tasks').update({ done: true, done_at: new Date().toISOString() }).eq('id', task.id);

  // Повторяющаяся задача с датой — создаём следующую копию, как на сайте
  if (task.repeat_rule && task.repeat_rule !== 'none' && task.due_date) {
    const next = new Date(task.due_date + 'T00:00:00');
    next.setDate(next.getDate() + (task.repeat_rule === 'daily' ? 1 : 7));
    const nextIso = next.getFullYear() + '-' + String(next.getMonth() + 1).padStart(2, '0') + '-' + String(next.getDate()).padStart(2, '0');

    await sb.from('tasks').insert({
      user_id: ctx.profile.id,
      column_name: task.column_name,
      text: task.text,
      is_private: task.is_private,
      due_date: nextIso,
      repeat_rule: task.repeat_rule,
    });
  }

  ctx.reply(`Выполнено: ${task.text}`);
});

bot.command('deltask', requireProfile, async (ctx) => {
  const code = ctx.message.text.replace(/^\/deltask(@\w+)?\s*/, '').trim();
  if (!code) return ctx.reply('Использование: /deltask код');

  const tasks = await getMyTasks(ctx.profile.id);
  const task = findByShortCode(tasks, code);
  if (!task) return ctx.reply('Не нашёл задачу с таким кодом.');

  await sb.from('tasks').delete().eq('id', task.id);
  ctx.reply(`Удалил: ${task.text}`);
});

bot.command('taskprivate', requireProfile, async (ctx) => {
  const code = ctx.message.text.replace(/^\/taskprivate(@\w+)?\s*/, '').trim();
  if (!code) return ctx.reply('Использование: /taskprivate код');

  const tasks = await getMyTasks(ctx.profile.id);
  const task = findByShortCode(tasks, code);
  if (!task) return ctx.reply('Не нашёл задачу с таким кодом.');

  await sb.from('tasks').update({ is_private: !task.is_private }).eq('id', task.id);
  ctx.reply(task.is_private ? 'Теперь видно друзьям 🌐' : 'Теперь приватно 🔒');
});

bot.command('taskdate', requireProfile, async (ctx) => {
  const raw = ctx.message.text.replace(/^\/taskdate(@\w+)?\s*/, '').trim();
  const match = raw.match(/^(\S+)\s+(\d{4}-\d{2}-\d{2}|-)$/);
  if (!match) return ctx.reply('Использование: /taskdate код ГГГГ-ММ-ДД (или /taskdate код - чтобы убрать дату)');

  const [, code, dateArg] = match;
  const tasks = await getMyTasks(ctx.profile.id);
  const task = findByShortCode(tasks, code);
  if (!task) return ctx.reply('Не нашёл задачу с таким кодом.');

  const due_date = dateArg === '-' ? null : dateArg;
  await sb.from('tasks').update({ due_date }).eq('id', task.id);
  ctx.reply(due_date ? `Дата: ${due_date}` : 'Дата убрана.');
});

bot.command('taskrepeat', requireProfile, async (ctx) => {
  const raw = ctx.message.text.replace(/^\/taskrepeat(@\w+)?\s*/, '').trim();
  const match = raw.match(/^(\S+)\s+(none|daily|weekly)$/);
  if (!match) return ctx.reply('Использование: /taskrepeat код none|daily|weekly');

  const [, code, rule] = match;
  const tasks = await getMyTasks(ctx.profile.id);
  const task = findByShortCode(tasks, code);
  if (!task) return ctx.reply('Не нашёл задачу с таким кодом.');

  const updates = { repeat_rule: rule };
  if (rule !== 'none' && !task.due_date) updates.due_date = todayISO();

  await sb.from('tasks').update(updates).eq('id', task.id);
  ctx.reply(`Повтор: ${rule === 'none' ? 'выключен' : rule === 'daily' ? 'каждый день' : 'каждую неделю'}`);
});

// ---------- Привычки ----------

bot.command('habits', requireProfile, async (ctx) => {
  const { data: habits } = await sb.from('habits').select('*').eq('user_id', ctx.profile.id).order('created_at');
  if (!habits || habits.length === 0) return ctx.reply('Привычек пока нет. Создать: /newhabit название');

  const today = todayISO();
  for (const h of habits) {
    const done = !!(h.history || {})[today];
    const lock = h.is_private ? '🔒' : '🌐';
    await ctx.reply(
      `#${h.id.slice(0, 6)} ${lock} ${done ? '✅' : '◻️'} ${h.name}`,
      Markup.inlineKeyboard([
        Markup.button.callback(done ? 'Снять отметку' : 'Отметить выполненной', `habit:${h.id}`),
      ])
    );
  }
  ctx.reply('Ещё: /newhabit название · /habitprivate код · /streak код');
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
  const lock = habit.is_private ? '🔒' : '🌐';
  await ctx.editMessageText(`#${habit.id.slice(0, 6)} ${lock} ${history[today] ? '✅' : '◻️'} ${habit.name}`);
});

bot.command('newhabit', requireProfile, async (ctx) => {
  const name = ctx.message.text.replace(/^\/newhabit(@\w+)?\s*/, '').trim();
  if (!name) return ctx.reply('Использование: /newhabit читать 20 минут');

  await sb.from('habits').insert({ user_id: ctx.profile.id, name, history: {}, is_private: true });
  ctx.reply(`Создал привычку: ${name}`);
});

bot.command('habitprivate', requireProfile, async (ctx) => {
  const code = ctx.message.text.replace(/^\/habitprivate(@\w+)?\s*/, '').trim();
  if (!code) return ctx.reply('Использование: /habitprivate код');

  const { data: habits } = await sb.from('habits').select('*').eq('user_id', ctx.profile.id);
  const habit = findByShortCode(habits, code);
  if (!habit) return ctx.reply('Не нашёл привычку с таким кодом.');

  await sb.from('habits').update({ is_private: !habit.is_private }).eq('id', habit.id);
  ctx.reply(habit.is_private ? 'Теперь видно друзьям 🌐' : 'Теперь приватно 🔒');
});

bot.command('streak', requireProfile, async (ctx) => {
  const code = ctx.message.text.replace(/^\/streak(@\w+)?\s*/, '').trim();
  if (!code) return ctx.reply('Использование: /streak код (код см. в /habits)');

  const { data: habits } = await sb.from('habits').select('*').eq('user_id', ctx.profile.id);
  const habit = findByShortCode(habits, code);
  if (!habit) return ctx.reply('Не нашёл привычку с таким кодом.');

  const history = habit.history || {};
  const current = computeStreak(history);
  const best = computeBestStreak(history);
  const total = countTotalDone(history);

  // Мини-теплокарта за последние 28 дней, по 7 в строке (старые сверху)
  const days = [];
  for (let i = 27; i >= 0; i--) days.push(isoFromOffset(-i));
  let grid = '';
  days.forEach((iso, idx) => {
    grid += history[iso] ? '🟩' : '⬜';
    if (idx % 7 === 6) grid += '\n';
  });

  ctx.reply(
    `${habit.name}\n\n` +
    `Текущий стрик: ${current} 🔥\nЛучший стрик: ${best}\nВсего дней: ${total}\n\n` +
    `Последние 4 недели:\n${grid}`
  );
});

// ---------- Друзья ----------

async function getUsername(userId) {
  const { data } = await sb.from('profiles').select('username').eq('id', userId).maybeSingle();
  return data ? data.username : '?';
}

bot.command('addfriend', requireProfile, async (ctx) => {
  const username = ctx.message.text.replace(/^\/addfriend(@\w+)?\s*/, '').trim();
  if (!username) return ctx.reply('Использование: /addfriend юзернейм');
  if (username === ctx.profile.username) return ctx.reply('Это же ты 🙂');

  const { data: target } = await sb.from('profiles').select('id, username').eq('username', username).maybeSingle();
  if (!target) return ctx.reply('Пользователь с таким юзернеймом не найден.');

  const { data: existing } = await sb
    .from('friendships')
    .select('*')
    .or(
      `and(requester_id.eq.${ctx.profile.id},addressee_id.eq.${target.id}),and(requester_id.eq.${target.id},addressee_id.eq.${ctx.profile.id})`
    )
    .maybeSingle();

  if (existing) return ctx.reply('Заявка или дружба с этим пользователем уже есть.');

  await sb.from('friendships').insert({ requester_id: ctx.profile.id, addressee_id: target.id, status: 'pending' });
  ctx.reply(`Заявка отправлена: @${target.username}`);
});

bot.command('requests', requireProfile, async (ctx) => {
  const { data } = await sb.from('friendships').select('*').eq('addressee_id', ctx.profile.id).eq('status', 'pending');
  if (!data || data.length === 0) return ctx.reply('Входящих заявок нет.');

  const lines = [];
  for (const f of data) {
    const username = await getUsername(f.requester_id);
    lines.push(`#${f.id.slice(0, 6)} — @${username}`);
  }
  ctx.reply(lines.join('\n') + '\n\nПринять: /accept код');
});

bot.command('accept', requireProfile, async (ctx) => {
  const code = ctx.message.text.replace(/^\/accept(@\w+)?\s*/, '').trim();
  if (!code) return ctx.reply('Использование: /accept код (код см. в /requests)');

  const { data } = await sb.from('friendships').select('*').eq('addressee_id', ctx.profile.id).eq('status', 'pending');
  const found = findByShortCode(data, code);
  if (!found) return ctx.reply('Не нашёл заявку с таким кодом.');

  await sb.from('friendships').update({ status: 'accepted' }).eq('id', found.id);
  const username = await getUsername(found.requester_id);
  ctx.reply(`Теперь вы друзья с @${username}`);
});

async function getAcceptedFriends(userId) {
  const { data } = await sb
    .from('friendships')
    .select('*')
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
    .eq('status', 'accepted');

  return (data || []).map(f => (f.requester_id === userId ? f.addressee_id : f.requester_id));
}

bot.command('friends', requireProfile, async (ctx) => {
  const friendIds = await getAcceptedFriends(ctx.profile.id);
  if (friendIds.length === 0) return ctx.reply('Друзей пока нет. Добавить: /addfriend юзернейм');

  const lines = [];
  for (const id of friendIds) lines.push(`@${await getUsername(id)}`);
  ctx.reply(lines.join('\n'));
});

bot.command('friendinfo', requireProfile, async (ctx) => {
  const username = ctx.message.text.replace(/^\/friendinfo(@\w+)?\s*/, '').trim();
  if (!username) return ctx.reply('Использование: /friendinfo юзернейм');

  const { data: target } = await sb.from('profiles').select('id, username').eq('username', username).maybeSingle();
  if (!target) return ctx.reply('Пользователь не найден.');

  const friendIds = await getAcceptedFriends(ctx.profile.id);
  if (!friendIds.includes(target.id)) return ctx.reply('Вы не друзья — публичные данные недоступны.');

  const { data: tasks } = await sb.from('tasks').select('column_name, text, done').eq('user_id', target.id).eq('is_private', false).eq('done', false);
  const { data: habits } = await sb.from('habits').select('name, history').eq('user_id', target.id).eq('is_private', false);

  const todayTasks = (tasks || []).filter(t => t.column_name === 'today');
  const weekTasks = (tasks || []).filter(t => t.column_name === 'week');

  let msg = `@${target.username}\n\nСегодня (${todayTasks.length}):\n${todayTasks.map(t => `• ${t.text}`).join('\n') || '—'}\n\n`;
  msg += `Предстоящее (${weekTasks.length}):\n${weekTasks.map(t => `• ${t.text}`).join('\n') || '—'}\n\n`;
  msg += `Привычки:\n${(habits || []).map(h => `• ${h.name} — стрик ${computeStreak(h.history || {})} 🔥`).join('\n') || '—'}`;

  ctx.reply(msg);
});

bot.command('leaderboard', requireProfile, async (ctx) => {
  const { data: myHabits } = await sb.from('habits').select('history').eq('user_id', ctx.profile.id);
  const myTotal = (myHabits || []).reduce((s, h) => s + computeStreak(h.history || {}), 0);
  const entries = [{ username: ctx.profile.username, total: myTotal, isMe: true }];

  const friendIds = await getAcceptedFriends(ctx.profile.id);
  if (friendIds.length > 0) {
    const { data: friendHabits } = await sb.from('habits').select('user_id, history').in('user_id', friendIds).eq('is_private', false);
    const grouped = {};
    (friendHabits || []).forEach(h => {
      grouped[h.user_id] = (grouped[h.user_id] || 0) + computeStreak(h.history || {});
    });
    for (const id of friendIds) {
      entries.push({ username: await getUsername(id), total: grouped[id] || 0, isMe: false });
    }
  }

  entries.sort((a, b) => b.total - a.total);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = entries.map((e, i) => `${i < 3 ? medals[i] + ' ' : '　 '}@${e.username}${e.isMe ? ' (ты)' : ''} — ${e.total} 🔥`);
  ctx.reply(lines.join('\n'));
});

// ---------- Финансы ----------

bot.command('spend', requireProfile, async (ctx) => {
  const raw = ctx.message.text.replace(/^\/spend(@\w+)?\s*/, '').trim();
  const match = raw.match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/s);
  if (!match) return ctx.reply('Использование: /spend 2500 продукты');

  const amount = parseFloat(match[1].replace(',', '.'));
  const text = match[2].trim();

  await sb.from('finance_entries').insert({ user_id: ctx.profile.id, text, amount, type: 'expense' });
  ctx.reply(`Записал трату: ${amount} — ${text}`);
});

bot.command('income', requireProfile, async (ctx) => {
  const raw = ctx.message.text.replace(/^\/income(@\w+)?\s*/, '').trim();
  const match = raw.match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/s);
  if (!match) return ctx.reply('Использование: /income 50000 зарплата');

  const amount = parseFloat(match[1].replace(',', '.'));
  const text = match[2].trim();

  await sb.from('finance_entries').insert({ user_id: ctx.profile.id, text, amount, type: 'income' });
  ctx.reply(`Записал доход: ${amount} — ${text}`);
});

bot.command('setbudget', requireProfile, async (ctx) => {
  const raw = ctx.message.text.replace(/^\/setbudget(@\w+)?\s*/, '').trim();
  const val = parseFloat(raw.replace(',', '.'));
  if (!raw || Number.isNaN(val)) return ctx.reply('Использование: /setbudget 150000');

  await sb.from('finance_budget').upsert({ user_id: ctx.profile.id, budget: val });
  ctx.reply(`Бюджет установлен: ${val}`);
});

bot.command('budget', requireProfile, async (ctx) => {
  const { data: entries } = await sb.from('finance_entries').select('amount, type').eq('user_id', ctx.profile.id);
  const { data: budgetRow } = await sb.from('finance_budget').select('*').eq('user_id', ctx.profile.id).maybeSingle();

  const budget = budgetRow ? Number(budgetRow.budget) : 0;
  const spent = (entries || []).filter(e => e.type === 'expense').reduce((s, e) => s + Number(e.amount), 0);
  const income = (entries || []).filter(e => e.type === 'income').reduce((s, e) => s + Number(e.amount), 0);
  const remaining = budget - spent + income;

  ctx.reply(
    `Бюджет: ${budget}\nПотрачено: ${spent}\nДоходы: ${income}\nОстаток: ${remaining}`
  );
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
