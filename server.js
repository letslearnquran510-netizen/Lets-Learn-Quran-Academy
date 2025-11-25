// ========================================
// QURAN ACADEMY CALLING SERVER (v3 - REAL-TIME SYNC)
// FILE: server.js
// COMPLETE WITH: Auth, Students, Calls, Encryption, DB, WEBSOCKET
// ========================================

const express = require('express');
const twilio = require('twilio');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Create HTTP server (needed for WebSocket to share same port)
const server = http.createServer(app);

// ---------------------------------------------------------
// 🔌 WEBSOCKET SERVER FOR REAL-TIME SYNC
// This is the KEY component that was missing!
// ---------------------------------------------------------
const wss = new WebSocket.Server({ server });

// Track all connected clients
const connectedClients = new Set();

wss.on('connection', (ws) => {
    console.log('🔌 New WebSocket client connected');
    connectedClients.add(ws);
    
    // Send welcome message to confirm connection
    ws.send(JSON.stringify({
        type: 'CONNECTED',
        data: { 
            message: 'Connected to Quran Academy Real-Time Server', 
            timestamp: new Date().toISOString() 
        }
    }));
    
    ws.on('close', () => {
        console.log('🔌 WebSocket client disconnected');
        connectedClients.delete(ws);
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
        connectedClients.delete(ws);
    });
});

