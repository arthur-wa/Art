// ══════════════════════════════════════════════════════════════
//  anti-contact.js — يحذف أي رسالة "جهة اتصال" ويطرد مرسلها بالقروب
//  ✅ يعمل تلقائيًا بدون أمر (عبر global.messageEvHandlers)
//  ✅ الحذف يشمل الجميع بلا استثناء (حتى الأونر/الأدمن)
//  ✅ الطرد مستثنى للأونر والأدمنية فقط
//  ✅ طرد مباشر بدون فحص مسبق لصلاحية البوت (بنفس أسلوب أمر "طير" الناجح) — أسرع وأبسط
// ══════════════════════════════════════════════════════════════

const NovaUltra = {
    description: 'يحذف رسائل جهات الاتصال ويطرد مرسلها (عدا الأونر/الأدمن)',
    elite:       'off',
    group:       true,
    prv:         false,
    lock:        'off',
};

// ⚙️ إعدادات قابلة للتعديل
const EXEMPT_OWNER  = true;  // الأونر معفي من الطرد فقط (الحذف يشمله دائمًا)
const EXEMPT_ADMINS = true;  // أدمنية القروب معفيون من الطرد فقط (الحذف يشملهم دائمًا)

function isContactMessage(msg) {
    const m = msg.message;
    return !!(m && (m.contactMessage || m.contactsArrayMessage));
}

// طابور طرد لكل قروب — يضمن تنفيذ عمليات الطرد واحدة تلو الأخرى بدون تصادم
// وبفاصل زمني بسيط يتفادى rate limit واتساب على groupParticipantsUpdate
const kickQueues = new Map(); // chatId -> Promise chain
const KICK_GAP_MS = 1200; // فاصل بين كل عملية طرد ولي بعدها بنفس القروب

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function enqueueKick(chatId, task) {
    const prev = kickQueues.get(chatId) || Promise.resolve();
    const next = prev
        .then(async () => {
            await task();
            await delay(KICK_GAP_MS); // يمنع رمي عدة طرود متتالية بسرعة على نفس القروب
        })
        .catch(() => {})
        .finally(() => {
            if (kickQueues.get(chatId) === next) kickQueues.delete(chatId);
        });
    kickQueues.set(chatId, next);
    return next;
}

async function handler(sock, msg) {
    if (!isContactMessage(msg)) return;
    const t0 = Date.now();

    const chatId = msg.key.remoteJid;
    if (!chatId?.endsWith('@g.us')) return; // القروبات فقط

    // معرّف المرسل الخام — نفس القيمة كما وصلت من واتساب (يُستخدم مباشرة للحذف والطرد، بدون أي تحويل يدوي)
    const senderRaw = msg.key.fromMe ? sock.user.id : (msg.key.participant || msg.key.participantAlt || chatId);
    const senderPure = senderRaw.split('@')[0].split(':')[0];

    // ── الحذف: يصير فورًا وللجميع بلا أي استثناء (لا ينتظر الطابور) ──
    sock.sendMessage(chatId, {
        delete: { remoteJid: chatId, id: msg.key.id, participant: senderRaw, fromMe: msg.key.fromMe === true },
    }).then(() => {
    }).catch(() => {});

    // ── تحديد الاستثناء من الطرد (أونر / أدمن) ──
    let isExempt = false;
    try {
        let ownerNumber = '';
        try {
            const { default: configImport } = await import('../nova/config.js');
            ownerNumber = configImport.owner ? configImport.owner.toString().replace(/\D/g, '') : '';
        } catch (e) {}

        if (EXEMPT_OWNER && ownerNumber && senderPure === ownerNumber) {
            isExempt = true;
        } else if (EXEMPT_ADMINS) {
            const meta = await sock.groupMetadata(chatId);
            const participant = meta.participants.find(p => p.id.split('@')[0] === senderPure || p.id === senderRaw);
            if (participant?.admin) isExempt = true;
        }
    } catch (e) {}

    if (isExempt) return;

    // ── الطرد: يُضاف للطابور الخاص بالقروب بدل التنفيذ الفوري المتزامن ──
    // هذا يمنع تراكم عدة طلبات groupParticipantsUpdate بنفس اللحظة وفقدان بعضها
    enqueueKick(chatId, async () => {
        try {
            await sock.groupParticipantsUpdate(chatId, [senderRaw], "remove");
        } catch (err) {
            if (String(err).includes('401') || String(err).includes('not a group admin')) {
                console.log('[anti-contact] ⚠️ البوت ليس مشرفاً لطرد العضو.');
            } else {
                console.log(`[anti-contact] ⚠️ فشل طرد ${senderPure}: ${String(err).slice(0, 120)}`);
            }
        }
    });
}

// تسجيل الهاندلر تلقائيًا عند تحميل البلوجن (يصمد أمام إعادة التحميل عبر أمر "حدث")
if (!global.messageEvHandlers) global.messageEvHandlers = [];
global.messageEvHandlers = global.messageEvHandlers.filter(h => h.__pluginTag !== 'anti-contact');
handler.__pluginTag = 'anti-contact';
global.messageEvHandlers.push(handler);

// execute فاضي لأن هذا البلوجن بلا أمر — يعمل كحدث فقط عبر global.messageEvHandlers
async function execute() {}

export default { NovaUltra, execute };
