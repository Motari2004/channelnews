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

// --- UPDATED PORT LOGIC ---
// Render usually provides a PORT env var (10000). Locally, it will now use 3000.
const PORT = process.env.PORT || 3000;

const IS_PROD = process.env.RENDER === 'true';
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

function getStats() {
    try {
        const history = JSON.parse(fs.readFileSync(HISTORY_FILE));
        const queue = JSON.parse(fs.readFileSync(QUEUE_FILE));
        return { posted: history.length, queue: queue.length };
    } catch (e) { return { posted: 0, queue: 0 }; }
}

async function scanNews() {
    if (!isBotActive || botStatus !== "Active") return;
    const url = `https://newsapi.org/v2/everything?q=world&sortBy=publishedAt&language=en&apiKey=${API_KEY}`;
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
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue.slice(0, 500)));
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
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-1000)));
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue));
    } catch (err) {
        queue.unshift(article);
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue));
    }
}

function resetPostInterval() {
    if (postTimer) clearInterval(postTimer);
    postTimer = setInterval(postFromQueue, postIntervalTime);
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
        version, auth: state,
        logger: pino({ level: "silent" }),
        browser: ["Watchdog Pro", "Chrome", "1.0.0"],
    });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async (update) => {
        const { connection, qr } = update;
        if (qr) { latestQR = await QRCode.toDataURL(qr); botStatus = "QR Ready"; }
        if (connection === "open") {
            botStatus = "Active"; latestQR = null;
            scanNews();
            setInterval(scanNews, 60 * 60 * 1000);
            resetPostInterval();
        }
        if (connection === "close") { botStatus = "Disconnected"; setTimeout(startBot, 5000); }
    });
}

app.get('/api/stats', (req, res) => {
    const s = getStats();
    res.json({ ...s, status: botStatus, isBotActive, qr: latestQR, interval: postIntervalTime / 1000 });
});

app.post('/api/settings', (req, res) => {
    if (req.body.interval) {
        postIntervalTime = req.body.interval * 1000;
        if (botStatus === "Active") resetPostInterval();
    }
    if (req.body.toggle !== undefined) isBotActive = req.body.toggle;
    res.json({ success: true });
});

app.post('/api/test', async (req, res) => {
    if (botStatus === "Active") {
        await sock.sendMessage(CHANNEL_JID, { text: "🧪 *Watchdog Connection Test*: Successful!" });
        return res.json({ success: true });
    }
    res.json({ success: false });
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Watchdog Pro</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style> body { background: #020617; color: white; } .stat-card { background: #0f172a; border: 1px solid rgba(255,255,255,0.05); } </style>
    </head>
    <body class="flex items-center justify-center min-h-screen p-4">
        <div class="w-full max-w-sm">
            <div class="text-center mb-6">
                <h1 class="text-4xl font-black text-blue-500 italic">WATCHDOG PRO</h1>
                <div class="mt-2 flex items-center justify-center gap-2">
                    <span id="dot" class="h-2 w-2 rounded-full bg-red-500"></span>
                    <span id="stText" class="text-[10px] font-mono uppercase tracking-[0.3em] text-slate-500">Connecting</span>
                </div>
            </div>
            <div id="qrBox" class="hidden mb-6 bg-white p-4 rounded-3xl text-center"><img id="qrImg" class="mx-auto w-48 h-48"></div>
            <div class="grid grid-cols-2 gap-4 mb-6">
                <div class="stat-card p-6 rounded-[2rem] text-center"><p class="text-slate-500 text-[9px] uppercase font-black mb-1">Posted</p><h2 id="pCnt" class="text-4xl font-black">0</h2></div>
                <div class="stat-card p-6 rounded-[2rem] text-center"><p class="text-slate-500 text-[9px] uppercase font-black mb-1">Queue</p><h2 id="qCnt" class="text-4xl font-black text-orange-500">0</h2></div>
            </div>
            <div class="stat-card p-6 rounded-[2rem] mb-6">
                <div class="flex justify-between text-[10px] font-black text-slate-500 mb-4"><span>INTERVAL</span> <span id="intDisp" class="text-blue-400">30s</span></div>
                <input type="range" id="sld" min="10" max="600" step="10" value="30" class="w-full accent-blue-500" oninput="document.getElementById('intDisp').innerText=this.value+'s'" onchange="updateSet()">
            </div>
            <button id="kBtn" onclick="toggle()" class="w-full py-5 rounded-[1.5rem] font-black text-xs mb-3 border-b-4"></button>
            <button onclick="testPost()" class="w-full py-4 rounded-[1.5rem] font-bold text-[10px] bg-slate-800 text-slate-400 border border-slate-700">🧪 SEND TEST POST</button>
        </div>
        <script>
            let active = true;
            async function updateSet() { await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({interval:document.getElementById('sld').value}) }); }
            async function toggle() { active = !active; await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({toggle:active}) }); sync(); }
            async function testPost() { await fetch('/api/test', {method:'POST'}); alert('Test post triggered!'); }
            async function sync() {
                const r = await fetch('/api/stats'); const d = await r.json();
                document.getElementById('pCnt').innerText = d.posted; document.getElementById('qCnt').innerText = d.queue;
                document.getElementById('stText').innerText = d.status;
                document.getElementById('dot').className = "h-2 w-2 rounded-full " + (d.status==='Active'?'bg-green-500 animate-pulse':'bg-red-500');
                if(d.qr) { document.getElementById('qrBox').classList.remove('hidden'); document.getElementById('qrImg').src=d.qr; }
                else { document.getElementById('qrBox').classList.add('hidden'); }
                const btn = document.getElementById('kBtn'); active = d.isBotActive;
                btn.innerText = active ? "🛑 STOP BOT" : "🚀 START BOT";
                btn.className = "w-full py-5 rounded-[1.5rem] font-black text-xs mb-3 border-b-4 " + (active?"bg-red-600 border-red-800":"bg-green-600 border-green-800");
            }
            setInterval(sync, 4000); sync();
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Watchdog running on port ${PORT}`);
    if (!IS_PROD) console.log(`Access locally at: http://localhost:${PORT}`);
    startBot();
});