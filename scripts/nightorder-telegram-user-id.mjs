// Prints only sender numeric IDs from the bot's pending private updates.
// Never prints the bot token, Telegram message content or full API URLs.
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set in this shell.');
  process.exitCode = 1;
} else {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        timeout: 0,
        limit: 15,
        allowed_updates: ['message'],
      }),
    });
    const result = await res.json();
    if (!res.ok || result.ok !== true || !Array.isArray(result.result)) {
      throw new Error('Telegram did not return pending updates');
    }
    const ids = [
      ...new Set(
        result.result.flatMap((update) => {
          const msg = update.message;
          return msg?.chat?.type === 'private' &&
            Number.isSafeInteger(msg.from?.id)
            ? [String(msg.from.id)]
            : [];
        }),
      ),
    ];
    if (ids.length) console.log('Private Telegram user IDs:', ids.join(', '));
    else
      console.log(
        'No private update yet. Send /start to your new bot, then rerun.',
      );
  } catch {
    console.error(
      'Could not query Telegram. Check token, connectivity and bot webhook state.',
    );
    process.exitCode = 1;
  }
}
