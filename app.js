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

// --- PERSISTENT STORAGE (/temp) ---
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
const HEADERS = ["🚨 *BREAKING NEWS*", "🌍 *WORLD UPDATES*", "📡 *GLOBAL FLASH*", "⚡ *QUICK FEED*", "🔥 *NEWS UPDATE*"];

let sock = null;
let latestQR = null;
let botStatus = "Disconnected";
let isBotActive = true; 
let intervalsStarted = false;

// --- HELPERS ---
function getHistoryCount() {
    try {
        const data = JSON.parse(fs.readFileSync(HISTORY_FILE));
        return data.length;
    } catch (e) { return 0; }
}

function getQueueCount() {
    try {
        const data = JSON.parse(fs.readFileSync(QUEUE_FILE));
        return data.length;
    } catch (e) { return 0; }
}

// --- CORE ENGINE ---
async function scanNews() {
    if (!isBotActive || botStatus !== "Active") return;
    
    const yesterday = new Date();
    yesterday.setHours(yesterday.getHours() - 24);
    const url = `https://newsapi.org/v2/everything?q=world&from=${yesterday.toISOString().split('T')[0]}&sortBy=publishedAt&language=en&apiKey=${API_KEY}`;
    
    try {
        const { data } = await axios.get(url);
        if (data.status !== "ok") return;

        let history = JSON.parse(fs.readFileSync(HISTORY_FILE));
        let queue = JSON.parse(fs.readFileSync(QUEUE_FILE));

        data.articles.forEach(article => {
            if (article.url && !history.includes(article.url) && !queue.some(a => a.url === article.url)) {
                queue.push(article);
            }
        });
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue));
    } catch (e) { console.error("Scan Error"); }
}

async function postFromQueue() {
    if (!isBotActive || botStatus !== "Active") return;

    let queue = JSON.parse(fs.readFileSync(QUEUE_FILE));
    if (queue.length === 0) return;

    const article = queue.shift();
    const header = HEADERS[Math.floor(Math.random() * HEADERS.length)];
    
    try {
        const message = `${header}\n\n📰 *${article.title.toUpperCase()}*\n\n${article.description || ""}\n\n🔗 ${article.url}\n\n📡 _Source: ${article.source.name}_`;
        await sock.sendMessage(CHANNEL_JID, { text: message });
        
        let history = JSON.parse(fs.readFileSync(HISTORY_FILE));
        history.push(article.url);
        if (history.length > 1000) history.shift();
        
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue));
    } catch (err) {
        queue.unshift(article);
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue));
    }
}

// --- WHATSAPP SETUP ---
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
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
            botStatus = "Active";
            latestQR = null;
            if (!intervalsStarted) {
                scanNews();
                setInterval(scanNews, 60 * 60 * 1000); // 1hr
                setInterval(postFromQueue, 30000);     // 30s
                intervalsStarted = true;
            }
        }

        if (connection === "close") {
            botStatus = "Disconnected";
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut) {
                fs.rmSync(SESSION_PATH, { recursive: true, force: true });
            }
            setTimeout(startBot, 5000);
        }
    });
}

// --- ROUTES ---
app.get('/api/stats', (req, res) => {
    res.json({
        posted: getHistoryCount(),
        queue: getQueueCount(),
        status: botStatus,
        isBotActive: isBotActive,
        qr: latestQR
    });
});

app.post('/api/toggle', (req, res) => {
    isBotActive = !isBotActive;
    res.json({ active: isBotActive });
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Watchdog Pro</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            body { background: #020617; color: white; }
            .stat-card { background: #0f172a; border: 1px solid rgba(255,255,255,0.05); }
        </style>
    </head>
    <body class="flex items-center justify-center min-h-screen p-4">
        <div class="w-full max-w-sm">
            <div class="text-center mb-6">
                <h1 class="text-4xl font-black tracking-tighter text-blue-500 italic">WATCHDOG PRO</h1>
                <div class="mt-2 flex items-center justify-center gap-2">
                    <span id="statusDot" class="h-2 w-2 rounded-full bg-red-500"></span>
                    <span id="statusText" class="text-[10px] font-mono uppercase tracking-[0.3em] text-slate-500">Connecting</span>
                </div>
            </div>

            <div id="qrContainer" class="hidden mb-6 bg-white p-4 rounded-3xl text-center">
                <p class="text-black text-xs font-bold mb-2">SCAN TO LINK WHATSAPP</p>
                <img id="qrImg" class="mx-auto w-48 h-48">
            </div>

            <div class="space-y-4 mb-10">
                <div class="stat-card p-8 rounded-[2.5rem] text-center">
                    <p class="text-slate-500 text-[10px] uppercase font-black tracking-widest mb-1">Total Posts</p>
                    <h2 id="postedCount" class="text-6xl font-black text-white">0</h2>
                </div>
                <div class="stat-card p-8 rounded-[2.5rem] text-center">
                    <p class="text-slate-500 text-[10px] uppercase font-black tracking-widest mb-1">Queue</p>
                    <h2 id="queueCount" class="text-6xl font-black text-orange-500">0</h2>
                </div>
            </div>

            <button id="killBtn" onclick="toggleBot()" class="w-full py-6 rounded-[2rem] font-black uppercase text-xs border-b-4 transition-all active:translate-y-1">
                LOADING...
            </button>
        </div>

        <script>
            async function toggleBot() {
                await fetch('/api/toggle', { method: 'POST' });
                updateStats();
            }

            async function updateStats() {
                try {
                    const res = await fetch('/api/stats');
                    const data = await res.json();
                    
                    document.getElementById('postedCount').innerText = data.posted;
                    document.getElementById('queueCount').innerText = data.queue;
                    document.getElementById('statusText').innerText = data.status;

                    const dot = document.getElementById('statusDot');
                    dot.className = "h-2 w-2 rounded-full " + (data.status === 'Active' ? 'bg-green-500 animate-pulse' : 'bg-red-500');

                    if (data.qr) {
                        document.getElementById('qrContainer').classList.remove('hidden');
                        document.getElementById('qrImg').src = data.qr;
                    } else {
                        document.getElementById('qrContainer').classList.add('hidden');
                    }

                    const btn = document.getElementById('killBtn');
                    if (data.isBotActive) {
                        btn.innerText = "🛑 STOP SERVICES";
                        btn.className = "w-full py-6 rounded-[2rem] font-black bg-red-600 border-red-800 text-white";
                    } else {
                        btn.innerText = "🚀 RESUME SERVICES";
                        btn.className = "w-full py-6 rounded-[2rem] font-black bg-green-600 border-green-800 text-white";
                    }
                } catch (e) {}
            }
            setInterval(updateStats, 3000);
            updateStats();
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Watchdog running on port ${PORT}`);
    startBot();
});