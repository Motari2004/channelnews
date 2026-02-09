const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require("@whiskeysockets/baileys");
const axios = require("axios");
const fs = require("fs");
const pino = require("pino");
const QRCode = require("qrcode"); 
const express = require("express");

const app = express();
app.use(express.json()); 

const PORT = process.env.PORT || 3000;

// --- STORAGE ---
const SESSION_FOLDER = "/tmp/watchdog_sessions"; 
const HISTORY_FILE = "/tmp/posted_news.json";

if (!fs.existsSync(SESSION_FOLDER)) fs.mkdirSync(SESSION_FOLDER, { recursive: true });
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
        console.log(`[SYSTEM] Scan complete. Queue: ${newsQueue.length}`);
    } catch (e) { console.error("[SCAN ERROR]:", e.message); }
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
        console.error("[POST ERROR] Retrying later...");
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
        // Using a high-reputation Browser string
        browser: ["Mac OS", "Chrome", "121.0.6167.184"],
        syncFullHistory: false,
        printQRInTerminal: true,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000,
        generateHighQualityLinkPreview: true
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            console.log("[SYSTEM] New QR Generated");
            latestQR = await QRCode.toDataURL(qr);
        }

        if (connection === "open") {
            console.log("[SYSTEM] WhatsApp Connected Successfully");
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
            
            console.log(`[SYSTEM] Connection closed. Status: ${statusCode}`);

            // Logic for Error 405 or Logged Out: Wipe and start fresh
            if (statusCode === DisconnectReason.loggedOut || statusCode === 405) {
                console.log("[CRITICAL] Session invalid or error 405. Wiping session...");
                fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
                await delay(5000);
                startBot();
            } else {
                // Generic reconnect for standard network drops
                console.log("[SYSTEM] Attempting standard reconnect...");
                await delay(5000);
                startBot();
            }
        }
    });
}

// --- API ---
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
        <title>Watchdog Pro Hub</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            body { background: #020617; color: white; font-family: sans-serif; }
            .glass { background: rgba(15, 23, 42, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); }
            .qr-overlay { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #020617; }
        </style>
    </head>
    <body class="p-6">
        <div id="qrOverlay" class="qr-overlay">
            <h1 class="text-5xl font-black text-blue-500 mb-2 tracking-tighter">WATCHDOG PRO</h1>
            <p class="text-slate-500 text-[10px] uppercase tracking-[0.5em] mb-12">Deployment Environment: Render</p>
            <div class="glass p-10 rounded-[3.5rem] border-2 border-blue-500/30 text-center shadow-2xl">
                <div id="qrLoader" class="w-56 h-56 flex items-center justify-center italic text-slate-500 animate-pulse text-sm">System Handshake...</div>
                <img id="qrImg" class="hidden w-56 h-56 bg-white p-3 rounded-3xl mx-auto" />
                <p class="text-[10px] text-blue-400 font-bold mt-8 uppercase tracking-widest">Scan to Initialize</p>
            </div>
        </div>

        <div id="dashboard" class="hidden max-w-sm mx-auto mt-12">
            <header class="text-center mb-10">
                <h1 class="text-3xl font-black italic text-blue-600">WATCHDOG ONLINE</h1>
                <p id="statusTag" class="text-[10px] text-green-500 font-mono mt-2 uppercase tracking-widest">● Core Active</p>
            </header>

            <div class="grid grid-cols-2 gap-4 mb-6">
                <div class="glass p-6 rounded-3xl text-center">
                    <p class="text-slate-500 text-[9px] uppercase font-black mb-1">Posts</p>
                    <h2 id="pCount" class="text-4xl font-black">0</h2>
                </div>
                <div class="glass p-6 rounded-3xl text-center border-blue-500/20">
                    <p class="text-blue-500 text-[9px] uppercase font-black mb-1">Queue</p>
                    <h2 id="qCount" class="text-4xl font-black">0</h2>
                </div>
            </div>

            <div class="glass p-6 rounded-[2rem]">
                <p class="text-slate-400 text-[10px] uppercase font-black mb-4 flex justify-between">
                    Interval <span><span id="iVal" class="text-blue-500">10</span>s</span>
                </p>
                <input type="range" min="5" max="300" value="10" class="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-600"
                    oninput="document.getElementById('iVal').innerText = this.value"
                    onchange="fetch('/api/set-interval', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({seconds:parseInt(this.value)})})">
            </div>
        </div>

        <script>
            async function sync() {
                try {
                    const r = await fetch('/api/stats');
                    const d = await r.json();
                    if (d.status === 'Active') {
                        document.getElementById('qrOverlay').classList.add('hidden');
                        document.getElementById('dashboard').classList.remove('hidden');
                        document.getElementById('pCount').innerText = d.posted;
                        document.getElementById('qCount').innerText = d.queue;
                    } else {
                        document.getElementById('qrOverlay').classList.remove('hidden');
                        document.getElementById('dashboard').classList.add('hidden');
                        if (d.qr) {
                            document.getElementById('qrLoader').classList.add('hidden');
                            const img = document.getElementById('qrImg');
                            img.classList.remove('hidden');
                            img.src = d.qr;
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