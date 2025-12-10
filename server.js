// ========================================
// QURAN ACADEMY CALLING SERVER
// With MongoDB Database & WebSocket
// ========================================

const express = require('express');
const twilio = require('twilio');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// WebSocket server for real-time updates
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Serve static files
app.use(express.static(path.join(__dirname)));

// Serve index.html on root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------
const config = {
    twilio: {
        accountSid: (process.env.TWILIO_ACCOUNT_SID || '').trim(),
        authToken: (process.env.TWILIO_AUTH_TOKEN || '').trim(),
        phoneNumber: (process.env.TWILIO_PHONE_NUMBER || '').trim(),
    },
    publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').trim(),
    mongoUri: process.env.MONGODB_URI || '',
};

// ---------------------------------------------------------
// MONGODB CONNECTION
// ---------------------------------------------------------
let dbConnected = false;

if (config.mongoUri) {
    mongoose.connect(config.mongoUri)
        .then(() => {
            console.log('✅ MongoDB CONNECTED ✓');
            dbConnected = true;
            initializeAdmin();
        })
        .catch(err => {
            console.error('❌ MongoDB connection error:', err.message);
        });
} else {
    console.log('⚠️ MongoDB URI not configured - using in-memory storage');
    console.log('   Add MONGODB_URI environment variable for permanent storage');
}

// ---------------------------------------------------------
// DATABASE SCHEMAS
// ---------------------------------------------------------

// User Schema (Admin & Teachers)
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
    type: { type: String, enum: ['admin', 'teacher'], default: 'teacher' },
    phone: { type: String },
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    lastLogin: { type: Date }
});

// Student Schema
const studentSchema = new mongoose.Schema({
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String },
    notes: { type: String },
    course: { type: String },
    status: { type: String, enum: ['active', 'inactive', 'completed'], default: 'active' },
    addedBy: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Call History Schema
const callHistorySchema = new mongoose.Schema({
    studentName: { type: String, required: true },
    studentPhone: { type: String },
    teacherName: { type: String, required: true },
    teacherId: { type: String },
    status: { type: String, required: true },
    duration: { type: Number, default: 0 },
    callSid: { type: String },
    recordingUrl: { type: String },
    notes: { type: String },
    timestamp: { type: Date, default: Date.now }
});

// Create models
const User = mongoose.model('User', userSchema);
const Student = mongoose.model('Student', studentSchema);
const CallHistory = mongoose.model('CallHistory', callHistorySchema);

// Initialize default admin account
async function initializeAdmin() {
    try {
        const adminExists = await User.findOne({ type: 'admin' });
        if (!adminExists) {
            const hashedPassword = await bcrypt.hash('Quran@123', 10);
            await User.create({
                name: 'Administrator',
                email: 'admin@quranacademy.com',
                password: hashedPassword,
                type: 'admin'
            });
            console.log('✅ Default admin account created');
            console.log('   Email: admin@quranacademy.com');
            console.log('   Password: Quran@123');
        }
    } catch (err) {
        console.error('Error creating admin:', err.message);
    }
}

// ---------------------------------------------------------
// IN-MEMORY STORAGE (Fallback & Call Tracking)
// ---------------------------------------------------------
const activeCalls = new Map();
const recordingsMap = new Map();

// In-memory fallback if MongoDB not connected
let inMemoryStudents = [];
let inMemoryTeachers = [];
let inMemoryCallHistory = [];

// ---------------------------------------------------------
// TWILIO CONFIGURATION
// ---------------------------------------------------------
if (!config.twilio.accountSid || !config.twilio.authToken || !config.twilio.phoneNumber) {
    console.error('❌ ERROR: Twilio credentials not configured!');
} else {
    console.log('✅ Twilio CONFIGURED ✓');
    console.log('   Phone:', config.twilio.phoneNumber);
}

let twilioClient = null;
try {
    if (config.twilio.accountSid && config.twilio.authToken) {
        twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
        console.log('✅ Twilio client initialized');
    }
} catch (err) {
    console.error('❌ Twilio init error:', err.message);
}

// ---------------------------------------------------------
// WEBSOCKET MANAGEMENT
// ---------------------------------------------------------
const wsClients = new Set();

wss.on('connection', (ws) => {
    console.log('🔌 WebSocket client connected');
    wsClients.add(ws);
    
    ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Real-time updates enabled' }));
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'PING') {
                ws.send(JSON.stringify({ type: 'PONG' }));
            } else if (data.type === 'SUBSCRIBE_CALL') {
                ws.subscribedCallSid = data.callSid;
            }
        } catch (e) {
            console.error('WS message error:', e);
        }
    });
    
    ws.on('close', () => {
        wsClients.delete(ws);
        console.log('🔌 WebSocket client disconnected');
    });
    
    ws.on('error', (err) => {
        console.error('WS error:', err.message);
        wsClients.delete(ws);
    });
});

