require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

let sock = null;
let currentQR = null;
let isConnected = false;
let catalog = [];
let orders = [];

function getSystemPrompt() {
    const catalogText = catalog.map(p => `- ${p.name} (SKU: ${p.sku}): ₹${p.price} [Stock: ${p.stock}]`).join('\n');
    return `
Aap Shubh Enterprise ke WhatsApp Sales Assistant hain. Customers se Hinglish me polite baat karein.
Available Products & Prices:
${catalogText || 'Catalog update ho raha hai.'}

Rules:
1. Customer jo part maange uska price batayein.
2. Max discount 5% de sakte hain.
3. Deal pakki hone par Delivery Address aur item details lein.
4. ORDER FINAL HOTE HI reply ke end me ye JSON zaroor dalein:
<<<ORDER_JSON
{
  "customer_name": "Customer Name",
  "items": [{"name": "Item Name", "qty": 1, "price": 500}],
  "total_bill": 500,
  "address": "Customer ka complete address"
}
ORDER_JSON>>>
`;
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false
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
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            io.emit('status', { connected: true });
            console.log('WhatsApp connected successfully!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        if (!text) return;

        io.emit('new_message', { sender, text, direction: 'in' });

        try {
            const prompt = `${getSystemPrompt()}\n\nCustomer Message: "${text}"\nAapka reply:`;
            const result = await model.generateContent(prompt);
            const reply = result.response.text();
            let cleanReply = reply;

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
                        console.error('JSON Error:', e);
                    }
                }
            }

            await sock.sendMessage(sender, { text: cleanReply });
            io.emit('new_message', { sender, text: cleanReply, direction: 'out' });
        } catch (err) {
            console.error('AI error:', err);
        }
    });
}

app.get('/api/status', (req, res) => res.json({ connected: isConnected, qr: currentQR }));

app.post('/api/sync-catalog', (req, res) => {
    catalog = req.body.products || [];
    res.json({ success: true, count: catalog.length });
});

app.post('/api/send-campaign', async (req, res) => {
    const { contacts, template, delaySeconds } = req.body;
    if (!isConnected || !sock) return res.status(400).json({ error: 'WhatsApp not connected' });

    res.json({ success: true, message: 'Campaign started' });

    for (const contact of contacts) {
        let phone = contact.phone.replace(/[^0-9]/g, '');
        if (phone.length === 10) phone = '91' + phone;
        const jid = `${phone}@s.whatsapp.net`;
        const msg = template.replace('{{name}}', contact.name);

        try {
            await sock.sendMessage(jid, { text: msg });
            io.emit('campaign_progress', { phone, name: contact.name, status: 'Sent' });
        } catch (err) {
            io.emit('campaign_progress', { phone, name: contact.name, status: 'Failed' });
        }
        await new Promise(r => setTimeout(r, (delaySeconds || 20) * 1000));
    }
});

io.on('connection', (socket) => {
    if (currentQR) socket.emit('qr', currentQR);
    socket.emit('status', { connected: isConnected });
    socket.emit('orders_list', orders);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    connectToWhatsApp();
});
              
