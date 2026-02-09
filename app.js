const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser } = require("@whiskeysockets/baileys");
const http = require("http");
const fs = require("fs");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const isProduction = process.env.RENDER || process.env.NODE_ENV === 'production';
const BASE_SESSION_DIR = isProduction ? '/tmp/scorpio_sessions' : path.join(__dirname, 'sessions');
const DB_PATH = path.join(BASE_SESSION_DIR, 'user_creds.json');
const TRIAL_DURATION = 5 * 24 * 60 * 60 * 1000; 
const ADMIN_CREDENTIALS = { u: "Motari2004", p: "Hopefrey2004" };

// Ensure directories
if (!fs.existsSync(BASE_SESSION_DIR)) fs.mkdirSync(BASE_SESSION_DIR, { recursive: true });
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}));

const sessions = new Map();

function getDb() {
    try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); }
    catch (e) { return {}; }
}

async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.sock || existing.initializing) return;
    }

    sessions.set(sessionId, {
        connected: false, qr: null, views: 0, emoji: "none",
        active: true, phoneNumber: null, sock: null, initializing: true
    });

    const session = sessions.get(sessionId);
    const sessionFolder = path.join(BASE_SESSION_DIR, sessionId);
    if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ["Scorpio Engine", "Chrome", "1.0.0"],
            printQRInTerminal: true // Good for Render logs backup
        });

        session.sock = sock;
        session.initializing = false;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log(`[${sessionId}] QR Generated`);
                session.qr = await QRCode.toDataURL(qr);
            }

            if (connection === 'open') {
                console.log(`[${sessionId}] Connected`);
                session.connected = true;
                session.qr = null;
                session.phoneNumber = jidNormalizedUser(sock.user.id).split('@')[0];
                
                const db = getDb();
                if (!db[session.phoneNumber]) {
                    db[session.phoneNumber] = {
                        phone: session.phoneNumber,
                        sid: sessionId,
                        views: 0,
                        startDate: Date.now(),
                        isPremium: false,
                        createdAt: Date.now(),
                    };
                    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
                }
            }

            if (connection === 'close') {
                session.connected = false;
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    session.sock = null;
                    setTimeout(() => startSession(sessionId), 5000);
                } else {
                    sessions.delete(sessionId);
                    if (fs.existsSync(sessionFolder)) fs.rmSync(sessionFolder, { recursive: true, force: true });
                }
            }
        });

        // --- Status Auto-Viewer Logic ---
        sock.ev.on("messages.upsert", async ({ messages }) => {
            const phone = session.phoneNumber;
            if (!phone || !session.active || !session.connected) return;

            const db = getDb();
            const user = db[phone];
            if (!user) return;

            // Check expiry
            if (!user.isPremium && (Date.now() - user.startDate > TRIAL_DURATION)) {
                session.active = false;
                return;
            }

            for (const msg of messages) {
                if (msg.key.remoteJid === "status@broadcast" && !msg.key.fromMe) {
                    const participant = msg.key.participant || msg.participant;
                    
                    // Simple instant delay for free, random for premium
                    let delay = user.isPremium ? Math.floor(Math.random() * 10000) + 2000 : 0;

                    setTimeout(async () => {
                        try {
                            await sock.sendReceipt("status@broadcast", participant, [msg.key.id], "read");
                            user.views = (user.views || 0) + 1;
                            db[phone] = user;
                            fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
                            
                            if (session.emoji !== "none") {
                                await sock.sendMessage("status@broadcast", {
                                    react: { text: session.emoji, key: msg.key }
                                }, { statusJidList: [participant] });
                            }
                        } catch (e) {}
                    }, delay);
                }
            }
        });

    } catch (err) {
        session.initializing = false;
        console.error("StartSession Error:", err);
    }
}

// --- HTTP SERVER ---
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sid") || "default-scorpio";

    // API Status Endpoint (Used by Frontend)
    if (url.pathname === "/api/status") {
        if (!sessions.has(sessionId)) await startSession(sessionId);
        const s = sessions.get(sessionId);
        const db = getDb();
        const user = s.phoneNumber ? db[s.phoneNumber] : {};

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            connected: s.connected,
            qr: s.qr, // Send the QR back to the frontend
            views: user.views || 0,
            emoji: s.emoji,
            active: s.active,
            phoneNumber: s.phoneNumber,
            isPremium: !!user.isPremium
        }));
    }

    // Serving the HTML
    if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(getHtmlContent(sessionId));
    }

    res.writeHead(404);
    res.end("Not Found");
});

function getHtmlContent(sid) {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://cdn.tailwindcss.com"></script>
        <title>Scorpio Engine</title>
        <style>body { background: #020617; color: white; }</style>
    </head>
    <body class="flex flex-col items-center justify-center min-h-screen p-4">
        <div class="bg-slate-900 p-10 rounded-[3rem] border border-white/10 w-full max-w-sm text-center">
            <h1 class="text-4xl font-black italic mb-8">SCORPIO<span class="text-orange-500">.</span></h1>

            <div id="qr-view" class="space-y-4">
                <div id="qr-container" class="bg-white p-2 rounded-2xl inline-block shadow-2xl">
                    <div id="loader" class="w-48 h-48 flex items-center justify-center text-slate-400 italic text-xs">Generating QR...</div>
                    <img id="qr-img" class="hidden w-48 h-48" />
                </div>
                <p class="text-[10px] uppercase font-bold text-slate-500 tracking-widest">Link WhatsApp to Start</p>
            </div>

            <div id="dash-view" class="hidden space-y-4">
                <div class="bg-slate-950 p-4 rounded-2xl border border-white/5">
                    <p class="text-[10px] text-slate-500 uppercase font-black">Total Views</p>
                    <h2 id="view-count" class="text-4xl font-black text-orange-500">0</h2>
                </div>
                <button class="w-full bg-orange-600 py-4 rounded-2xl font-black uppercase tracking-widest">Engine Active</button>
            </div>
        </div>

        <script>
            const sid = "${sid}";
            async function checkStatus() {
                try {
                    const r = await fetch("/api/status?sid=" + sid);
                    const data = await r.json();

                    if (data.connected) {
                        document.getElementById('qr-view').classList.add('hidden');
                        document.getElementById('dash-view').classList.remove('hidden');
                        document.getElementById('view-count').innerText = data.views;
                    } else if (data.qr) {
                        document.getElementById('loader').classList.add('hidden');
                        const img = document.getElementById('qr-img');
                        img.classList.remove('hidden');
                        img.src = data.qr;
                    }
                } catch (e) { console.log("Status error", e); }
            }
            setInterval(checkStatus, 3000);
            checkStatus();
        </script>
    </body>
    </html>`;
}

server.listen(PORT, () => console.log(`Scorpio Online: ${PORT}`));