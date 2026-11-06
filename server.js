require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const { Telegraf, Markup } = require('telegraf');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname));

// ================= 1. DATABASE CONNECTION (NEON POSTGRES) ================= //
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 25, // Neon Connection እንዳይጨናነቅ የተገደበ
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
    console.error('Neon DB Pool Error:', err);
});

// Auto-run DB Migrations (የተለየ ዋሌት በየቦቱ እንዲሆን ተደርጎ የተሰራ)
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT NOT NULL,
                bot_key VARCHAR(50) NOT NULL DEFAULT 'swift',
                first_name VARCHAR(100),
                username VARCHAR(100),
                real_balance NUMERIC(12, 2) DEFAULT 0.00 CHECK (real_balance >= 0),
                bonus_balance NUMERIC(12, 2) DEFAULT 0.00 CHECK (bonus_balance >= 0),
                balance NUMERIC(12, 2) DEFAULT 0.00,
                total_deposited NUMERIC(12, 2) DEFAULT 0.00 CHECK (total_deposited >= 0),
                total_withdrawn NUMERIC(12, 2) DEFAULT 0.00,
                total_won NUMERIC(12, 2) DEFAULT 0.00,
                cards_bought_this_week INT DEFAULT 0,
                referred_by BIGINT,
                referral_rewarded BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(telegram_id, bot_key)
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                bot_key VARCHAR(50) NOT NULL DEFAULT 'swift',
                type VARCHAR(20) NOT NULL,
                payment_method VARCHAR(20) NOT NULL,
                amount NUMERIC(12, 2) NOT NULL,
                sms_text TEXT,
                sms_hash VARCHAR(64) UNIQUE,
                trx_ref VARCHAR(64) UNIQUE,
                order_id VARCHAR(64) UNIQUE,
                account_number VARCHAR(100),
                account_name VARCHAR(100),
                status VARCHAR(20) DEFAULT 'PENDING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS bingo_rounds (
                id SERIAL PRIMARY KEY,
                round_number BIGINT NOT NULL,
                bot_key VARCHAR(50) DEFAULT 'global',
                card_price NUMERIC(10, 2) DEFAULT 10.00,
                total_cards INT DEFAULT 0,
                pool_prize NUMERIC(12, 2) DEFAULT 0.00,
                owner_rake NUMERIC(12, 2) DEFAULT 0.00,
                winner_id INT REFERENCES users(id),
                winning_card_number INT,
                status VARCHAR(20) DEFAULT 'COMPLETED',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Multi-Bot Database Schema successfully verified.');
    } catch (e) {
        console.error('Migration notice:', e.message);
    }
})();

// ================= 2. CONFIGURATION & LIMITS ================= //
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'super_secret_dash_admin_2026';
const TELEBIRR_API_URL = process.env.TELEBIRR_API_URL || process.env.VERIFY_API_URL || 'https://verifiy-server.app.aletcloud.com/api/verify';
const TELEBIRR_SECRET_TOKEN = process.env.TELEBIRR_SECRET_TOKEN || process.env.VERIFY_SECRET_TOKEN || 'Verifi_Prod_9842_Aymen_X9!2026';
const WEBAPP_BASE_URL = process.env.WEBAPP_URL || 'https://dashserver-wyol.onrender.com';

const MINIMUM_DEPOSIT = 100;    // አነስተኛ ማስገቢያ
const MINIMUM_WITHDRAW = 200;   // አነስተኛ ማውጫ
const CARD_PRICE = 10;
const HOUSE_COMMISSION = 0.20;
const SELECTION_SECONDS = 30;
const REFERRAL_BONUS_AMOUNT = 10.00;

// 10ሩ ቦቶች ዝርዝር
const BOTS_REGISTRY = {
    pulse: { name: "Pulse Bingo ⚡", envKey: "BOT_PULSE" },
    bolt: { name: "Bolt Dab ⚡", envKey: "BOT_BOLT" },
    speed: { name: "Speed Card ⚡", envKey: "BOT_SPEED" },
    zing: { name: "Zing Bingo ⚡", envKey: "BOT_ZING" },
    rapid: { name: "Rapid Win ⚡", envKey: "BOT_RAPID" },
    velo: { name: "Velo Dab ⚡", envKey: "BOT_VELO" },
    spark: { name: "Spark Bingo ⚡", envKey: "BOT_SPARK" },
    jet: { name: "Jet Ball ⚡", envKey: "BOT_JET" },
    turbo: { name: "Turbo Win ⚡", envKey: "BOT_TURBO" },
    swift: { name: "Swift Bingo ⚡", envKey: "BOT_SWIFT" }
};

// ================= 3. MULTI-BOT ENGINE ================= //
const activeBots = {}; // ቦቶቹን በአንድ ላይ መያዣ

