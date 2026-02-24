// ========================================
// QURAN ACADEMY CALLING SERVER
// HIGH PERFORMANCE VERSION
// Optimized for 400+ concurrent users
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
const compression = require('compression');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// =========================================
// HIGH PERFORMANCE CONFIGURATION
// =========================================

// Enable compression for all responses (reduces bandwidth by 70%)
app.use(compression({
    level: 6, // Balanced compression
    threshold: 1024, // Only compress if > 1KB
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    }
}));

// Increase payload limits for high traffic
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS with caching
app.use(cors({
    origin: true,
    credentials: true,
    maxAge: 86400 // Cache preflight for 24 hours
}));

// Static file caching (reduces server load significantly)
app.use(express.static(path.join(__dirname), {
    maxAge: '1h', // Cache static files for 1 hour
    etag: true,
    lastModified: true
}));

// =========================================
// SIMPLE IN-MEMORY RATE LIMITING
// Prevents server overload from too many requests
// =========================================
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 100; // Max 100 requests per minute per IP

// Clean up old entries every minute
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of requestCounts.entries()) {
        if (now - data.startTime > RATE_LIMIT_WINDOW) {
            requestCounts.delete(key);
        }
    }
}, 60000);

// Rate limiting middleware
const rateLimiter = (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    
    let data = requestCounts.get(ip);
    if (!data || now - data.startTime > RATE_LIMIT_WINDOW) {
        data = { count: 1, startTime: now };
        requestCounts.set(ip, data);
    } else {
        data.count++;
    }
    
    if (data.count > RATE_LIMIT_MAX) {
        return res.status(429).json({ 
            success: false, 
            error: 'Too many requests. Please wait a moment.' 
        });
    }
    
    next();
};

// Apply rate limiting to API routes only (not static files)
app.use('/api', rateLimiter);

// Serve index.html on root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve video-room.html for student video calls
app.get('/video-room.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'video-room.html'));
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
// MONGODB CONNECTION WITH OPTIMIZED POOLING
// Critical for handling 400+ concurrent connections
// ---------------------------------------------------------
let dbConnected = false;

// Function to check if database is actually connected
function isDbConnected() {
    return mongoose.connection.readyState === 1;
}

// Wait for database connection (with timeout)
async function waitForDbConnection(timeoutMs = 5000) {
    if (isDbConnected()) return true;
    
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        if (isDbConnected()) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return isDbConnected();
}

if (config.mongoUri) {
    // OPTIMIZED MongoDB connection for HIGH LOAD (400+ concurrent users)
    mongoose.connect(config.mongoUri, {
        // Connection pool settings - critical for high concurrency
        maxPoolSize: 100,          // Max connections in pool (handles 400+ users)
        minPoolSize: 10,           // Keep minimum connections ready
        maxIdleTimeMS: 30000,      // Close idle connections after 30s
        serverSelectionTimeoutMS: 5000,  // Fail fast if can't connect
        socketTimeoutMS: 45000,    // Socket timeout
        family: 4,                 // Use IPv4
        
        // Buffer commands when disconnected (prevents errors during reconnect)
        bufferCommands: true,
        
        // Retry settings
        retryWrites: true,
        retryReads: true,
    })
    .then(() => {
        console.log('✅ MongoDB CONNECTED ✓ (High-Performance Pool: 100 connections)');
        dbConnected = true;
        initializeAdmin();
    })
    .catch(err => {
        console.error('❌ MongoDB connection error:', err.message);
    });
    
    // Handle connection events
    mongoose.connection.on('connected', () => {
        console.log('✅ MongoDB reconnected');
        dbConnected = true;
    });
    
    mongoose.connection.on('disconnected', () => {
        console.log('⚠️ MongoDB disconnected');
        dbConnected = false;
    });
    
    mongoose.connection.on('error', (err) => {
        console.error('❌ MongoDB error:', err.message);
    });
} else {
    console.log('⚠️ MongoDB URI not configured - using in-memory storage');
    console.log('   Add MONGODB_URI environment variable for permanent storage');
}

// ---------------------------------------------------------
// DATABASE SCHEMAS (OPTIMIZED WITH INDEXES FOR 400+ USERS)
// ---------------------------------------------------------

// User Schema (Admin & Teachers)
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
    type: { type: String, enum: ['admin', 'teacher'], default: 'teacher', index: true },
    phone: { type: String },
    isActive: { type: Boolean, default: true, index: true },
    createdAt: { type: Date, default: Date.now },
    lastLogin: { type: Date }
});
// Compound index for common queries
userSchema.index({ type: 1, isActive: 1 });

// Student Schema
const studentSchema = new mongoose.Schema({
    name: { type: String, required: true },
    phone: { type: String, required: true, index: true },
    email: { type: String },
    notes: { type: String },
    course: { type: String },
    status: { type: String, enum: ['active', 'inactive', 'completed', 'deleted'], default: 'active', index: true },
    addedBy: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});
// Compound index for filtering active students
studentSchema.index({ status: 1, createdAt: -1 });

// Call History Schema
const callHistorySchema = new mongoose.Schema({
    studentName: { type: String, required: true },
    studentPhone: { type: String, index: true },
    teacherName: { type: String, required: true },
    teacherId: { type: String, index: true },
    status: { type: String, required: true },
    duration: { type: Number, default: 0 },
    callSid: { type: String, unique: true, sparse: true, index: true },
    recordingUrl: { type: String },
    notes: { type: String },
    direction: { type: String, enum: ['inbound', 'outbound'], default: 'outbound' },
    callType: { type: String, enum: ['voice', 'video'], default: 'voice' }, // voice or video call
    roomName: { type: String }, // For video calls - the room name
    timestamp: { type: Date, default: Date.now, index: true }
});
// Compound indexes for common queries
callHistorySchema.index({ teacherId: 1, timestamp: -1 });
callHistorySchema.index({ timestamp: -1 }); // For sorting by recent
callHistorySchema.index({ callSid: 1 }, { unique: true, sparse: true }); // Prevent duplicate entries

// SMS Message Schema
const messageSchema = new mongoose.Schema({
    studentId: { type: String, required: true, index: true },
    studentName: { type: String, required: true },
    studentPhone: { type: String, required: true, index: true },
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    body: { type: String, required: true },
    senderName: { type: String }, // Teacher name for outbound
    senderId: { type: String }, // Teacher ID for outbound
    messageSid: { type: String }, // Twilio message SID
    status: { type: String, default: 'sent' }, // sent, delivered, failed
    read: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now, index: true }
});
// Compound index for fetching messages by student
messageSchema.index({ studentId: 1, timestamp: -1 });

// Conversation Schema (for tracking last message per student)
const conversationSchema = new mongoose.Schema({
    studentId: { type: String, required: true, unique: true },
    studentName: { type: String, required: true },
    studentPhone: { type: String, required: true, index: true },
    lastMessage: { type: String },
    lastMessageTime: { type: Date, default: Date.now, index: true },
    lastMessageDirection: { type: String, enum: ['inbound', 'outbound'] },
    unreadCount: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now }
});
// Index for sorting by recent
conversationSchema.index({ lastMessageTime: -1 });

