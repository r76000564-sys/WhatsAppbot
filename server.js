require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');
const { GoogleGenAI } = require('@google/genai');

// WhatsApp Baileys Engine
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Gemini AI Setup
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

let sock = null;
let currentQR = null;
let isConnected = false;
let catalog = [];
let orders = [];

// System AI Instruction Template
function getSystemPrompt() {
    const catalogText = catalog.map(p => `- ${p.name} (SKU: ${p.sku}): ₹${p.price} [Stock: ${p.stock}]`).join('\n');
    return `
Aap Shubh Enterprise ke WhatsApp Sales & Order Assistant hain. Aap customers se Hinglish me bohot polite, professional aur natural baat karte hain.

Available Products & Prices:
${catalogText || 'Products catalog update ho raha hai.'}

Aapke Rules:
1. Customer jo bhi spare part maange, availability aur price batayein.
2. Discount customer mange to maximum 5% bol sakte hain agar order bada ho.
3. Order finalize karne ke liye Customer se: (a) Delivery Address aur (b) Items confirm karein.
4. JAISE HI CUSTOMER ADDRESS DE AUR ORDER CONFIRM KARE, aapko apne final reply ke sabse aakhri me exactly ye JSON block lagana hai:
<<<ORDER_JSON
{
  "customer_name": "Customer Name",
  "items": [{"name": "Item Name", "qty": 1, "price": 500}],
  "total_bill": 500,
  "address": "Customer ka complete address"
}
ORDER_JSON>>>
5. Normal baatchit me JSON mat bhejna, sirf order confirm hone par hi aakhri me bhejna.
`;
}

// 1. WhatsApp Connection Handler
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = await QRCode.toDataURL(qr);
            io.emit('qr', currentQR);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            isConnected = false;
            io.emit('status', { connected: false });
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            io.emit('status', { connected: true });
            console.log('WhatsApp successfully connected!');
        }
    });

    // 2. Incoming Messages Listener (AI Auto-Reply)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        if (!text) return;
        console.log(`Received from ${sender}: ${text}`);

        io.emit('new_message', { sender, text, direction: 'in' });

        // Generate Reply via Gemini AI
        try {
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: text,
                config: {
                    systemInstruction: getSystemPrompt()
                }
            });

            const reply = response.text || '';
            let cleanReply = reply;

            // Check if Order was finalized
            if (reply.includes('<<<ORDER_JSON')) {
                const jsonMatch = reply.match(/<<<ORDER_JSON([\s\S]*?)ORDER_JSON>>>/);
                if (jsonMatch && jsonMatch[1]) {
                    try {
                        const orderData = JSON.parse(jsonMatch[1].trim());
                        orderData.phone = sender.replace('@s.whatsapp.net', '');
                        orderData.id = 'ORD-' + Date.now().toString().slice(-4);
                        orderData.date = new Date().toLocaleString('en-IN');
                        orders.unshift(orderData);

                        io.emit('new_order', orderData);
                        cleanReply = reply.replace(/<<<ORDER_JSON[\s\S]*?ORDER_JSON>>>/, '').trim();
                    } catch (e) {
                        console.error('JSON parse error:', e);
                    }
                }
            }

            // Send WhatsApp Response back to Customer
            await sock.sendMessage(sender, { text: cleanReply });
            io.emit('new_message', { sender, text: cleanReply, direction: 'out' });

        } catch (err) {
            console.error('AI Reply failed:', err);
        }
    });
}

// 3. API Routes for Website Dashboard Control
app.get('/api/status', (req, res) => {
    res.json({ connected: isConnected, qr: currentQR });
});

app.post('/api/sync-catalog', (req, res) => {
    catalog = req.body.products || [];
    res.json({ success: true, count: catalog.length });
});

// Broadcast / Sheet Campaign Endpoint
app.post('/api/send-campaign', async (req, res) => {
    const { contacts, template, delaySeconds } = req.body;
    if (!isConnected || !sock) {
        return res.status(400).json({ error: 'WhatsApp not connected' });
    }

    res.json({ success: true, message: 'Campaign started in background' });

    // Send messages one by one with human-like safety delay
    for (const contact of contacts) {
        let phone = contact.phone.replace(/[^0-9]/g, '');
        if (phone.length === 10) phone = '91' + phone;
        const jid = `${phone}@s.whatsapp.net`;
        const messageText = template.replace('{{name}}', contact.name);

        try {
            await sock.sendMessage(jid, { text: messageText });
            io.emit('campaign_progress', { phone, name: contact.name, status: 'Sent' });
        } catch (error) {
            io.emit('campaign_progress', { phone, name: contact.name, status: 'Failed' });
        }

        const waitTime = (delaySeconds || 20) * 1000;
        await new Promise((r) => setTimeout(r, waitTime));
    }
});

io.on('connection', (socket) => {
    if (currentQR) socket.emit('qr', currentQR);
    socket.emit('status', { connected: isConnected });
    socket.emit('orders_list', orders);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    connectToWhatsApp();
});
              
