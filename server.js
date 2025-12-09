// ========================================
// QURAN ACADEMY CALLING SERVER
// With WebSocket Real-Time Updates
// ========================================

const express = require('express');
const twilio = require('twilio');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
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
};

// Validate Twilio credentials
if (!config.twilio.accountSid || !config.twilio.authToken || !config.twilio.phoneNumber) {
    console.error('❌ ERROR: Twilio credentials not configured!');
} else {
    console.log('✅ Twilio CONFIGURED ✓');
    console.log('   Phone:', config.twilio.phoneNumber);
}

// Initialize Twilio client
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
// IN-MEMORY CALL STORAGE
// ---------------------------------------------------------
const activeCalls = new Map();
const recordingsMap = new Map(); // Store recordings separately for history lookups

// ---------------------------------------------------------
// WEBSOCKET MANAGEMENT
// ---------------------------------------------------------
const wsClients = new Set();

wss.on('connection', (ws) => {
    console.log('🔌 WebSocket client connected');
    wsClients.add(ws);
    
    // Send welcome message
    ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Real-time updates enabled' }));
    
    // Handle ping/pong for keepalive
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'PING') {
                ws.send(JSON.stringify({ type: 'PONG' }));
            }
            // Subscribe to specific call updates
            if (data.type === 'SUBSCRIBE_CALL' && data.callSid) {
                ws.subscribedCallSid = data.callSid;
                console.log('📡 Client subscribed to call:', data.callSid);
            }
        } catch (e) {
            // Ignore invalid messages
        }
    });
    
    ws.on('close', () => {
        console.log('🔌 WebSocket client disconnected');
        wsClients.delete(ws);
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
        wsClients.delete(ws);
    });
});

// Broadcast call status to all connected clients
function broadcastCallStatus(callSid, status, duration, recordingUrl) {
    const message = JSON.stringify({
        type: 'CALL_STATUS_UPDATE',
        callSid,
        status,
        duration,
        recordingUrl,
        timestamp: Date.now()
    });
    
    console.log(`📢 Broadcasting to ${wsClients.size} clients:`, status);
    
    wsClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            // Send to all clients or only subscribed ones
            if (!client.subscribedCallSid || client.subscribedCallSid === callSid) {
                client.send(message);
            }
        }
    });
}

// ---------------------------------------------------------
// API ENDPOINTS
// ---------------------------------------------------------