Object.entries(BOTS_REGISTRY).forEach(([botKey, config]) => {
    // የተለየው Bot Token ከሌለ እንደ ፎልባክ BOT_TOKENን ያነባል
    const token = process.env[config.envKey] || (botKey === 'swift' ? process.env.BOT_TOKEN : null);
    
    if (token) {
        try {
            const botInstance = new Telegraf(token);

            botInstance.start(async (ctx) => {
                const { id, first_name, username } = ctx.from;
                const startPayload = ctx.startPayload || '';
                
                let referrerId = null;
                if (startPayload.startsWith('ref_')) {
                    const parsed = parseInt(startPayload.replace('ref_', ''));
                    if (!isNaN(parsed) && parsed !== id) {
                        referrerId = parsed;
                    }
                }

                try {
                    await pool.query(
                        `INSERT INTO users (telegram_id, bot_key, first_name, username, referred_by) 
                         VALUES ($1, $2, $3, $4, $5) 
                         ON CONFLICT (telegram_id, bot_key) DO UPDATE 
                         SET first_name = $3, username = $4`,
                        [id, botKey, first_name || 'ተጫዋች', username || '', referrerId]
                    );

                    const appUrl = `${WEBAPP_BASE_URL}?bot=${botKey}`;
                    ctx.reply(
                        `እንኳን ወደ <b>${config.name}</b> በደህና መጡ! ⚡\n\nበቴሌብር ወይም በንግድ ባንክ (CBE) ተቀማጭ በማድረግ አሁኑኑ መጫወት ይጀምሩ፦`,
                        {
                            parse_mode: 'HTML',
                            ...Markup.inlineKeyboard([
                                [Markup.button.webApp(`🎮 Play ${config.name}`, appUrl)]
                            ])
                        }
                    );
                } catch (e) {
                    console.error(`Bot [${botKey}] start error:`, e.message);
                }
            });

            botInstance.launch({ dropPendingUpdates: true })
                .then(() => console.log(`🤖 Bot [${config.name}] launched successfully.`))
                .catch(err => console.warn(`⚠️ Launch notice [${botKey}]:`, err.message));

            activeBots[botKey] = botInstance;
        } catch (e) {
            console.error(`Failed to initialize bot [${botKey}]:`, e.message);
        }
    }
});

// መልእክት ለተጠቃሚው በገባበት ቦት በኩል መላኪያ
async function sendNotification(telegramId, botKey, message) {
    try {
        const bot = activeBots[botKey] || activeBots['swift'] || Object.values(activeBots)[0];
        if (bot) {
            await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'HTML' });
        }
    } catch (e) {
        console.warn(`Notify failed (${telegramId}):`, e.message);
    }
}

