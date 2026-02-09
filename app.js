const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require("@whiskeysockets/baileys");
const axios = require("axios");
const fs = require("fs");
const pino = require("pino");
const QRCode = require("qrcode"); 
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json()); 

const PORT = process.env.PORT || 3000;
const SESSION_PATH = path.join(__dirname, "session");
const CREDS_PATH = path.join(SESSION_PATH, "creds.json");
const HISTORY_FILE = path.join(__dirname, "posted_news.json");

if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));

// --- BOT SETTINGS ---
const API_KEY = "f7da4fb81e024dcba2f28f19ec500cfc"; 
const CHANNEL_JID = "120363424747900547@newsletter";
const HEADERS = ["🚨 *BREAKING NEWS*", "🌍 *WORLD UPDATES*", "📡 *GLOBAL FLASH*", "⚡ *QUICK FEED*", "🔥 *NEWS UPDATE*"];

let sock = null;
let newsQueue = []; 
let botStatus = "Disconnected"; 
let latestQR = null; 
let postIntervalTime = 10000; 
let postTimer = null;
let scanTimer = null;
let intervalsStarted = false;

async function startBot() {
    if (sock) return;

    // --- RENDER ENVIRONMENT RESTORE ---
    if (process.env.SESSION_DATA) {
        if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
        try {
            const decodedData = Buffer.from(process.env.SESSION_DATA, 'base64').toString('utf-8');
            fs.writeFileSync(CREDS_PATH, decodedData);
            console.log("📂 Session file created from ENV variable.");
        } catch (e) {
            console.error("❌ Error decoding SESSION_DATA:", e);
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    botStatus = "Connecting";
    
    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: true,
        browser: ["Watchdog Pro", "Chrome", "1.0.0"],
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
    });

    // When keys update, save them and print a new Base64 string for backup
    sock.ev.on("creds.update", () => {
        saveCreds();
        const currentCreds = fs.readFileSync(CREDS_PATH).toString('base64');
        console.log("🔄 SESSION UPDATED. If the bot stops working later, update your Render ENV with this:");
        console.log(currentCreds);
    });

    sock.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            latestQR = await QRCode.toDataURL(qr);
            botStatus = "QR Ready";
        }

        if (connection === "open") {
            console.log("✅ WHATSAPP CONNECTED");
            botStatus = "Active";
            latestQR = null;
            if (!intervalsStarted) {
                scanNews();
                scanTimer = setInterval(scanNews, 60 * 60 * 1000); 
                postTimer = setInterval(postFromQueue, postIntervalTime);
                intervalsStarted = true;
            }
        }

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            botStatus = "Disconnected";
            sock = null;
            if (reason === DisconnectReason.loggedOut) {
                console.log("Logged out. Manual intervention required.");
                fs.rmSync(SESSION_PATH, { recursive: true, force: true });
            } else {
                setTimeout(startBot, 5000);
            }
        }
    });
}

// ... (Rest of your scanNews, postFromQueue, and API routes)
// Ensure you keep the scanNews, postFromQueue, and express routes from your previous code!

async function scanNews() {
    if (botStatus !== "Active") return;
    const yesterday = new Date();
    yesterday.setHours(yesterday.getHours() - 24);
    const url = `https://newsapi.org/v2/everything?q=world&from=${yesterday.toISOString().split('T')[0]}&sortBy=publishedAt&language=en&apiKey=${API_KEY}`;
    try {
        const { data } = await axios.get(url);
        if (data.status !== "ok") return;
        let history = JSON.parse(fs.readFileSync(HISTORY_FILE));
        data.articles.forEach(article => {
            if (article.url && !history.includes(article.url) && !newsQueue.some(a => a.url === article.url)) {
                newsQueue.push(article);
            }
        });
    } catch (e) { console.error("News API Error"); }
}

async function postFromQueue() {
    if (botStatus !== "Active" || newsQueue.length === 0 || !sock) return;
    const article = newsQueue.shift();
    const header = HEADERS[Math.floor(Math.random() * HEADERS.length)];
    try {
        const message = `${header}\n\n📰 *${article.title.toUpperCase()}*\n\n${article.description || ""}\n\n🔗 ${article.url}\n\n📡 _Source: ${article.source.name}_`;
        await sock.sendMessage(CHANNEL_JID, { text: message });
        let history = JSON.parse(fs.readFileSync(HISTORY_FILE));
        history.push(article.url);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    } catch (err) { 
        console.log("Post failed, re-queueing...");
        newsQueue.unshift(article); 
    }
}

app.get('/api/stats', (req, res) => {
    res.json({
        posted: (JSON.parse(fs.readFileSync(HISTORY_FILE))).length,
        queue: newsQueue.length,
        status: botStatus,
        qr: latestQR
    });
});

app.post('/api/control', async (req, res) => {
    const { action } = req.body;
    if (action === "stop") {
        if (sock) {
            await sock.logout();
            sock = null;
        }
        botStatus = "Disconnected";
        clearInterval(scanTimer);
        clearInterval(postTimer);
        intervalsStarted = false;
    }
    if (action === "start") startBot();
    res.json({ success: true });
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>...[UI HTML as before]...`);
});

startBot();
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));