// POST /make-call - Initiate a call
app.post('/make-call', async (req, res) => {
    const { to, name, record } = req.body;
    
    console.log('\n' + '='.repeat(50));
    console.log('📞 INITIATING CALL');
    console.log('   To:', to);
    console.log('   Name:', name);
    console.log('   Record:', record);
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
            record: true, // Always record calls
            recordingStatusCallback: `${config.publicUrl}/webhooks/recording-status`,
            recordingStatusCallbackEvent: ['completed'],
            statusCallback: `${config.publicUrl}/webhooks/call-status`,
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            statusCallbackMethod: 'POST'
        });
        
        // Store call info
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
        
        // Broadcast call initiated
        broadcastCallStatus(call.sid, 'initiated', 0, null);
        
        res.json({
            success: true,
            callSid: call.sid,
            message: 'Call initiated successfully'
        });
        
    } catch (error) {
        console.error('❌ Twilio Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// GET /call-status/:sid - Get call status
// ALWAYS checks Twilio directly for active calls to catch hangups immediately
app.get('/call-status/:sid', async (req, res) => {
    const { sid } = req.params;
    
    const cachedCall = activeCalls.get(sid);
    
    // For active/in-progress calls, ALWAYS check Twilio directly
    // This catches hangups faster than waiting for webhooks
    if (twilioClient && cachedCall && (cachedCall.status === 'in-progress' || cachedCall.status === 'ringing' || cachedCall.status === 'queued' || cachedCall.status === 'initiated')) {
        try {
            const call = await twilioClient.calls(sid).fetch();
            const twilioStatus = call.status;
            
            // If Twilio shows a terminal status, update cache and broadcast immediately
            const terminalStatuses = ['completed', 'busy', 'no-answer', 'canceled', 'failed'];
            if (terminalStatuses.includes(twilioStatus) && !terminalStatuses.includes(cachedCall.status)) {
                console.log('🔴 DETECTED: Call ended via Twilio API check!', twilioStatus);
                
                const duration = parseInt(call.duration) || cachedCall.duration || 0;
                cachedCall.status = twilioStatus;
                cachedCall.duration = duration;
                
                // Broadcast immediately!
                broadcastCallStatus(sid, twilioStatus, duration, cachedCall.recordingUrl);
                
                return res.json({
                    status: twilioStatus,
                    duration: duration,
                    recordingUrl: cachedCall.recordingUrl
                });
            }
            
            // Update cache with latest Twilio status
            if (twilioStatus !== cachedCall.status) {
                cachedCall.status = twilioStatus;
                if (twilioStatus === 'in-progress' && !cachedCall.answeredTime) {
                    cachedCall.answeredTime = Date.now();
                }
            }
            
            // Calculate duration if call is active
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
            // Fall through to cache
        }
    }
    
    // Return cached status for non-active calls
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
    
    // If not in cache, try to fetch from Twilio
    if (!twilioClient) {
        return res.status(404).json({ error: 'Call not found' });
    }
    
    try {
        const call = await twilioClient.calls(sid).fetch();
        const status = call.status;
        const duration = parseInt(call.duration) || 0;
        
        console.log('📊 Twilio status:', sid.substring(0, 10) + '...', '→', status);
        
        res.json({
            status: status,
            duration: duration,
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
    
    console.log('✋ HANGUP requested for:', sid);
    
    if (!sid) {
        return res.status(400).json({ success: false, error: 'Call SID required' });
    }
    
    const cachedCall = activeCalls.get(sid);
    let duration = 0;
    
    if (cachedCall && cachedCall.answeredTime) {
        duration = Math.floor((Date.now() - cachedCall.answeredTime) / 1000);
    }
    
    if (!twilioClient) {
        if (cachedCall) {
            cachedCall.status = 'completed';
            cachedCall.duration = duration;
        }
        // Broadcast even without Twilio
        broadcastCallStatus(sid, 'completed', duration, null);
        return res.json({ success: true, status: 'completed', duration });
    }
    
    try {
        await twilioClient.calls(sid).update({ status: 'completed' });
        
        if (cachedCall) {
            cachedCall.status = 'completed';
            cachedCall.duration = duration;
        }
        
        console.log('✅ Call terminated, duration:', duration, 's');
        
        // Broadcast call ended
        broadcastCallStatus(sid, 'completed', duration, cachedCall?.recordingUrl || null);
        
        res.json({
            success: true,
            status: 'completed',
            duration: duration,
            recordingUrl: cachedCall?.recordingUrl || null
        });
        
    } catch (error) {
        console.error('❌ Hangup error:', error.message);
        if (error.code === 20404) {
            broadcastCallStatus(sid, 'completed', duration, null);
            return res.json({ success: true, status: 'completed', duration });
        }
        res.status(500).json({ success: false, error: error.message });
    }
});

// ---------------------------------------------------------
// TWIML ENDPOINTS - Voice instructions for calls
// ---------------------------------------------------------

// TwiML for outbound calls - This plays when the CALLEE answers
// The actual connection happens through Twilio's call bridging
app.post('/twiml/outbound', (req, res) => {
    const { To, From, CallSid } = req.body;
    console.log('📞 TwiML requested');
    console.log('   CallSid:', CallSid);
    console.log('   To:', To);
    console.log('   From:', From);
    
    // This TwiML plays to the person being called (student)
    // It announces the call and then keeps the line open
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">You have a call from Quran Academy. Please hold.</Say>
    <Pause length="120"/>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
});

// TwiML that keeps the call open for conversation
app.all('/twiml/conference', (req, res) => {
    console.log('📞 TwiML conference requested');
    
    // Use a conference to allow real two-way conversation
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
// RECORDING WEBHOOK - Captures recording URL when ready
// ---------------------------------------------------------
app.post('/webhooks/recording-status', async (req, res) => {
    const { 
        RecordingSid, 
        RecordingUrl, 
        RecordingStatus, 
        RecordingDuration,
        CallSid 
    } = req.body;
    
    console.log('\n' + '='.repeat(50));
    console.log('🎙️ RECORDING WEBHOOK RECEIVED');
    console.log('   Recording SID:', RecordingSid);
    console.log('   Call SID:', CallSid);
    console.log('   Status:', RecordingStatus);
    console.log('   Duration:', RecordingDuration);
    console.log('   URL:', RecordingUrl);
    console.log('='.repeat(50));
    
    if (RecordingStatus === 'completed' && RecordingUrl) {
        // Add .mp3 extension for playback
        const playableUrl = RecordingUrl + '.mp3';
        
        // Update our local cache
        const cachedCall = activeCalls.get(CallSid);
        if (cachedCall) {
            cachedCall.recordingUrl = playableUrl;
            cachedCall.recordingSid = RecordingSid;
            console.log('✅ Recording URL saved for call:', CallSid);
        }
        
        // Store recording in a separate map for history lookups
        recordingsMap.set(CallSid, {
            sid: RecordingSid,
            url: playableUrl,
            duration: parseInt(RecordingDuration) || 0,
            timestamp: Date.now()
        });
        
        // Broadcast recording available
        broadcastCallStatus(CallSid, 'recording-ready', parseInt(RecordingDuration) || 0, playableUrl);
    }
    
    res.status(200).send('OK');
});

// GET /recording/:callSid - Get recording for a call
app.get('/recording/:callSid', async (req, res) => {
    const { callSid } = req.params;
    
    console.log('🎙️ Recording requested for call:', callSid);
    
    // Check local cache first
    const cachedRecording = recordingsMap.get(callSid);
    if (cachedRecording && cachedRecording.url) {
        console.log('   ✅ Found in cache:', cachedRecording.url);
        return res.json({
            success: true,
            recordingUrl: cachedRecording.url,
            duration: cachedRecording.duration,
            source: 'cache'
        });
    }
    
    // Check active calls cache
    const cachedCall = activeCalls.get(callSid);
    if (cachedCall && cachedCall.recordingUrl) {
        console.log('   ✅ Found in active calls:', cachedCall.recordingUrl);
        return res.json({
            success: true,
            recordingUrl: cachedCall.recordingUrl,
            duration: cachedCall.duration,
            source: 'active-cache'
        });
    }
    
    // Try to fetch from Twilio API
    if (twilioClient) {
        try {
            console.log('   🔍 Searching Twilio API for recording...');
            const recordings = await twilioClient.recordings.list({
                callSid: callSid,
                limit: 1
            });
            
            if (recordings.length > 0) {
                const recording = recordings[0];
                const recordingUrl = `https://api.twilio.com${recording.uri.replace('.json', '.mp3')}`;
                
                console.log('   ✅ Found in Twilio API:', recordingUrl);
                console.log('   Duration:', recording.duration, 'seconds');
                
                // Cache it
                recordingsMap.set(callSid, {
                    sid: recording.sid,
                    url: recordingUrl,
                    duration: recording.duration,
                    timestamp: Date.now()
                });
                
                return res.json({
                    success: true,
                    recordingUrl: recordingUrl,
                    duration: recording.duration,
                    source: 'twilio-api'
                });
            } else {
                console.log('   ❌ No recording found in Twilio API');
                console.log('   This could mean:');
                console.log('   - The call was too short (< 1 second)');
                console.log('   - The call was not answered');
                console.log('   - Recording is still processing (try again in a few seconds)');
            }
        } catch (error) {
            console.error('   ❌ Error fetching from Twilio:', error.message);
        }
    } else {
        console.log('   ❌ Twilio client not configured');
    }
    
    console.log('   ❌ No recording found for call:', callSid);
    res.status(404).json({ 
        success: false, 
        error: 'Recording not found. The call may have been too short or is still processing.' 
    });
});

// GET /recording-audio/:callSid - Stream the actual audio file (proxy for Twilio)
app.get('/recording-audio/:callSid', async (req, res) => {
    const { callSid } = req.params;
    
    console.log('🎵 Audio stream requested for call:', callSid);
    
    try {
        // First, get the recording URL
        let recordingUrl = null;
        let recordingSid = null;
        
        // Check local cache
        const cachedRecording = recordingsMap.get(callSid);
        if (cachedRecording && cachedRecording.url) {
            recordingUrl = cachedRecording.url;
            recordingSid = cachedRecording.sid;
        }
        
        // Check active calls cache
        if (!recordingUrl) {
            const cachedCall = activeCalls.get(callSid);
            if (cachedCall && cachedCall.recordingUrl) {
                recordingUrl = cachedCall.recordingUrl;
                recordingSid = cachedCall.recordingSid;
            }
        }
        
        // Fetch from Twilio if not cached
        if (!recordingUrl && twilioClient) {
            const recordings = await twilioClient.recordings.list({
                callSid: callSid,
                limit: 1
            });
            
            if (recordings.length > 0) {
                const recording = recordings[0];
                recordingSid = recording.sid;
                recordingUrl = `https://api.twilio.com${recording.uri.replace('.json', '.mp3')}`;
                
                // Cache it
                recordingsMap.set(callSid, {
                    sid: recordingSid,
                    url: recordingUrl,
                    duration: recording.duration,
                    timestamp: Date.now()
                });
            }
        }
        
        if (!recordingUrl) {
            return res.status(404).json({ error: 'Recording not found' });
        }
        
        console.log('   Streaming from:', recordingUrl);
        
        // Fetch the audio from Twilio with authentication
        const authString = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
        
        const audioRequest = https.request(recordingUrl, {
            headers: {
                'Authorization': `Basic ${authString}`
            }
        }, (audioResponse) => {
            // Forward headers
            res.set('Content-Type', audioResponse.headers['content-type'] || 'audio/mpeg');
            if (audioResponse.headers['content-length']) {
                res.set('Content-Length', audioResponse.headers['content-length']);
            }
            res.set('Accept-Ranges', 'bytes');
            
            // Stream the audio
            audioResponse.pipe(res);
        });
        
        audioRequest.on('error', (err) => {
            console.error('   Error streaming audio:', err.message);
            res.status(500).json({ error: 'Failed to stream recording' });
        });
        
        audioRequest.end();
        
    } catch (error) {
        console.error('   Error in audio stream:', error.message);
        res.status(500).json({ error: 'Failed to stream recording' });
    }
});

// ---------------------------------------------------------
// TWILIO WEBHOOKS - Real-time status updates
// ---------------------------------------------------------
app.post('/webhooks/call-status', (req, res) => {
    const { CallSid, CallStatus, CallDuration, RecordingUrl } = req.body;
    
    console.log('\n' + '='.repeat(50));
    console.log('📡 TWILIO WEBHOOK RECEIVED');
    console.log('   SID:', CallSid);
    console.log('   Status:', CallStatus);
    console.log('   Duration:', CallDuration || 0);
    console.log('   Time:', new Date().toISOString());
    console.log('='.repeat(50));
    
    // Update our local cache
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
        
        // When call completes, try to fetch recording if not already available
        if (CallStatus === 'completed' && !cachedCall.recordingUrl && twilioClient) {
            // Fetch recording asynchronously
            setTimeout(async () => {
                try {
                    const recordings = await twilioClient.recordings.list({
                        callSid: CallSid,
                        limit: 1
                    });
                    
                    if (recordings.length > 0) {
                        const recording = recordings[0];
                        const recordingUrl = `https://api.twilio.com${recording.uri.replace('.json', '.mp3')}`;
                        
                        cachedCall.recordingUrl = recordingUrl;
                        recordingsMap.set(CallSid, {
                            sid: recording.sid,
                            url: recordingUrl,
                            duration: recording.duration,
                            timestamp: Date.now()
                        });
                        
                        console.log('✅ Recording fetched after call completed:', recordingUrl);
                        
                        // Broadcast recording available
                        broadcastCallStatus(CallSid, 'recording-ready', recording.duration, recordingUrl);
                    }
                } catch (err) {
                    console.error('Error fetching recording after call:', err.message);
                }
            }, 3000); // Wait 3 seconds for recording to be processed
        }
        
        // Clean up completed calls after 10 minutes (longer for recording retrieval)
        if (['completed', 'busy', 'no-answer', 'canceled', 'failed'].includes(CallStatus)) {
            setTimeout(() => activeCalls.delete(CallSid), 10 * 60 * 1000);
        }
    }
    
    // 🚀 BROADCAST IMMEDIATELY to all connected WebSocket clients
    broadcastCallStatus(CallSid, CallStatus, duration, RecordingUrl || cachedCall?.recordingUrl);
    
    
    res.status(200).send('OK');
});

// ---------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        twilio: twilioClient ? 'configured' : 'not configured',
        activeCalls: activeCalls.size,
        wsClients: wsClients.size,
        timestamp: new Date().toISOString()
    });
});

// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 QURAN ACADEMY SERVER (WebSocket Enabled)');
    console.log('='.repeat(50));
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
    console.log(`🌐 Public URL: ${config.publicUrl}`);
    console.log('='.repeat(50) + '\n');
});
