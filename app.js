const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const axios = require("axios");
const fs = require("fs");
const pino = require("pino");
const QRCode = require("qrcode"); 
const express = require("express");

const app = express();
app.use(express.json()); 

const PORT = process.env.PORT || 3000;

// --- STORAGE (Optimized for Render /tmp) ---
const SESSION_FOLDER = "/tmp/sessions"; 
const HISTORY_FILE = "/tmp/posted_news.json";

if (!fs.existsSync(SESSION_FOLDER)) fs.mkdirSync(SESSION_FOLDER, { recursive: true });
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));

// --- SETTINGS ---
const API_KEY = "f7da4fb81e024dcba2f28f19ec500cfc"; 
const CHANNEL_JID = "120363424747900547@newsletter";
const HEADERS = ["🚨 *BREAKING NEWS*", "🌍 *WORLD UPDATES*", "📡 *GLOBAL FLASH*", "⚡ *QUICK FEED*", "🔥 *NEWS UPDATE*"];

let sock;
let newsQueue = []; 
let botStatus = "Disconnected";
let isBotActive = true; 
let latestQR = null; 
let postIntervalTime = 10000; 
let postTimer;
let intervalsStarted = false;

// --- HELPERS ---
function getHistory() {
    try {
        return JSON.parse(fs.readFileSync(HISTORY_FILE));
    } catch (e) { return []; }
}

function saveToHistory(url) {
    let history = getHistory();
    if (!history.includes(url)) {
        history.push(url);
        if (history.length > 1000) history.shift();
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    }
}

// --- CORE LOGIC ---
async function scanNews() {
    if (!isBotActive) return;
    const yesterday = new Date();
    yesterday.setHours(yesterday.getHours() - 24);
    const url = `https://newsapi.org/v2/everything?q=world&from=${yesterday.toISOString().split('T')[0]}&sortBy=publishedAt&language=en&apiKey=${API_KEY}`;
    
    try {
        const { data } = await axios.get(url);
        if (data.status !== "ok") return;
        let history = getHistory();
        data.articles.forEach(article => {
            if (article.url && !history.includes(article.url) && !newsQueue.some(a => a.url === article.url)) {
                newsQueue.push(article);
            }
        });
    } catch (e) { console.error("Scan Error:", e.message); }
}

async function postFromQueue() {
    if (!isBotActive || newsQueue.length === 0 || !sock) return;
    const article = newsQueue.shift();
    const header = HEADERS[Math.floor(Math.random() * HEADERS.length)];
    try {
        const message = `${header}\n\n📰 *${article.title.toUpperCase()}*\n\n${article.description || ""}\n\n🔗 ${article.url}\n\n📡 _Source: ${article.source.name}_`;
        await sock.sendMessage(CHANNEL_JID, { text: message });
        saveToHistory(article.url);
    } catch (err) { 
        console.error("Post Error:", err.message);
        newsQueue.unshift(article); 
    }
}

// --- API ROUTES ---
app.get('/api/stats', (req, res) => {
    res.json({
        posted: getHistory().length,
        queue: newsQueue.length,
        status: botStatus,
        isBotActive,
        interval: postIntervalTime / 1000,
        qr: latestQR
    });
});

app.post('/api/toggle', (req, res) => {
    isBotActive = !isBotActive;
    res.json({ active: isBotActive });
});

app.post('/api/set-interval', (req, res) => {
    const { seconds } = req.body;
    clearInterval(postTimer);
    postIntervalTime = seconds * 1000;
    postTimer = setInterval(postFromQueue, postIntervalTime);
    res.json({ success: true });
});

