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

const PORT = process.env.PORT || 10000;

// --- STORAGE ---
const TEMP_DIR = path.join(__dirname, "temp");
const SESSION_PATH = path.join(TEMP_DIR, "session");
const HISTORY_FILE = path.join(TEMP_DIR, "posted_news.json");
const QUEUE_FILE = path.join(TEMP_DIR, "news_queue.json");

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));
if (!fs.existsSync(QUEUE_FILE)) fs.writeFileSync(QUEUE_FILE, JSON.stringify([]));

// --- SETTINGS ---
const API_KEY = "f7da4fb81e024dcba2f28f19ec500cfc"; 
const CHANNEL_JID = "120363424747900547@newsletter";

let sock = null;
let botStatus = "Initializing"; 
let latestQR = null;
let intervalsStarted = false;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    console.log("🚀 Starting WhatsApp Engine...");
    botStatus = "Connecting...";

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: true, // Also shows in Render logs
        browser: ["Watchdog Pro", "Chrome", "1.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            console.log("💡 NEW QR CODE GENERATED");
            latestQR = await QRCode.toDataURL(qr);
            botStatus = "QR Ready - PLEASE SCAN";
        }

        if (connection === "open") {
            console.log("✅ CONNECTED SUCCESSFULLY");
            botStatus = "Active";
            latestQR = null;
            if (!intervalsStarted) {
                setInterval(scanNews, 60 * 60 * 1000); 
                setInterval(postFromQueue, 60000); 
                scanNews(); 
                intervalsStarted = true;
            }
        }

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            botStatus = "Disconnected";
            latestQR = null;
            
            if (reason === DisconnectReason.loggedOut) {
                console.log("❌ Logged out. Clearing session for new QR...");
                fs.rmSync(SESSION_PATH, { recursive: true, force: true });
                if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH);
                setTimeout(startBot, 2000);
            } else {
                setTimeout(startBot, 5000);
            }
        }
    });
}

// --- NEWS LOGIC (Simplified) ---
async function scanNews() {
    try {
        const url = `https://newsapi.org/v2/everything?q=world&language=en&apiKey=${API_KEY}`;
        const { data } = await axios.get(url);
        let history = JSON.parse(fs.readFileSync(HISTORY_FILE));
        let queue = JSON.parse(fs.readFileSync(QUEUE_FILE));
        
        data.articles.forEach(article => {
            if (!history.includes(article.url) && !queue.some(a => a.url === article.url)) {
                queue.push(article);
            }
        });
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue));
    } catch (e) { console.log("News fetch failed."); }
}

async function postFromQueue() {
    if (botStatus !== "Active") return;
    let queue = JSON.parse(fs.readFileSync(QUEUE_FILE));
    if (queue.length === 0) return;

    const article = queue.shift();
    try {
        const msg = `🚨 *NEWS UPDATE*\n\n*${article.title}*\n\n🔗 ${article.url}`;
        await sock.sendMessage(CHANNEL_JID, { text: msg });
        let history = JSON.parse(fs.readFileSync(HISTORY_FILE));
        history.push(article.url);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-100)));
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue));
    } catch (e) { queue.unshift(article); fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue)); }
}

// --- DASHBOARD ---
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Watchdog Pro | Auth</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { background: #0f172a; color: white; font-family: sans-serif; text-align: center; padding: 20px; }
                .card { background: #1e293b; padding: 30px; border-radius: 20px; display: inline-block; margin-top: 50px; border: 1px solid #334155; }
                img { background: white; padding: 10px; border-radius: 10px; margin-top: 20px; }
                .status { text-transform: uppercase; letter-spacing: 2px; font-weight: bold; color: #38bdf8; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>WATCHDOG PRO</h1>
                <p class="status">${botStatus}</p>
                ${latestQR ? `<div><p>Scan this with your WhatsApp:</p><img src="${latestQR}"></div>` : '<p><i>Waiting for QR or Connected...</i></p>'}
            </div>
            <script>setTimeout(() => { if(!document.querySelector('img') && "${botStatus}" !== "Active") location.reload(); }, 5000);</script>
        </body>
        </html>
    `);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Dashboard: port ${PORT}`);
    startBot();
});