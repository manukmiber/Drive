// Telegram Bot API adapter (SPEC §6.4). The mock records messages in KV for the dev mailbox.
export interface TelegramButton {
  text: string;
  url: string;
}

export interface TelegramClient {
  readonly name: string;
  sendMessage(
    chatId: string,
    text: string,
    buttons?: TelegramButton[],
  ): Promise<{ messageId: string }>;
}

export class BotApiTelegram implements TelegramClient {
  readonly name = 'telegram';
  constructor(private token: string) {}
  async sendMessage(
    chatId: string,
    text: string,
    buttons?: TelegramButton[],
  ): Promise<{ messageId: string }> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(buttons?.length
          ? {
              reply_markup: {
                inline_keyboard: [buttons.map((b) => ({ text: b.text, url: b.url }))],
              },
            }
          : {}),
      }),
    });
    const data = (await res.json()) as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    };
    if (!data.ok) throw new Error(`telegram: ${data.description ?? res.status}`);
    return { messageId: String(data.result?.message_id ?? '') };
  }
}

export const DEV_TG_PREFIX = 'dev:tg:';

export class MockTelegram implements TelegramClient {
  readonly name = 'mock';
  constructor(private kv: KVNamespace) {}
  async sendMessage(
    chatId: string,
    text: string,
    buttons?: TelegramButton[],
  ): Promise<{ messageId: string }> {
    const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
    await this.kv.put(
      `${DEV_TG_PREFIX}${id}`,
      JSON.stringify({ chatId, text, buttons, at: Date.now() }),
      { expirationTtl: 86_400 },
    );
    console.log(`[mock-telegram] chat=${chatId}\n${text}`);
    return { messageId: id };
  }
}
