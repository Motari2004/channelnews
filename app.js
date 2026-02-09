const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require("@whiskeysockets/baileys");
const axios = require("axios");
const fs = require("fs");
const pino = require("pino");
const QRCode = require("qrcode"); 
const express = require("express");
const crypto = require("crypto"); // Added for unique session IDs

const app = express();
app.use(express.json()); 

const PORT = process.env.PORT || 3000;

// --- DYNAMIC STORAGE ---
let currentSessionID = crypto.randomBytes(4).toString('hex');
let SESSION_FOLDER = `/tmp/session_${currentSessionID}`; 
const HISTORY_FILE = "/tmp/posted_news.json";

if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));

// --- SETTINGS ---
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

// --- BOT STARTUP ---
async function startBot() {
    botStatus = "Connecting";
    console.log(`[INIT] Starting session: ${currentSessionID}`);
    
    // Ensure clean directory
    if (!fs.existsSync(SESSION_FOLDER)) fs.mkdirSync(SESSION_FOLDER, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        // Adding a randomized device name to bypass 405 filters
        browser: ["Watchdog Pro", "Chrome", `Node-${currentSessionID}`],
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 15000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            console.log("[QR] New code ready for scan");
            latestQR = await QRCode.toDataURL(qr);
        }

        if (connection === "open") {
            console.log("✅ SUCCESS: Connected to WhatsApp");
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
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            botStatus = "Disconnected";
            console.log(`[CLOSE] Reason: ${statusCode}`);

            // If 405 or Logged Out, we MUST change the session ID to force a fresh handshake
            if (statusCode === 405 || statusCode === DisconnectReason.loggedOut) {
                console.log("[CRITICAL] Forcing Session Rotation...");
                try { fs.rmSync(SESSION_FOLDER, { recursive: true, force: true }); } catch(e) {}
                
                // GENERATE NEW SESSION ID
                currentSessionID = crypto.randomBytes(4).toString('hex');
                SESSION_FOLDER = `/tmp/session_${currentSessionID}`;
                
                await delay(3000);
                startBot();
            } else {
                console.log("[RETRY] Attempting reconnect...");
                await delay(5000);
                startBot();
            }
        }
    });
}

// --- CORE LOGIC (SCAN/POST) ---
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
        console.log(`[NEWS] Queue size: ${newsQueue.length}`);
    } catch (e) { console.error("[NEWS ERR]:", e.message); }
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
    } catch (err) { newsQueue.unshift(article); }
}

// --- API ---
app.get('/api/stats', (req, res) => {
    res.json({
        posted: (JSON.parse(fs.readFileSync(HISTORY_FILE))).length,
        queue: newsQueue.length,
        status: botStatus,
        interval: postIntervalTime / 1000,
        qr: latestQR,
        session: currentSessionID
    });
});

app.post('/api/set-interval', (req, res) => {
    const { seconds } = req.body;
    if (postTimer) clearInterval(postTimer);
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
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Watchdog Pro</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            body { background: #020617; color: white; font-family: sans-serif; }
            .glass { background: rgba(15, 23, 42, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); }
        </style>
    </head>
    <body class="flex items-center justify-center min-h-screen p-6">
        <div id="qrUI" class="text-center">
            <h1 class="text-4xl font-black text-blue-500 mb-2 tracking-tighter">WATCHDOG PRO</h1>
            <p id="sessionID" class="text-slate-500 text-[10px] uppercase tracking-widest mb-8 italic"></p>
            <div class="glass p-8 rounded-[3rem] border-2 border-blue-500/20 inline-block shadow-2xl">
                <div id="loader" class="w-56 h-56 flex items-center justify-center text-slate-500 animate-pulse text-sm">Initializing...</div>
                <img id="qrImg" class="hidden w-56 h-56 bg-white p-2 rounded-2xl mx-auto shadow-2xl" />
            </div>
            <p class="mt-8 text-[10px] text-blue-400 font-bold uppercase tracking-[0.3em]">Scan with WhatsApp</p>
        </div>

        <div id="mainUI" class="hidden w-full max-w-sm">
            <header class="text-center mb-10">
                <h1 class="text-3xl font-black italic text-blue-500">SYSTEM LIVE</h1>
                <div class="inline-block mt-2 px-3 py-1 bg-green-500/10 border border-green-500/20 rounded-full text-[9px] text-green-500 font-bold uppercase tracking-widest">● Broadcast Ready</div>
            </header>
            <div class="grid grid-cols-2 gap-4 mb-6">
                <div class="glass p-6 rounded-3xl text-center">
                    <p class="text-slate-500 text-[9px] font-black uppercase mb-1">Total Posts</p>
                    <h2 id="pCnt" class="text-4xl font-black">0</h2>
                </div>
                <div class="glass p-6 rounded-3xl text-center">
                    <p class="text-blue-500 text-[9px] font-black uppercase mb-1">In Queue</p>
                    <h2 id="qCnt" class="text-4xl font-black">0</h2>
                </div>
            </div>
            <div class="glass p-6 rounded-[2rem]">
                <p class="text-slate-400 text-[10px] uppercase font-black mb-4 flex justify-between">Interval <span><span id="iVal" class="text-blue-500">10</span>s</span></p>
                <input type="range" min="5" max="300" value="10" class="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                    oninput="document.getElementById('iVal').innerText = this.value"
                    onchange="fetch('/api/set-interval', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({seconds:parseInt(this.value)})})">
            </div>
        </div>

        <script>
            async function sync() {
                try {
                    const r = await fetch('/api/stats');
                    const d = await r.json();
                    document.getElementById('sessionID').innerText = "Session: " + d.session;
                    if (d.status === 'Active') {
                        document.getElementById('qrUI').classList.add('hidden');
                        document.getElementById('mainUI').classList.remove('hidden');
                        document.getElementById('pCnt').innerText = d.posted;
                        document.getElementById('qCnt').innerText = d.queue;
                    } else {
                        document.getElementById('qrUI').classList.remove('hidden');
                        document.getElementById('mainUI').classList.add('hidden');
                        if (d.qr) {
                            document.getElementById('loader').classList.add('hidden');
                            document.getElementById('qrImg').classList.remove('hidden');
                            document.getElementById('qrImg').src = d.qr;
                        }
                    }
                } catch(e){}
            }
            setInterval(sync, 3000);
            sync();
        </script>
    </body>
    </html>
    `);
});

startBot();
app.listen(PORT, '0.0.0.0', () => console.log(`Watchdog Hub Online: ${PORT}`));