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
const SESSION_PATH = path.join(__dirname, ".session");
const CREDS_PATH = path.join(SESSION_PATH, "creds.json");
const SOURCE_JSON = path.join(__dirname, "session.json"); 
const HISTORY_FILE = path.join(__dirname, "posted_news.json");

// Ensure history file exists
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));

// --- BOT SETTINGS ---
const API_KEY = "f7da4fb81e024dcba2f28f19ec500cfc"; 
const CHANNEL_JID = "120363424747900547@newsletter";
const HEADERS = ["🚨 *BREAKING NEWS*", "🌍 *WORLD UPDATES*", "📡 *GLOBAL FLASH*", "⚡ *QUICK FEED*", "🔥 *NEWS UPDATE*"];

let sock = null;
let newsQueue = []; 
let botStatus = "Disconnected"; 
let latestQR = null; 
let postIntervalTime = 60000; // 1 minute between posts
let scanTimer = null;
let postTimer = null;
let intervalsStarted = false;

async function startBot() {
    if (sock) return;

    // 1. SESSION RESTORATION FROM LOCAL FILE
    if (fs.existsSync(SOURCE_JSON)) {
        if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
        try {
            const data = fs.readFileSync(SOURCE_JSON);
            fs.writeFileSync(CREDS_PATH, data);
            console.log("📂 Session initialized from uploaded session.json");
        } catch (e) {
            console.error("❌ Error setting up session files:", e);
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

    sock.ev.on("creds.update", saveCreds);

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
                scanTimer = setInterval(scanNews, 60 * 60 * 1000); // Scan every hour
                postTimer = setInterval(postFromQueue, postIntervalTime);
                intervalsStarted = true;
            }
        }

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            botStatus = "Disconnected";
            sock = null;

            if (reason === DisconnectReason.loggedOut) {
                console.log("Logged out. Delete session.json and re-link.");
                if (fs.existsSync(SESSION_PATH)) fs.rmSync(SESSION_PATH, { recursive: true, force: true });
            } else {
                setTimeout(startBot, 5000);
            }
        }
    });
}

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
        console.log(`🔎 Scanned news. Queue size: ${newsQueue.length}`);
    } catch (e) {
        console.error("News API Error: ", e.message);
    }
}

async function postFromQueue() {
    if (botStatus !== "Active" || newsQueue.length === 0 || !sock) return;

    const article = newsQueue.shift();
    const header = HEADERS[Math.floor(Math.random() * HEADERS.length)];

    try {
        const message = `${header}\n\n📰 *${article.title.toUpperCase()}*\n\n${article.description || ""}\n\n🔗 ${article.url}\n\n📡 _Source: ${article.source.name}_`;
        
        await sock.sendMessage(CHANNEL_JID, { text: message });
        
        // Save to history
        let history = JSON.parse(fs.readFileSync(HISTORY_FILE));
        history.push(article.url);
        // Keep history manageable (last 500 links)
        if (history.length > 500) history.shift();
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
        
        console.log("📤 Posted: " + article.title);
    } catch (err) {
        console.error("Post failed, re-queueing...");
        newsQueue.unshift(article); 
    }
}

// --- EXPRESS ROUTES ---

app.get('/', (req, res) => {
    res.send(`
        <html>
            <body style="font-family:sans-serif; text-align:center; padding:50px;">
                <h1>News Bot Status: ${botStatus}</h1>
                <p>Queue: ${newsQueue.length} articles</p>
                ${latestQR ? `<h3>Scan QR if disconnected:</h3><img src="${latestQR}">` : '<p>✅ Connected and Running</p>'}
                <script>setTimeout(() => location.reload(), 30000);</script>
            </body>
        </html>
    `);
});

app.get('/api/stats', (req, res) => {
    res.json({ status: botStatus, queue: newsQueue.length });
});

startBot();
app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on port ${PORT}`));