#!/usr/bin/env node

/**
 * Diagnose why the model is returning 0s after switching to CDN URLs
 */

require('dotenv').config();
const axios = require('axios');

console.log('╔══════════════════════════════════════════════════════════════════════════╗');
console.log('║            Diagnosing Model Image Issue (0 predictions)                 ║');
console.log('╚══════════════════════════════════════════════════════════════════════════╝\n');

async function diagnose() {
  console.log('🔍 Potential Issues:\n');
  console.log('1. WebP format not supported by AI model');
  console.log('2. AI model cannot access external CDN URLs');
  console.log('3. CORS or network restrictions');
  console.log('4. Image format/encoding issues\n');
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('📸 Testing Image URLs:\n');
  
  const testUrls = [
    { name: 'Gate 1 (WebP)', url: process.env.CCTV_GATE_1_URL },
    { name: 'Default Placeholder (JPG)', url: 'https://vkaongvemnzkvvvxgduk.supabase.co/storage/v1/object/public/congestion_image/medium_congested.jpg' }
  ];
  
  for (const test of testUrls) {
    if (!test.url) {
      console.log(`⚠️  ${test.name}: URL not configured\n`);
      continue;
    }
    
    try {
      console.log(`Testing: ${test.name}`);
      console.log(`URL: ${test.url}`);
      
      const response = await axios.head(test.url, { timeout: 5000 });
      const contentType = response.headers['content-type'];
      const contentLength = response.headers['content-length'];
      
      console.log(`✅ Accessible: HTTP ${response.status}`);
      console.log(`   Content-Type: ${contentType}`);
      console.log(`   Size: ${contentLength} bytes`);
      
      // Check format
      if (contentType.includes('webp')) {
        console.log('   ⚠️  Format: WebP - May not be supported by AI model!');
      } else if (contentType.includes('jpeg') || contentType.includes('jpg')) {
        console.log('   ✅ Format: JPEG - Should work');
      }
      
      console.log();
    } catch (error) {
      console.log(`❌ Error: ${error.message}\n`);
    }
  }
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('🎯 Root Cause Analysis:\n');
  
  console.log('The AI model is likely failing because:\n');
  console.log('1. ❌ WebP format is NOT supported by the model');
  console.log('   → Model expects JPEG/PNG format');
  console.log('   → SkylineWebcams serves WebP (modern format)');
  console.log('   → Model cannot decode WebP → returns 0s\n');
  
  console.log('2. ❌ Model cannot access external CDN URLs');
  console.log('   → Model might only accept local/S3 URLs');
  console.log('   → External CDN may be blocked by firewall\n');
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('💡 Solutions:\n');
  
  console.log('Option A: Convert WebP to JPEG before sending to model ⭐ (Recommended)');
  console.log('  → Download WebP from CDN');
  console.log('  → Convert to JPEG in memory');
  console.log('  → Upload JPEG to S3');
  console.log('  → Send S3 URL to model\n');
  
  console.log('Option B: Use CCTV cron with conversion');
  console.log('  → Enable CCTV cron (ENABLE_CCTV_CRON=true)');
  console.log('  → Cron downloads WebP every 3 minutes');
  console.log('  → Converts to JPEG and uploads to S3');
  console.log('  → Model uses S3 URLs\n');
  
  console.log('Option C: Find JPEG alternatives to WebP');
  console.log('  → Some webcam services offer JPEG snapshots');
  console.log('  → Less efficient but may work directly\n');
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('🔧 Recommended Fix:\n');
  console.log('Enable CCTV cron with format conversion:\n');
  console.log('1. Set ENABLE_CCTV_CRON=true in .env');
  console.log('2. Ensure cctvService converts WebP → JPEG');
  console.log('3. Restart server');
  console.log('4. Wait 3 minutes for first snapshot');
  console.log('5. Predictions will use S3 JPEG URLs\n');
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

diagnose().catch(console.error);