// Broadcast message to ALL connected clients
// This is how real-time sync works - when Twilio sends status update,
// we broadcast to all browser tabs/windows
function broadcast(message) {
    const data = JSON.stringify(message);
    console.log(`📡 Broadcasting to ${connectedClients.size} clients:`, message.type);
    
    connectedClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// Serve static files (HTML, CSS, JS)
const path = require('path');
app.use(express.static(path.join(__dirname)));

// Serve index.html on root path
app.get('/', (req, res) => {
    try {
        res.sendFile(path.join(__dirname, 'index.html'));
    } catch (error) {
        res.status(500).json({ error: 'Could not load index.html' });
    }
});

// ---------------------------------------------------------
// 🔧 CONFIGURATION (FROM .env file)
// ---------------------------------------------------------
const config = {
    twilio: {
        // Trim whitespace that might have been accidentally copied
        accountSid: (process.env.TWILIO_ACCOUNT_SID || '').trim(),
        authToken: (process.env.TWILIO_AUTH_TOKEN || '').trim(),
        phoneNumber: (process.env.TWILIO_PHONE_NUMBER || '').trim(),
    },
    publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').trim(),
    jwtSecret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
    encryptionKey: process.env.ENCRYPTION_KEY || 'your-encryption-key-32-chars-min',
    database: {
        type: process.env.DB_TYPE || 'memory',
        mongoUrl: process.env.MONGO_URL,
        pgUrl: process.env.PG_URL,
    }
};

// Validate Twilio credentials
if (!config.twilio.accountSid || !config.twilio.authToken || !config.twilio.phoneNumber) {
    console.error('❌ ERROR: Twilio credentials not configured!');
    console.error('   Add these to your .env file:');
    console.error('   TWILIO_ACCOUNT_SID=your_account_sid');
    console.error('   TWILIO_AUTH_TOKEN=your_auth_token');
    console.error('   TWILIO_PHONE_NUMBER=+1234567890');
    console.error('\n⚠️ Server will run in SIMULATION mode (no real calls)');
} else {
    console.log('✅ Twilio Credentials Loaded:');
    console.log('   Account SID: ' + config.twilio.accountSid.substring(0, 8) + '...' + config.twilio.accountSid.substring(config.twilio.accountSid.length - 4));
    console.log('   Auth Token Length: ' + config.twilio.authToken.length + ' chars');
    console.log('   Phone Number: ' + config.twilio.phoneNumber);
}

let twilio_client = null;
try {
    if (config.twilio.accountSid && config.twilio.authToken) {
        twilio_client = twilio(config.twilio.accountSid, config.twilio.authToken);
        console.log('✅ Twilio client initialized successfully');
    }
} catch (initError) {
    console.error('❌ Failed to initialize Twilio client:', initError.message);
}

// ---------------------------------------------------------
// 📊 IN-MEMORY DATABASE
// ---------------------------------------------------------
const database = {
    students: [
        {
            id: 'student_1',
            name: 'Ahmed Mohammed',
            email: 'ahmed@test.com',
            phoneEncrypted: 'encrypted_phone_1',
            parent: 'Ahmed Family',
            createdAt: new Date().toISOString()
        },
        {
            id: 'student_2',
            name: 'Fatima Khan',
            email: 'fatima@test.com',
            phoneEncrypted: 'encrypted_phone_2',
            parent: 'Khan Family',
            createdAt: new Date().toISOString()
        },
        {
            id: 'student_3',
            name: 'Hassan Ali',
            email: 'hassan@test.com',
            phoneEncrypted: 'encrypted_phone_3',
            parent: 'Ali Family',
            createdAt: new Date().toISOString()
        }
    ],
    calls: [],
    users: [
        {
            id: 'admin_1',
            name: 'Administrator',
            email: 'admin@test.com',
            type: 'admin',
            password: 'admin123'
        },
        {
            id: 'teacher_1',
            name: 'Teacher',
            email: 'teacher@test.com',
            type: 'teacher',
            password: 'teacher123'
        }
    ]
};

// ---------------------------------------------------------
// 🔐 ENCRYPTION FUNCTIONS
// ---------------------------------------------------------
function encrypt(text) {
    try {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(
            'aes-256-cbc',
            Buffer.from(config.encryptionKey.padEnd(32, '0').slice(0, 32)),
            iv
        );
        let encrypted = cipher.update(text);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        return iv.toString('hex') + ':' + encrypted.toString('hex');
    } catch (error) {
        console.error('Encryption error:', error);
        return text;
    }
}

function decrypt(encryptedText) {
    try {
        const parts = encryptedText.split(':');
        if (parts.length !== 2) return encryptedText;
        
        const iv = Buffer.from(parts[0], 'hex');
        const encrypted = Buffer.from(parts[1], 'hex');
        const decipher = crypto.createDecipheriv(
            'aes-256-cbc',
            Buffer.from(config.encryptionKey.padEnd(32, '0').slice(0, 32)),
            iv
        );
        let decrypted = decipher.update(encrypted);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error) {
        console.error('Decryption error:', error);
        return encryptedText;
    }
}

// ---------------------------------------------------------
// 🔑 JWT MIDDLEWARE
// ---------------------------------------------------------
function generateToken(user) {
    return jwt.sign(
        { id: user.id, name: user.name, type: user.type },
        config.jwtSecret,
        { expiresIn: '24h' }
    );
}

function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];
    
    if (!token && authHeader === 'Bearer demo') {
        req.user = { id: 'demo', name: 'Demo User', type: 'admin' };
        return next();
    }
    
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    
    try {
        req.user = jwt.verify(token, config.jwtSecret);
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token: ' + error.message });
    }
}

function requireAdmin(req, res, next) {
    if (req.user.type !== 'admin') {
        return res.status(403).json({ error: 'Admin only' });
    }
    next();
}

// ---------------------------------------------------------
// 🏥 HEALTH CHECK
// ---------------------------------------------------------
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        server: 'Quran Academy v3 - Real-Time Sync',
        publicUrl: config.publicUrl,
        twilioConfigured: !!twilio_client,
        connectedClients: connectedClients.size,
        timestamp: new Date().toISOString()
    });
});

// ---------------------------------------------------------
// 🔐 AUTHENTICATION
// ---------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    const user = database.users.find(u => u.email === email && u.password === password);
    
    if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = generateToken(user);
    
    res.json({
        success: true,
        user: {
            id: user.id,
            name: user.name,
            email: user.email,
            type: user.type,
            avatar: user.name[0].toUpperCase()
        },
        token: token
    });
});