// ================= 4. HELPER: PARSE TELEBIRR & CBE SMS/REF ================= //
function parsePaymentInput(input, method = 'TELEBIRR') {
    const text = String(input || '').trim();
    let ref = null;
    let amount = null;

    if (String(method).toUpperCase() === 'CBE') {
        const cbeMatch = text.match(/\b(FT[A-Z0-9]{8,14})\b/i) || text.match(/(?:Txn\s*ID|Txn\s*Ref|Ref|ቁጥር|ትዕዛዝ)\s*[:፡-]?\s*([A-Z0-9]{8,16})/i);
        if (cbeMatch) ref = cbeMatch[1].toUpperCase();
        else if (/^[A-Z0-9]{8,18}$/i.test(text)) ref = text.toUpperCase();
    } else {
        const tbMatch = text.match(/\b(D[A-Z][A-Z0-9]{8,12})\b/i);
        if (tbMatch) {
            ref = tbMatch[1].toUpperCase();
        } else {
            const genericMatch = text.match(/transaction\s*(?:number|id|ref|no)?\s*(?:is|:)?\s*([A-Z0-9]{8,14})/i);
            if (genericMatch) ref = genericMatch[1].toUpperCase();
            else if (/^[A-Z0-9]{8,14}$/i.test(text)) ref = text.toUpperCase();
        }
    }

    const amtMatch = text.match(/(?:ETB|Birr|ብር)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i) || text.match(/\b([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:ETB|Birr|ብር)/i);
    if (amtMatch) amount = parseFloat(amtMatch[1].replace(/,/g, ''));

    return { ref, amount };
}

// ================= 5. BINGO GAME ENGINE (IN-MEMORY & BOTS) ================= //
const ENABLE_DEMO_BOTS = true;
const TEST_LUCKY_MODE = true;
const LUCKY_WIN_CHANCE = 1;

const BOT_NAMES = [
    "የድል_ጎዳና ⚡", "💎 ብሩህ_አእምሮ ✨", "🦁 የአንበሳ_ፈለግ 🦅", "☕ የቡና_ሰዓት 🤎",
    "🌙 የሌሊት_ጥላ 🌌", "🎵 የዜማ_ሞገድ 🎧", "❄️ ቀዝቃዛ_አየር 🧊", "🌍 የሀገሬ_ልጅ 🇪🇹",
    "👑 የንግስና_ጊዜ 💫", "⚡ Swift_Pro ⚡", "🌹 የፍቅር_ጉዞ 💕", "🍃 የተፈጥሮ_ድምጽ 🌿",
    "አቤል_ዘአበሻ", "ሰላም_ለእግዚአብሔር", "ዮሐንስ_አሸናፊ", "ዳዊት_ብርሃኑ",
    "ማርያም_ምስክሬ", "እድለኛው_ሰው", "ምስራቅ_ፀሐይ", "ፍቅሬ_ነህ",
    "ሐበሻዊው_ሰው", "የአባይ_ልጅ", "የወንዙ_ሞገድ", "የተስፋ_ብርሃን",
    "꧁༒ 𝕰𝖙𝖍𝖎𝖔_𝕶𝖎𝖓𝖌 ༒꧂", "༺ 𝕷𝖊𝖌𝖊𝖓𝖉 ༻", "『 𝕾𝖙𝖆𝖗_𝕭𝖔𝖞 』",
    "𝕯𝖗𝖊𝖆𝖒_𝕮𝖆𝖙𝖈𝖍𝖊𝖗 🌙", "𝓔𝓽𝓱𝓲𝓸_𝐋𝐢𝐟𝐞 🔥", "█▬█ █ ▀█▀ 🇪🇹"
];

let gameState = {
    roundNumber: 1001,
    status: 'SELECTION',
    countdown: SELECTION_SECONDS,
    selectedCards: {},
    calledNumbers: [],
    currentNumber: null,
    totalPrize: 0,
    ownerProfit: 0
};

function generateBingoCard() {
    const getCols = (min, max) => {
        let nums = [];
        while (nums.length < 5) {
            let r = Math.floor(Math.random() * (max - min + 1)) + min;
            if (!nums.includes(r)) nums.push(r);
        }
        return nums;
    };
    let b = getCols(1, 15);
    let i = getCols(16, 30);
    let n = getCols(31, 45);
    let g = getCols(46, 60);
    let o = getCols(61, 75);
    n[2] = 0; // Free Center Star (★)
    return [b, i, n, g, o];
}

function checkWinner(card, called) {
    const isMarked = (val) => val === 0 || called.includes(val);
    for (let c = 0; c < 5; c++) {
        if (card[c].every(isMarked)) return true;
    }
    for (let r = 0; r < 5; r++) {
        let rowWin = true;
        for (let c = 0; c < 5; c++) {
            if (!isMarked(card[c][r])) { rowWin = false; break; }
        }
        if (rowWin) return true;
    }
    let diag1 = true, diag2 = true;
    for (let idx = 0; idx < 5; idx++) {
        if (!isMarked(card[idx][idx])) diag1 = false;
        if (!isMarked(card[idx][4 - idx])) diag2 = false;
    }
    return diag1 || diag2;
}

function simulateMassivePurchases(count = 12) {
    if (gameState.status !== 'SELECTION' || !ENABLE_DEMO_BOTS) return;

    for (let i = 0; i < count; i++) {
        let randomCard;
        let attempts = 0;
        do {
            randomCard = Math.floor(Math.random() * 500) + 1;
            attempts++;
        } while (gameState.selectedCards[randomCard] && attempts < 200);

        if (gameState.selectedCards[randomCard]) continue;

        const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
        gameState.selectedCards[randomCard] = {
            userId: null,
            userName: botName,
            botKey: 'bot',
            numbers: generateBingoCard(),
            isBot: true
        };
    }

    const cardCount = Object.keys(gameState.selectedCards).length;
    const totalPot = cardCount * CARD_PRICE;
    gameState.totalPrize = totalPot * (1 - HOUSE_COMMISSION);
    gameState.ownerProfit = totalPot * HOUSE_COMMISSION;

    io.emit('card_taken', {
        cardIndex: Math.floor(Math.random() * 500) + 1,
        userName: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
        totalCards: cardCount,
        poolPrize: gameState.totalPrize
    });
}

// 🎮 የማዕከላዊ ጨዋታ ዙር (RAM-Only Loop - Database Usage የለውም)
setInterval(async () => {
    if (gameState.status === 'SELECTION') {
        gameState.countdown--;
        io.emit('game_tick', { status: 'SELECTION', countdown: gameState.countdown });

        if (gameState.countdown > 1) {
            simulateMassivePurchases(Math.floor(Math.random() * 5) + 10);
        }

        if (gameState.countdown <= 0) {
            const cardCount = Object.keys(gameState.selectedCards).length;
            if (cardCount >= 1) {
                gameState.status = 'PLAYING';
                gameState.calledNumbers = [];
                const totalPot = cardCount * CARD_PRICE;
                gameState.ownerProfit = totalPot * HOUSE_COMMISSION;
                gameState.totalPrize = totalPot - gameState.ownerProfit;
                io.emit('round_started', {
                    roundNumber: gameState.roundNumber,
                    totalPrize: gameState.totalPrize,
                    totalCards: cardCount
                });
            } else {
                gameState.countdown = SELECTION_SECONDS;
            }
        }
    } else if (gameState.status === 'PLAYING') {
        if (gameState.calledNumbers.length >= 75) {
            resetGame();
            return;
        }

        let nextNum;
        let picked = false;

        if (TEST_LUCKY_MODE && Math.random() * 100 < LUCKY_WIN_CHANCE) {
            const realPlayerCards = Object.values(gameState.selectedCards).filter(c => !c.isBot);
            if (realPlayerCards.length > 0) {
                const targetCard = realPlayerCards[Math.floor(Math.random() * realPlayerCards.length)];
                const flatNumbers = targetCard.numbers.flat().filter(n => n !== 0 && !gameState.calledNumbers.includes(n));
                if (flatNumbers.length > 0) {
                    nextNum = flatNumbers[Math.floor(Math.random() * flatNumbers.length)];
                    picked = true;
                }
            }
        }

        if (!picked) {
            do {
                nextNum = Math.floor(Math.random() * 75) + 1;
            } while (gameState.calledNumbers.includes(nextNum));
        }

        gameState.calledNumbers.push(nextNum);
        gameState.currentNumber = nextNum;

        let winners = [];
        for (const [cardIndex, cardData] of Object.entries(gameState.selectedCards)) {
            if (checkWinner(cardData.numbers, gameState.calledNumbers)) {
                winners.push({ cardIndex: parseInt(cardIndex), ...cardData });
            }
        }

        if (winners.length > 0) {
            gameState.status = 'GAME_OVER';
            const totalSplitPrize = gameState.totalPrize / winners.length;

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                let realWinnerId = null;

                for (const win of winners) {
                    if (win.userId && !win.isBot) {
                        realWinnerId = win.userId;

                        // አሸናፊ ገንዘብ በቀጥታ ወደ Real Wallet ይገባል (ሊወጣ ይችላል)
                        await client.query(
                            `UPDATE users 
                             SET real_balance = real_balance + $1,
                                 balance = real_balance + $1,
                                 total_won = total_won + $1 
                             WHERE id = $2`,
                            [totalSplitPrize, win.userId]
                        );

                        await client.query(
                            `INSERT INTO transactions (user_id, bot_key, type, payment_method, amount, sms_text, status) 
                             VALUES ($1, $2, 'BINGO_WIN', 'INTERNAL', $3, $4, 'APPROVED')`,
                            [win.userId, win.botKey || 'swift', totalSplitPrize, `Round #${gameState.roundNumber} Winner (Card #${win.cardIndex})`]
                        );

                        const uRes = await client.query('SELECT telegram_id, bot_key FROM users WHERE id = $1', [win.userId]);
                        if (uRes.rows.length > 0) {
                            sendNotification(
                                uRes.rows[0].telegram_id,
                                uRes.rows[0].bot_key,
                                `🎉 <b>BINGO WINNER! እንኳን ደስ አለዎት!</b>\n\nበካርድ #${win.cardIndex} <b>${totalSplitPrize.toFixed(2)} ETB</b> አሸንፈዋል! ገንዘቡ ወደ Real ሒሳብዎ ገቢ ሆኗል።`
                            );
                        }
                    }
                }

                await client.query(
                    `INSERT INTO bingo_rounds (round_number, card_price, total_cards, pool_prize, owner_rake, winner_id, winning_card_number)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        gameState.roundNumber, 
                        CARD_PRICE, 
                        Object.keys(gameState.selectedCards).length, 
                        gameState.totalPrize, 
                        gameState.ownerProfit, 
                        realWinnerId, 
                        winners[0].cardIndex
                    ]
                );
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                console.error("Payout error:", err);
            } finally {
                client.release();
            }

            io.emit('round_won', {
                winners: winners.map(w => ({ userName: w.userName, cardIndex: w.cardIndex })),
                prize: totalSplitPrize,
                calledNumbers: gameState.calledNumbers
            });

            setTimeout(() => { resetGame(); }, 3000);
        } else {
            io.emit('number_called', {
                number: nextNum,
                called: gameState.calledNumbers
            });
        }
    }
}, 2400);

function resetGame() {
    gameState.roundNumber++;
    gameState.status = 'SELECTION';
    gameState.countdown = SELECTION_SECONDS;
    gameState.selectedCards = {};
    gameState.calledNumbers = [];
    gameState.currentNumber = null;
    gameState.totalPrize = 0;
    gameState.ownerProfit = 0;
    io.emit('game_reset', gameState);
}

// ================= 6. USER SYNC & PROFILE (BOT-SPECIFIC WALLET) ================= //
app.post('/api/user/sync', async (req, res) => {
    const { telegramId, firstName, username, botKey = 'swift', ref } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'telegramId is required' });

    let referrerId = null;
    if (ref) {
        const parsed = parseInt(String(ref).replace('ref_', ''));
        if (!isNaN(parsed) && parsed !== parseInt(telegramId)) referrerId = parsed;
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO users (telegram_id, bot_key, first_name, username, referred_by) 
             VALUES ($1, $2, $3, $4, $5) 
             ON CONFLICT (telegram_id, bot_key) DO UPDATE 
             SET first_name = EXCLUDED.first_name, username = EXCLUDED.username 
             RETURNING id, telegram_id, bot_key, first_name, username, real_balance, 
                       bonus_balance, real_balance as balance, total_deposited, total_won`,
            [telegramId, botKey.toLowerCase(), firstName || 'ተጫዋች', username || '', referrerId]
        );
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================= 7. VERIFI V5 AUTOMATED DEPOSIT (TELEBIRR & CBE) ================= //
app.post('/api/deposit/verify', async (req, res) => {
    const { telegramId, rawInput, typedAmount, paymentMethod, botKey = 'swift' } = req.body;
    const selectedMethod = (paymentMethod || 'TELEBIRR').toUpperCase();
    const cleanBotKey = String(botKey).toLowerCase();

    if (!telegramId || !rawInput) {
        return res.status(400).json({ error: 'እባክዎ የግብይት ቁጥር (Ref) ወይም ሙሉ SMS ያስገቡ!' });
    }

    const parsed = parsePaymentInput(rawInput, selectedMethod);
    const ref = parsed.ref;
    const finalAmount = parsed.amount || parseFloat(typedAmount);

    if (!ref || ref.length < 7) {
        return res.status(400).json({ error: 'ትክክለኛ የግብይት ቁጥር አልተገኘም!' });
    }

    if (!finalAmount || finalAmount < MINIMUM_DEPOSIT) {
        return res.status(400).json({ error: `ዝቅተኛው የዴፖዚት መጠን ${MINIMUM_DEPOSIT} ETB ነው!` });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // ተጠቃሚውን በተለየው bot_key ብቻ እናገኘዋለን
        const userRes = await client.query(
            `SELECT * FROM users WHERE telegram_id = $1 AND bot_key = $2 FOR UPDATE`, 
            [telegramId, cleanBotKey]
        );
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'ተጠቃሚው አልተገኘም' });
        }
        const user = userRes.rows[0];

        // Ref ቀደም ሲል ጥቅም ላይ ውሏል?
        const refCheck = await client.query('SELECT id FROM transactions WHERE trx_ref = $1', [ref]);
        if (refCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ይህ የግብይት ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል!' });
        }

        const orderId = `DEP_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const verifyUrl = `${TELEBIRR_API_URL}?token=${encodeURIComponent(TELEBIRR_SECRET_TOKEN)}&ref=${encodeURIComponent(ref)}&amount=${encodeURIComponent(finalAmount)}&method=${encodeURIComponent(selectedMethod.toLowerCase())}`;
        
        let gatewayResponse;
        try {
            const resp = await fetch(verifyUrl, {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });
            gatewayResponse = await resp.json();
        } catch (fetchErr) {
            await client.query('ROLLBACK');
            return res.status(502).json({ error: 'የክፍያ ማረጋገጫ ሲስተሙ ለጊዜው አልመለሰም፤ እባክዎ ጥቂት ሰከንዶች ጠብቀው እንደገና ይሞክሩ።' });
        }

        const gStatus = gatewayResponse?.status;
        if (gStatus === 'Pending') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ክፍያው ገና አልደረሰም፤ እባክዎ ጥቂት ሰከንዶች ጠብቀው እንደገና ይሞክሩ።' });
        }
        if (gStatus === 'AlreadyUsed') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ይህ የግብይት ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል!' });
        }

        const isVerified = (gStatus === 'Verified' || gStatus === 'success' || gatewayResponse?.verified === true);
        if (!isVerified) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: gatewayResponse?.message || 'ክፍያውን ማረጋገጥ አልተቻለም።' });
        }

        const verifiedAmount = parseFloat(gatewayResponse.amount || finalAmount);
        const newRealBalance = parseFloat(user.real_balance || 0) + verifiedAmount;

        // 1. የገንዘብ ተቀማጩን በዚያ ቦት ዋሌት ላይ መመዝገብ
        await client.query(
            `UPDATE users 
             SET real_balance = $1, 
                 balance = $1,
                 total_deposited = total_deposited + $2 
             WHERE id = $3`,
            [newRealBalance, verifiedAmount, user.id]
        );

        await client.query(
            `INSERT INTO transactions (user_id, bot_key, type, payment_method, amount, trx_ref, order_id, status) 
             VALUES ($1, $2, 'DEPOSIT', $3, $4, $5, $6, 'APPROVED')`,
            [user.id, cleanBotKey, selectedMethod, verifiedAmount, ref, orderId]
        );

        // 2. ሪፈራል ቦነስ አከፋፈል (የመጀመሪያ ተቀማጭ ሲሆን ለጋባዡ 10 ETB ወደ bonus_balance ይሰጣል)
        if (user.referred_by && !user.referral_rewarded && verifiedAmount >= MINIMUM_DEPOSIT) {
            const referrerRes = await client.query(
                `SELECT id, telegram_id, bonus_balance FROM users WHERE telegram_id = $1 AND bot_key = $2 FOR UPDATE`,
                [user.referred_by, cleanBotKey]
            );

            if (referrerRes.rows.length > 0) {
                const referrer = referrerRes.rows[0];
                await client.query(
                    `UPDATE users 
                     SET bonus_balance = bonus_balance + $1 
                     WHERE id = $2`,
                    [REFERRAL_BONUS_AMOUNT, referrer.id]
                );

                await client.query(`UPDATE users SET referral_rewarded = TRUE WHERE id = $1`, [user.id]);

                sendNotification(
                    referrer.telegram_id,
                    cleanBotKey,
                    `🎁 <b>የሪፈራል ቦነስ!</b>\n\nየጋበዙት ተጫዋች የመጀመሪያ ተቀማጭ በማድረጉ <b>${REFERRAL_BONUS_AMOUNT} ETB</b> ቦነስ አግኝተዋል! በቦነሱ ካርድ ቆርጠው ይጫወቱ።`
                );
            }
        }

        await client.query('COMMIT');

        sendNotification(
            telegramId,
            cleanBotKey,
            `✅ <b>የ ${selectedMethod} ዴፖዚትዎ በራስ-ሰር ጸድቋል!</b>\n\nመጠን፡ <b>${verifiedAmount.toFixed(2)} ETB</b>\nRef: <code>${ref}</code>\nየዋሌት ሒሳብዎ፡ <b>${newRealBalance.toFixed(2)} ETB</b>`
        );

        res.json({
            success: true,
            amount: verifiedAmount,
            ref,
            newRealBalance,
            message: `🎉 እንኳን ደስ አለዎት! ${verifiedAmount.toFixed(2)} ETB በራስ-ሰር ተረጋግጦ ወደ ዋሌትዎ ገቢ ሆኗል!`
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Verify Deposit Error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ================= 8. WITHDRAWAL API (MIN 200 ETB) ================= //
app.post('/api/withdraw', async (req, res) => {
    const { telegramId, amount, accountNumber, accountName, paymentMethod = 'TELEBIRR', botKey = 'swift' } = req.body;
    const withdrawAmount = parseFloat(amount);
    const cleanBotKey = String(botKey).toLowerCase();

    if (isNaN(withdrawAmount) || withdrawAmount < MINIMUM_WITHDRAW) {
        return res.status(400).json({ error: `አነስተኛው የማውጣት መጠን ${MINIMUM_WITHDRAW} ETB ነው!` });
    }
    if (withdrawAmount > 5000) {
        return res.status(400).json({ error: 'በአንድ ጊዜ የሚፈቀደው ከፍተኛው የማውጣት መጠን 5,000 ETB ነው!' });
    }
    if (!accountNumber || !accountName) {
        return res.status(400).json({ error: 'እባክዎ የሂሳብ ቁጥር እና ሙሉ ስም በትክክል ያስገቡ!' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query(
            `SELECT id, real_balance, total_deposited FROM users WHERE telegram_id = $1 AND bot_key = $2 FOR UPDATE`, 
            [telegramId, cleanBotKey]
        );
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'ተጠቃሚው አልተገኘም' });
        }
        const user = userRes.rows[0];

        // ህግ 1፡ በዚያ ቦት ቢያንስ 100 ETB ማስገባት ግዴታ ነው
        if (parseFloat(user.total_deposited || 0) < MINIMUM_DEPOSIT) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: `ገንዘብ ለማውጣት ቢያንስ 1 ጊዜ ${MINIMUM_DEPOSIT} ETB ተቀማጭ ማድረግ ግዴታ ነው!` 
            });
        }

        // ህግ 2፡ ማውጣት የሚቻለው ከ Real Balance ብቻ ነው (Bonus አይወጣም)
        const currentReal = parseFloat(user.real_balance || 0);
        if (currentReal < withdrawAmount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: `በቂ Real Balance የለዎትም! (ያለዎት Real Balance: ${currentReal.toFixed(2)} ETB)` 
            });
        }

        // ህግ 3፡ በ 24 ሰዓት ውስጥ ቢበዛ 2 ጊዜ ብቻ
        const recentWithRes = await client.query(
            `SELECT id FROM transactions 
             WHERE user_id = $1 AND type = 'WITHDRAW' 
             AND created_at >= NOW() - INTERVAL '24 hours' 
             AND status IN ('PENDING', 'APPROVED')`,
            [user.id]
        );
        if (recentWithRes.rows.length >= 2) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'በ 24 ሰዓት ውስጥ ቢበዛ 2 ጊዜ ብቻ ማውጣት ይቻላል!' });
        }

        const fee = withdrawAmount * 0.05;
        const netPayout = withdrawAmount - fee;
        const newReal = currentReal - withdrawAmount;

        await client.query(
            `UPDATE users 
             SET real_balance = $1,
                 balance = $1 
             WHERE id = $2`, 
            [newReal, user.id]
        );

        await client.query(
            `INSERT INTO transactions (user_id, bot_key, type, payment_method, amount, account_number, account_name, status) 
             VALUES ($1, $2, 'WITHDRAW', $3, $4, $5, $6, 'PENDING')`,
            [user.id, cleanBotKey, paymentMethod.toUpperCase(), netPayout, accountNumber, accountName]
        );

        await client.query('COMMIT');

        sendNotification(
            telegramId,
            cleanBotKey,
            `📤 <b>የማውጣት ጥያቄ ደርሶናል</b>\n\nየተጠየቀው መጠን፡ <b>${withdrawAmount.toFixed(2)} ETB</b>\nየአገልግሎት ክፍያ (5%)፡ <b>${fee.toFixed(2)} ETB</b>\nየሚደርስዎት የተጣራ ብር፡ <b>${netPayout.toFixed(2)} ETB</b>\nመዳረሻ (${paymentMethod})፡ <b>${accountNumber}</b>\n\nኤጀንቱን ያነጋግሩ፡ @Dashagent1`
        );

        res.json({ 
            success: true, 
            message: `የ ${withdrawAmount} ETB ማውጣት ጥያቄዎ ተመዝግቧል! (5% ክፍያ ተቀንሶ ${netPayout.toFixed(2)} ETB ይላክልዎታል)` 
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ================= 9. ADMIN PANEL & AUDIT SYSTEM ================= //
function checkAdminAuth(req, res, next) {
    const key = req.headers['x-admin-key'] || req.query.admin_key;
    if (key !== ADMIN_SECRET) {
        return res.status(403).json({ error: 'ያልተፈቀደ መዳረሻ! የተሳሳተ Admin Key።' });
    }
    next();
}

app.get('/api/admin/audit', checkAdminAuth, async (req, res) => {
    const { timeframe = 'all', botKey } = req.query;
    let timeFilterTx = "";
    let botFilterTx = "";

    const intervals = {
        '30m': '30 minutes', '1h': '1 hour', '12h': '12 hours',
        '24h': '24 hours', '7d': '7 days', '30d': '30 days'
    };
    if (intervals[timeframe]) timeFilterTx = `AND created_at >= NOW() - INTERVAL '${intervals[timeframe]}'`;
    if (botKey && botKey !== 'all') botFilterTx = `AND bot_key = '${botKey.toLowerCase()}'`;

    try {
        const query = `
            SELECT 
                COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND status = 'APPROVED' THEN amount ELSE 0 END), 0) AS total_deposits,
                COALESCE(SUM(CASE WHEN type = 'WITHDRAW' AND status = 'APPROVED' THEN amount ELSE 0 END), 0) AS total_withdrawals,
                COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND payment_method = 'TELEBIRR' AND status = 'APPROVED' THEN amount ELSE 0 END), 0) AS telebirr_deposits,
                COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND payment_method = 'CBE' AND status = 'APPROVED' THEN amount ELSE 0 END), 0) AS cbe_deposits,
                COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending_deposits_count,
                COALESCE(SUM(CASE WHEN type = 'WITHDRAW' AND status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending_withdrawals_count
            FROM transactions
            WHERE 1=1 ${timeFilterTx} ${botFilterTx};
        `;
        const { rows } = await pool.query(query);
        const data = rows[0];

        const userStats = await pool.query('SELECT COALESCE(SUM(real_balance), 0) AS total_real_liability, COUNT(*) AS total_users FROM users');
        const roundStats = await pool.query('SELECT COALESCE(SUM(owner_rake), 0) AS total_rake, COUNT(*) AS total_rounds FROM bingo_rounds');

        const totalDep = parseFloat(data.total_deposits);
        const totalWith = parseFloat(data.total_withdrawals);

        res.json({
            totalDeposits: totalDep,
            telebirrDeposits: parseFloat(data.telebirr_deposits),
            cbeDeposits: parseFloat(data.cbe_deposits),
            totalWithdrawals: totalWith,
            netCash: totalDep - totalWith,
            totalRake: parseFloat(roundStats.rows[0].total_rake),
            totalRounds: parseInt(roundStats.rows[0].total_rounds),
            totalUsers: parseInt(userStats.rows[0].total_users),
            pendingDepositsCount: parseInt(data.pending_deposits_count),
            pendingWithdrawalsCount: parseInt(data.pending_withdrawals_count),
            totalRealLiability: parseFloat(userStats.rows[0].total_real_liability),
            activeBotsCount: Object.keys(activeBots).length
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/transactions', checkAdminAuth, async (req, res) => {
    const { category, botKey } = req.query;
    let conditions = ["1=1"];

    if (category === 'PENDING') conditions.push("t.status = 'PENDING'");
    else if (category === 'DEPOSIT') conditions.push("t.type = 'DEPOSIT'");
    else if (category === 'WITHDRAW') conditions.push("t.type = 'WITHDRAW'");

    if (botKey && botKey !== 'all') conditions.push(`t.bot_key = '${botKey.toLowerCase()}'`);

    try {
        const query = `
            SELECT t.*, u.first_name, u.telegram_id, u.real_balance 
            FROM transactions t 
            LEFT JOIN users u ON u.id = t.user_id 
            WHERE ${conditions.join(' AND ')}
            ORDER BY t.created_at DESC LIMIT 200
        `;
        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/approve', checkAdminAuth, async (req, res) => {
    const { txId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const txRes = await client.query(`SELECT t.*, u.telegram_id FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.id = $1 FOR UPDATE`, [txId]);
        if (txRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'ግብይቱ አልተገኘም' });
        }
        const tx = txRes.rows[0];

        if (tx.status !== 'PENDING') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ግብይቱ ቀደም ሲል ተጠናቋል' });
        }

        if (tx.type === 'DEPOSIT') {
            await client.query(
                `UPDATE users 
                 SET real_balance = real_balance + $1,
                     balance = real_balance + $1, 
                     total_deposited = total_deposited + $1 
                 WHERE id = $2`, 
                [tx.amount, tx.user_id]
            );
        }

        await client.query("UPDATE transactions SET status = 'APPROVED' WHERE id = $1", [txId]);
        await client.query('COMMIT');

        sendNotification(
            tx.telegram_id,
            tx.bot_key,
            `✅ <b>ግብይትዎ ጸድቋል!</b>\n\nመጠን፡ <b>${parseFloat(tx.amount).toFixed(2)} ETB</b>\nሁኔታ፡ <b>APPROVED</b>`
        );

        res.json({ success: true, message: 'ግብይቱ ጸድቋል!' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.post('/api/admin/reject', checkAdminAuth, async (req, res) => {
    const { txId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const txRes = await client.query(`SELECT t.*, u.telegram_id FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.id = $1 FOR UPDATE`, [txId]);
        const tx = txRes.rows[0];

        if (tx.type === 'WITHDRAW') {
            await client.query(
                `UPDATE users 
                 SET real_balance = real_balance + $1, 
                     balance = real_balance + $1 
                 WHERE id = $2`, 
                [tx.amount, tx.user_id]
            );
        }

        await client.query("UPDATE transactions SET status = 'REJECTED' WHERE id = $1", [txId]);
        await client.query('COMMIT');

        sendNotification(
            tx.telegram_id,
            tx.bot_key,
            `🔄 <b>የማውጣት ጥያቄዎ ውድቅ ተደርጓል</b>\n\nየ <b>${parseFloat(tx.amount).toFixed(2)} ETB</b> መጠን ወደ ዋሌትዎ ተመልሷል።`
        );

        res.json({ success: true, message: 'ግብይቱ ተሰርዞ ገንዘቡ ተመልሷል!' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ================= 10. REAL-TIME SOCKET.IO ENGINE ================= //
io.on('connection', (socket) => {
    socket.emit('game_init', {
        roundNumber: gameState.roundNumber,
        status: gameState.status,
        countdown: gameState.countdown,
        calledNumbers: gameState.calledNumbers,
        currentNumber: gameState.currentNumber,
        totalPrize: gameState.totalPrize,
        totalCards: Object.keys(gameState.selectedCards).length,
        selectedCards: Object.keys(gameState.selectedCards).map(Number)
    });

    socket.on('buy_card', async ({ telegramId, cardIndex, botKey = 'swift' }) => {
        const cIndex = parseInt(cardIndex);
        const cleanBotKey = String(botKey).toLowerCase();

        if (isNaN(cIndex) || cIndex < 1 || cIndex > 999) {
            socket.emit('error_msg', 'የተሳሳተ የካርድ ቁጥር! (ከ 1 እስከ 999)');
            return;
        }

        if (gameState.status !== 'SELECTION') {
            socket.emit('error_msg', 'የካርድ መቁረጫ ሰዓቱ አልቋል!');
            return;
        }

        if (gameState.selectedCards[cIndex]) {
            socket.emit('error_msg', `ካርድ #${cIndex} ቀደም ሲል ተይዟል!`);
            return;
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const userRes = await client.query(
                `SELECT id, first_name, real_balance, bonus_balance 
                 FROM users WHERE telegram_id = $1 AND bot_key = $2 FOR UPDATE`, 
                [telegramId, cleanBotKey]
            );

            if (userRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return socket.emit('error_msg', 'ተጠቃሚው አልተገኘም!');
            }

            const user = userRes.rows[0];
            const realBal = parseFloat(user.real_balance || 0);
            const bonusBal = parseFloat(user.bonus_balance || 0);

            // 🎯 ቦነስ ካለው ቅድሚያ ከቦነስ ይቀንሳል፤ ከሌለው ከ Real Balance ይቀንሳል
            let deductBonus = 0;
            let deductReal = 0;

            if (bonusBal >= CARD_PRICE) {
                deductBonus = CARD_PRICE;
            } else if (bonusBal > 0) {
                deductBonus = bonusBal;
                deductReal = CARD_PRICE - bonusBal;
                if (realBal < deductReal) {
                    await client.query('ROLLBACK');
                    return socket.emit('error_msg', `ሒሳብዎ በቂ አይደለም! (ካርድ 10 ETB)`);
                }
            } else {
                deductReal = CARD_PRICE;
                if (realBal < deductReal) {
                    await client.query('ROLLBACK');
                    return socket.emit('error_msg', `ሒሳብዎ በቂ አይደለም! (ካርድ 10 ETB)`);
                }
            }

            await client.query(
                `UPDATE users 
                 SET bonus_balance = bonus_balance - $1,
                     real_balance = real_balance - $2,
                     balance = real_balance - $2,
                     cards_bought_this_week = cards_bought_this_week + 1 
                 WHERE id = $3`,
                [deductBonus, deductReal, user.id]
            );

            await client.query(
                `INSERT INTO transactions (user_id, bot_key, type, payment_method, amount, sms_text, status) 
                 VALUES ($1, $2, 'BINGO_CARD', 'INTERNAL', $3, $4, 'APPROVED')`,
                [user.id, cleanBotKey, CARD_PRICE, `Round #${gameState.roundNumber} - Card #${cIndex}`]
            );

            const generatedCard = generateBingoCard();
            gameState.selectedCards[cIndex] = {
                userId: user.id,
                userName: user.first_name,
                botKey: cleanBotKey,
                numbers: generatedCard,
                isBot: false
            };

            await client.query('COMMIT');

            const cardCount = Object.keys(gameState.selectedCards).length;
            const totalPot = cardCount * CARD_PRICE;
            gameState.totalPrize = totalPot * (1 - HOUSE_COMMISSION);
            gameState.ownerProfit = totalPot * HOUSE_COMMISSION;

            io.emit('card_taken', {
                cardIndex: cIndex,
                userName: user.first_name,
                totalCards: cardCount,
                poolPrize: gameState.totalPrize
            });

            socket.emit('my_card', { cardIndex: cIndex, numbers: generatedCard });
        } catch (e) {
            await client.query('ROLLBACK');
            console.error('Card Purchase Error:', e);
        } finally {
            client.release();
        }
    });
});

// ================= 11. START SERVER ================= //
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`⚡ Multi-Bot Bingo Central Server running on port ${PORT}`);
});

process.once('SIGINT', () => {
    Object.values(activeBots).forEach(b => b.stop('SIGINT'));
});
process.once('SIGTERM', () => {
    Object.values(activeBots).forEach(b => b.stop('SIGTERM'));
});
