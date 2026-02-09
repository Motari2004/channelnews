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

const PORT = process.env.PORT || 10000; // Render's preferred port

// --- PATHS ---
const SESSION_PATH = path.join(__dirname, "session");
const CREDS_PATH = path.join(SESSION_PATH, "creds.json");
const SOURCE_JSON = path.join(__dirname, "session.json");
const HISTORY_FILE = path.join(__dirname, "posted_news.json");

// Ensure directories exist
if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));

// --- SETTINGS ---
const API_KEY = "f7da4fb81e024dcba2f28f19ec500cfc"; 
const CHANNEL_JID = "120363424747900547@newsletter";
const HEADERS = ["🚨 *BREAKING NEWS*", "🌍 *WORLD UPDATES*", "📡 *GLOBAL FLASH*"];

let sock = null;
let newsQueue = []; 
let botStatus = "Disconnected"; 
let latestQR = null;
let intervalsStarted = false;

async function startBot() {
    // Session setup from the file you uploaded
    if (fs.existsSync(SOURCE_JSON) && !fs.existsSync(CREDS_PATH)) {
        console.log("📂 Session initialized from uploaded session.json");
        fs.writeFileSync(CREDS_PATH, fs.readFileSync(SOURCE_JSON));
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: true,
        browser: ["Watchdog Pro", "Chrome", "1.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            latestQR = await QRCode.toDataURL(qr);
            botStatus = "QR Ready";
        }

        if (connection === "open") {
            console.log("✅ CONNECTED TO WHATSAPP");
            botStatus = "Active";
            latestQR = null;
            
            if (!intervalsStarted) {
                setInterval(scanNews, 60 * 60 * 1000); // Hourly scan
                setInterval(postFromQueue, 30000);     // Post every 30s
                scanNews(); 
                intervalsStarted = true;
            }
        }

        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            botStatus = "Disconnected";
            if (shouldReconnect) setTimeout(startBot, 5000);
        }
    });
}

// --- PREVENT CRASHES ---
process.on('uncaughtException', (err) => {
    console.error('⚠️ Critical Error Caught:', err.message);
});

// --- NEWS LOGIC ---
async function scanNews() {
    try {
        const url = `https://newsapi.org/v2/everything?q=world&language=en&apiKey=${API_KEY}`;
        const { data } = await axios.get(url);
        let history = JSON.parse(fs.readFileSync(HISTORY_FILE));
        
        data.articles.forEach(article => {
            if (!history.includes(article.url)) newsQueue.push(article);
        });
        console.log(`🔎 Queue: ${newsQueue.length}`);
    } catch (e) { console.log("API Fetch failed."); }
}

async function postFromQueue() {
    if (botStatus !== "Active" || newsQueue.length === 0) return;
    const article = newsQueue.shift();
    try {
        const msg = `*${article.title}*\n\n${article.description}\n\n🔗 ${article.url}`;
        await sock.sendMessage(CHANNEL_JID, { text: msg });
        
        let history = JSON.parse(fs.readFileSync(HISTORY_FILE));
        history.push(article.url);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-100))); // Keep last 100
    } catch (e) { newsQueue.unshift(article); }
}

// --- WEB SERVER ---
app.get('/', (req, res) => res.send(`Bot Status: ${botStatus} | Queue: ${newsQueue.length}`));
app.get('/api/stats', (req, res) => res.json({ status: botStatus, queue: newsQueue.length, qr: latestQR }));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server active on port ${PORT}`);
    startBot();
});