function broadcastCallStatus(callSid, status, duration, recordingUrl) {
    const message = JSON.stringify({
        type: 'CALL_STATUS_UPDATE',
        callSid,
        status,
        duration,
        recordingUrl,
        timestamp: Date.now()
    });
    
    wsClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            if (!client.subscribedCallSid || client.subscribedCallSid === callSid) {
                client.send(message);
            }
        }
    });
}

// ==========================================================
// DATABASE API ENDPOINTS
// ==========================================================

// ---------------------------------------------------------
// AUTHENTICATION
// ---------------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
    const { email, password, type } = req.body;
    
    console.log('🔐 Login attempt:', email, 'type:', type);
    
    try {
        if (dbConnected) {
            // Check database
            const user = await User.findOne({ 
                email: email.toLowerCase(),
                type: type 
            });
            
            if (!user) {
                return res.status(401).json({ success: false, error: 'Invalid credentials' });
            }
            
            const validPassword = await bcrypt.compare(password, user.password);
            if (!validPassword) {
                return res.status(401).json({ success: false, error: 'Invalid credentials' });
            }
            
            // Update last login
            user.lastLogin = new Date();
            await user.save();
            
            console.log('✅ Login successful:', user.name);
            
            return res.json({
                success: true,
                user: {
                    id: user._id,
                    name: user.name,
                    email: user.email,
                    type: user.type
                }
            });
        } else {
            // Fallback: hardcoded admin
            if (type === 'admin' && email === 'admin@quranacademy.com' && password === 'Quran@123') {
                return res.json({
                    success: true,
                    user: { id: 'admin-1', name: 'Administrator', email: email, type: 'admin' }
                });
            }
            
            // Check in-memory teachers
            const teacher = inMemoryTeachers.find(t => 
                t.email.toLowerCase() === email.toLowerCase() && t.password === password
            );
            if (teacher && type === 'teacher') {
                return res.json({
                    success: true,
                    user: { id: teacher.id, name: teacher.name, email: teacher.email, type: 'teacher' }
                });
            }
            
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// ---------------------------------------------------------
// STUDENTS API
// ---------------------------------------------------------

// Get all students
app.get('/api/students', async (req, res) => {
    try {
        if (dbConnected) {
            const students = await Student.find({ status: { $ne: 'deleted' } }).sort({ createdAt: -1 });
            return res.json({ success: true, students });
        } else {
            return res.json({ success: true, students: inMemoryStudents });
        }
    } catch (err) {
        console.error('Get students error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch students' });
    }
});

// Add new student
app.post('/api/students', async (req, res) => {
    const { name, phone, email, notes, course, addedBy } = req.body;
    
    console.log('➕ Adding student:', name, phone);
    
    if (!name || !phone) {
        return res.status(400).json({ success: false, error: 'Name and phone required' });
    }
    
    try {
        if (dbConnected) {
            const student = await Student.create({
                name, phone, email, notes, course, addedBy
            });
            console.log('✅ Student added to database:', student._id);
            return res.json({ success: true, student });
        } else {
            const student = {
                id: Date.now().toString(),
                name, phone, email, notes, course, addedBy,
                createdAt: new Date()
            };
            inMemoryStudents.push(student);
            return res.json({ success: true, student });
        }
    } catch (err) {
        console.error('Add student error:', err);
        res.status(500).json({ success: false, error: 'Failed to add student' });
    }
});

// Update student
app.put('/api/students/:id', async (req, res) => {
    const { id } = req.params;
    const { name, phone, email, notes, course, status } = req.body;
    
    console.log('✏️ Updating student:', id);
    
    try {
        if (dbConnected) {
            const student = await Student.findByIdAndUpdate(
                id,
                { name, phone, email, notes, course, status, updatedAt: new Date() },
                { new: true }
            );
            if (!student) {
                return res.status(404).json({ success: false, error: 'Student not found' });
            }
            return res.json({ success: true, student });
        } else {
            const index = inMemoryStudents.findIndex(s => s.id === id);
            if (index === -1) {
                return res.status(404).json({ success: false, error: 'Student not found' });
            }
            inMemoryStudents[index] = { ...inMemoryStudents[index], name, phone, email, notes, course, status };
            return res.json({ success: true, student: inMemoryStudents[index] });
        }
    } catch (err) {
        console.error('Update student error:', err);
        res.status(500).json({ success: false, error: 'Failed to update student' });
    }
});

// Delete student
app.delete('/api/students/:id', async (req, res) => {
    const { id } = req.params;
    
    console.log('🗑️ Deleting student:', id);
    
    try {
        if (dbConnected) {
            await Student.findByIdAndDelete(id);
            return res.json({ success: true });
        } else {
            inMemoryStudents = inMemoryStudents.filter(s => s.id !== id);
            return res.json({ success: true });
        }
    } catch (err) {
        console.error('Delete student error:', err);
        res.status(500).json({ success: false, error: 'Failed to delete student' });
    }
});

// ---------------------------------------------------------
// TEACHERS/USERS API
// ---------------------------------------------------------

// Get all teachers
app.get('/api/teachers', async (req, res) => {
    try {
        if (dbConnected) {
            const teachers = await User.find({ type: 'teacher', isActive: true })
                .select('-password')
                .sort({ createdAt: -1 });
            return res.json({ success: true, teachers });
        } else {
            const teachers = inMemoryTeachers.map(({ password, ...t }) => t);
            return res.json({ success: true, teachers });
        }
    } catch (err) {
        console.error('Get teachers error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch teachers' });
    }
});

