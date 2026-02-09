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
const SESSION_FOLDER = "/tmp/watchdog_sessions"; 
const HISTORY_FILE = "/tmp/posted_news.json";

if (!fs.existsSync(SESSION_FOLDER)) fs.mkdirSync(SESSION_FOLDER, { recursive: true });
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));

// --- SETTINGS ---
const API_KEY = "f7da4fb81e024dcba2f28f19ec500cfc"; 
const CHANNEL_JID = "120363424747900547@newsletter";
const HEADERS = ["🚨 *BREAKING NEWS*", "🌍 *WORLD UPDATES*", "📡 *GLOBAL FLASH*", "⚡ *QUICK FEED*", "🔥 *NEWS UPDATE*"];

// Global State
let sock = null;
let newsQueue = []; 
let botStatus = "Disconnected"; 
let latestQR = null; 
let postIntervalTime = 10000; 
let postTimer = null;
let scanTimer = null;
let intervalsStarted = false;

// --- CORE LOGIC ---
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
        console.log(`Scan successful. Queue: ${newsQueue.length}`);
    } catch (e) { console.error("Scan Error:", e.message); }
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
        console.error("Posting failed, returning to queue...");
        newsQueue.unshift(article); 
    }
}

// --- BOT STARTUP ---
async function startBot() {
    botStatus = "Connecting";
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "110.0.5481.177"],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            console.log("New QR Generated");
            latestQR = await QRCode.toDataURL(qr);
        }

        if (connection === "open") {
            console.log("✅ Connected to WhatsApp");
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
            botStatus = "Disconnected";
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`Connection closed [${statusCode}]. Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                // 5-second delay to prevent Render loop spam
                setTimeout(() => startBot(), 5000);
            } else {
                console.log("Session logged out. Wiping credentials...");
                fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
                setTimeout(() => startBot(), 5000);
            }
        }
    });
}

// --- API ENDPOINTS ---
app.get('/api/stats', (req, res) => {
    res.json({
        posted: (JSON.parse(fs.readFileSync(HISTORY_FILE))).length,
        queue: newsQueue.length,
        status: botStatus,
        interval: postIntervalTime / 1000,
        qr: latestQR
    });
});

app.post('/api/set-interval', (req, res) => {
    const { seconds } = req.body;
    clearInterval(postTimer);
    postIntervalTime = seconds * 1000;
    postTimer = setInterval(postFromQueue, postIntervalTime);
    res.json({ success: true });
});

// --- DASHBOARD UI ---
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Watchdog Pro Setup</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            body { background: #020617; color: white; font-family: ui-sans-serif, system-ui; }
            .stat-card { background: #0f172a; border: 1px solid rgba(255,255,255,0.05); }
            .qr-overlay { background: #020617; position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column; align-items: center; justify-content: center; }
        </style>
    </head>
    <body class="p-4">
        <div id="qrOverlay" class="qr-overlay">
            <h1 class="text-4xl font-black text-blue-500 mb-2 tracking-tighter">WATCHDOG PRO</h1>
            <p class="text-slate-500 text-xs font-mono mb-10 uppercase tracking-widest">Initial Connection Required</p>
            
            <div id="qrContainer" class="stat-card p-6 rounded-[3rem] border-2 border-blue-500/30 text-center">
                <div id="qrLoader" class="w-48 h-48 flex items-center justify-center italic text-slate-600">Generating QR...</div>
                <img id="qrImg" class="hidden w-48 h-48 bg-white p-2 rounded-2xl mx-auto shadow-2xl" />
                <p class="text-[10px] text-blue-400 font-bold mt-6 uppercase tracking-widest">Scan with WhatsApp</p>
            </div>
            <p class="mt-8 text-[9px] text-slate-600 uppercase tracking-[0.4em]">Waiting for system handshake</p>
        </div>

        <div id="mainDashboard" class="hidden max-w-sm mx-auto mt-10">
            <header class="text-center mb-8">
                <h1 class="text-2xl font-black text-blue-500 uppercase tracking-tighter italic">Watchdog Active</h1>
                <p class="text-[10px] text-green-500 font-mono animate-pulse uppercase">● Connected</p>
            </header>

            <div class="grid grid-cols-2 gap-4 mb-6">
                <div class="stat-card p-6 rounded-3xl text-center">
                    <p class="text-slate-500 text-[9px] uppercase font-black mb-1">Posted</p>
                    <h2 id="postedCount" class="text-4xl font-black">0</h2>
                </div>
                <div class="stat-card p-6 rounded-3xl text-center">
                    <p class="text-orange-500 text-[9px] uppercase font-black mb-1">Queue</p>
                    <h2 id="queueCount" class="text-4xl font-black">0</h2>
                </div>
            </div>

            <div class="stat-card p-6 rounded-[2rem] mb-6">
                <p class="text-slate-500 text-[10px] uppercase font-black mb-4">Post Interval: <span id="intervalVal" class="text-blue-500">10s</span></p>
                <input type="range" min="5" max="600" value="10" class="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                    oninput="document.getElementById('intervalVal').innerText = this.value + 's'"
                    onchange="fetch('/api/set-interval', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({seconds:parseInt(this.value)})})">
            </div>
        </div>

        <script>
            async function refresh() {
                try {
                    const res = await fetch('/api/stats');
                    const data = await res.json();
                    
                    if (data.status === 'Active') {
                        document.getElementById('qrOverlay').classList.add('hidden');
                        document.getElementById('mainDashboard').classList.remove('hidden');
                        document.getElementById('postedCount').innerText = data.posted;
                        document.getElementById('queueCount').innerText = data.queue;
                    } else {
                        document.getElementById('qrOverlay').classList.remove('hidden');
                        document.getElementById('mainDashboard').classList.add('hidden');
                        if (data.qr) {
                            document.getElementById('qrLoader').classList.add('hidden');
                            const img = document.getElementById('qrImg');
                            img.classList.remove('hidden');
                            img.src = data.qr;
                        }
                    }
                } catch(e){}
            }
            setInterval(refresh, 3000);
            refresh();
        </script>
    </body>
    </html>
    `);
});

startBot();
app.listen(PORT, '0.0.0.0', () => console.log(`Watchdog Hub Online: ${PORT}`));