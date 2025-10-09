#!/usr/bin/env node

/**
 * Test CDN Configuration
 * Verifies that predictionService will correctly use CDN URLs
 */

require('dotenv').config();

console.log('╔══════════════════════════════════════════════════════════════════════════╗');
console.log('║               Testing CDN URL Configuration                              ║');
console.log('╚══════════════════════════════════════════════════════════════════════════╝\n');

// Test environment variables
console.log('📋 Environment Variables Check:\n');

const gates = ['1', 'A', 'B', 'C', 'D'];
const results = [];

gates.forEach(gateId => {
  const envKey = `CCTV_GATE_${gateId}_URL`;
  const url = process.env[envKey];
  
  if (url) {
    console.log(`✅ ${envKey}`);
    console.log(`   → ${url}`);
    results.push({ gateId, envKey, url, status: 'configured' });
  } else {
    console.log(`❌ ${envKey} - NOT SET`);
    results.push({ gateId, envKey, url: null, status: 'missing' });
  }
  console.log();
});

// Check CCTV cron status
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('🔄 CCTV Cron Status:\n');
const cctvCronEnabled = process.env.ENABLE_CCTV_CRON === 'true';
console.log(`   ENABLE_CCTV_CRON = ${process.env.ENABLE_CCTV_CRON || 'not set'}`);
if (!cctvCronEnabled) {
  console.log('   ✅ Correct! CCTV cron is disabled (using direct CDN)');
} else {
  console.log('   ⚠️  Warning: CCTV cron is enabled (not needed for direct CDN)');
}

// Simulate predictionService logic
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('🎯 Simulating Prediction Service Logic:\n');

gates.forEach(gateId => {
  const envKey = `CCTV_GATE_${gateId}_URL`;
  const cdnUrl = process.env[envKey];
  
  let imagePath;
  let source;
  
  // Simulate the logic in predictionService.js
  const webcamImage = null; // Assuming no webcamImages (no CCTV cron)
  
  if (webcamImage?.imageUrl) {
    imagePath = webcamImage.imageUrl;
    source = 'S3 (webcamImages)';
  } else if (cdnUrl) {
    imagePath = cdnUrl;
    source = 'CDN (environment)';
  } else {
    imagePath = 'https://...default_placeholder...';
    source = 'Default placeholder';
  }
  
  console.log(`Gate ${gateId}:`);
  console.log(`   Source: ${source}`);
  console.log(`   Path:   ${imagePath}`);
  console.log();
});

// Test URLs accessibility
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('🧪 Testing URL Accessibility:\n');

const axios = require('axios');

async function testUrls() {
  for (const result of results) {
    if (result.url) {
      try {
        const response = await axios.head(result.url, { timeout: 5000 });
        console.log(`✅ Gate ${result.gateId}: HTTP ${response.status}`);
      } catch (error) {
        console.log(`❌ Gate ${result.gateId}: ${error.message}`);
      }
    }
  }
  
  // Summary
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('📊 Summary:\n');
  
  const configured = results.filter(r => r.status === 'configured').length;
  const missing = results.filter(r => r.status === 'missing').length;
  
  console.log(`   Configured Gates: ${configured}/${gates.length}`);
  console.log(`   Missing Gates:    ${missing}/${gates.length}`);
  
  if (configured === gates.length) {
    console.log('\n✅ All gates configured correctly!');
    console.log('   Your prediction service will use real Rome crowd images.\n');
  } else {
    console.log('\n⚠️  Some gates are not configured.');
    console.log('   Add missing environment variables to .env\n');
  }
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('🚀 Next Steps:\n');
  console.log('   1. Restart server: pkill -f "node.*server.js" && node src/server.js');
  console.log('   2. Trigger prediction: curl -X POST http://localhost:3000/api/v1/prediction/EVENT_ID');
  console.log('   3. Check results for real incident detection!\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

testUrls().catch(console.error);