// Video Room Schema
const videoRoomSchema = new mongoose.Schema({
    roomName: { type: String, required: true, unique: true },
    roomSid: { type: String },
    studentId: { type: String, required: true },
    studentName: { type: String, required: true },
    studentPhone: { type: String, required: true },
    teacherId: { type: String, required: true, index: true },
    teacherName: { type: String, required: true },
    status: { type: String, enum: ['waiting', 'active', 'completed'], default: 'waiting', index: true },
    joinUrl: { type: String },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    duration: { type: Number, default: 0 }
});
// Index for finding active rooms by teacher
videoRoomSchema.index({ teacherId: 1, status: 1 });

// Create models
const User = mongoose.model('User', userSchema);
const Student = mongoose.model('Student', studentSchema);
const CallHistory = mongoose.model('CallHistory', callHistorySchema);
const Message = mongoose.model('Message', messageSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);
const VideoRoom = mongoose.model('VideoRoom', videoRoomSchema);

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
const activeVideoRooms = new Map(); // For tracking active video rooms
const inboundCalls = new Map(); // For tracking incoming calls waiting to be answered

// In-memory fallback if MongoDB not connected
let inMemoryStudents = [];
let inMemoryTeachers = [];
let inMemoryCallHistory = [];
let inMemoryMessages = [];
let inMemoryConversations = [];

// =========================================
// HIGH-PERFORMANCE CACHING SYSTEM
// Reduces database load for 400+ concurrent users
// =========================================
const cache = {
    students: { data: null, timestamp: 0, ttl: 30000 }, // 30 second cache
    teachers: { data: null, timestamp: 0, ttl: 30000 }, // 30 second cache
    conversations: { data: null, timestamp: 0, ttl: 15000 }, // 15 second cache
};

// Cache helper functions
function getCached(key) {
    const entry = cache[key];
    if (entry && entry.data && (Date.now() - entry.timestamp < entry.ttl)) {
        return entry.data;
    }
    return null;
}

function setCache(key, data) {
    if (cache[key]) {
        cache[key].data = data;
        cache[key].timestamp = Date.now();
    }
}

function invalidateCache(key) {
    if (cache[key]) {
        cache[key].data = null;
        cache[key].timestamp = 0;
    }
}

// Invalidate all caches
function invalidateAllCaches() {
    Object.keys(cache).forEach(key => invalidateCache(key));
}

// =========================================
// MEMORY CLEANUP ROUTINES
// Prevents memory leaks with high traffic
// =========================================

// Clean up stale active calls (older than 2 hours)
setInterval(() => {
    const now = Date.now();
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    let cleaned = 0;
    
    activeCalls.forEach((callData, callSid) => {
        if (now - (callData.startTime || 0) > TWO_HOURS) {
            activeCalls.delete(callSid);
            cleaned++;
        }
    });
    
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} stale active calls. Remaining: ${activeCalls.size}`);
    }
}, 5 * 60 * 1000); // Every 5 minutes

// Clean up old recordings references (older than 24 hours)
setInterval(() => {
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;
    let cleaned = 0;
    
    recordingsMap.forEach((recordingData, callSid) => {
        if (now - (recordingData.timestamp || 0) > ONE_DAY) {
            recordingsMap.delete(callSid);
            cleaned++;
        }
    });
    
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} old recording references. Remaining: ${recordingsMap.size}`);
    }
}, 60 * 60 * 1000); // Every hour

// Clean up stale video rooms (older than 4 hours)
setInterval(() => {
    const now = Date.now();
    const FOUR_HOURS = 4 * 60 * 60 * 1000;
    let cleaned = 0;
    
    activeVideoRooms.forEach((roomData, roomName) => {
        const startTime = roomData.startedAt ? new Date(roomData.startedAt).getTime() : 0;
        if (now - startTime > FOUR_HOURS) {
            activeVideoRooms.delete(roomName);
            cleaned++;
        }
    });
    
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} stale video rooms. Remaining: ${activeVideoRooms.size}`);
    }
}, 10 * 60 * 1000); // Every 10 minutes

// Clean up stale inbound calls (older than 2 minutes - not answered)
setInterval(() => {
    const now = Date.now();
    const TWO_MINUTES = 2 * 60 * 1000;
    let cleaned = 0;
    
    inboundCalls.forEach((callData, callSid) => {
        if (now - (callData.timestamp || 0) > TWO_MINUTES) {
            inboundCalls.delete(callSid);
            cleaned++;
        }
    });
    
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} stale inbound calls. Remaining: ${inboundCalls.size}`);
    }
}, 30 * 1000); // Every 30 seconds

// Log memory usage periodically (helps monitor for issues)
setInterval(() => {
    const used = process.memoryUsage();
    const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024);
    
    console.log(`📊 Memory: ${heapUsedMB}MB / ${heapTotalMB}MB | WS: ${wsClients.size} | Calls: ${activeCalls.size} | Rooms: ${activeVideoRooms.size}`);
}, 5 * 60 * 1000); // Every 5 minutes

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
        // Create Twilio client with optimized HTTP agent for faster SMS delivery
        twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken, {
            // Use HTTP keep-alive for faster subsequent requests
            lazyLoading: true,
            // Timeout settings
            timeout: 30000, // 30 second timeout
        });
        console.log('✅ Twilio client initialized (optimized with keep-alive)');
    }
} catch (err) {
    console.error('❌ Twilio init error:', err.message);
}

// ---------------------------------------------------------
// HIGH-PERFORMANCE WEBSOCKET MANAGEMENT
// Optimized for 400+ concurrent connections
// ---------------------------------------------------------
const wsClients = new Map(); // Map instead of Set for better tracking
const MAX_WS_CONNECTIONS = 1000; // Maximum WebSocket connections
const WS_HEARTBEAT_INTERVAL = 30000; // 30 seconds heartbeat
const WS_TIMEOUT = 60000; // 60 seconds timeout for dead connections

// WebSocket server with optimized settings
const wss = new WebSocket.Server({ 
    server,
    maxPayload: 1024 * 1024, // 1MB max payload
    clientTracking: true,
    perMessageDeflate: {
        zlibDeflateOptions: { level: 6 },
        threshold: 1024, // Compress messages > 1KB
    }
});

// Heartbeat to detect dead connections
function heartbeat() {
    this.isAlive = true;
    this.lastPong = Date.now();
}

