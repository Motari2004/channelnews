const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const axios = require("axios");
const fs = require("fs");
const pino = require("pino");
const QRCode = require("qrcode"); 
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json()); 

const PORT = process.env.PORT || 3000;

// --- STORAGE CONFIG (Render Optimized) ---
const SESSION_FOLDER = "/tmp/watchdog_sessions"; 
const HISTORY_FILE = "/tmp/posted_news.json";

if (!fs.existsSync(SESSION_FOLDER)) fs.mkdirSync(SESSION_FOLDER, { recursive: true });
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));

// --- BOT SETTINGS ---
const API_KEY = "f7da4fb81e024dcba2f28f19ec500cfc"; 
const CHANNEL_JID = "120363424747900547@newsletter";
const HEADERS = ["🚨 *BREAKING NEWS*", "🌍 *WORLD UPDATES*", "📡 *GLOBAL FLASH*", "⚡ *QUICK FEED*", "🔥 *NEWS UPDATE*"];

// Global Bot State
let sock = null;
let newsQueue = []; 
let botStatus = "Disconnected"; // "Disconnected", "Connecting", "Active"
let latestQR = null; 
let postIntervalTime = 10000; 
let postTimer = null;
let scanTimer = null;

// --- BOT LOGIC ---
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
        console.log(`Scan complete. Queue size: ${newsQueue.length}`);
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
        console.error("Post Error:", err.message);
        newsQueue.unshift(article); // Put it back if it failed
    }
}

// --- BOT STARTUP ---
async function startBot() {
    botStatus = "Connecting";
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["Watchdog Pro", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            console.log("New QR Generated");
            latestQR = await QRCode.toDataURL(qr);
        }

        if (connection === "open") {
            console.log("WhatsApp Connected!");
            botStatus = "Active";
            latestQR = null;
            
            // Start the loops only once connected
            if (!scanTimer) {
                scanNews();
                scanTimer = setInterval(scanNews, 60 * 60 * 1000);
            }
            if (!postTimer) {
                postTimer = setInterval(postFromQueue, postIntervalTime);
            }
        }

        if (connection === "close") {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            botStatus = "Disconnected";
            console.log("Connection closed. Reconnecting:", shouldReconnect);
            
            if (shouldReconnect) {
                startBot();
            } else {
                // If logged out, clear session and force fresh QR
                fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
                startBot();
            }
        }
    });
}

// --- WEB API ---
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

// --- UI DASHBOARD ---
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://cdn.tailwindcss.com"></script>
        <title>Watchdog Pro</title>
        <style>
            body { background: #020617; color: white; font-family: sans-serif; }
            .glass { background: rgba(15, 23, 42, 0.8); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.1); }
            .qr-screen { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #020617; }
        </style>
    </head>
    <body class="flex items-center justify-center min-h-screen p-4">

        <div id="qrScreen" class="qr-screen">
            <h1 class="text-4xl font-black tracking-tighter mb-2 text-blue-500">WATCHDOG PRO</h1>
            <p class="text-slate-500 text-[10px] uppercase tracking-[0.3em] mb-12">System Authentication Required</p>
            
            <div class="glass p-8 rounded-[3rem] border-2 border-blue-500/20 text-center shadow-2xl">
                <div id="qrLoader" class="w-56 h-56 flex items-center justify-center italic text-slate-600 text-sm">
                    Starting Engine...
                </div>
                <img id="qrImg" class="hidden w-56 h-56 bg-white p-3 rounded-3xl mx-auto shadow-inner" />
                <div class="mt-8">
                    <p class="text-blue-400 font-bold text-xs uppercase tracking-widest animate-pulse">Scan to Connect</p>
                </div>
            </div>
        </div>

        <div id="mainApp" class="hidden w-full max-w-sm">
            <header class="text-center mb-10">
                <h1 class="text-3xl font-black italic text-blue-500">WATCHDOG<span class="text-white">.</span></h1>
                <div class="inline-block mt-2 px-3 py-1 bg-green-500/10 border border-green-500/20 rounded-full">
                    <p class="text-[9px] text-green-500 font-bold uppercase tracking-widest">● System Live</p>
                </div>
            </header>

            <div class="grid grid-cols-2 gap-4 mb-6">
                <div class="glass p-6 rounded-3xl text-center">
                    <p class="text-slate-500 text-[9px] font-black uppercase mb-1">Articles Posted</p>
                    <h2 id="postCount" class="text-4xl font-black">0</h2>
                </div>
                <div class="glass p-6 rounded-3xl text-center">
                    <p class="text-blue-500 text-[9px] font-black uppercase mb-1">In Queue</p>
                    <h2 id="queueCount" class="text-4xl font-black">0</h2>
                </div>
            </div>

            <div class="glass p-6 rounded-[2rem]">
                <div class="flex justify-between items-center mb-4">
                    <p class="text-[10px] font-black uppercase text-slate-400">Post Interval</p>
                    <span id="intDisplay" class="text-blue-500 font-bold">10s</span>
                </div>
                <input type="range" min="5" max="300" value="10" 
                    class="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                    oninput="document.getElementById('intDisplay').innerText = this.value + 's'"
                    onchange="updateInterval(this.value)">
            </div>
        </div>

        <script>
            async function updateInterval(val) {
                await fetch('/api/set-interval', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({seconds: parseInt(val)})
                });
            }

            async function sync() {
                try {
                    const res = await fetch('/api/stats');
                    const data = await res.json();

                    if (data.status === "Active") {
                        document.getElementById('qrScreen').classList.add('hidden');
                        document.getElementById('mainApp').classList.remove('hidden');
                        document.getElementById('postCount').innerText = data.posted;
                        document.getElementById('queueCount').innerText = data.queue;
                    } else {
                        document.getElementById('qrScreen').classList.remove('hidden');
                        document.getElementById('mainApp').classList.add('hidden');
                        if (data.qr) {
                            document.getElementById('qrLoader').classList.add('hidden');
                            const img = document.getElementById('qrImg');
                            img.classList.remove('hidden');
                            img.src = data.qr;
                        } else {
                            document.getElementById('qrLoader').innerText = "Generating Handshake...";
                        }
                    }
                } catch(e) {}
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