// --- DASHBOARD ---
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
            body { background: #020617; color: white; font-family: ui-sans-serif, system-ui; }
            .stat-card { background: #0f172a; border: 1px solid rgba(255,255,255,0.05); }
        </style>
    </head>
    <body class="flex items-center justify-center min-h-screen p-4">
        <div class="w-full max-w-sm">
            <header class="text-center mb-8">
                <h1 class="text-4xl font-black tracking-tighter text-blue-500">WATCHDOG</h1>
                <p id="statusLabel" class="text-[10px] font-mono uppercase tracking-[0.3em] text-slate-500 mt-2">Connecting</p>
            </header>

            <div id="qrBox" class="hidden stat-card p-6 rounded-[2.5rem] text-center mb-6 border-2 border-blue-500/20">
                <p class="text-[10px] font-black text-blue-400 mb-4 uppercase tracking-widest text-center">Scan to Link</p>
                <div class="bg-white p-2 rounded-xl inline-block mb-4 shadow-xl">
                    <img id="qrImg" class="w-48 h-48" />
                </div>
                <p class="text-[9px] text-slate-500 italic">Open WhatsApp > Linked Devices</p>
            </div>

            <div class="grid grid-cols-2 gap-4 mb-6">
                <div class="stat-card p-6 rounded-3xl text-center">
                    <p class="text-slate-500 text-[9px] uppercase font-black mb-1">Posted</p>
                    <h2 id="postedCount" class="text-4xl font-black">0</h2>
                </div>
                <div class="stat-card p-6 rounded-3xl text-center">
                    <p class="text-slate-500 text-[9px] uppercase font-black mb-1 text-orange-500">Queue</p>
                    <h2 id="queueCount" class="text-4xl font-black">0</h2>
                </div>
            </div>

            <div class="stat-card p-6 rounded-[2rem] mb-6">
                <div class="flex justify-between items-center mb-4">
                    <p class="text-slate-500 text-[10px] uppercase font-black tracking-widest">Post Interval</p>
                    <span id="intervalVal" class="bg-blue-600 px-3 py-1 rounded-lg text-xs font-bold text-white">10s</span>
                </div>
                <input type="range" min="5" max="600" value="10" class="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                    oninput="document.getElementById('intervalVal').innerText = this.value + 's'"
                    onchange="fetch('/api/set-interval', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({seconds:parseInt(this.value)})})">
            </div>

            <button id="killBtn" onclick="fetch('/api/toggle', {method:'POST'})" class="w-full py-6 rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-2xl transition-all">SYNCING</button>
        </div>

        <script>
            async function refresh() {
                try {
                    const res = await fetch('/api/stats');
                    const data = await res.json();
                    document.getElementById('postedCount').innerText = data.posted;
                    document.getElementById('queueCount').innerText = data.queue;
                    document.getElementById('statusLabel').innerText = data.status;

                    if (data.qr && data.status !== 'Active') {
                        document.getElementById('qrBox').classList.remove('hidden');
                        document.getElementById('qrImg').src = data.qr;
                    } else {
                        document.getElementById('qrBox').classList.add('hidden');
                    }

                    const btn = document.getElementById('killBtn');
                    btn.innerText = data.isBotActive ? "🛑 Stop Engine" : "🚀 Resume Engine";
                    btn.className = "w-full py-6 rounded-2xl font-black text-[10px] uppercase tracking-widest " + (data.isBotActive ? "bg-red-600 text-white" : "bg-green-600 text-white");
                } catch(e){}
            }
            setInterval(refresh, 3000);
            refresh();
        </script>
    </body>
    </html>
    `);
});

// --- STARTUP ---
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
    sock = makeWASocket({ auth: state, logger: pino({ level: "silent" }) });
    
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;
        
        if (qr) {
            console.log("QR Updated - Fetching DataURL");
            latestQR = await QRCode.toDataURL(qr); 
        }
        
        if (connection === "open") {
            botStatus = "Active";
            latestQR = null; 
            if (!intervalsStarted) {
                scanNews();
                setInterval(scanNews, 60 * 60 * 1000); 
                postTimer = setInterval(postFromQueue, postIntervalTime);
                intervalsStarted = true;
            }
        }
        
        if (connection === "close") {
            botStatus = "Disconnected";
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });
}

startBot();
app.listen(PORT, '0.0.0.0', () => console.log(`Watchdog PRO online on port ${PORT}`));