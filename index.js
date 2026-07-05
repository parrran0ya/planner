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

// Хранилище "ожидаемого ввода" (человек нажал кнопку, теперь бот ждёт от него текст)
// chatId -> { type: 'add_task' | 'add_habit' | 'add_friend' | 'spend' | 'income' | 'setbudget' | 'add_reminder', ...extra }
const pendingActions = new Map();

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

// ---------- Рендер меню: общий помощник ----------
// Пытается отредактировать текущее сообщение (когда пришли из нажатия кнопки),
// если не получается — присылает новое.
async function renderOrEdit(ctx, text, keyboardRows, edit) {
  const markup = Markup.inlineKeyboard(keyboardRows);
  if (edit) {
    try {
      await ctx.editMessageText(text, markup);
      return;
    } catch (e) {
      const desc = e?.response?.description || e?.message || '';
      if (desc.includes('message is not modified')) return;
      // иначе не получилось отредактировать (например, сообщение слишком старое) — шлём новое
    }
  }
  await ctx.reply(text, markup).catch(() => {});
}

// ---------- Привязка аккаунта ----------

async function findProfileByChatId(chatId) {
  const { data } = await sb.from('profiles').select('*').eq('telegram_chat_id', chatId).maybeSingle();
  return data;
}

bot.start(async (ctx) => {
  const profile = await findProfileByChatId(ctx.chat.id);
  if (profile) {
    ctx.profile = profile;
    await ctx.reply('С возвращением! 👋');
    return renderMainMenu(ctx, false);
  }
  await ctx.reply(
    'Привет! Я бот твоего планера.\n\n' +
    'Чтобы привязать аккаунт: открой сайт → профиль → «Привязать Telegram», ' +
    'скопируй код и пришли его мне одним сообщением (например: 4F9K2A).\n\n' +
    'После привязки набери /menu — появится меню с кнопками.'
  );
});

// Ловим любое текстовое сообщение, похожее на код привязки (6 симв, буквы/цифры), если юзер ещё не привязан
bot.hears(/^[A-Za-z0-9]{6}$/, async (ctx, next) => {
  const existing = await findProfileByChatId(ctx.chat.id);
  if (existing) return next(); // уже привязан — пропускаем дальше, вдруг это ответ на ожидаемый ввод

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

  const profile = await findProfileByChatId(ctx.chat.id);
  ctx.profile = profile;
  await ctx.reply('Готово, аккаунт привязан! 🎉');
  await renderMainMenu(ctx, false);
});

// ---------- Middleware: требуем привязку для команд ----------

async function requireProfile(ctx, next) {
  const profile = await findProfileByChatId(ctx.chat.id);
  if (!profile) {
    return ctx.reply('Сначала привяжи аккаунт — пришли код из настроек сайта.');
  }
  ctx.profile = profile;
  return next();
}

// Обёртка для callback-кнопок с той же проверкой привязки
function actionWithProfile(pattern, handler) {
  bot.action(pattern, async (ctx) => {
    const profile = await findProfileByChatId(ctx.chat.id);
    if (!profile) return ctx.answerCbQuery('Сначала привяжи аккаунт.', { show_alert: true });
    ctx.profile = profile;
    return handler(ctx);
  });
}

function helpText() {
  return (
    '❓ Помощь\n\n' +
    'Открой /menu — там всё управление кнопками: задачи, привычки, друзья, финансы, напоминания.\n\n' +
    'Также работают текстовые команды (для тех, кто предпочитает печатать):\n\n' +
    'Задачи:\n' +
    '/tasks · /add текст · /later текст · /done код · /deltask код · /taskprivate код\n' +
    '/taskdate код ГГГГ-ММ-ДД · /taskrepeat код none|daily|weekly\n\n' +
    'Привычки:\n' +
    '/habits · /newhabit название · /habitprivate код · /streak код\n\n' +
    'Друзья:\n' +
    '/addfriend юзернейм · /requests · /accept код · /friends · /friendinfo юзернейм · /leaderboard\n\n' +
    'Финансы:\n' +
    '/spend сумма текст · /income сумма текст · /setbudget сумма · /budget\n\n' +
    'Напоминания:\n' +
    '/remind ЧЧ:ММ текст · /remind daily ЧЧ:ММ текст · /remind weekly ЧЧ:ММ текст\n' +
    '/reminders · /delremind код'
  );
}

async function renderHelp(ctx, edit = false) {
  await renderOrEdit(ctx, helpText(), [[Markup.button.callback('⬅️ Меню', 'menu:main')]], edit);
}

bot.command('help', (ctx) => renderHelp(ctx, false));

// ---------- Главное меню ----------

function mainMenuKeyboard() {
  return [
    [Markup.button.callback('📋 Задачи', 'menu:tasks'), Markup.button.callback('✅ Привычки', 'menu:habits')],
    [Markup.button.callback('👥 Друзья', 'menu:friends'), Markup.button.callback('💰 Финансы', 'menu:finance')],
    [Markup.button.callback('⏰ Напоминания', 'menu:reminders')],
    [Markup.button.callback('❓ Помощь', 'menu:help')],
  ];
}