// Add new teacher
app.post('/api/teachers', async (req, res) => {
    const { name, email, password, phone } = req.body;
    
    console.log('➕ Adding teacher:', name, email);
    
    if (!name || !email || !password) {
        return res.status(400).json({ success: false, error: 'Name, email and password required' });
    }
    
    try {
        if (dbConnected) {
            // Check if email exists
            const exists = await User.findOne({ email: email.toLowerCase() });
            if (exists) {
                return res.status(400).json({ success: false, error: 'Email already exists' });
            }
            
            const hashedPassword = await bcrypt.hash(password, 10);
            const teacher = await User.create({
                name, 
                email: email.toLowerCase(), 
                password: hashedPassword, 
                phone,
                type: 'teacher'
            });
            
            console.log('✅ Teacher added to database:', teacher._id);
            
            return res.json({ 
                success: true, 
                teacher: { id: teacher._id, name, email, phone, type: 'teacher' }
            });
        } else {
            const teacher = {
                id: Date.now().toString(),
                name, email, password, phone, type: 'teacher',
                createdAt: new Date()
            };
            inMemoryTeachers.push(teacher);
            const { password: _, ...teacherWithoutPassword } = teacher;
            return res.json({ success: true, teacher: teacherWithoutPassword });
        }
    } catch (err) {
        console.error('Add teacher error:', err);
        res.status(500).json({ success: false, error: 'Failed to add teacher' });
    }
});

