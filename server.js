// ========================================
// QURAN ACADEMY CALLING SERVER
// Save as: server.js
// ========================================

const express = require('express');
const twilio = require('twilio');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// 🔧 REPLACE WITH YOUR TWILIO CREDENTIALS:
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER; // Your Twilio phone number


// Check if all required environment variables are set
if (!accountSid || !authToken || !twilioPhoneNumber || !staffPhoneNumber) {
  console.error(
    'ERROR: Missing Twilio credentials. Please check your .env file and ensure all variables are set.'
  );
  process.exit(1);
}

const client = new Twilio(accountSid, authToken);

// ========================================
// HEALTH CHECK - Tests if server is running
// ========================================
app.get('/health', (req, res) => {
    console.log('✅ Health check received');
    res.json({ 
        status: 'Server is running!',
        twilioConfigured: true,
        timestamp: new Date().toISOString()
    });
});

// ========================================
// MAKE CALL - Makes real call via Twilio
// ========================================
app.post('/make-call', async (req, res) => {
    const { to, name } = req.body;

    console.log(`\n📞 Incoming call request for: ${name} (${to})`);

    if (!to) {
        return res.status(400).json({ 
            success: false,
            error: 'Phone number is required' 
        });
    }

    try {
        console.log(`🔄 Initiating call from ${TWILIO_PHONE_NUMBER} to ${to}...`);
        
        const call = await client.calls.create({
            url: 'http://demo.twilio.com/docs/voice.xml',
            to: to,
            from: TWILIO_PHONE_NUMBER,
            statusCallback: 'http://localhost:3000/call-status',
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
        });

        console.log(`✅ Call initiated successfully!`);
        console.log(`   Call SID: ${call.sid}`);
        console.log(`   Status: ${call.status}`);
        
        res.json({
            success: true,
            callSid: call.sid,
            message: `Calling ${name}...`,
            status: call.status
        });
    } catch (error) {
        console.error('❌ Call failed:', error.message);
        console.error('   Error code:', error.code);
        
        res.status(500).json({
            success: false,
            error: error.message,
            code: error.code
        });
    }
});

// ========================================
// CALL STATUS - Webhook for call updates
// ========================================
app.post('/call-status', (req, res) => {
    const { CallSid, CallStatus, CallDuration } = req.body;
    console.log(`📊 Call ${CallSid}: ${CallStatus}${CallDuration ? ` (${CallDuration}s)` : ''}`);
    res.sendStatus(200);
});

// ========================================
// START SERVER
// ========================================
const PORT = 3000;
app.listen(PORT, () => {
    console.clear();
    console.log(`
╔═══════════════════════════════════════════════╗
║   🕌 QURAN ACADEMY CALLING SERVER STARTED    ║
╚═══════════════════════════════════════════════╝

✅ Server Status: RUNNING
🌐 Server URL: http://localhost:${PORT}
📞 Ready to make calls!

⚙️  Configuration:
   • Account SID: ${TWILIO_ACCOUNT_SID.substring(0, 10)}...
   • Phone Number: ${TWILIO_PHONE_NUMBER}

📝 Next Steps:
   1. Keep this window open (don't close!)
   2. Open your web app
   3. Click "Test Connection"
   4. Should show: "✅ Connected!"

🔗 Test URL: http://localhost:${PORT}/health
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Server logs will appear below:
    `);
});

// Handle server errors
app.on('error', (error) => {
    console.error('❌ Server error:', error.message);
});

process.on('SIGINT', () => {
    console.log('\n\n👋 Server shutting down...');
    process.exit(0);
});