// Добавить в planner.html как обработчик кнопки "Привязать Telegram" в профиле.
// Нужна одна функция — генерирует код и сохраняет его в telegram_link_codes.

async function generateTelegramLinkCode() {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase(); // например "4F9K2A"

  const { error } = await sb.from('telegram_link_codes').insert({
    code,
    user_id: myProfile.id,
  });

  if (error) {
    alert('Не удалось сгенерировать код: ' + error.message);
    return;
  }

  alert(
    `Код: ${code}\n\nОткрой бота в Telegram и пришли ему этот код одним сообщением. ` +
    `Код действует 10 минут.`
  );
}

// Пример кнопки в HTML:
// <button onclick="generateTelegramLinkCode()">Привязать Telegram</button>

// Не забудь добавить политику RLS для telegram_link_codes, разрешающую
// вставку строки только для своего же user_id:
//
// create policy "insert own link code" on telegram_link_codes
//   for insert with check (auth.uid() = user_id);