// Update teacher
app.put('/api/teachers/:id', async (req, res) => {
    const { id } = req.params;
    const { name, email, password, phone } = req.body;
    
    console.log('✏️ Updating teacher:', id);
    
    try {
        if (dbConnected) {
            const updateData = { name, email: email.toLowerCase(), phone };
            if (password) {
                updateData.password = await bcrypt.hash(password, 10);
            }
            
            const teacher = await User.findByIdAndUpdate(id, updateData, { new: true }).select('-password');
            if (!teacher) {
                return res.status(404).json({ success: false, error: 'Teacher not found' });
            }
            return res.json({ success: true, teacher });
        } else {
            const index = inMemoryTeachers.findIndex(t => t.id === id);
            if (index === -1) {
                return res.status(404).json({ success: false, error: 'Teacher not found' });
            }
            inMemoryTeachers[index] = { ...inMemoryTeachers[index], name, email, phone };
            if (password) inMemoryTeachers[index].password = password;
            const { password: _, ...teacherWithoutPassword } = inMemoryTeachers[index];
            return res.json({ success: true, teacher: teacherWithoutPassword });
        }
    } catch (err) {
        console.error('Update teacher error:', err);
        res.status(500).json({ success: false, error: 'Failed to update teacher' });
    }
});

// Delete teacher
app.delete('/api/teachers/:id', async (req, res) => {
    const { id } = req.params;
    
    console.log('🗑️ Deleting teacher:', id);
    
    try {
        if (dbConnected) {
            await User.findByIdAndDelete(id);
            return res.json({ success: true });
        } else {
            inMemoryTeachers = inMemoryTeachers.filter(t => t.id !== id);
            return res.json({ success: true });
        }
    } catch (err) {
        console.error('Delete teacher error:', err);
        res.status(500).json({ success: false, error: 'Failed to delete teacher' });
    }
});

// ---------------------------------------------------------
// CALL HISTORY API
// ---------------------------------------------------------

// Get call history
app.get('/api/call-history', async (req, res) => {
    const { limit = 500, teacherId } = req.query;
    
    try {
        if (dbConnected) {
            let query = {};
            if (teacherId) query.teacherId = teacherId;
            
            const history = await CallHistory.find(query)
                .sort({ timestamp: -1 })
                .limit(parseInt(limit));
            return res.json({ success: true, history });
        } else {
            let history = inMemoryCallHistory;
            if (teacherId) {
                history = history.filter(h => h.teacherId === teacherId);
            }
            return res.json({ success: true, history: history.slice(0, parseInt(limit)) });
        }
    } catch (err) {
        console.error('Get call history error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch call history' });
    }
});

// Add call to history
app.post('/api/call-history', async (req, res) => {
    const { studentName, studentPhone, teacherName, teacherId, status, duration, callSid, recordingUrl, notes } = req.body;
    
    console.log('📝 Adding call to history:', studentName, status);
    
    try {
        if (dbConnected) {
            const call = await CallHistory.create({
                studentName, studentPhone, teacherName, teacherId, 
                status, duration, callSid, recordingUrl, notes
            });
            console.log('✅ Call history saved to database');
            return res.json({ success: true, call });
        } else {
            const call = {
                id: Date.now().toString(),
                studentName, studentPhone, teacherName, teacherId,
                status, duration, callSid, recordingUrl, notes,
                timestamp: new Date()
            };
            inMemoryCallHistory.unshift(call);
            return res.json({ success: true, call });
        }
    } catch (err) {
        console.error('Add call history error:', err);
        res.status(500).json({ success: false, error: 'Failed to save call history' });
    }
});

// ---------------------------------------------------------
// DATABASE STATUS
// ---------------------------------------------------------
app.get('/api/db-status', (req, res) => {
    res.json({
        connected: dbConnected,
        type: dbConnected ? 'MongoDB Atlas' : 'In-Memory (temporary)',
        message: dbConnected 
            ? 'All data is permanently saved' 
            : 'Data will be lost on server restart. Add MONGODB_URI for permanent storage.'
    });
});

// ==========================================================
// TWILIO CALLING ENDPOINTS
// ==========================================================