async function renderMainMenu(ctx, edit = false) {
  await renderOrEdit(ctx, '🏠 Главное меню\n\nВыбери раздел:', mainMenuKeyboard(), edit);
}

bot.command('menu', requireProfile, (ctx) => renderMainMenu(ctx, false));

actionWithProfile(/^menu:(main|tasks|habits|friends|finance|reminders|help)$/, async (ctx) => {
  const section = ctx.match[1];
  await ctx.answerCbQuery();
  if (section === 'main') return renderMainMenu(ctx, true);
  if (section === 'tasks') return renderTasksMenu(ctx, true);
  if (section === 'habits') return renderHabitsMenu(ctx, true);
  if (section === 'friends') return renderFriendsMenu(ctx, true);
  if (section === 'finance') return renderFinanceMenu(ctx, true);
  if (section === 'reminders') return renderRemindersMenu(ctx, true);
  if (section === 'help') return renderHelp(ctx, true);
});

// ================== ЗАДАЧИ ==================

async function getMyTasks(userId) {
  const { data } = await sb.from('tasks').select('*').eq('user_id', userId).eq('done', false);
  return data || [];
}

async function renderTasksMenu(ctx, edit = false) {
  const profile = ctx.profile || (await findProfileByChatId(ctx.chat.id));
  const { data: tasks } = await sb
    .from('tasks')
    .select('*')
    .eq('user_id', profile.id)
    .eq('done', false)
    .order('due_date', { ascending: true, nullsFirst: true });

  const list = (tasks || []).slice(0, 12);
  let text = '📋 Задачи\n\n';
  const keyboard = [];

  if (list.length === 0) {
    text += 'Активных задач нет 🎉';
  } else {
    list.forEach((t, i) => {
      const where = t.column_name === 'today' ? 'Сегодня' : 'Предстоящее';
      const date = t.due_date ? ` · ${t.due_date}` : '';
      const rep = t.repeat_rule && t.repeat_rule !== 'none' ? ` 🔁${t.repeat_rule === 'daily' ? 'день' : 'нед'}` : '';
      const lock = t.is_private ? '🔒' : '🌐';
      text += `${i + 1}. ${lock} [${where}${date}]${rep} — ${t.text}\n`;
      keyboard.push([
        Markup.button.callback(`✅ ${i + 1}`, `task:done:${t.id}`),
        Markup.button.callback(t.is_private ? `🌐 ${i + 1}` : `🔒 ${i + 1}`, `task:priv:${t.id}`),
        Markup.button.callback(`🗑 ${i + 1}`, `task:del:${t.id}`),
      ]);
    });
    if ((tasks || []).length > 12) {
      text += `\n…и ещё ${tasks.length - 12}. Полный список — на сайте.`;
    }
    text += '\n\nИзменить дату/повтор: /taskdate код и /taskrepeat код (код см. на сайте или /tasks текстом).';
  }

  keyboard.push([
    Markup.button.callback('➕ Сегодня', 'task:add:today'),
    Markup.button.callback('➕ Предстоящее', 'task:add:week'),
  ]);
  keyboard.push([Markup.button.callback('⬅️ Меню', 'menu:main')]);

  await renderOrEdit(ctx, text, keyboard, edit);
}

bot.command('tasks', requireProfile, (ctx) => renderTasksMenu(ctx, false));

bot.command('add', requireProfile, async (ctx) => {
  const text = ctx.message.text.replace(/^\/add(@\w+)?\s*/, '').trim();
  if (!text) return ctx.reply('Использование: /add купить молоко');
  await sb.from('tasks').insert({ user_id: ctx.profile.id, column_name: 'today', text, is_private: true });
  await ctx.reply(`Добавил в «Сегодня»: ${text}`);
  await renderTasksMenu(ctx, false);
});

bot.command('later', requireProfile, async (ctx) => {
  const text = ctx.message.text.replace(/^\/later(@\w+)?\s*/, '').trim();
  if (!text) return ctx.reply('Использование: /later купить подарок на день рождения');
  await sb.from('tasks').insert({ user_id: ctx.profile.id, column_name: 'week', text, is_private: true });
  await ctx.reply(`Добавил в «Предстоящее»: ${text}`);
  await renderTasksMenu(ctx, false);
});

bot.command('done', requireProfile, async (ctx) => {
  const code = ctx.message.text.replace(/^\/done(@\w+)?\s*/, '').trim();
  if (!code) return ctx.reply('Использование: /done код (код см. в /tasks)');
  const tasks = await getMyTasks(ctx.profile.id);
  const task = findByShortCode(tasks, code);
  if (!task) return ctx.reply('Не нашёл задачу с таким кодом.');
  await completeTask(ctx.profile.id, task);
  ctx.reply(`Выполнено: ${task.text}`);
});

