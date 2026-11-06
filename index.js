import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const LEAD_KEYWORDS = (process.env.LEAD_KEYWORDS || 'ищу,куплю,посоветуйте,подскажите,нужен,нужна')
  .split(',')
  .map(k => k.trim().toLowerCase())
  .filter(Boolean);

// Функция отправки уведомления в Telegram
function sendTelegramAlert(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log('[TG-DISABLED] ' + text);
    return;
  }
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage?chat_id=${TG_CHAT_ID}&text=${encodeURIComponent(text)}&parse_mode=Markdown`;
  https.get(url, (res) => {
    res.on('data', () => {});
  }).on('error', (err) => {
    console.error('[TG-ERR]', err.message);
  });
}

// Логирование в файл
function appendLog(filename, data) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...data }) + '\n';
  fs.appendFileSync(filename, line, 'utf8');
}

async function startSpider() {
  console.log('🚀 Запуск чистого WhatsApp Spider на Baileys...');
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    auth: state,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('\n📲 СКАНИРУЙ QR-КОД В WHATSAPP (Связанные устройства):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`❌ Соединение разорвано. Причина: ${statusCode}. Переподключение: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(startSpider, 3000);
      } else {
        console.log('🚫 Сессия завершена. Удалите auth_info_baileys и отсканируйте QR заново.');
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp Spider успешно подключен и активен 24/7!');
      sendTelegramAlert('🕷 *WhatsApp Story & Lead Spider подключен и работает 24/7!*');
    }
  });

  // 1. ПЕРЕХВАТЧИК СТОРИС (Кто посмотрел?)
  sock.ev.on('message-receipt.update', (receipts) => {
    for (const r of receipts) {
      if (r.key && r.key.remoteJid === 'status@broadcast') {
        const viewerRaw = r.receipt?.userJid || r.key?.participant || 'Неизвестно';
        const phone = viewerRaw.replace('@s.whatsapp.net', '').replace('@lid', '');
        const storyId = r.key.id;
        const timeStr = new Date().toLocaleTimeString('ru-RU');

        console.log(`🔥 [СТОРИС ПРОСМОТР] От: +${phone} в ${timeStr}`);
        appendLog('story_views.jsonl', { phone, storyId, raw: viewerRaw });

        const tgText = `👁 *Новый просмотр сторис в WhatsApp!*\n\n` +
                       `👤 *Номер:* \`+${phone}\`\n` +
                       `🆔 *ID сторис:* \`${storyId}\`\n` +
                       `🕒 *Время:* ${timeStr}\n\n` +
                       `💡 _Горячий сигнал спроса — лид активен прямо сейчас!_`;
        sendTelegramAlert(tgText);
      }
    }
  });

  // 2. ГРУППОВОЙ ПАУК (Перехват сигналов спроса в бизнес-чатах)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid || '';
      const isGroup = remoteJid.endsWith('@g.us');
      if (!isGroup) continue;

      const text = msg.message.conversation ||
                   msg.message.extendedTextMessage?.text ||
                   msg.message.imageMessage?.caption || '';

      if (!text) continue;

      const lower = text.toLowerCase();
      const matchedWord = LEAD_KEYWORDS.find(kw => lower.includes(kw));

      if (matchedWord) {
        const sender = (msg.key.participant || remoteJid).replace('@s.whatsapp.net', '');
        const pushName = msg.pushName || 'Без имени';

        console.log(`🎯 [СИГНАЛ ЛИДА В ГРУППЕ] +${sender} (${pushName}): "${matchedWord}"`);
        appendLog('group_leads.jsonl', { sender, pushName, group: remoteJid, text, matchedWord });

        const tgLead = `🎯 *Найден потенциальный лид в группе!*\n\n` +
                       `👤 *Имя:* ${pushName}\n` +
                       `📞 *Телефон:* \`+${sender}\`\n` +
                       `🔑 *Ключевое слово:* \`${matchedWord}\`\n` +
                       `💬 *Сообщение:*\n"${text.substring(0, 300)}..."\n\n` +
                       `🚀 _Напиши ему в ЛС прямо сейчас!_`;
        sendTelegramAlert(tgLead);
      }
    }
  });
}

startSpider().catch(console.error);