// POST /make-call - Initiate a phone call
app.post('/make-call', async (req, res) => {
    const { to, name } = req.body;
    
    console.log('\n' + '='.repeat(50));
    console.log('📞 INITIATING CALL');
    console.log('   To:', to);
    console.log('   Name:', name);
    console.log('='.repeat(50));
    
    if (!to) {
        return res.status(400).json({ success: false, error: 'Phone number required' });
    }
    
    if (!twilioClient) {
        return res.status(500).json({ success: false, error: 'Twilio not configured' });
    }
    
    try {
        const call = await twilioClient.calls.create({
            url: `${config.publicUrl}/twiml/outbound`,
            to: to,
            from: config.twilio.phoneNumber,
            record: true,
            recordingStatusCallback: `${config.publicUrl}/webhooks/recording-status`,
            recordingStatusCallbackEvent: ['completed'],
            statusCallback: `${config.publicUrl}/webhooks/call-status`,
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            statusCallbackMethod: 'POST'
        });
        
        activeCalls.set(call.sid, {
            sid: call.sid,
            to: to,
            name: name,
            status: 'initiated',
            duration: 0,
            startTime: Date.now(),
            recordingUrl: null,
            recordingSid: null
        });
        
        console.log('✅ Call created - SID:', call.sid);
        broadcastCallStatus(call.sid, 'initiated', 0, null);
        
        res.json({
            success: true,
            callSid: call.sid,
            message: 'Call initiated successfully'
        });
        
    } catch (error) {
        console.error('❌ Twilio Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /call-status/:sid - Get real-time call status
app.get('/call-status/:sid', async (req, res) => {
    const { sid } = req.params;
    const cachedCall = activeCalls.get(sid);
    
    if (twilioClient && cachedCall && ['in-progress', 'ringing', 'queued', 'initiated'].includes(cachedCall.status)) {
        try {
            const call = await twilioClient.calls(sid).fetch();
            const twilioStatus = call.status;
            
            const terminalStatuses = ['completed', 'busy', 'no-answer', 'canceled', 'failed'];
            if (terminalStatuses.includes(twilioStatus) && !terminalStatuses.includes(cachedCall.status)) {
                console.log('🔴 DETECTED: Call ended via Twilio API check!', twilioStatus);
                
                const duration = parseInt(call.duration) || cachedCall.duration || 0;
                cachedCall.status = twilioStatus;
                cachedCall.duration = duration;
                
                broadcastCallStatus(sid, twilioStatus, duration, cachedCall.recordingUrl);
                
                return res.json({
                    status: twilioStatus,
                    duration: duration,
                    recordingUrl: cachedCall.recordingUrl
                });
            }
            
            if (twilioStatus !== cachedCall.status) {
                cachedCall.status = twilioStatus;
                if (twilioStatus === 'in-progress' && !cachedCall.answeredTime) {
                    cachedCall.answeredTime = Date.now();
                }
            }
            
            if (cachedCall.status === 'in-progress' && cachedCall.answeredTime) {
                cachedCall.duration = Math.floor((Date.now() - cachedCall.answeredTime) / 1000);
            }
            
            return res.json({
                status: cachedCall.status,
                duration: cachedCall.duration,
                recordingUrl: cachedCall.recordingUrl
            });
            
        } catch (error) {
            console.error('Twilio status check error:', error.message);
        }
    }
    
    if (cachedCall) {
        if (cachedCall.status === 'in-progress' && cachedCall.answeredTime) {
            cachedCall.duration = Math.floor((Date.now() - cachedCall.answeredTime) / 1000);
        }
        
        return res.json({
            status: cachedCall.status,
            duration: cachedCall.duration,
            recordingUrl: cachedCall.recordingUrl
        });
    }
    
    if (!twilioClient) {
        return res.status(404).json({ error: 'Call not found' });
    }
    
    try {
        const call = await twilioClient.calls(sid).fetch();
        res.json({
            status: call.status,
            duration: parseInt(call.duration) || 0,
            recordingUrl: null
        });
    } catch (error) {
        console.error('❌ Status fetch error:', error.message);
        res.status(404).json({ error: 'Call not found' });
    }
});

// POST /hangup-call - End a call
app.post('/hangup-call', async (req, res) => {
    const { sid } = req.body;
    
    console.log('🔴 Hangup request for:', sid);
    
    if (!sid) {
        return res.status(400).json({ success: false, error: 'Call SID required' });
    }
    
    if (!twilioClient) {
        return res.status(500).json({ success: false, error: 'Twilio not configured' });
    }
    
    try {
        const cachedCall = activeCalls.get(sid);
        let duration = 0;
        
        if (cachedCall && cachedCall.answeredTime) {
            duration = Math.floor((Date.now() - cachedCall.answeredTime) / 1000);
            cachedCall.duration = duration;
        }
        
        await twilioClient.calls(sid).update({ status: 'completed' });
        
        console.log('✅ Call ended successfully');
        
        if (cachedCall) {
            cachedCall.status = 'completed';
        }
        
        broadcastCallStatus(sid, 'completed', duration, cachedCall?.recordingUrl || null);
        
        res.json({
            success: true,
            message: 'Call ended',
            duration: duration,
            recordingUrl: cachedCall?.recordingUrl || null
        });
        
    } catch (error) {
        console.error('❌ Hangup error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ---------------------------------------------------------
// TWIML ENDPOINTS
// ---------------------------------------------------------
app.post('/twiml/outbound', (req, res) => {
    const { CallSid } = req.body;
    console.log('📞 TwiML requested for:', CallSid);
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">You have a call from Quran Academy. Please hold.</Say>
    <Pause length="120"/>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
});

app.all('/twiml/conference', (req, res) => {
    const conferenceName = `call-${Date.now()}`;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">You are now connected.</Say>
    <Dial>
        <Conference startConferenceOnEnter="true" endConferenceOnExit="true" record="record-from-start">
            ${conferenceName}
        </Conference>
    </Dial>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
});

// ---------------------------------------------------------
// RECORDING ENDPOINTS
// ---------------------------------------------------------
app.post('/webhooks/recording-status', async (req, res) => {
    const { RecordingSid, RecordingUrl, RecordingStatus, RecordingDuration, CallSid } = req.body;
    
    console.log('🎙️ RECORDING WEBHOOK:', RecordingStatus, 'for call:', CallSid);
    
    if (RecordingStatus === 'completed' && RecordingUrl) {
        const playableUrl = RecordingUrl + '.mp3';
        
        const cachedCall = activeCalls.get(CallSid);
        if (cachedCall) {
            cachedCall.recordingUrl = playableUrl;
            cachedCall.recordingSid = RecordingSid;
        }
        
        recordingsMap.set(CallSid, {
            sid: RecordingSid,
            url: playableUrl,
            duration: parseInt(RecordingDuration) || 0,
            timestamp: Date.now()
        });
        
        // Update database if connected
        if (dbConnected) {
            try {
                await CallHistory.findOneAndUpdate(
                    { callSid: CallSid },
                    { recordingUrl: playableUrl }
                );
            } catch (err) {
                console.error('Error updating recording URL:', err);
            }
        }
        
        broadcastCallStatus(CallSid, 'recording-ready', parseInt(RecordingDuration) || 0, playableUrl);
    }
    
    res.status(200).send('OK');
});

app.get('/recording/:callSid', async (req, res) => {
    const { callSid } = req.params;
    
    console.log('🎙️ Recording requested for:', callSid);
    
    // Check caches
    const cachedRecording = recordingsMap.get(callSid);
    if (cachedRecording?.url) {
        return res.json({ success: true, recordingUrl: cachedRecording.url, duration: cachedRecording.duration });
    }
    
    const cachedCall = activeCalls.get(callSid);
    if (cachedCall?.recordingUrl) {
        return res.json({ success: true, recordingUrl: cachedCall.recordingUrl, duration: cachedCall.duration });
    }
    
    // Check database
    if (dbConnected) {
        try {
            const call = await CallHistory.findOne({ callSid });
            if (call?.recordingUrl) {
                return res.json({ success: true, recordingUrl: call.recordingUrl, duration: call.duration });
            }
        } catch (err) {
            console.error('DB recording lookup error:', err);
        }
    }
    
    // Try Twilio API
    if (twilioClient) {
        try {
            const recordings = await twilioClient.recordings.list({ callSid, limit: 1 });
            if (recordings.length > 0) {
                const recording = recordings[0];
                const recordingUrl = `https://api.twilio.com${recording.uri.replace('.json', '.mp3')}`;
                
                recordingsMap.set(callSid, {
                    sid: recording.sid,
                    url: recordingUrl,
                    duration: recording.duration,
                    timestamp: Date.now()
                });
                
                return res.json({ success: true, recordingUrl, duration: recording.duration });
            }
        } catch (error) {
            console.error('Twilio recording fetch error:', error.message);
        }
    }
    
    res.status(404).json({ success: false, error: 'Recording not found' });
});

app.get('/recording-audio/:callSid', async (req, res) => {
    const { callSid } = req.params;
    
    try {
        let recordingUrl = null;
        
        const cachedRecording = recordingsMap.get(callSid);
        if (cachedRecording?.url) recordingUrl = cachedRecording.url;
        
        if (!recordingUrl) {
            const cachedCall = activeCalls.get(callSid);
            if (cachedCall?.recordingUrl) recordingUrl = cachedCall.recordingUrl;
        }
        
        if (!recordingUrl && twilioClient) {
            const recordings = await twilioClient.recordings.list({ callSid, limit: 1 });
            if (recordings.length > 0) {
                recordingUrl = `https://api.twilio.com${recordings[0].uri.replace('.json', '.mp3')}`;
            }
        }
        
        if (!recordingUrl) {
            return res.status(404).json({ error: 'Recording not found' });
        }
        
        const authString = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
        
        const audioRequest = https.request(recordingUrl, {
            headers: { 'Authorization': `Basic ${authString}` }
        }, (audioResponse) => {
            res.set('Content-Type', audioResponse.headers['content-type'] || 'audio/mpeg');
            if (audioResponse.headers['content-length']) {
                res.set('Content-Length', audioResponse.headers['content-length']);
            }
            audioResponse.pipe(res);
        });
        
        audioRequest.on('error', (err) => {
            console.error('Audio stream error:', err.message);
            res.status(500).json({ error: 'Failed to stream recording' });
        });
        
        audioRequest.end();
        
    } catch (error) {
        console.error('Audio stream error:', error.message);
        res.status(500).json({ error: 'Failed to stream recording' });
    }
});

// ---------------------------------------------------------
// TWILIO WEBHOOKS
// ---------------------------------------------------------
app.post('/webhooks/call-status', (req, res) => {
    const { CallSid, CallStatus, CallDuration, RecordingUrl } = req.body;
    
    console.log('📡 WEBHOOK:', CallStatus, 'for:', CallSid);
    
    const cachedCall = activeCalls.get(CallSid);
    let duration = parseInt(CallDuration) || 0;
    
    if (cachedCall) {
        cachedCall.status = CallStatus;
        cachedCall.lastUpdate = Date.now();
        
        if (CallStatus === 'in-progress' && !cachedCall.answeredTime) {
            cachedCall.answeredTime = Date.now();
        }
        
        if (CallDuration) {
            cachedCall.duration = duration;
        } else if (cachedCall.answeredTime) {
            duration = Math.floor((Date.now() - cachedCall.answeredTime) / 1000);
            cachedCall.duration = duration;
        }
        
        if (RecordingUrl) {
            cachedCall.recordingUrl = RecordingUrl;
        }
    }
    
    broadcastCallStatus(CallSid, CallStatus, duration, cachedCall?.recordingUrl || RecordingUrl || null);
    
    res.status(200).send('OK');
});

// ---------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        twilio: !!twilioClient,
        database: dbConnected ? 'MongoDB Connected' : 'In-Memory',
        websocket: wsClients.size + ' clients'
    });
});

// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 QURAN ACADEMY SERVER STARTED');
    console.log('='.repeat(50));
    console.log(`   Port: ${PORT}`);
    console.log(`   Database: ${dbConnected ? 'MongoDB Connected ✓' : 'In-Memory (add MONGODB_URI)'}`);
    console.log(`   Twilio: ${twilioClient ? 'Connected ✓' : 'Not configured'}`);
    console.log(`   WebSocket: Enabled ✓`);
    console.log('='.repeat(50) + '\n');
});
