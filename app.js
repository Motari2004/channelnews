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

const IS_PROD = process.env.RENDER === 'true';
const PORT = process.env.PORT || 3000;

const BASE_DIR = IS_PROD ? "/opt/render/project/src/temp" : path.join(__dirname, "temp");
const SESSION_PATH = path.join(BASE_DIR, "session");
const HISTORY_FILE = path.join(BASE_DIR, "posted_news.json");
const QUEUE_FILE = path.join(BASE_DIR, "news_queue.json");

if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR, { recursive: true });
if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));
if (!fs.existsSync(QUEUE_FILE)) fs.writeFileSync(QUEUE_FILE, JSON.stringify([]));

const API_KEY = "f7da4fb81e024dcba2f28f19ec500cfc"; 
const CHANNEL_JID = "120363424747900547@newsletter";
const HEADERS = ["🚨 *BREAKING NEWS*", "🌍 *WORLD UPDATES*", "📡 *GLOBAL FLASH*", "⚡ *QUICK FEED*", "🔥 *NEWS UPDATE*"];

let sock = null;
let latestQR = null;
let botStatus = "Disconnected";
let isBotActive = true; 
let postIntervalTime = 30000; 
let postTimer = null;

// --- CORE FUNCTIONS ---

async function scanNews() {
    if (!isBotActive || botStatus !== "Active") return;
    console.log("🔍 Scanning for new articles...");
    const url = `https://newsapi.org/v2/everything?q=world&sortBy=publishedAt&language=en&apiKey=${API_KEY}`;
    try {
        const { data } = await axios.get(url);
        if (data.status !== "ok") return;
        let history = JSON.parse(fs.readFileSync(HISTORY_FILE));
        let queue = JSON.parse(fs.readFileSync(QUEUE_FILE));
        
        let newItems = 0;
        data.articles.forEach(article => {
            if (article.url && !history.includes(article.url) && !queue.some(a => a.url === article.url)) {
                queue.push(article);
                newItems++;
            }
        });
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue.slice(0, 500)));
        console.log(`📥 Added ${newItems} new articles to queue.`);
    } catch (e) { console.error("⚠️ News API Error"); }
}

async function postFromQueue() {
    if (!isBotActive || botStatus !== "Active") return;
    
    let queue = JSON.parse(fs.readFileSync(QUEUE_FILE));
    if (queue.length === 0) {
        console.log("😴 Queue empty, scanning for news...");
        await scanNews();
        return;
    }

    const article = queue.shift();
    const header = HEADERS[Math.floor(Math.random() * HEADERS.length)];
    
    try {
        const message = `${header}\n\n📰 *${article.title.toUpperCase()}*\n\n${article.description || ""}\n\n🔗 ${article.url}\n\n📡 _Source: ${article.source.name}_`;
        const sent = await sock.sendMessage(CHANNEL_JID, { text: message });
        
        console.log(`✅ Successfully Posted [ID: ${sent.key.id}]`);
        
        let history = JSON.parse(fs.readFileSync(HISTORY_FILE));
        history.push(article.url);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-1000)));
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue));
    } catch (err) {
        console.error("❌ Post Failed:", err.message);
        queue.unshift(article); 
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue));
    }
}

function startPostingLoop() {
    if (postTimer) clearInterval(postTimer);
    console.log(`🚀 Posting loop started: ${postIntervalTime/1000}s interval`);
    postTimer = setInterval(postFromQueue, postIntervalTime);
}

// --- WHATSAPP ENGINE ---

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["Watchdog Pro", "Chrome", "1.0.0"],
        printQRInTerminal: true // Good for local debugging
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = await QRCode.toDataURL(qr);
            botStatus = "QR Ready";
            console.log("📲 New QR Code generated. Scan to connect.");
        }

        if (connection === "open") {
            botStatus = "Active";
            latestQR = null;
            console.log("🔗 WhatsApp Connected!");
            
            // Trigger sequence: Scan first, then start posting
            await scanNews();
            startPostingLoop();
            
            // Hourly refresh
            setInterval(scanNews, 60 * 60 * 1000);
        }

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            botStatus = "Disconnected";
            console.log(`❌ Connection closed. Reason: ${reason}`);
            
            if (postTimer) clearInterval(postTimer);

            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 Reconnecting...");
                setTimeout(startBot, 5000);
            } else {
                console.log("⛔ Logged out. Delete 'session' folder and scan again.");
            }
        }
    });
}

// --- API & ROUTES ---

app.get('/api/stats', (req, res) => {
    try {
        const history = JSON.parse(fs.readFileSync(HISTORY_FILE));
        const queue = JSON.parse(fs.readFileSync(QUEUE_FILE));
        res.json({ 
            posted: history.length, 
            queue: queue.length, 
            status: botStatus, 
            isBotActive, 
            qr: latestQR, 
            interval: postIntervalTime / 1000 
        });
    } catch (e) { res.status(500).json({ error: "File read error" }); }
});

app.post('/api/settings', (req, res) => {
    if (req.body.interval) {
        postIntervalTime = req.body.interval * 1000;
        if (botStatus === "Active") startPostingLoop();
    }
    if (req.body.toggle !== undefined) isBotActive = req.body.toggle;
    res.json({ success: true });
});