async function completeTask(userId, task) {
  await sb.from('tasks').update({ done: true, done_at: new Date().toISOString() }).eq('id', task.id);
  if (task.repeat_rule && task.repeat_rule !== 'none' && task.due_date) {
    const next = new Date(task.due_date + 'T00:00:00');
    next.setDate(next.getDate() + (task.repeat_rule === 'daily' ? 1 : 7));
    const nextIso = next.getFullYear() + '-' + String(next.getMonth() + 1).padStart(2, '0') + '-' + String(next.getDate()).padStart(2, '0');
    await sb.from('tasks').insert({
      user_id: userId,
      column_name: task.column_name,
      text: task.text,
      is_private: task.is_private,
      due_date: nextIso,
      repeat_rule: task.repeat_rule,
    });
  }
}

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

actionWithProfile(/^task:done:(.+)$/, async (ctx) => {
  const taskId = ctx.match[1];
  const { data: task } = await sb.from('tasks').select('*').eq('id', taskId).eq('user_id', ctx.profile.id).maybeSingle();
  if (!task) return ctx.answerCbQuery('Не найдено');
  await completeTask(ctx.profile.id, task);
  await ctx.answerCbQuery('Готово ✅');
  await renderTasksMenu(ctx, true);
});

actionWithProfile(/^task:priv:(.+)$/, async (ctx) => {
  const { data: task } = await sb.from('tasks').select('*').eq('id', ctx.match[1]).eq('user_id', ctx.profile.id).maybeSingle();
  if (!task) return ctx.answerCbQuery('Не найдено');
  await sb.from('tasks').update({ is_private: !task.is_private }).eq('id', task.id);
  await ctx.answerCbQuery(task.is_private ? 'Теперь видно друзьям 🌐' : 'Теперь приватно 🔒');
  await renderTasksMenu(ctx, true);
});

actionWithProfile(/^task:del:(.+)$/, async (ctx) => {
  const { data: task } = await sb.from('tasks').select('id').eq('id', ctx.match[1]).eq('user_id', ctx.profile.id).maybeSingle();
  if (!task) return ctx.answerCbQuery('Не найдено');
  await sb.from('tasks').delete().eq('id', task.id);
  await ctx.answerCbQuery('Удалено 🗑');
  await renderTasksMenu(ctx, true);
});

actionWithProfile(/^task:add:(today|week)$/, async (ctx) => {
  const column = ctx.match[1];
  pendingActions.set(ctx.chat.id, { type: 'add_task', column });
  await ctx.answerCbQuery();
  await ctx.reply(column === 'today' ? 'Пришли текст задачи для «Сегодня»:' : 'Пришли текст задачи для «Предстоящее»:');
});

// ================== ПРИВЫЧКИ ==================

async function renderHabitsMenu(ctx, edit = false) {
  const profile = ctx.profile || (await findProfileByChatId(ctx.chat.id));
  const { data: habits } = await sb.from('habits').select('*').eq('user_id', profile.id).order('created_at');
  const today = todayISO();
  let text = '✅ Привычки\n\n';
  const keyboard = [];

  if (!habits || habits.length === 0) {
    text += 'Привычек пока нет.';
  } else {
    habits.forEach((h, i) => {
      const done = !!(h.history || {})[today];
      const lock = h.is_private ? '🔒' : '🌐';
      const streak = computeStreak(h.history || {});
      text += `${i + 1}. ${lock} ${done ? '✅' : '◻️'} ${h.name} — стрик ${streak}🔥\n`;
      keyboard.push([
        Markup.button.callback(done ? `◻️ ${i + 1}` : `✅ ${i + 1}`, `habit:toggle:${h.id}`),
        Markup.button.callback(h.is_private ? `🌐 ${i + 1}` : `🔒 ${i + 1}`, `habit:priv:${h.id}`),
        Markup.button.callback(`📈 ${i + 1}`, `habit:streak:${h.id}`),
        Markup.button.callback(`🗑 ${i + 1}`, `habit:del:${h.id}`),
      ]);
    });
  }

  keyboard.push([Markup.button.callback('➕ Новая привычка', 'habit:add')]);
  keyboard.push([Markup.button.callback('⬅️ Меню', 'menu:main')]);

  await renderOrEdit(ctx, text, keyboard, edit);
}

bot.command('habits', requireProfile, (ctx) => renderHabitsMenu(ctx, false));

