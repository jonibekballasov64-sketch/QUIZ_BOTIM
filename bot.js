require('dotenv').config();
const { Telegraf } = require('telegraf');
const mammoth = require('mammoth');
const https = require('https');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '').trim();

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN topilmadi. Railway env variables ga qo\'shing.');
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error('ADMIN_ID topilmadi. Railway env variables ga qo\'shing.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---------- Faqat admin ishlata oladi ----------
bot.use((ctx, next) => {
  const fromId = ctx.from && String(ctx.from.id);
  if (fromId !== ADMIN_ID) {
    return ctx.reply('Kechirasiz, bu bot faqat egasi uchun ishlaydi.');
  }
  return next();
});

// ---------- Yordamchi: faylni buffer sifatida yuklab olish ----------
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ---------- Fayldan matn olish (.txt yoki .docx) ----------
async function extractText(ctx, doc) {
  const fileLink = await ctx.telegram.getFileLink(doc.file_id);
  const buffer = await downloadBuffer(fileLink.href);
  const fileName = (doc.file_name || '').toLowerCase();

  if (fileName.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  return buffer.toString('utf-8');
}

// ---------- Matnni savollarga ajratish ----------
// Format:
// ⁉️1. Savol matni...
// 🔷️A) variant matni
// 🔷️B) variant matni
// 🔷️C) variant matni
// 🔷️D) variant matni
// ✅️C
function parseQuestions(rawText) {
  const text = rawText.replace(/\r\n/g, '\n');
  const blocks = text.split(/(?=⁉️)/u).map(b => b.trim()).filter(b => b.startsWith('⁉️'));

  const questions = [];

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);

    let questionLines = [];
    const options = [];
    let correctLetter = null;

    for (const line of lines) {
      if (line.startsWith('⁉️')) {
        questionLines.push(line.replace(/^⁉️/, '').trim());
      } else if (line.startsWith('🔷')) {
        const cleaned = line.replace(/^🔷️?/, '').trim();
        const m = cleaned.match(/^([A-D])\)?\s*(.*)$/u);
        if (m) {
          options.push({ letter: m[1].toUpperCase(), text: m[2].trim() });
        } else {
          const letter = String.fromCharCode(65 + options.length);
          options.push({ letter, text: cleaned });
        }
      } else if (line.startsWith('✅')) {
        const cleaned = line.replace(/^✅️?/, '').trim();
        const m = cleaned.match(/^([A-D])/i);
        if (m) {
          correctLetter = m[1].toUpperCase();
        } else {
          const found = options.find(o => o.text.toLowerCase() === cleaned.toLowerCase());
          if (found) correctLetter = found.letter;
        }
      } else {
        if (options.length === 0) {
          questionLines.push(line);
        }
      }
    }

    const questionText = questionLines.join(' ').replace(/^\d+[\.\)]\s*/, '').trim();
    const correctIndex = options.findIndex(o => o.letter === correctLetter);

    if (questionText && options.length >= 2 && correctIndex !== -1) {
      questions.push({
        question: questionText,
        options: options.map(o => o.text),
        correctIndex
      });
    }
  }

  return questions;
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Savollarni poll qilib yuborish (fayl va matn uchun umumiy) ----------
async function sendQuestionsAsPolls(ctx, rawText) {
  const questions = parseQuestions(rawText);

  if (questions.length === 0) {
    return ctx.reply(
      'Hech qanday savol topilmadi. Format shunday bo\'lishi kerak:\n\n' +
      '⁉️1. Savol matni\n🔷️A) variant\n🔷️B) variant\n🔷️C) variant\n🔷️D) variant\n✅️C'
    );
  }

  await ctx.reply(`${questions.length} ta savol topildi. Yuborilyapti...`);

  let sent = 0;
  let skipped = 0;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const questionText = truncate(`[${i + 1}/${questions.length}] ${q.question}`, 300);
    const opts = q.options.slice(0, 10).map(o => truncate(o, 100));

    if (q.correctIndex >= opts.length) {
      skipped++;
      continue;
    }

    try {
      await ctx.telegram.sendPoll(ctx.chat.id, questionText, opts, {
        type: 'quiz',
        correct_option_id: q.correctIndex,
        is_anonymous: false
      });
      sent++;
    } catch (e) {
      console.error(`Savol ${i + 1} yuborilmadi:`, e.message);
      skipped++;
    }

    await sleep(350);
  }

  await ctx.reply(`Tayyor. Yuborildi: ${sent} ta${skipped ? `, o'tkazib yuborildi: ${skipped} ta` : ''}.`);
}

// ---------- Fayl kelganda ----------
bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  const name = (doc.file_name || '').toLowerCase();

  if (!name.endsWith('.txt') && !name.endsWith('.docx')) {
    return ctx.reply('Faqat .txt yoki .docx fayl yuboring, yoki savollarni to\'g\'ridan-to\'g\'ri matn qilib yuboring.');
  }

  await ctx.reply('Fayl o\'qilyapti...');

  let rawText;
  try {
    rawText = await extractText(ctx, doc);
  } catch (e) {
    console.error(e);
    return ctx.reply('Faylni o\'qib bo\'lmadi: ' + e.message);
  }

  await sendQuestionsAsPolls(ctx, rawText);
});

// ---------- Oddiy matn xabar kelganda ----------
bot.on('text', async (ctx) => {
  const text = ctx.message.text;

  if (text.startsWith('/')) return; // /start kabi komandalarni bu yerda ishlatmaymiz

  if (!text.includes('⁉️')) {
    return ctx.reply(
      'Savol formatida yubor:\n\n' +
      '⁉️1. Savol matni\n🔷️A) variant\n🔷️B) variant\n🔷️C) variant\n🔷️D) variant\n✅️C\n\n' +
      'Yoki shu formatdagi .txt/.docx fayl yuboring.'
    );
  }

  await sendQuestionsAsPolls(ctx, text);
});

bot.start((ctx) => ctx.reply(
  'Salom! Menga savollarni ⁉️/🔷️/✅️ formatida matn qilib yozing yoki .txt/.docx fayl yuboring — quiz poll qilib qaytaraman.\n\n' +
  'Format:\n⁉️1. Savol matni\n🔷️A) variant\n🔷️B) variant\n🔷️C) variant\n🔷️D) variant\n✅️C'
));

bot.launch();
console.log('Bot ishga tushdi.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
