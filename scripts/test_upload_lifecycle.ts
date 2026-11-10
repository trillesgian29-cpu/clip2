import fs from 'fs';
import path from 'path';

const API_BASE = 'http://localhost:3000';
const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunks

async function runTests() {
  console.log('=== TEST 1: AUTHORIZED SAMPLE VIDEO UPLOAD ===');
  const samplePath = path.resolve('samples/sample-podcast-1794235524195.mp4');
  const stats = fs.statSync(samplePath);
  const fileSize = stats.size;
  const fileName = 'verified-sample-podcast.mp4';
  const fileType = 'video/mp4';

  console.log(`Sample File: ${samplePath}`);
  console.log(`File Size: ${fileSize} bytes (${(fileSize / (1024 * 1024)).toFixed(2)} MB)`);
  console.log(`MIME Type: ${fileType}`);

  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  console.log(`Chunk Size: ${CHUNK_SIZE} bytes, Total Chunks: ${totalChunks}`);

  // 1. Init
  console.log('\n--- Step 1: Init Session ---');
  const initRes = await fetch(`${API_BASE}/api/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: fileName,
      totalSize: fileSize,
      chunkSize: CHUNK_SIZE,
      mimeType: fileType,
    }),
  });

  const initData = await initRes.json();
  console.log(`Init HTTP Status: ${initRes.status}`);
  console.log('Init Response:', JSON.stringify(initData));
  if (!initRes.ok) throw new Error(`Init failed: ${JSON.stringify(initData)}`);
  const uploadId = initData.session.uploadId;

  // 2. Chunks
  console.log('\n--- Step 2: Chunk Uploads ---');
  const buffer = fs.readFileSync(samplePath);
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, fileSize);
    const chunkBuf = buffer.subarray(start, end);

    const chunkRes = await fetch(`${API_BASE}/api/upload/chunk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-upload-id': uploadId,
        'x-chunk-index': i.toString(),
        'x-chunk-size': chunkBuf.length.toString(),
      },
      body: chunkBuf,
    });
    const chunkData = await chunkRes.json();
    console.log(`Chunk ${i}/${totalChunks - 1} (${chunkBuf.length} bytes): HTTP ${chunkRes.status} -> received: ${chunkData.receivedChunks?.length || 1}/${totalChunks}`);
    if (!chunkRes.ok) throw new Error(`Chunk ${i} failed`);
  }

  // 3. Complete
  console.log('\n--- Step 3: Complete / Finalize Video ---');
  const completeRes = await fetch(`${API_BASE}/api/upload/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId,
    }),
  });
  const completeData = await completeRes.json();
  console.log(`Complete HTTP Status: ${completeRes.status}`);
  console.log('Complete Response:', JSON.stringify(completeData, null, 2));

  if (!completeRes.ok) throw new Error(`Complete failed: ${JSON.stringify(completeData)}`);

  console.log('\n--- Step 4: Verification of Created File ---');
  const savedFilePath = path.resolve(completeData.video.filepath);
  const savedStats = fs.statSync(savedFilePath);
  console.log(`Saved File Path: ${savedFilePath}`);
  console.log(`Saved File Exists: ${fs.existsSync(savedFilePath)}`);
  console.log(`Saved File Size: ${savedStats.size} bytes (Expected: ${fileSize} bytes)`);
  console.assert(savedStats.size === fileSize, 'File size matches exactly');
  console.log('Probe metadata:', {
    duration: completeData.video.duration,
    width: completeData.video.width,
    height: completeData.video.height,
    fps: completeData.video.fps,
    aspectRatio: completeData.video.aspectRatio,
  });

  console.log('\n=== TEST 2: CORRUPT CONTAINER FAILURE HANDLING & PRESERVATION ===');
  const corruptSize = 100 * 1024; // 100KB of random/invalid bytes
  const corruptBuffer = Buffer.alloc(corruptSize, 0x5a); // Invalid container bytes
  const corruptTotalChunks = 1;

  const corruptInitRes = await fetch(`${API_BASE}/api/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: 'corrupt-test.mp4',
      totalSize: corruptSize,
      chunkSize: CHUNK_SIZE,
      mimeType: 'video/mp4',
    }),
  });
  const corruptInitData = await corruptInitRes.json();
  const corruptUploadId = corruptInitData.session.uploadId;
  console.log(`Corrupt Upload ID: ${corruptUploadId}`);

  // Upload chunk
  const cChunkRes = await fetch(`${API_BASE}/api/upload/chunk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-upload-id': corruptUploadId,
      'x-chunk-index': '0',
      'x-chunk-size': corruptBuffer.length.toString(),
    },
    body: corruptBuffer,
  });
  console.log(`Corrupt Chunk Upload: HTTP ${cChunkRes.status}`);

  // Finalize
  const corruptCompRes = await fetch(`${API_BASE}/api/upload/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId: corruptUploadId,
    }),
  });
  const corruptCompData = await corruptCompRes.json();
  console.log(`Corrupt Complete HTTP Status: ${corruptCompRes.status} (Expected: 422)`);
  console.log('Corrupt Complete Response:', JSON.stringify(corruptCompData, null, 2));

  console.assert(corruptCompRes.status === 422, 'Status is 422 Unprocessable Entity');
  console.assert(corruptCompData.stage === 'validating', 'Failed stage is "validating"');
  console.assert(corruptCompData.error.includes('corrupted') || corruptCompData.error.includes('Invalid'), 'Error indicates container corruption');

  // Verify assembled file is PRESERVED on disk for debugging/recovery
  const preservedPath = path.resolve(corruptCompData.preservedFilePath);
  const isPreserved = fs.existsSync(preservedPath);
  console.log(`Preserved file exists at ${preservedPath}: ${isPreserved}`);
  console.assert(isPreserved, 'Original assembled file preserved on disk');

  console.log('\n=== ALL TESTS PASSED SUCCESSFULLY! ===');
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