bot.command('newhabit', requireProfile, async (ctx) => {
  const name = ctx.message.text.replace(/^\/newhabit(@\w+)?\s*/, '').trim();
  if (!name) return ctx.reply('Использование: /newhabit читать 20 минут');
  await sb.from('habits').insert({ user_id: ctx.profile.id, name, history: {}, is_private: true });
  await ctx.reply(`Создал привычку: ${name}`);
  await renderHabitsMenu(ctx, false);
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

function streakMessage(habit) {
  const history = habit.history || {};
  const current = computeStreak(history);
  const best = computeBestStreak(history);
  const total = countTotalDone(history);
  const days = [];
  for (let i = 27; i >= 0; i--) days.push(isoFromOffset(-i));
  let grid = '';
  days.forEach((iso, idx) => {
    grid += history[iso] ? '🟩' : '⬜';
    if (idx % 7 === 6) grid += '\n';
  });
  return `${habit.name}\n\nТекущий стрик: ${current} 🔥\nЛучший стрик: ${best}\nВсего дней: ${total}\n\nПоследние 4 недели:\n${grid}`;
}

bot.command('streak', requireProfile, async (ctx) => {
  const code = ctx.message.text.replace(/^\/streak(@\w+)?\s*/, '').trim();
  if (!code) return ctx.reply('Использование: /streak код (код см. в /habits)');
  const { data: habits } = await sb.from('habits').select('*').eq('user_id', ctx.profile.id);
  const habit = findByShortCode(habits, code);
  if (!habit) return ctx.reply('Не нашёл привычку с таким кодом.');
  ctx.reply(streakMessage(habit));
});

actionWithProfile(/^habit:toggle:(.+)$/, async (ctx) => {
  const { data: habit } = await sb.from('habits').select('*').eq('id', ctx.match[1]).eq('user_id', ctx.profile.id).maybeSingle();
  if (!habit) return ctx.answerCbQuery('Не найдено');
  const today = todayISO();
  const history = { ...(habit.history || {}) };
  if (history[today]) delete history[today]; else history[today] = true;
  await sb.from('habits').update({ history }).eq('id', habit.id);
  await ctx.answerCbQuery(history[today] ? 'Отмечено ✅' : 'Отметка снята');
  await renderHabitsMenu(ctx, true);
});

actionWithProfile(/^habit:priv:(.+)$/, async (ctx) => {
  const { data: habit } = await sb.from('habits').select('*').eq('id', ctx.match[1]).eq('user_id', ctx.profile.id).maybeSingle();
  if (!habit) return ctx.answerCbQuery('Не найдено');
  await sb.from('habits').update({ is_private: !habit.is_private }).eq('id', habit.id);
  await ctx.answerCbQuery(habit.is_private ? 'Теперь видно друзьям 🌐' : 'Теперь приватно 🔒');
  await renderHabitsMenu(ctx, true);
});

actionWithProfile(/^habit:del:(.+)$/, async (ctx) => {
  const { data: habit } = await sb.from('habits').select('id').eq('id', ctx.match[1]).eq('user_id', ctx.profile.id).maybeSingle();
  if (!habit) return ctx.answerCbQuery('Не найдено');
  await sb.from('habits').delete().eq('id', habit.id);
  await ctx.answerCbQuery('Удалено 🗑');
  await renderHabitsMenu(ctx, true);
});

actionWithProfile(/^habit:streak:(.+)$/, async (ctx) => {
  const { data: habit } = await sb.from('habits').select('*').eq('id', ctx.match[1]).eq('user_id', ctx.profile.id).maybeSingle();
  if (!habit) return ctx.answerCbQuery('Не найдено');
  await ctx.answerCbQuery();
  await ctx.reply(streakMessage(habit), Markup.inlineKeyboard([[Markup.button.callback('⬅️ Привычки', 'menu:habits')]]));
});

actionWithProfile('habit:add', async (ctx) => {
  pendingActions.set(ctx.chat.id, { type: 'add_habit' });
  await ctx.answerCbQuery();
  await ctx.reply('Пришли название новой привычки:');
});

// ================== ДРУЗЬЯ ==================

async function getUsername(userId) {
  const { data } = await sb.from('profiles').select('username').eq('id', userId).maybeSingle();
  return data ? data.username : '?';
}

async function getAcceptedFriends(userId) {
  const { data } = await sb
    .from('friendships')
    .select('*')
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
    .eq('status', 'accepted');
  return (data || []).map((f) => (f.requester_id === userId ? f.addressee_id : f.requester_id));
}

async function renderFriendsMenu(ctx, edit = false) {
  const text = '👥 Друзья\n\nВыбери действие:';
  const keyboard = [
    [Markup.button.callback('📨 Заявки', 'friend:requests')],
    [Markup.button.callback('👥 Мои друзья', 'friend:list')],
    [Markup.button.callback('🏆 Рейтинг', 'friend:leaderboard')],
    [Markup.button.callback('➕ Добавить друга', 'friend:add')],
    [Markup.button.callback('⬅️ Меню', 'menu:main')],
  ];
  await renderOrEdit(ctx, text, keyboard, edit);
}

bot.command('friends', requireProfile, async (ctx) => {
  const friendIds = await getAcceptedFriends(ctx.profile.id);
  if (friendIds.length === 0) return ctx.reply('Друзей пока нет. Добавить: /addfriend юзернейм');
  const lines = [];
  for (const id of friendIds) lines.push(`@${await getUsername(id)}`);
  ctx.reply(lines.join('\n'));
});

bot.command('addfriend', requireProfile, async (ctx) => {
  const username = ctx.message.text.replace(/^\/addfriend(@\w+)?\s*/, '').trim().replace('@', '');
  if (!username) return ctx.reply('Использование: /addfriend юзернейм');
  await sendFriendRequest(ctx, username);
});

async function sendFriendRequest(ctx, username) {
  if (username === ctx.profile.username) return ctx.reply('Это же ты 🙂');
  const { data: target } = await sb.from('profiles').select('id, username').eq('username', username).maybeSingle();
  if (!target) return ctx.reply('Пользователь с таким юзернеймом не найден.');
  const { data: existing } = await sb
    .from('friendships')
    .select('*')
    .or(`and(requester_id.eq.${ctx.profile.id},addressee_id.eq.${target.id}),and(requester_id.eq.${target.id},addressee_id.eq.${ctx.profile.id})`)
    .maybeSingle();
  if (existing) return ctx.reply('Заявка или дружба с этим пользователем уже есть.');
  await sb.from('friendships').insert({ requester_id: ctx.profile.id, addressee_id: target.id, status: 'pending' });
  ctx.reply(`Заявка отправлена: @${target.username}`);
}

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

bot.command('friendinfo', requireProfile, async (ctx) => {
  const username = ctx.message.text.replace(/^\/friendinfo(@\w+)?\s*/, '').trim().replace('@', '');
  if (!username) return ctx.reply('Использование: /friendinfo юзернейм');
  const { data: target } = await sb.from('profiles').select('id, username').eq('username', username).maybeSingle();
  if (!target) return ctx.reply('Пользователь не найден.');
  const friendIds = await getAcceptedFriends(ctx.profile.id);
  if (!friendIds.includes(target.id)) return ctx.reply('Вы не друзья — публичные данные недоступны.');
  ctx.reply(await friendInfoText(target.id, target.username));
});

async function friendInfoText(targetId, username) {
  const { data: tasks } = await sb.from('tasks').select('column_name, text, done').eq('user_id', targetId).eq('is_private', false).eq('done', false);
  const { data: habits } = await sb.from('habits').select('name, history').eq('user_id', targetId).eq('is_private', false);
  const todayTasks = (tasks || []).filter((t) => t.column_name === 'today');
  const weekTasks = (tasks || []).filter((t) => t.column_name === 'week');
  let msg = `@${username}\n\nСегодня (${todayTasks.length}):\n${todayTasks.map((t) => `• ${t.text}`).join('\n') || '—'}\n\n`;
  msg += `Предстоящее (${weekTasks.length}):\n${weekTasks.map((t) => `• ${t.text}`).join('\n') || '—'}\n\n`;
  msg += `Привычки:\n${(habits || []).map((h) => `• ${h.name} — стрик ${computeStreak(h.history || {})} 🔥`).join('\n') || '—'}`;
  return msg;
}

async function leaderboardText(profile) {
  const { data: myHabits } = await sb.from('habits').select('history').eq('user_id', profile.id);
  const myTotal = (myHabits || []).reduce((s, h) => s + computeStreak(h.history || {}), 0);
  const entries = [{ username: profile.username, total: myTotal, isMe: true }];

  const friendIds = await getAcceptedFriends(profile.id);
  if (friendIds.length > 0) {
    const { data: friendHabits } = await sb.from('habits').select('user_id, history').in('user_id', friendIds).eq('is_private', false);
    const grouped = {};
    (friendHabits || []).forEach((h) => {
      grouped[h.user_id] = (grouped[h.user_id] || 0) + computeStreak(h.history || {});
    });
    for (const id of friendIds) {
      entries.push({ username: await getUsername(id), total: grouped[id] || 0, isMe: false });
    }
  }

  entries.sort((a, b) => b.total - a.total);
  const medals = ['🥇', '🥈', '🥉'];
  return entries.map((e, i) => `${i < 3 ? medals[i] + ' ' : '　 '}@${e.username}${e.isMe ? ' (ты)' : ''} — ${e.total} 🔥`).join('\n');
}

bot.command('leaderboard', requireProfile, async (ctx) => {
  ctx.reply(await leaderboardText(ctx.profile));
});

actionWithProfile('friend:requests', async (ctx) => {
  await ctx.answerCbQuery();
  const { data } = await sb.from('friendships').select('*').eq('addressee_id', ctx.profile.id).eq('status', 'pending');
  let text = '📨 Входящие заявки\n\n';
  const keyboard = [];
  if (!data || data.length === 0) {
    text += 'Заявок нет.';
  } else {
    for (const f of data) {
      const username = await getUsername(f.requester_id);
      text += `@${username}\n`;
      keyboard.push([Markup.button.callback(`✅ Принять @${username}`, `friend:accept:${f.id}`)]);
    }
  }
  keyboard.push([Markup.button.callback('⬅️ Друзья', 'friend:back')]);
  await renderOrEdit(ctx, text, keyboard, true);
});

actionWithProfile(/^friend:accept:(.+)$/, async (ctx) => {
  const { data: found } = await sb.from('friendships').select('*').eq('id', ctx.match[1]).eq('addressee_id', ctx.profile.id).maybeSingle();
  if (!found) return ctx.answerCbQuery('Не найдено');
  await sb.from('friendships').update({ status: 'accepted' }).eq('id', found.id);
  await ctx.answerCbQuery('Приняли ✅');
  const username = await getUsername(found.requester_id);
  await ctx.reply(`Теперь вы друзья с @${username}`);
  // перерисовываем список заявок
  const fakeCtx = ctx;
  const { data } = await sb.from('friendships').select('*').eq('addressee_id', ctx.profile.id).eq('status', 'pending');
  let text = '📨 Входящие заявки\n\n';
  const keyboard = [];
  if (!data || data.length === 0) {
    text += 'Заявок нет.';
  } else {
    for (const f of data) {
      const uname = await getUsername(f.requester_id);
      text += `@${uname}\n`;
      keyboard.push([Markup.button.callback(`✅ Принять @${uname}`, `friend:accept:${f.id}`)]);
    }
  }
  keyboard.push([Markup.button.callback('⬅️ Друзья', 'friend:back')]);
  await renderOrEdit(fakeCtx, text, keyboard, true);
});

actionWithProfile('friend:list', async (ctx) => {
  await ctx.answerCbQuery();
  const friendIds = await getAcceptedFriends(ctx.profile.id);
  let text = '👥 Мои друзья\n\n';
  const keyboard = [];
  if (friendIds.length === 0) {
    text += 'Друзей пока нет.';
  } else {
    for (const id of friendIds) {
      const username = await getUsername(id);
      text += `@${username}\n`;
      keyboard.push([Markup.button.callback(`ℹ️ @${username}`, `friend:info:${id}`)]);
    }
  }
  keyboard.push([Markup.button.callback('⬅️ Друзья', 'friend:back')]);
  await renderOrEdit(ctx, text, keyboard, true);
});

actionWithProfile(/^friend:info:(.+)$/, async (ctx) => {
  const targetId = ctx.match[1];
  const friendIds = await getAcceptedFriends(ctx.profile.id);
  if (!friendIds.includes(targetId)) return ctx.answerCbQuery('Вы не друзья');
  await ctx.answerCbQuery();
  const username = await getUsername(targetId);
  const text = await friendInfoText(targetId, username);
  await renderOrEdit(ctx, text, [[Markup.button.callback('⬅️ Друзья', 'friend:list')]], true);
});

actionWithProfile('friend:leaderboard', async (ctx) => {
  await ctx.answerCbQuery();
  const text = '🏆 Рейтинг\n\n' + (await leaderboardText(ctx.profile));
  await renderOrEdit(ctx, text, [[Markup.button.callback('⬅️ Друзья', 'friend:back')]], true);
});

actionWithProfile('friend:add', async (ctx) => {
  pendingActions.set(ctx.chat.id, { type: 'add_friend' });
  await ctx.answerCbQuery();
  await ctx.reply('Пришли юзернейм друга (без @):');
});

actionWithProfile('friend:back', (ctx) => {
  ctx.answerCbQuery();
  return renderFriendsMenu(ctx, true);
});

// ================== ФИНАНСЫ ==================

async function renderFinanceMenu(ctx, edit = false) {
  const profile = ctx.profile || (await findProfileByChatId(ctx.chat.id));
  const { data: entries } = await sb.from('finance_entries').select('amount, type').eq('user_id', profile.id);
  const { data: budgetRow } = await sb.from('finance_budget').select('*').eq('user_id', profile.id).maybeSingle();
  const budget = budgetRow ? Number(budgetRow.budget) : 0;
  const spent = (entries || []).filter((e) => e.type === 'expense').reduce((s, e) => s + Number(e.amount), 0);
  const income = (entries || []).filter((e) => e.type === 'income').reduce((s, e) => s + Number(e.amount), 0);
  const remaining = budget - spent + income;

  const text = `💰 Финансы\n\nБюджет: ${budget}\nПотрачено: ${spent}\nДоходы: ${income}\nОстаток: ${remaining}`;
  const keyboard = [
    [Markup.button.callback('➖ Добавить трату', 'fin:spend'), Markup.button.callback('➕ Добавить доход', 'fin:income')],
    [Markup.button.callback('🎯 Установить бюджет', 'fin:setbudget')],
    [Markup.button.callback('⬅️ Меню', 'menu:main')],
  ];
  await renderOrEdit(ctx, text, keyboard, edit);
}

bot.command('budget', requireProfile, (ctx) => renderFinanceMenu(ctx, false));

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

actionWithProfile('fin:spend', async (ctx) => {
  pendingActions.set(ctx.chat.id, { type: 'spend' });
  await ctx.answerCbQuery();
  await ctx.reply('Пришли сумму и описание, например: 2500 продукты');
});

actionWithProfile('fin:income', async (ctx) => {
  pendingActions.set(ctx.chat.id, { type: 'income' });
  await ctx.answerCbQuery();
  await ctx.reply('Пришли сумму и описание, например: 50000 зарплата');
});

actionWithProfile('fin:setbudget', async (ctx) => {
  pendingActions.set(ctx.chat.id, { type: 'setbudget' });
  await ctx.answerCbQuery();
  await ctx.reply('Пришли сумму бюджета, например: 150000');
});

// ================== НАПОМИНАНИЯ ==================

function computeNextTrigger(hour, minute, repeatRule) {
  const now = DateTime.now().setZone(TZ);
  let dt = now.set({ hour, minute, second: 0, millisecond: 0 });
  if (dt <= now) {
    dt = repeatRule === 'weekly' ? dt.plus({ weeks: 1 }) : dt.plus({ days: 1 });
  }
  return dt.toUTC().toISO();
}

async function renderRemindersMenu(ctx, edit = false) {
  const profile = ctx.profile || (await findProfileByChatId(ctx.chat.id));
  const { data } = await sb.from('bot_reminders').select('*').eq('user_id', profile.id).order('next_trigger');
  const labels = { none: 'разово', daily: 'ежедневно', weekly: 'еженедельно' };
  let text = '⏰ Напоминания\n\n';
  const keyboard = [];

  if (!data || data.length === 0) {
    text += 'Активных напоминаний нет.';
  } else {
    data.forEach((r, i) => {
      text += `${i + 1}. ${r.time_of_day} (${labels[r.repeat_rule]}) — ${r.text}\n`;
      keyboard.push([Markup.button.callback(`🗑 Удалить ${i + 1}`, `remind:del:${r.id}`)]);
    });
  }

  keyboard.push([Markup.button.callback('➕ Новое напоминание', 'remind:add')]);
  keyboard.push([Markup.button.callback('⬅️ Меню', 'menu:main')]);

  await renderOrEdit(ctx, text, keyboard, edit);
}

bot.command('reminders', requireProfile, (ctx) => renderRemindersMenu(ctx, false));

bot.command('remind', requireProfile, async (ctx) => {
  const raw = ctx.message.text.replace(/^\/remind(@\w+)?\s*/, '').trim();
  const usage =
    'Использование:\n' +
    '/remind 18:30 позвонить маме — разово\n' +
    '/remind daily 08:00 выпить витамины — каждый день\n' +
    '/remind weekly 19:00 позвонить бабушке — каждую неделю';
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

  const weekday = DateTime.now().setZone(TZ).weekday;
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

bot.command('delremind', requireProfile, async (ctx) => {
  const code = ctx.message.text.replace(/^\/delremind(@\w+)?\s*/, '').trim().toLowerCase();
  if (!code) return ctx.reply('Использование: /delremind код (код см. в /reminders)');
  const { data } = await sb.from('bot_reminders').select('id').eq('user_id', ctx.profile.id);
  const found = (data || []).find((r) => r.id.startsWith(code));
  if (!found) return ctx.reply('Не нашёл напоминание с таким кодом.');
  await sb.from('bot_reminders').delete().eq('id', found.id);
  ctx.reply('Удалил.');
});

actionWithProfile(/^remind:del:(.+)$/, async (ctx) => {
  const { data: r } = await sb.from('bot_reminders').select('id').eq('id', ctx.match[1]).eq('user_id', ctx.profile.id).maybeSingle();
  if (!r) return ctx.answerCbQuery('Не найдено');
  await sb.from('bot_reminders').delete().eq('id', r.id);
  await ctx.answerCbQuery('Удалено 🗑');
  await renderRemindersMenu(ctx, true);
});

actionWithProfile('remind:add', async (ctx) => {
  await ctx.answerCbQuery();
  await renderOrEdit(
    ctx,
    '⏰ Новое напоминание\n\nКакой тип повтора?',
    [
      [Markup.button.callback('Разово', 'remind:addtype:none')],
      [Markup.button.callback('Каждый день', 'remind:addtype:daily')],
      [Markup.button.callback('Каждую неделю', 'remind:addtype:weekly')],
      [Markup.button.callback('⬅️ Напоминания', 'menu:reminders')],
    ],
    true
  );
});

actionWithProfile(/^remind:addtype:(none|daily|weekly)$/, async (ctx) => {
  const rule = ctx.match[1];
  pendingActions.set(ctx.chat.id, { type: 'add_reminder', repeatRule: rule });
  await ctx.answerCbQuery();
  await ctx.reply('Пришли время и текст в формате ЧЧ:ММ текст, например:\n08:30 выпить витамины');
});

// ================== ОБРАБОТКА ОЖИДАЕМОГО ВВОДА ==================

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const pending = pendingActions.get(chatId);
  if (!pending) return; // не ждём ввода — молча игнорируем (команды обрабатываются отдельно)

  const profile = await findProfileByChatId(chatId);
  if (!profile) {
    pendingActions.delete(chatId);
    return ctx.reply('Сначала привяжи аккаунт.');
  }
  ctx.profile = profile;
  const text = ctx.message.text.trim();
  pendingActions.delete(chatId);

  switch (pending.type) {
    case 'add_task': {
      await sb.from('tasks').insert({ user_id: profile.id, column_name: pending.column, text, is_private: true });
      await ctx.reply(`Добавил: ${text}`);
      await renderTasksMenu(ctx, false);
      break;
    }
    case 'add_habit': {
      await sb.from('habits').insert({ user_id: profile.id, name: text, history: {}, is_private: true });
      await ctx.reply(`Создал привычку: ${text}`);
      await renderHabitsMenu(ctx, false);
      break;
    }
    case 'add_friend': {
      await sendFriendRequest(ctx, text.replace('@', ''));
      break;
    }
    case 'spend':
    case 'income': {
      const match = text.match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/s);
      if (!match) { await ctx.reply('Не понял формат. Пример: 2500 продукты'); break; }
      const amount = parseFloat(match[1].replace(',', '.'));
      const desc = match[2].trim();
      await sb.from('finance_entries').insert({ user_id: profile.id, text: desc, amount, type: pending.type === 'spend' ? 'expense' : 'income' });
      await ctx.reply(pending.type === 'spend' ? `Записал трату: ${amount} — ${desc}` : `Записал доход: ${amount} — ${desc}`);
      await renderFinanceMenu(ctx, false);
      break;
    }
    case 'setbudget': {
      const val = parseFloat(text.replace(',', '.'));
      if (Number.isNaN(val)) { await ctx.reply('Не понял число. Пример: 150000'); break; }
      await sb.from('finance_budget').upsert({ user_id: profile.id, budget: val });
      await ctx.reply(`Бюджет установлен: ${val}`);
      await renderFinanceMenu(ctx, false);
      break;
    }
    case 'add_reminder': {
      const match = text.match(/^(\d{1,2}):(\d{2})\s+(.+)$/s);
      if (!match) { await ctx.reply('Не понял формат. Пример: 08:30 выпить витамины'); break; }
      const hour = parseInt(match[1], 10);
      const minute = parseInt(match[2], 10);
      if (hour > 23 || minute > 59) { await ctx.reply('Неверное время.'); break; }
      const remText = match[3].trim();
      const weekday = DateTime.now().setZone(TZ).weekday;
      const nextTrigger = computeNextTrigger(hour, minute, pending.repeatRule);
      const timeOfDay = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      await sb.from('bot_reminders').insert({
        user_id: profile.id,
        text: remText,
        repeat_rule: pending.repeatRule,
        weekday: pending.repeatRule === 'weekly' ? weekday : null,
        time_of_day: timeOfDay,
        next_trigger: nextTrigger,
      });
      await ctx.reply('Напоминание создано.');
      await renderRemindersMenu(ctx, false);
      break;
    }
    default:
      break;
  }
});

// ================== ФОНОВЫЕ НАПОМИНАНИЯ ==================

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

async function morningReminders() {
  const today = todayISO();
  const { data: tasks } = await sb
    .from('tasks')
    .select('user_id, text, profiles!inner(telegram_chat_id)')
    .eq('done', false)
    .or(`column_name.eq.today,due_date.eq.${today}`)
    .not('profiles.telegram_chat_id', 'is', null);

  const byChat = {};
  (tasks || []).forEach((t) => {
    const chatId = t.profiles.telegram_chat_id;
    (byChat[chatId] ||= []).push(t.text);
  });

  for (const [chatId, texts] of Object.entries(byChat)) {
    const list = texts.map((t) => `• ${t}`).join('\n');
    await bot.telegram.sendMessage(chatId, `Доброе утро! На сегодня:\n${list}`).catch(() => {});
  }
}

async function eveningReminders() {
  const { data: profiles } = await sb.from('profiles').select('id, telegram_chat_id').not('telegram_chat_id', 'is', null);
  const today = todayISO();

  for (const p of profiles || []) {
    const { data: habits } = await sb.from('habits').select('name, history').eq('user_id', p.id);
    const undone = (habits || []).filter((h) => !(h.history || {})[today]);
    if (undone.length === 0) continue;
    const list = undone.map((h) => `◻️ ${h.name}`).join('\n');
    await bot.telegram.sendMessage(
      p.telegram_chat_id,
      `Вечерняя проверка привычек:\n${list}\n\nОтметить — /menu → Привычки`
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