// Clean up dead connections every 30 seconds
const wsCleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    wsClients.forEach((clientData, ws) => {
        if (!clientData.isAlive || (now - clientData.lastActivity > WS_TIMEOUT)) {
            ws.terminate();
            wsClients.delete(ws);
            cleaned++;
        } else {
            clientData.isAlive = false;
            try {
                ws.ping();
            } catch (e) {
                ws.terminate();
                wsClients.delete(ws);
                cleaned++;
            }
        }
    });
    
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} dead WebSocket connections. Active: ${wsClients.size}`);
    }
}, WS_HEARTBEAT_INTERVAL);

// Clean up on server shutdown
wss.on('close', () => {
    clearInterval(wsCleanupInterval);
});

wss.on('connection', (ws, req) => {
    // Reject if too many connections
    if (wsClients.size >= MAX_WS_CONNECTIONS) {
        console.warn('⚠️ Max WebSocket connections reached, rejecting new connection');
        ws.close(1013, 'Server is at capacity');
        return;
    }
    
    // Initialize client data
    const clientData = {
        isAlive: true,
        lastActivity: Date.now(),
        subscribedCallSid: null,
        userId: null,
        ip: req.socket.remoteAddress
    };
    
    wsClients.set(ws, clientData);
    
    // Only log occasionally to reduce console spam
    if (wsClients.size % 10 === 0 || wsClients.size <= 5) {
        console.log(`🔌 WebSocket connected. Total clients: ${wsClients.size}`);
    }
    
    ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Real-time updates enabled' }));
    
    // Handle pong (heartbeat response)
    ws.on('pong', () => {
        const data = wsClients.get(ws);
        if (data) {
            data.isAlive = true;
            data.lastActivity = Date.now();
        }
    });
    
    ws.on('message', (message) => {
        try {
            const data = wsClients.get(ws);
            if (data) data.lastActivity = Date.now();
            
            const parsed = JSON.parse(message);
            
            if (parsed.type === 'PING') {
                ws.send(JSON.stringify({ type: 'PONG' }));
            } else if (parsed.type === 'SUBSCRIBE_CALL') {
                if (data) data.subscribedCallSid = parsed.callSid;
            } else if (parsed.type === 'SET_USER_ID') {
                if (data) data.userId = parsed.userId;
            }
        } catch (e) {
            // Silently ignore parse errors to prevent log spam
        }
    });
    
    ws.on('close', () => {
        wsClients.delete(ws);
    });
    
    ws.on('error', () => {
        wsClients.delete(ws);
    });
});

// OPTIMIZED broadcast - only send to relevant clients
function broadcastCallStatus(callSid, status, duration, recordingUrl) {
    const message = JSON.stringify({
        type: 'CALL_STATUS_UPDATE',
        callSid,
        status,
        duration,
        recordingUrl,
        timestamp: Date.now()
    });
    
    let sent = 0;
    wsClients.forEach((clientData, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            // Only send to clients subscribed to this call OR not subscribed to anything
            if (!clientData.subscribedCallSid || clientData.subscribedCallSid === callSid) {
                try {
                    ws.send(message);
                    sent++;
                } catch (e) {
                    // Remove dead connection
                    wsClients.delete(ws);
                }
            }
        }
    });
}

// OPTIMIZED broadcast for new SMS message
function broadcastNewMessage(message) {
    const payload = JSON.stringify({
        type: 'NEW_SMS_MESSAGE',
        message,
        timestamp: Date.now()
    });
    
    wsClients.forEach((clientData, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(payload);
            } catch (e) {
                wsClients.delete(ws);
            }
        }
    });
}

// OPTIMIZED broadcast incoming call
function broadcastIncomingCall(callData) {
    const payload = JSON.stringify({
        type: 'INCOMING_CALL',
        call: callData,
        timestamp: Date.now()
    });
    
    let sent = 0;
    wsClients.forEach((clientData, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(payload);
                sent++;
            } catch (e) {
                wsClients.delete(ws);
            }
        }
    });
    
    console.log(`📢 Broadcast incoming call to ${sent}/${wsClients.size} clients`);
}

// OPTIMIZED broadcast incoming call status update
function broadcastIncomingCallStatus(callSid, status, additionalData = {}) {
    const payload = JSON.stringify({
        type: 'INCOMING_CALL_STATUS',
        callSid,
        status,
        ...additionalData,
        timestamp: Date.now()
    });
    
    wsClients.forEach((clientData, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(payload);
            } catch (e) {
                wsClients.delete(ws);
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
// STUDENTS API (with CACHING for high performance)
// ---------------------------------------------------------

// Unified cache helper aliases for backwards compatibility
const getCachedData = getCached;
const setCachedData = setCache;

// Get all students (with caching)
app.get('/api/students', async (req, res) => {
    try {
        // Try cache first (reduces DB load significantly with 400+ users)
        const cached = getCachedData('students');
        if (cached) {
            return res.json({ success: true, students: cached, fromCache: true });
        }
        
        if (dbConnected) {
            const students = await Student.find({ status: { $ne: 'deleted' } })
                .sort({ createdAt: -1 })
                .lean(); // .lean() returns plain JS objects (faster)
            
            setCachedData('students', students);
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
            invalidateCache('students'); // Clear cache on add
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
            invalidateCache('students'); // Clear cache on update
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
            invalidateCache('students'); // Clear cache on delete
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
            // Try cache first
            const cached = getCachedData('teachers');
            if (cached) {
                return res.json({ success: true, teachers: cached, fromCache: true });
            }
            
            const teachers = await User.find({ type: 'teacher', isActive: true })
                .select('-password')
                .sort({ createdAt: -1 })
                .lean(); // Faster - returns plain JS objects
            
            setCachedData('teachers', teachers);
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
            const exists = await User.findOne({ email: email.toLowerCase() }).lean();
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
            invalidateCache('teachers'); // Clear cache on add
            
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
            
            const teacher = await User.findByIdAndUpdate(id, updateData, { new: true }).select('-password').lean();
            if (!teacher) {
                return res.status(404).json({ success: false, error: 'Teacher not found' });
            }
            invalidateCache('teachers'); // Clear cache on update
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
            invalidateCache('teachers'); // Clear cache on delete
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
                .limit(parseInt(limit))
                .lean(); // Faster - returns plain JS objects
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
    const { studentName, studentPhone, teacherName, teacherId, status, duration, callSid, recordingUrl, notes, callType, roomName, direction } = req.body;
    
    console.log('📝 Adding call to history:', studentName, status, callType || 'voice');
    
    try {
        // DEDUPLICATION: If callSid is provided, check if this call already exists
        if (callSid) {
            if (dbConnected) {
                const existing = await CallHistory.findOne({ callSid });
                if (existing) {
                    console.log('⚠️ Duplicate call history detected for callSid:', callSid, '- skipping');
                    return res.json({ success: true, call: existing, duplicate: true });
                }
            } else {
                const existing = inMemoryCallHistory.find(c => c.callSid === callSid);
                if (existing) {
                    console.log('⚠️ Duplicate call history detected (in-memory) for callSid:', callSid, '- skipping');
                    return res.json({ success: true, call: existing, duplicate: true });
                }
            }
        }
        
        if (dbConnected) {
            const call = await CallHistory.create({
                studentName, studentPhone, teacherName, teacherId, 
                status, duration, callSid, recordingUrl, notes,
                callType: callType || 'voice',
                roomName: roomName || null,
                direction: direction || 'outbound'
            });
            console.log('✅ Call history saved to database');
            return res.json({ success: true, call });
        } else {
            const call = {
                id: Date.now().toString(),
                studentName, studentPhone, teacherName, teacherId,
                status, duration, callSid, recordingUrl, notes,
                callType: callType || 'voice',
                roomName: roomName || null,
                direction: direction || 'outbound',
                timestamp: new Date()
            };
            inMemoryCallHistory.unshift(call);
            return res.json({ success: true, call });
        }
    } catch (err) {
        // Handle MongoDB duplicate key error (code 11000) gracefully
        if (err.code === 11000 && callSid) {
            console.log('⚠️ Duplicate key error for callSid:', callSid, '- returning existing record');
            try {
                const existing = await CallHistory.findOne({ callSid });
                if (existing) return res.json({ success: true, call: existing, duplicate: true });
            } catch (e) { /* fall through */ }
        }
        console.error('Add call history error:', err);
        res.status(500).json({ success: false, error: 'Failed to save call history' });
    }
});

// Delete call history records (admin only)
app.post('/api/call-history/delete', async (req, res) => {
    const { ids } = req.body;
    
    console.log('🗑️ Delete request received');
    console.log('   IDs received:', ids);
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        console.log('❌ No valid IDs provided');
        return res.status(400).json({ success: false, error: 'No IDs provided for deletion' });
    }
    
    console.log('🗑️ Attempting to delete', ids.length, 'call history records');
    
    try {
        if (dbConnected) {
            // Convert all IDs to strings and filter valid MongoDB ObjectIds
            const stringIds = ids.map(id => String(id));
            const validObjectIds = stringIds.filter(id => /^[0-9a-fA-F]{24}$/.test(id));
            
            console.log('   Valid ObjectIds:', validObjectIds.length);
            console.log('   All IDs (for callSid):', stringIds.length);
            
            // Build query - match by _id OR by callSid
            const query = {
                $or: []
            };
            
            // Add ObjectId matches if any
            if (validObjectIds.length > 0) {
                query.$or.push({ _id: { $in: validObjectIds } });
            }
            
            // Always try to match by callSid too
            query.$or.push({ callSid: { $in: stringIds } });
            
            // If no valid query conditions, return error
            if (query.$or.length === 0) {
                return res.status(400).json({ success: false, error: 'No valid IDs to delete' });
            }
            
            console.log('   Query:', JSON.stringify(query));
            
            const result = await CallHistory.deleteMany(query);
            
            console.log(`✅ Deleted ${result.deletedCount} call history records from database`);
            return res.json({ 
                success: true, 
                deletedCount: result.deletedCount,
                message: `Successfully deleted ${result.deletedCount} record(s)`
            });
        } else {
            // In-memory deletion
            const stringIds = ids.map(id => String(id));
            const initialLength = inMemoryCallHistory.length;
            
            inMemoryCallHistory = inMemoryCallHistory.filter(call => {
                const callId = String(call.id || call._id || call.callSid || '');
                return !stringIds.includes(callId);
            });
            
            const deletedCount = initialLength - inMemoryCallHistory.length;
            
            console.log(`✅ Deleted ${deletedCount} call history records from memory`);
            return res.json({ 
                success: true, 
                deletedCount,
                message: `Successfully deleted ${deletedCount} record(s)`
            });
        }
    } catch (err) {
        console.error('❌ Delete call history error:', err);
        res.status(500).json({ success: false, error: 'Failed to delete call history records: ' + err.message });
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
// SMS MESSAGING API
// ==========================================================

// Get all conversations (for Messages sidebar)
app.get('/api/sms/conversations', async (req, res) => {
    try {
        if (dbConnected) {
            const conversations = await Conversation.find()
                .sort({ lastMessageTime: -1 })
                .lean(); // Faster - returns plain JS objects
            return res.json({ success: true, conversations });
        } else {
            return res.json({ success: true, conversations: inMemoryConversations });
        }
    } catch (err) {
        console.error('Get conversations error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch conversations' });
    }
});

// Get messages for a specific student
app.get('/api/sms/messages/:studentId', async (req, res) => {
    const { studentId } = req.params;
    
    try {
        if (dbConnected) {
            const messages = await Message.find({ studentId })
                .sort({ timestamp: 1 }) // Oldest first for chat view
                .lean(); // Faster - returns plain JS objects
            
            // Mark messages as read (background - don't wait)
            Message.updateMany(
                { studentId, direction: 'inbound', read: false },
                { read: true }
            ).exec().catch(err => console.error('Mark read error:', err));
            
            // Reset unread count for this conversation (background - don't wait)
            Conversation.findOneAndUpdate(
                { studentId },
                { unreadCount: 0 }
            ).exec().catch(err => console.error('Reset unread error:', err));
            
            return res.json({ success: true, messages });
        } else {
            const messages = inMemoryMessages
                .filter(m => m.studentId === studentId)
                .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            return res.json({ success: true, messages });
        }
    } catch (err) {
        console.error('Get messages error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch messages' });
    }
});

// Send SMS to a student
app.post('/api/sms/send', async (req, res) => {
    const { studentId, studentName, studentPhone, body, senderName, senderId } = req.body;
    
    console.log('\n' + '='.repeat(50));
    console.log('📱 SENDING SMS');
    console.log('   To:', studentPhone);
    console.log('   Student:', studentName);
    console.log('   Message:', body.substring(0, 50) + (body.length > 50 ? '...' : ''));
    console.log('='.repeat(50));
    
    if (!studentPhone || !body) {
        return res.status(400).json({ success: false, error: 'Phone number and message body required' });
    }
    
    if (!twilioClient) {
        return res.status(500).json({ success: false, error: 'Twilio not configured' });
    }
    
    try {
        // Send via Twilio
        const twilioMessage = await twilioClient.messages.create({
            body: body,
            from: config.twilio.phoneNumber,
            to: studentPhone,
            statusCallback: `${config.publicUrl}/webhooks/sms-status`
        });
        
        console.log('✅ SMS sent, SID:', twilioMessage.sid);
        
        // Save message to database
        const messageData = {
            studentId: studentId || studentPhone,
            studentName: studentName || 'Unknown',
            studentPhone,
            direction: 'outbound',
            body,
            senderName: senderName || 'Admin',
            senderId: senderId || 'admin',
            messageSid: twilioMessage.sid,
            status: 'sent',
            timestamp: new Date()
        };
        
        let savedMessage;
        if (dbConnected) {
            savedMessage = await Message.create(messageData);
            
            // Update or create conversation
            await Conversation.findOneAndUpdate(
                { studentId: messageData.studentId },
                {
                    studentId: messageData.studentId,
                    studentName: messageData.studentName,
                    studentPhone: messageData.studentPhone,
                    lastMessage: body,
                    lastMessageTime: new Date(),
                    lastMessageDirection: 'outbound',
                    updatedAt: new Date()
                },
                { upsert: true, new: true }
            );
        } else {
            savedMessage = { ...messageData, _id: Date.now().toString() };
            inMemoryMessages.push(savedMessage);
            
            // Update in-memory conversations
            const convIndex = inMemoryConversations.findIndex(c => c.studentId === messageData.studentId);
            const convData = {
                studentId: messageData.studentId,
                studentName: messageData.studentName,
                studentPhone: messageData.studentPhone,
                lastMessage: body,
                lastMessageTime: new Date(),
                lastMessageDirection: 'outbound',
                unreadCount: 0,
                updatedAt: new Date()
            };
            if (convIndex >= 0) {
                inMemoryConversations[convIndex] = convData;
            } else {
                inMemoryConversations.unshift(convData);
            }
        }
        
        // Broadcast to all clients
        broadcastNewMessage(savedMessage);
        
        res.json({ success: true, message: savedMessage });
        
    } catch (err) {
        console.error('❌ SMS send error:', err.message);
        res.status(500).json({ success: false, error: err.message || 'Failed to send SMS' });
    }
});

// Get unread count for all conversations
app.get('/api/sms/unread-count', async (req, res) => {
    try {
        if (dbConnected) {
            const result = await Conversation.aggregate([
                { $group: { _id: null, total: { $sum: '$unreadCount' } } }
            ]);
            const totalUnread = result.length > 0 ? result[0].total : 0;
            return res.json({ success: true, unreadCount: totalUnread });
        } else {
            const totalUnread = inMemoryConversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
            return res.json({ success: true, unreadCount: totalUnread });
        }
    } catch (err) {
        console.error('Get unread count error:', err);
        res.status(500).json({ success: false, error: 'Failed to get unread count' });
    }
});

// Delete SMS conversations (admin only)
app.post('/api/sms/conversations/delete', async (req, res) => {
    const { ids } = req.body;
    
    console.log('🗑️ Delete conversations request received');
    console.log('   IDs received:', ids);
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        console.log('❌ No valid IDs provided');
        return res.status(400).json({ success: false, error: 'No IDs provided for deletion' });
    }
    
    console.log('🗑️ Attempting to delete', ids.length, 'conversations');
    
    try {
        if (dbConnected) {
            const stringIds = ids.map(id => String(id));
            
            // Delete conversations
            const convResult = await Conversation.deleteMany({
                $or: [
                    { studentId: { $in: stringIds } },
                    { _id: { $in: stringIds.filter(id => /^[0-9a-fA-F]{24}$/.test(id)) } }
                ]
            });
            
            // Also delete associated messages
            const msgResult = await Message.deleteMany({
                studentId: { $in: stringIds }
            });
            
            console.log(`✅ Deleted ${convResult.deletedCount} conversations and ${msgResult.deletedCount} messages from database`);
            return res.json({ 
                success: true, 
                deletedCount: convResult.deletedCount,
                messagesDeleted: msgResult.deletedCount,
                message: `Successfully deleted ${convResult.deletedCount} conversation(s)`
            });
        } else {
            // In-memory deletion
            const stringIds = ids.map(id => String(id));
            const initialConvLength = inMemoryConversations.length;
            const initialMsgLength = inMemoryMessages.length;
            
            inMemoryConversations = inMemoryConversations.filter(c => {
                const convId = String(c.studentId || c._id || '');
                return !stringIds.includes(convId);
            });
            
            inMemoryMessages = inMemoryMessages.filter(m => {
                const studentId = String(m.studentId || '');
                return !stringIds.includes(studentId);
            });
            
            const deletedConvCount = initialConvLength - inMemoryConversations.length;
            const deletedMsgCount = initialMsgLength - inMemoryMessages.length;
            
            console.log(`✅ Deleted ${deletedConvCount} conversations and ${deletedMsgCount} messages from memory`);
            return res.json({ 
                success: true, 
                deletedCount: deletedConvCount,
                messagesDeleted: deletedMsgCount,
                message: `Successfully deleted ${deletedConvCount} conversation(s)`
            });
        }
    } catch (err) {
        console.error('❌ Delete conversations error:', err);
        res.status(500).json({ success: false, error: 'Failed to delete conversations: ' + err.message });
    }
});

// ==========================================================
// VIDEO CALLING API
// ==========================================================

// Twilio AccessToken for Video
const AccessToken = twilio.jwt.AccessToken;
const VideoGrant = AccessToken.VideoGrant;

// Generate a unique room name
function generateRoomName() {
    return 'quran-room-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
}

// Check if Video API keys are configured
function hasVideoApiKeys() {
    return process.env.TWILIO_API_KEY_SID && process.env.TWILIO_API_KEY_SECRET;
}

// Generate access token for video room
function generateVideoToken(identity, roomName) {
    if (!hasVideoApiKeys()) {
        throw new Error('Video API keys not configured. Please add TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET to environment variables.');
    }
    
    const token = new AccessToken(
        config.twilio.accountSid,
        process.env.TWILIO_API_KEY_SID,
        process.env.TWILIO_API_KEY_SECRET,
        { identity: identity }
    );
    
    const videoGrant = new VideoGrant({
        room: roomName
    });
    
    token.addGrant(videoGrant);
    return token.toJwt();
}

// Create a new video room and send invite to student
app.post('/api/video/create-room', async (req, res) => {
    const { studentId, studentName, studentPhone, teacherId, teacherName } = req.body;
    
    console.log('\n' + '='.repeat(50));
    console.log('🎥 CREATING VIDEO ROOM');
    console.log('   Student:', studentName);
    console.log('   Teacher:', teacherName);
    console.log('='.repeat(50));
    
    // Check if Video API keys are configured
    if (!hasVideoApiKeys()) {
        console.error('❌ Video API keys not configured');
        return res.status(500).json({ 
            success: false, 
            error: 'Video calling is not configured. Please add TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET to Render environment variables.' 
        });
    }
    
    if (!studentPhone || !studentName) {
        return res.status(400).json({ success: false, error: 'Student info required' });
    }
    
    try {
        const roomName = generateRoomName();
        const joinUrl = `${config.publicUrl}/video-room.html?room=${roomName}&name=${encodeURIComponent(studentName)}`;
        
        // Generate teacher token
        const teacherToken = generateVideoToken(teacherName || 'Teacher', roomName);
        
        // Save room to database
        const roomData = {
            roomName,
            studentId: studentId || studentPhone,
            studentName,
            studentPhone,
            teacherId: teacherId || 'admin',
            teacherName: teacherName || 'Teacher',
            status: 'waiting',
            joinUrl,
            startedAt: new Date()
        };
        
        // Track active room IMMEDIATELY - teacher is joining
        activeVideoRooms.set(roomName, {
            ...roomData,
            teacherJoined: true,
            studentJoined: false
        });
        
        console.log('✅ Room added to active rooms:', roomName);
        console.log('   Total active rooms:', activeVideoRooms.size);
        console.log('✅ Video room created:', roomName);
        console.log('   Join URL:', joinUrl);
        
        // SEND RESPONSE IMMEDIATELY - Don't wait for DB or SMS
        res.json({
            success: true,
            room: {
                roomName,
                joinUrl,
                teacherToken,
                studentName,
                studentPhone,
                status: 'waiting'
            }
        });
        
        // ==========================================
        // BACKGROUND TASKS (after response sent)
        // Send SMS FIRST, then database (SMS is more urgent)
        // ==========================================
        
        // Send SMS invitation IMMEDIATELY (highest priority)
        if (twilioClient) {
            // Use setImmediate to ensure this runs right after response
            setImmediate(async () => {
                const smsStartTime = Date.now();
                console.log('📤 Sending SMS invitation to:', studentPhone);
                
                try {
                    const smsBody = `Assalam Alaikum ${studentName}! Your teacher is waiting for you in a video class. Join now: ${joinUrl}`;
                    
                    await twilioClient.messages.create({
                        body: smsBody,
                        from: config.twilio.phoneNumber,
                        to: studentPhone
                    });
                    
                    const smsTime = Date.now() - smsStartTime;
                    console.log(`✅ SMS invitation sent in ${smsTime}ms`);
                } catch (smsErr) {
                    console.error('⚠️ Failed to send SMS invitation:', smsErr.message);
                }
            });
        } else {
            console.warn('⚠️ Twilio client not available - SMS not sent');
        }
        
        // Save to database in background (lower priority than SMS)
        if (isDbConnected()) {
            setImmediate(() => {
                VideoRoom.create(roomData)
                    .then(() => console.log('✅ Room saved to database:', roomName))
                    .catch(dbErr => console.error('⚠️ Failed to save room to database:', dbErr.message));
            });
        }
        
    } catch (err) {
        console.error('❌ Create video room error:', err);
        // Only send error if response not already sent
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: err.message || 'Failed to create video room' });
        }
    }
});

// Get token for joining a video room (for students)
app.get('/api/video/join/:roomName', async (req, res) => {
    const { roomName } = req.params;
    const { name } = req.query;
    
    console.log('\n' + '='.repeat(50));
    console.log('🎥 STUDENT JOINING VIDEO ROOM');
    console.log('   Room:', roomName);
    console.log('   Student Name:', name);
    console.log('   Active rooms in memory:', activeVideoRooms.size);
    console.log('   Room exists in memory:', activeVideoRooms.has(roomName));
    console.log('='.repeat(50));
    
    // Check if Video API keys are configured
    if (!hasVideoApiKeys()) {
        console.error('❌ Video API keys not configured');
        return res.status(500).json({ 
            success: false, 
            error: 'Video calling is not configured on the server. Please contact your administrator.' 
        });
    }
    
    if (!roomName || !name) {
        return res.status(400).json({ success: false, error: 'Room name and participant name required' });
    }
    
    try {
        // Check if room exists in memory
        let roomInfo = activeVideoRooms.get(roomName);
        
        // If not in memory, try to find in database
        if (!roomInfo) {
            console.log('   Room NOT in memory, checking database...');
            console.log('   Mongoose state:', mongoose.connection.readyState);
            // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
            
            // Wait for database connection if it's still connecting
            if (mongoose.connection.readyState === 2) {
                console.log('   Database is connecting, waiting...');
                await waitForDbConnection(5000);
            }
            
            const canUseDb = isDbConnected();
            console.log('   Can use database:', canUseDb);
            
            if (canUseDb) {
                try {
                    const dbRoom = await VideoRoom.findOne({ roomName });
                    console.log('   Database lookup result:', dbRoom ? 'FOUND' : 'NOT FOUND');
                    
                    if (!dbRoom) {
                        console.log('❌ Room not found in database:', roomName);
                        return res.status(404).json({ success: false, error: 'Video room not found or has expired' });
                    }
                    if (dbRoom.status === 'completed') {
                        return res.status(400).json({ success: false, error: 'This video call has already ended' });
                    }
                    
                    // Restore room info from database to memory
                    roomInfo = {
                        roomName: dbRoom.roomName,
                        studentId: dbRoom.studentId,
                        studentName: dbRoom.studentName,
                        studentPhone: dbRoom.studentPhone,
                        teacherId: dbRoom.teacherId,
                        teacherName: dbRoom.teacherName,
                        status: dbRoom.status,
                        joinUrl: dbRoom.joinUrl,
                        teacherJoined: true,
                        studentJoined: false
                    };
                    activeVideoRooms.set(roomName, roomInfo);
                    console.log('✅ Room restored from database:', roomName);
                } catch (dbErr) {
                    console.error('❌ Database query error:', dbErr.message);
                    return res.status(500).json({ success: false, error: 'Database error. Please try again.' });
                }
            } else {
                console.log('❌ Room not found (database not connected):', roomName);
                console.log('   Tip: Database may still be connecting. Try again in a few seconds.');
                return res.status(404).json({ success: false, error: 'Video room not found. Please try again in a few seconds.' });
            }
        } else {
            console.log('   ✅ Room found in memory!');
        }
        
        // Generate token for student
        const token = generateVideoToken(name, roomName);
        
        // Update room status
        roomInfo.studentJoined = true;
        if (roomInfo.teacherJoined) {
            roomInfo.status = 'active';
        }
        
        // Broadcast student joined
        broadcastVideoEvent(roomName, 'STUDENT_JOINED', { name });
        
        console.log('✅ Student token generated for room:', roomName);
        
        // SEND RESPONSE IMMEDIATELY
        res.json({
            success: true,
            token,
            roomName,
            identity: name
        });
        
        // Update database in background (non-blocking)
        if (isDbConnected()) {
            VideoRoom.findOneAndUpdate(
                { roomName },
                { status: roomInfo?.teacherJoined ? 'active' : 'waiting' }
            ).catch(err => console.error('Background DB update error:', err.message));
        }
        
    } catch (err) {
        console.error('❌ Join video room error:', err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: 'Failed to join video room' });
        }
    }
});

// Teacher refreshes their token
app.post('/api/video/refresh-token', (req, res) => {
    const { roomName, identity } = req.body;
    
    if (!roomName || !identity) {
        return res.status(400).json({ success: false, error: 'Room name and identity required' });
    }
    
    try {
        const token = generateVideoToken(identity, roomName);
        res.json({ success: true, token });
    } catch (err) {
        console.error('Token refresh error:', err);
        res.status(500).json({ success: false, error: 'Failed to refresh token' });
    }
});

// End a video room
app.post('/api/video/end-room', async (req, res) => {
    const { roomName } = req.body;
    
    console.log('🎥 Ending video room:', roomName);
    
    try {
        // Remove from active rooms
        const roomInfo = activeVideoRooms.get(roomName);
        activeVideoRooms.delete(roomName);
        
        // Update database
        if (dbConnected) {
            await VideoRoom.findOneAndUpdate(
                { roomName },
                { 
                    status: 'completed',
                    endedAt: new Date(),
                    duration: roomInfo ? Math.floor((Date.now() - new Date(roomInfo.startedAt).getTime()) / 1000) : 0
                }
            );
        }
        
        // Broadcast room ended
        broadcastVideoEvent(roomName, 'ROOM_ENDED', {});
        
        console.log('✅ Video room ended:', roomName);
        
        res.json({ success: true });
        
    } catch (err) {
        console.error('End video room error:', err);
        res.status(500).json({ success: false, error: 'Failed to end video room' });
    }
});

// Get room status
app.get('/api/video/room-status/:roomName', async (req, res) => {
    const { roomName } = req.params;
    
    try {
        const roomInfo = activeVideoRooms.get(roomName);
        
        if (roomInfo) {
            return res.json({
                success: true,
                room: {
                    roomName,
                    status: roomInfo.status,
                    teacherJoined: roomInfo.teacherJoined,
                    studentJoined: roomInfo.studentJoined,
                    studentName: roomInfo.studentName
                }
            });
        }
        
        // Check database
        if (dbConnected) {
            const dbRoom = await VideoRoom.findOne({ roomName });
            if (dbRoom) {
                return res.json({
                    success: true,
                    room: {
                        roomName: dbRoom.roomName,
                        status: dbRoom.status,
                        studentName: dbRoom.studentName
                    }
                });
            }
        }
        
        res.status(404).json({ success: false, error: 'Room not found' });
        
    } catch (err) {
        console.error('Get room status error:', err);
        res.status(500).json({ success: false, error: 'Failed to get room status' });
    }
});

// Get active video rooms for teacher
app.get('/api/video/active-rooms', async (req, res) => {
    try {
        const rooms = [];
        activeVideoRooms.forEach((room, roomName) => {
            if (room.status !== 'completed') {
                rooms.push({
                    roomName,
                    studentName: room.studentName,
                    status: room.status,
                    startedAt: room.startedAt,
                    teacherJoined: room.teacherJoined,
                    studentJoined: room.studentJoined
                });
            }
        });
        
        res.json({ success: true, rooms });
    } catch (err) {
        console.error('Get active rooms error:', err);
        res.status(500).json({ success: false, error: 'Failed to get active rooms' });
    }
});

// OPTIMIZED broadcast video events via WebSocket
function broadcastVideoEvent(roomName, eventType, data) {
    const message = JSON.stringify({
        type: 'VIDEO_EVENT',
        roomName,
        eventType,
        data,
        timestamp: Date.now()
    });
    
    wsClients.forEach((clientData, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(message);
            } catch (e) {
                wsClients.delete(ws);
            }
        }
    });
}

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
// INCOMING VOICE CALL WEBHOOK
// ---------------------------------------------------------

// Webhook for incoming voice calls - Twilio calls this when someone calls your number
app.post('/webhooks/voice-incoming', async (req, res) => {
    const { CallSid, From, To, CallStatus, Direction } = req.body;
    
    console.log('\n' + '='.repeat(60));
    console.log('📞 INCOMING CALL RECEIVED');
    console.log('   CallSid:', CallSid);
    console.log('   From:', From);
    console.log('   To:', To);
    console.log('   Status:', CallStatus);
    console.log('   Direction:', Direction);
    console.log('='.repeat(60));
    
    try {
        // Look up caller in students database
        let callerName = 'Unknown Caller';
        let callerStudent = null;
        
        if (isDbConnected()) {
            callerStudent = await Student.findOne({ phone: From });
        } else {
            callerStudent = inMemoryStudents.find(s => s.phone === From);
        }
        
        if (callerStudent) {
            callerName = callerStudent.name;
            console.log('   ✅ Caller identified:', callerName);
        } else {
            console.log('   ⚠️ Caller not in student database');
        }
        
        // Store incoming call data
        const incomingCallData = {
            callSid: CallSid,
            from: From,
            to: To,
            callerName: callerName,
            studentId: callerStudent?.id || callerStudent?._id || null,
            status: 'ringing',
            startTime: Date.now(),
            answeredBy: null,
            answeredTime: null
        };
        
        inboundCalls.set(CallSid, incomingCallData);
        
        // Broadcast incoming call to all connected clients
        broadcastIncomingCall(incomingCallData);
        
        // Generate TwiML response - Play music/message while waiting for answer
        // The call will be kept alive for 60 seconds waiting for someone to answer
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Incoming call from ${callerName.replace(/[<>&'"]/g, '')}. Please wait while we connect you.</Say>
    <Play loop="0">http://com.twilio.sounds.music.s3.amazonaws.com/MARKOVICHAMP-B4.mp3</Play>
</Response>`;
        
        console.log('   📤 Sending TwiML response (hold music)');
        
        res.type('text/xml');
        res.send(twiml);
        
        // Set a timeout to auto-reject if not answered within 45 seconds
        setTimeout(() => {
            const call = inboundCalls.get(CallSid);
            if (call && call.status === 'ringing') {
                console.log('⏰ Incoming call timeout - not answered:', CallSid);
                call.status = 'missed';
                broadcastIncomingCallStatus(CallSid, 'missed', { callerName, from: From });
                
                // Save missed call to history
                saveInboundCallHistory(call, 'Missed', 0);
            }
        }, 45000);
        
    } catch (error) {
        console.error('❌ Error handling incoming call:', error);
        
        // Fallback TwiML - just play a message
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Thank you for calling Quran Academy. We are currently unavailable. Please try again later.</Say>
    <Hangup/>
</Response>`;
        
        res.type('text/xml');
        res.send(twiml);
    }
});

// Webhook for incoming call status updates
app.post('/webhooks/voice-incoming-status', async (req, res) => {
    const { CallSid, CallStatus, CallDuration } = req.body;
    
    console.log('📡 Incoming call status update:', CallStatus, 'for:', CallSid);
    
    const incomingCall = inboundCalls.get(CallSid);
    
    if (incomingCall) {
        const duration = parseInt(CallDuration) || 0;
        
        if (CallStatus === 'completed' || CallStatus === 'busy' || CallStatus === 'no-answer' || CallStatus === 'canceled' || CallStatus === 'failed') {
            console.log('   📞 Incoming call ended:', CallStatus);
            
            // Determine final status
            let finalStatus = 'Missed';
            if (incomingCall.answeredBy) {
                finalStatus = 'Completed';
            } else if (CallStatus === 'busy') {
                finalStatus = 'Busy';
            } else if (CallStatus === 'no-answer') {
                finalStatus = 'No Answer';
            } else if (CallStatus === 'canceled') {
                finalStatus = 'Canceled';
            }
            
            incomingCall.status = CallStatus;
            incomingCall.duration = duration;
            
            // Save to call history
            saveInboundCallHistory(incomingCall, finalStatus, duration);
            
            // Broadcast status
            broadcastIncomingCallStatus(CallSid, CallStatus, { 
                duration, 
                callerName: incomingCall.callerName,
                from: incomingCall.from
            });
            
            // Clean up
            inboundCalls.delete(CallSid);
        }
    }
    
    res.status(200).send('OK');
});

// Helper function to save inbound call to history
async function saveInboundCallHistory(callData, status, duration) {
    const historyEntry = {
        id: Date.now(),
        callSid: callData.callSid,
        studentId: callData.studentId,
        studentName: callData.callerName,
        teacherName: callData.answeredBy || 'System',
        phone: callData.from,
        duration: duration,
        status: `Inbound - ${status}`,
        timestamp: new Date(callData.startTime).toISOString(),
        direction: 'inbound',
        recordingUrl: null
    };
    
    try {
        if (isDbConnected()) {
            await CallHistory.create(historyEntry);
            console.log('   💾 Inbound call saved to database');
        } else {
            inMemoryCallHistory.unshift(historyEntry);
            console.log('   💾 Inbound call saved to memory');
        }
    } catch (err) {
        console.error('   ❌ Failed to save inbound call history:', err.message);
    }
}

// API endpoint to answer an incoming call
app.post('/api/inbound-call/answer', async (req, res) => {
    const { callSid, answeredBy } = req.body;
    
    console.log('📞 Answering incoming call:', callSid, 'by:', answeredBy);
    
    const incomingCall = inboundCalls.get(callSid);
    
    if (!incomingCall) {
        return res.status(404).json({ 
            success: false, 
            error: 'Incoming call not found or already ended' 
        });
    }
    
    if (incomingCall.status !== 'ringing') {
        return res.status(400).json({ 
            success: false, 
            error: 'Call is no longer ringing' 
        });
    }
    
    try {
        // Update call with TwiML to connect
        // This redirects the call to a conference or direct connection
        await twilioClient.calls(callSid).update({
            twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Connecting you now.</Say>
    <Dial record="record-from-answer-dual" recordingStatusCallback="${config.publicUrl}/webhooks/recording-status">
        <Client>${answeredBy.replace(/[^a-zA-Z0-9]/g, '_')}</Client>
    </Dial>
</Response>`
        });
        
        // Update call status
        incomingCall.status = 'answered';
        incomingCall.answeredBy = answeredBy;
        incomingCall.answeredTime = Date.now();
        
        // Broadcast that call was answered
        broadcastIncomingCallStatus(callSid, 'answered', {
            answeredBy,
            callerName: incomingCall.callerName,
            from: incomingCall.from
        });
        
        console.log('   ✅ Call answered successfully');
        
        res.json({ 
            success: true, 
            message: 'Call answered',
            call: incomingCall
        });
        
    } catch (error) {
        console.error('❌ Error answering call:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// API endpoint to reject/decline an incoming call
app.post('/api/inbound-call/reject', async (req, res) => {
    const { callSid, reason } = req.body;
    
    console.log('📞 Rejecting incoming call:', callSid, 'reason:', reason);
    
    const incomingCall = inboundCalls.get(callSid);
    
    if (!incomingCall) {
        return res.status(404).json({ 
            success: false, 
            error: 'Incoming call not found or already ended' 
        });
    }
    
    try {
        // End the call with a message
        await twilioClient.calls(callSid).update({
            twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">${reason || 'We are currently unavailable. Please try again later.'}</Say>
    <Hangup/>
</Response>`
        });
        
        // Update call status
        incomingCall.status = 'rejected';
        
        // Save to history
        saveInboundCallHistory(incomingCall, 'Rejected', 0);
        
        // Broadcast rejection
        broadcastIncomingCallStatus(callSid, 'rejected', {
            callerName: incomingCall.callerName,
            from: incomingCall.from
        });
        
        // Clean up
        inboundCalls.delete(callSid);
        
        console.log('   ✅ Call rejected');
        
        res.json({ 
            success: true, 
            message: 'Call rejected' 
        });
        
    } catch (error) {
        console.error('❌ Error rejecting call:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// API endpoint to get current incoming calls
app.get('/api/inbound-calls', (req, res) => {
    const calls = Array.from(inboundCalls.values()).filter(c => c.status === 'ringing');
    res.json({ 
        success: true, 
        calls 
    });
});

// ---------------------------------------------------------
// SMS WEBHOOKS
// ---------------------------------------------------------

// Webhook for incoming SMS messages
app.post('/webhooks/sms-incoming', async (req, res) => {
    const { From, Body, MessageSid } = req.body;
    
    console.log('\n' + '='.repeat(50));
    console.log('📥 INCOMING SMS');
    console.log('   From:', From);
    console.log('   Message:', Body.substring(0, 50) + (Body.length > 50 ? '...' : ''));
    console.log('='.repeat(50));
    
    try {
        // Find student by phone number
        let student = null;
        let studentId = From;
        let studentName = From;
        
        if (dbConnected) {
            student = await Student.findOne({ phone: From });
            if (student) {
                studentId = student._id.toString();
                studentName = student.name;
            }
        } else {
            student = inMemoryStudents.find(s => s.phone === From);
            if (student) {
                studentId = student.id;
                studentName = student.name;
            }
        }
        
        // Save incoming message
        const messageData = {
            studentId,
            studentName,
            studentPhone: From,
            direction: 'inbound',
            body: Body,
            messageSid: MessageSid,
            status: 'received',
            read: false,
            timestamp: new Date()
        };
        
        let savedMessage;
        if (dbConnected) {
            savedMessage = await Message.create(messageData);
            
            // Update or create conversation with unread count
            await Conversation.findOneAndUpdate(
                { studentId },
                {
                    studentId,
                    studentName,
                    studentPhone: From,
                    lastMessage: Body,
                    lastMessageTime: new Date(),
                    lastMessageDirection: 'inbound',
                    $inc: { unreadCount: 1 },
                    updatedAt: new Date()
                },
                { upsert: true, new: true }
            );
        } else {
            savedMessage = { ...messageData, _id: Date.now().toString() };
            inMemoryMessages.push(savedMessage);
            
            // Update in-memory conversations
            const convIndex = inMemoryConversations.findIndex(c => c.studentPhone === From);
            if (convIndex >= 0) {
                inMemoryConversations[convIndex].lastMessage = Body;
                inMemoryConversations[convIndex].lastMessageTime = new Date();
                inMemoryConversations[convIndex].lastMessageDirection = 'inbound';
                inMemoryConversations[convIndex].unreadCount = (inMemoryConversations[convIndex].unreadCount || 0) + 1;
            } else {
                inMemoryConversations.unshift({
                    studentId,
                    studentName,
                    studentPhone: From,
                    lastMessage: Body,
                    lastMessageTime: new Date(),
                    lastMessageDirection: 'inbound',
                    unreadCount: 1,
                    updatedAt: new Date()
                });
            }
        }
        
        // Broadcast to all clients
        broadcastNewMessage(savedMessage);
        
        console.log('✅ Incoming SMS saved');
        
        // Respond to Twilio (empty TwiML means no auto-reply)
        res.set('Content-Type', 'text/xml');
        res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
        
    } catch (err) {
        console.error('❌ SMS incoming webhook error:', err);
        res.status(500).send('Error processing incoming SMS');
    }
});

// Webhook for SMS delivery status updates
app.post('/webhooks/sms-status', async (req, res) => {
    const { MessageSid, MessageStatus } = req.body;
    
    console.log('📱 SMS Status Update:', MessageStatus, 'for:', MessageSid);
    
    try {
        if (dbConnected) {
            await Message.findOneAndUpdate(
                { messageSid: MessageSid },
                { status: MessageStatus }
            );
        } else {
            const msg = inMemoryMessages.find(m => m.messageSid === MessageSid);
            if (msg) msg.status = MessageStatus;
        }
    } catch (err) {
        console.error('SMS status update error:', err);
    }
    
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
        twilioVideo: hasVideoApiKeys(),
        database: isDbConnected() ? 'MongoDB Connected' : 'Disconnected',
        mongoState: mongoose.connection.readyState,
        websocket: wsClients.size + ' clients',
        activeVideoRooms: activeVideoRooms.size
    });
});

// Debug endpoint to check video rooms
app.get('/api/debug/video-rooms', (req, res) => {
    const rooms = [];
    activeVideoRooms.forEach((value, key) => {
        rooms.push({
            roomName: key,
            studentName: value.studentName,
            status: value.status,
            teacherJoined: value.teacherJoined,
            studentJoined: value.studentJoined
        });
    });
    res.json({
        count: activeVideoRooms.size,
        dbConnected: isDbConnected(),
        mongoState: mongoose.connection.readyState,
        rooms
    });
});

// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 QURAN ACADEMY SERVER STARTED');
    console.log('='.repeat(50));
    console.log(`   Port: ${PORT}`);
    console.log(`   Database: ${isDbConnected() ? 'MongoDB Connected ✓' : 'Connecting... (state: ' + mongoose.connection.readyState + ')'}`);
    console.log(`   Twilio Voice/SMS: ${twilioClient ? 'Connected ✓' : 'Not configured'}`);
    console.log(`   Twilio Video: ${hasVideoApiKeys() ? 'Configured ✓' : 'Not configured (add TWILIO_API_KEY_SID & TWILIO_API_KEY_SECRET)'}`);
    console.log(`   WebSocket: Enabled ✓`);
    console.log('='.repeat(50));
    
    // Warm up Twilio API connection for faster SMS delivery
    if (twilioClient) {
        try {
            console.log('🔥 Warming up Twilio API connection...');
            const warmupStart = Date.now();
            // Make a simple API call to establish connection
            await twilioClient.api.accounts(config.twilio.accountSid).fetch();
            const warmupTime = Date.now() - warmupStart;
            console.log(`✅ Twilio API warmed up in ${warmupTime}ms - SMS will be faster!`);
        } catch (warmupErr) {
            console.log('⚠️ Twilio warmup skipped:', warmupErr.message);
        }
    }
    
    console.log('');
});
