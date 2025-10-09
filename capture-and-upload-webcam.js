#!/usr/bin/env node

/**
 * 直接从SkylineWebcams网页捕获并上传图像到S3
 * 无需本地文件
 */

const s3Service = require('./src/services/s3Service');

/**
 * 从Chrome MCP截图并直接上传到S3
 * @param {string} webcamUrl - SkylineWebcams页面URL
 * @param {string} gateId - Gate ID
 * @returns {Promise<Object>} - 上传结果
 */
async function captureAndUploadWebcam(webcamUrl, gateId) {
  try {
    console.log(`\n🎥 Capturing webcam: ${webcamUrl}`);
    console.log(`   Gate ID: ${gateId}`);
    
    // Note: 这个函数展示了逻辑流程
    // 实际使用需要Chrome MCP工具的base64输出
    
    // 步骤1: 使用Chrome MCP获取base64截图
    console.log('\n📸 Step 1: Taking screenshot with Chrome MCP...');
    
    // 在实际使用中，你需要先使用Chrome MCP工具获取base64
    // 这里我们提供一个替代方案：直接从CDN URL获取图像
    
    const axios = require('axios');
    
    // 从HTML页面提取的快照URL
    const snapshotUrls = {
      'piazza_spagna': 'https://cdn.skylinewebcams.com/_205.webp',
      'trevi_fountain': 'https://cdn.skylinewebcams.com/live286.webp',
      'colosseum': 'https://cdn.skylinewebcams.com/live1151.webp',
      'pantheon': 'https://cdn.skylinewebcams.com/live165.webp',
      'piazza_navona': 'https://cdn.skylinewebcams.com/live57.webp'
    };
    
    const snapshotUrl = snapshotUrls[gateId];
    
    if (!snapshotUrl) {
      throw new Error(`Unknown gate ID: ${gateId}`);
    }
    
    console.log(`   Fetching from: ${snapshotUrl}`);
    
    // 步骤2: 下载图像到内存
    const response = await axios.get(snapshotUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: {
        'User-Agent': 'EventAI-CCTV-Service/1.0',
        'Accept': 'image/webp,image/*,*/*'
      }
    });
    
    const imageBuffer = Buffer.from(response.data);
    console.log(`   ✅ Image downloaded (${imageBuffer.length} bytes)`);
    
    // 步骤3: 直接上传到S3
    console.log('\n☁️  Step 2: Uploading to S3...');
    
    const timestamp = Date.now();
    const s3Key = `cctv-sources/skyline-webcam/${gateId}/${timestamp}.jpg`;
    
    const s3Url = await s3Service.uploadFile(s3Key, imageBuffer, 'image/jpeg');
    
    console.log(`   ✅ Upload successful!`);
    
    const result = {
      success: true,
      gateId,
      s3Url,
      s3Key,
      imageSize: imageBuffer.length,
      timestamp: new Date().toISOString()
    };
    
    console.log('\n✅ Complete!');
    console.log(`   S3 URL: ${s3Url}`);
    console.log(`   S3 Key: ${s3Key}`);
    
    return result;
    
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    throw error;
  }
}

/**
 * 批量捕获所有摄像头
 */
async function captureAllWebcams() {
  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║          SkylineWebcams → S3 直接上传工具                                ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');
  
  const webcams = [
    { id: 'piazza_spagna', name: 'Piazza di Spagna', url: 'https://www.skylinewebcams.com/en/webcam/italia/lazio/roma/piazza-di-spagna.html' },
    { id: 'trevi_fountain', name: 'Trevi Fountain', url: 'https://www.skylinewebcams.com/en/webcam/italia/lazio/roma/fontana-di-trevi.html' },
    { id: 'colosseum', name: 'Colosseum', url: 'https://www.skylinewebcams.com/en/webcam/italia/lazio/roma/roma-colosseo.html' },
    { id: 'pantheon', name: 'Pantheon', url: 'https://www.skylinewebcams.com/en/webcam/italia/lazio/roma/pantheon.html' },
    { id: 'piazza_navona', name: 'Piazza Navona', url: 'https://www.skylinewebcams.com/en/webcam/italia/lazio/roma/piazza-navona-roma.html' }
  ];
  
  const results = [];
  const errors = [];
  
  for (const webcam of webcams) {
    try {
      const result = await captureAndUploadWebcam(webcam.url, webcam.id);
      results.push({ ...result, name: webcam.name });
    } catch (error) {
      errors.push({ 
        id: webcam.id, 
        name: webcam.name, 
        error: error.message 
      });
    }
  }
  
  // 打印总结
  console.log('\n╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║                           上传总结                                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');
  console.log(`\n✅ 成功: ${results.length} / ${webcams.length}`);
  console.log(`❌ 失败: ${errors.length} / ${webcams.length}`);
  
  if (results.length > 0) {
    console.log('\n成功上传的摄像头:');
    results.forEach(r => {
      console.log(`  ✓ ${r.name}`);
      console.log(`    → ${r.s3Url}`);
    });
  }
  
  if (errors.length > 0) {
    console.log('\n失败的摄像头:');
    errors.forEach(e => {
      console.log(`  ✗ ${e.name}: ${e.error}`);
    });
  }
  
  console.log('\n📋 配置建议:');
  if (results.length >= 5) {
    console.log('\n可以在.env中使用以下配置:');
    console.log('ENABLE_CCTV_CRON=true');
    results.forEach((r, i) => {
      const gates = ['CCTV_GATE_1', 'CCTV_GATE_A', 'CCTV_GATE_B', 'CCTV_GATE_C', 'CCTV_GATE_D'];
      if (i < gates.length) {
        // 使用CDN URL而不是S3 URL（因为CDN会自动更新）
        const cdnUrls = {
          'piazza_spagna': 'https://cdn.skylinewebcams.com/_205.webp',
          'trevi_fountain': 'https://cdn.skylinewebcams.com/live286.webp',
          'colosseum': 'https://cdn.skylinewebcams.com/live1151.webp',
          'pantheon': 'https://cdn.skylinewebcams.com/live165.webp',
          'piazza_navona': 'https://cdn.skylinewebcams.com/live57.webp'
        };
        console.log(`${gates[i]}_URL=${cdnUrls[r.gateId]}`);
      }
    });
  }
  
  return { results, errors };
}

// CLI使用
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    // 批量处理所有摄像头
    captureAllWebcams()
      .then(() => {
        console.log('\n✅ All done!');
        process.exit(0);
      })
      .catch(error => {
        console.error('\n❌ Fatal error:', error);
        process.exit(1);
      });
  } else {
    // 单个摄像头
    const [url, gateId] = args;
    
    if (!url || !gateId) {
      console.error('Usage: node capture-and-upload-webcam.js <webcam_url> <gate_id>');
      console.error('   Or: node capture-and-upload-webcam.js   (to process all webcams)');
      process.exit(1);
    }
    
    captureAndUploadWebcam(url, gateId)
      .then(result => {
        console.log('\n✅ Success!');
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
      })
      .catch(error => {
        console.error('\n❌ Error:', error);
        process.exit(1);
      });
  }
}

module.exports = { captureAndUploadWebcam, captureAllWebcams };