app.post('/api/test', async (req, res) => {
    if (botStatus === "Active") {
        try {
            await sock.sendMessage(CHANNEL_JID, { text: "🧪 *Watchdog*: Manual test successful!" });
            res.json({ success: true });
        } catch (e) { res.json({ success: false, error: e.message }); }
    } else {
        res.json({ success: false, error: "Bot not connected" });
    }
});

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
            .glass { background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(255,255,255,0.05); backdrop-filter: blur(10px); }
        </style>
    </head>
    <body class="flex items-center justify-center min-h-screen p-6">
        <div class="w-full max-w-sm">
            <header class="text-center mb-10">
                <h1 class="text-5xl font-black italic tracking-tighter text-blue-500 mb-2">WATCHDOG</h1>
                <div class="flex items-center justify-center gap-3">
                    <span id="dot" class="h-3 w-3 rounded-full bg-red-500 shadow-[0_0_10px_red]"></span>
                    <span id="stText" class="text-xs font-mono uppercase tracking-[0.4em] text-slate-500">Initializing</span>
                </div>
            </header>

            <div id="qrBox" class="hidden mb-8 bg-white p-6 rounded-[2.5rem] text-center shadow-2xl">
                <p class="text-black text-[11px] font-black mb-4 uppercase tracking-wider">Scan to Link WhatsApp</p>
                <img id="qrImg" class="mx-auto w-52 h-52">
            </div>

            <div class="grid grid-cols-2 gap-4 mb-8">
                <div class="glass p-6 rounded-[2rem] text-center">
                    <p class="text-slate-500 text-[10px] uppercase font-black mb-1">Posted</p>
                    <h2 id="pCnt" class="text-4xl font-black">0</h2>
                </div>
                <div class="glass p-6 rounded-[2rem] text-center">
                    <p class="text-slate-500 text-[10px] uppercase font-black mb-1">Queue</p>
                    <h2 id="qCnt" class="text-4xl font-black text-orange-500">0</h2>
                </div>
            </div>

            <div class="glass p-6 rounded-[2rem] mb-8">
                <div class="flex justify-between text-[10px] font-black text-slate-400 mb-5">
                    <span class="uppercase">Interval</span>
                    <span id="intDisp" class="text-blue-400 font-mono">30s</span>
                </div>
                <input type="range" id="sld" min="10" max="600" step="10" value="30" 
                    class="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500" 
                    oninput="document.getElementById('intDisp').innerText=this.value+'s'" onchange="updateSet()">
            </div>

            <button id="kBtn" onclick="toggle()" class="w-full py-5 rounded-[1.8rem] font-black text-sm mb-4 border-b-4 transition-all active:translate-y-1 active:border-b-0"></button>
            <button onclick="testPost()" class="w-full py-4 rounded-[1.8rem] font-bold text-[10px] bg-slate-800/50 text-slate-400 border border-slate-700 uppercase tracking-widest">Test Connection</button>
            
            <footer class="mt-10 text-center opacity-30 text-[9px] font-bold tracking-widest uppercase">
                ${IS_PROD ? 'Render Production Cluster' : 'Local Development Instance'}
            </footer>
        </div>

        <script>
            let active = true;
            async function updateSet() { await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({interval:document.getElementById('sld').value}) }); }
            async function toggle() { active = !active; await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({toggle:active}) }); sync(); }
            async function testPost() { 
                const res = await fetch('/api/test', {method:'POST'}); 
                const data = await res.json();
                alert(data.success ? 'Message sent to channel!' : 'Failed: ' + data.error);
            }
            async function sync() {
                try {
                    const r = await fetch('/api/stats'); const d = await r.json();
                    document.getElementById('pCnt').innerText = d.posted; 
                    document.getElementById('qCnt').innerText = d.queue;
                    document.getElementById('stText').innerText = d.status;
                    
                    const dot = document.getElementById('dot');
                    if(d.status === 'Active') {
                        dot.className = "h-3 w-3 rounded-full bg-green-500 shadow-[0_0_10px_#22c55e] animate-pulse";
                    } else if(d.status === 'QR Ready') {
                        dot.className = "h-3 w-3 rounded-full bg-yellow-500 shadow-[0_0_10px_#eab308]";
                    } else {
                        dot.className = "h-3 w-3 rounded-full bg-red-500 shadow-[0_0_10px_#ef4444]";
                    }

                    if(d.qr) { 
                        document.getElementById('qrBox').classList.remove('hidden'); 
                        document.getElementById('qrImg').src=d.qr; 
                    } else { 
                        document.getElementById('qrBox').classList.add('hidden'); 
                    }

                    const btn = document.getElementById('kBtn'); active = d.isBotActive;
                    btn.innerText = active ? "STOP WATCHDOG" : "START WATCHDOG";
                    btn.className = "w-full py-5 rounded-[1.8rem] font-black text-sm mb-4 border-b-4 " + 
                        (active ? "bg-red-600 border-red-900 shadow-lg shadow-red-900/20" : "bg-green-600 border-green-900 shadow-lg shadow-green-900/20");
                } catch(e) {}
            }
            setInterval(sync, 3000); sync();
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n📡 Dashboard: http://localhost:${PORT}`);
    startBot();
});