// ---------------------------------------------------------
// 👥 STUDENT ENDPOINTS
// ---------------------------------------------------------
app.get('/api/students', verifyToken, (req, res) => {
    try {
        const students = database.students.map(s => ({
            id: s.id,
            name: s.name,
            email: s.email,
            phone: req.user.type === 'admin' ? decrypt(s.phoneEncrypted) : undefined,
            phoneEncrypted: s.phoneEncrypted,
            parent: s.parent,
            createdAt: s.createdAt
        }));
        
        res.json({ success: true, students: students });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/students', verifyToken, requireAdmin, (req, res) => {
    try {
        const { name, phone, email, parent } = req.body;
        
        if (!name || !phone) {
            return res.status(400).json({ error: 'Name and phone are required' });
        }
        
        const cleanPhone = phone.replace(/\D/g, '');
        
        if (cleanPhone.length !== 10) {
            return res.status(400).json({ error: 'Phone must be 10 digits' });
        }
        
        if (email && !email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        
        const newStudent = {
            id: 'student_' + Date.now(),
            name: name,
            email: email || '',
            phoneEncrypted: encrypt('+1' + cleanPhone),
            parent: parent || '',
            createdAt: new Date().toISOString()
        };
        
        database.students.push(newStudent);
        
        // Broadcast to all clients
        broadcast({
            type: 'STUDENT_ADDED',
            data: { student: { ...newStudent, phone: '+1' + cleanPhone } }
        });
        
        res.status(201).json({
            success: true,
            student: newStudent,
            message: `Student "${name}" added successfully`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/students/:id', verifyToken, requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const { name, phone, email, parent } = req.body;
        
        const student = database.students.find(s => s.id === id);
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        
        if (name) student.name = name;
        if (email) student.email = email;
        if (parent) student.parent = parent;
        if (phone) {
            const cleanPhone = phone.replace(/\D/g, '');
            if (cleanPhone.length === 10) {
                student.phoneEncrypted = encrypt('+1' + cleanPhone);
            }
        }
        
        broadcast({
            type: 'STUDENT_UPDATED',
            data: { student: { id: student.id, name: student.name } }
        });
        
        res.json({ success: true, message: `${student.name} updated` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/students/:id', verifyToken, requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const index = database.students.findIndex(s => s.id === id);
        
        if (index === -1) {
            return res.status(404).json({ error: 'Student not found' });
        }
        
        const deleted = database.students.splice(index, 1)[0];
        
        broadcast({
            type: 'STUDENT_DELETED',
            data: { studentId: id }
        });
        
        res.json({ success: true, message: `${deleted.name} deleted` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------
// 📞 CALL ENDPOINTS WITH REAL-TIME UPDATES
// ---------------------------------------------------------
app.post('/api/calls/initiate', verifyToken, async (req, res) => {
    try {
        const { studentId, staffId } = req.body;
        
        if (!studentId || !staffId) {
            return res.status(400).json({ error: 'studentId and staffId required' });
        }
        
        const student = database.students.find(s => s.id === studentId);
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        
        const phoneNumber = decrypt(student.phoneEncrypted);
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📞 INITIATING CALL TO: ${student.name}`);
        console.log(`   Phone: ${phoneNumber}`);
        console.log(`${'='.repeat(60)}`);
        
        let callSid = null;
        let callError = null;
        
        if (twilio_client && config.twilio.phoneNumber) {
            try {
                // Make the real Twilio call with status callbacks
                const call = await twilio_client.calls.create({
                    url: 'http://demo.twilio.com/docs/voice.xml',
                    to: phoneNumber,
                    from: config.twilio.phoneNumber,
                    // CRITICAL: These webhook settings enable real-time sync
                    statusCallback: `${config.publicUrl}/webhooks/call-status`,
                    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed', 'busy', 'failed', 'no-answer', 'canceled'],
                    statusCallbackMethod: 'POST'
                });
                callSid = call.sid;
                console.log(`✅ Call created - SID: ${callSid}`);
            } catch (error) {
                callError = error.message;
                console.error(`❌ Twilio Error: ${error.message}`);
                console.error(`   Error Code: ${error.code || 'N/A'}`);
                console.error(`   Error Status: ${error.status || 'N/A'}`);
                console.error(`   More Info: ${error.moreInfo || 'N/A'}`);
                console.error(`   Full Error:`, JSON.stringify(error, null, 2));
                callSid = 'sim_' + Date.now();
            }
        } else {
            callSid = 'sim_' + Date.now();
            console.log(`⚠️ Using simulation mode`);
        }
        
        const callRecord = {
            id: callSid,
            studentId: studentId,
            studentName: student.name,
            staffId: staffId,
            phoneEncrypted: student.phoneEncrypted,
            startTime: new Date().toISOString(),
            endTime: null,
            duration: 0,
            status: 'initiated',
            method: callSid.startsWith('CA') ? 'twilio' : 'simulated',
            error: callError
        };
        
        database.calls.push(callRecord);
        
        // Broadcast call initiated
        broadcast({
            type: 'CALL_STATE_CHANGED',
            data: {
                callId: callSid,
                studentId: studentId,
                studentName: student.name,
                status: 'initiated',
                timestamp: new Date().toISOString()
            }
        });
        
        res.json({
            success: true,
            callSid: callSid,
            method: callRecord.method,
            student: {
                id: student.id,
                name: student.name,
                email: student.email,
                phone: phoneNumber
            },
            message: `Call ${callRecord.method === 'twilio' ? 'initiated via Twilio' : 'simulated'}`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/calls/hangup', verifyToken, async (req, res) => {
    try {
        const { callSid, duration } = req.body;
        
        if (!callSid) {
            return res.status(400).json({ error: 'callSid required' });
        }
        
        console.log(`\n✋ HANGUP requested for: ${callSid}`);
        
        const callRecord = database.calls.find(c => c.id === callSid);
        
        if (callRecord) {
            callRecord.endTime = new Date().toISOString();
            callRecord.duration = duration || 0;
            callRecord.status = 'completed';
        }
        
        // Terminate real Twilio call
        if (twilio_client && callSid.startsWith('CA')) {
            try {
                await twilio_client.calls(callSid).update({ status: 'completed' });
                console.log(`✅ Twilio call terminated`);
            } catch (error) {
                console.warn(`⚠️ Twilio hangup note: ${error.message}`);
            }
        }
        
        // Broadcast call ended (user initiated)
        broadcast({
            type: 'CALL_ENDED',
            data: {
                callId: callSid,
                studentName: callRecord?.studentName,
                duration: duration || 0,
                endedAt: new Date().toISOString(),
                endedBy: 'user'
            }
        });
        
        res.json({ success: true, message: 'Call ended successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/calls', verifyToken, (req, res) => {
    try {
        const calls = database.calls.map(c => ({
            id: c.id,
            studentName: c.studentName,
            startTime: c.startTime,
            endTime: c.endTime,
            duration: c.duration,
            status: c.status
        }));
        res.json(calls);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------
// 🪝 TWILIO WEBHOOKS - THE HEART OF REAL-TIME SYNC
// When the other person hangs up, Twilio calls this endpoint
// and we broadcast to all connected clients immediately
// ---------------------------------------------------------
app.post('/webhooks/call-status', (req, res) => {
    const { CallSid, CallStatus, CallDuration, Timestamp } = req.body;
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📡 TWILIO WEBHOOK RECEIVED`);
    console.log(`   Call SID: ${CallSid}`);
    console.log(`   Status: ${CallStatus}`);
    console.log(`   Duration: ${CallDuration || 0}s`);
    console.log(`${'='.repeat(60)}`);
    
    const callRecord = database.calls.find(c => c.id === CallSid);
    
    if (callRecord) {
        callRecord.status = CallStatus;
        
        // Handle each status and broadcast appropriate message
        switch(CallStatus) {
            case 'ringing':
                broadcast({
                    type: 'CALL_STATE_CHANGED',
                    data: {
                        callId: CallSid,
                        studentName: callRecord.studentName,
                        status: 'ringing',
                        timestamp: new Date().toISOString()
                    }
                });
                break;
                
            case 'in-progress':
            case 'answered':
                broadcast({
                    type: 'CALL_CONNECTED',
                    data: {
                        callId: CallSid,
                        studentName: callRecord.studentName,
                        status: 'active',
                        connectedAt: new Date().toISOString()
                    }
                });
                break;
                
            case 'completed':
                // THIS IS THE KEY - when other person hangs up!
                callRecord.endTime = new Date().toISOString();
                callRecord.duration = parseInt(CallDuration) || 0;
                
                broadcast({
                    type: 'CALL_ENDED',
                    data: {
                        callId: CallSid,
                        studentName: callRecord.studentName,
                        duration: callRecord.duration,
                        endedAt: callRecord.endTime,
                        endedBy: 'remote' // Other person ended it
                    }
                });
                console.log(`✅ Call completed - Duration: ${callRecord.duration}s`);
                break;
                
            case 'busy':
                broadcast({
                    type: 'CALL_FAILED',
                    data: {
                        callId: CallSid,
                        studentName: callRecord.studentName,
                        reason: 'Line busy',
                        status: 'busy'
                    }
                });
                break;
                
            case 'no-answer':
                broadcast({
                    type: 'CALL_FAILED',
                    data: {
                        callId: CallSid,
                        studentName: callRecord.studentName,
                        reason: 'No answer',
                        status: 'no-answer'
                    }
                });
                break;
                
            case 'failed':
                broadcast({
                    type: 'CALL_FAILED',
                    data: {
                        callId: CallSid,
                        studentName: callRecord.studentName,
                        reason: 'Call failed',
                        status: 'failed'
                    }
                });
                break;
                
            case 'canceled':
                broadcast({
                    type: 'CALL_ENDED',
                    data: {
                        callId: CallSid,
                        studentName: callRecord.studentName,
                        duration: 0,
                        endedAt: new Date().toISOString(),
                        endedBy: 'canceled'
                    }
                });
                break;
        }
    }
    
    // Always respond 200 to Twilio
    res.sendStatus(200);
});

// ---------------------------------------------------------
// 📊 ANALYTICS
// ---------------------------------------------------------
app.get('/api/analytics/stats', verifyToken, requireAdmin, (req, res) => {
    try {
        const totalStudents = database.students.length;
        const totalCalls = database.calls.length;
        const totalDuration = database.calls.reduce((sum, c) => sum + (c.duration || 0), 0);
        
        res.json({
            totalStudents,
            totalCalls,
            totalDuration,
            averageDuration: totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Error handling
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// ---------------------------------------------------------
// 🚀 START SERVER (HTTP + WebSocket on same port)
// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('\n' + '='.repeat(70));
    console.log('🚀 QURAN ACADEMY SERVER v3 - REAL-TIME SYNC ENABLED');
    console.log('='.repeat(70));
    console.log(`✅ HTTP Server: http://localhost:${PORT}`);
    console.log(`✅ WebSocket:   ws://localhost:${PORT}`);
    console.log(`🌐 Public URL:  ${config.publicUrl}`);
    
    if (twilio_client) {
        console.log(`\n📞 Twilio: CONFIGURED ✅`);
        console.log(`   Phone: ${config.twilio.phoneNumber}`);
    } else {
        console.log(`\n📞 Twilio: NOT CONFIGURED (simulation mode)`);
    }
    
    console.log(`\n🔌 WebSocket Real-Time Events:`);
    console.log(`   • CALL_STATE_CHANGED - Call status updates`);
    console.log(`   • CALL_CONNECTED     - When call is answered`);
    console.log(`   • CALL_ENDED         - When either party hangs up`);
    console.log(`   • CALL_FAILED        - Busy, no-answer, failed`);
    console.log('='.repeat(70) + '\n');
});

module.exports = { app, server, wss };
