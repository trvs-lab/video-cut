#!/usr/bin/env node
/**
 * 审核服务器
 *
 * 功能：
 * 1. 提供静态文件服务（review.html, audio.mp3）
 * 2. POST /api/cut - 接收删除列表，执行剪辑
 *
 * 用法: node review_server.js [port] [video_file]
 * 默认: port=8899, video_file=自动检测目录下的 .mp4
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn, exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const PORT = process.argv[2] || 8899;
let VIDEO_FILE = process.argv[3] || findVideoFile();

// SSE 客户端列表
let sseClients = [];

// 发送进度到所有客户端
function broadcastProgress(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(message);
      // 立即刷新缓冲区，确保消息实时发送
      if (client.flush) client.flush();
    } catch (e) {
      // 移除已断开的客户端
      sseClients = sseClients.filter(c => c !== client);
    }
  });
}

function findVideoFile() {
  const files = fs.readdirSync('.').filter(f => f.endsWith('.mp4'));
  return files[0] || 'source.mp4';
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API: SSE 进度推送
  if (req.url === '/api/progress') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    // 禁用 Nagle 算法，确保立即发送
    res.socket.setNoDelay(true);
    // 立即发送初始确认消息并刷新
    res.write('data: {"type":"connected"}\n\n');
    if (res.flush) res.flush();
    sseClients.push(res);
    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res);
    });
    return;
  }

  // API: 执行剪辑
  if (req.method === 'POST' && req.url === '/api/cut') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const deleteList = data.segments || data; // 兼容旧格式
        const outputFormat = data.format || 'mp4'; // mp3 或 mp4

        // 保存删除列表到当前目录
        fs.writeFileSync('delete_segments.json', JSON.stringify(deleteList, null, 2));
        console.log(`📝 保存 ${deleteList.length} 个删除片段`);
        console.log(`📦 输出格式: ${outputFormat}`);

        // 生成输出文件名
        const ext = path.extname(VIDEO_FILE) || '.mp4';
        const baseName = path.basename(VIDEO_FILE, ext);
        const outputFile = `${baseName}_cut.${outputFormat}`;

        // 执行剪辑（异步，不等待完成）
        console.log('🎬 开始执行剪辑...');
        // 不等待完成，立即返回响应
        executeCutVideoSh(VIDEO_FILE, deleteList, outputFile, outputFormat).catch(err => {
          console.error('❌ 剪辑失败:', err);
          broadcastProgress({ type: 'error', message: '❌ 剪辑失败: ' + err.message });
        });

        // 立即返回响应，让客户端知道已开始
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          output: outputFile,
          format: outputFormat,
          message: `剪辑已开始，请查看进度`
        }));

      } catch (err) {
        console.error('❌ 剪辑失败:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 静态文件服务（从当前目录读取）
  let filePath = req.url === '/' ? '/review.html' : req.url;
  filePath = '.' + filePath;

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const stat = fs.statSync(filePath);

  // 支持 Range 请求（音频/视频拖动）
  if (req.headers.range && (ext === '.mp3' || ext === '.mp4')) {
    const range = req.headers.range.replace('bytes=', '').split('-');
    const start = parseInt(range[0], 10);
    const end = range[1] ? parseInt(range[1], 10) : stat.size - 1;

    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });

    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  // 普通请求
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes'
  });
  fs.createReadStream(filePath).pipe(res);
});

// 调用 cut_video.sh 并推送进度
async function executeCutVideoSh(input, deleteList, output, outputFormat = 'mp4') {
  // 保存删除列表
  fs.writeFileSync('delete_segments.json', JSON.stringify(deleteList, null, 2));

  // 先计算保留片段数
  const DURATION = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${input}"`).toString().trim());
  const BUFFER_SEC = 0.05;

  // 扩展并合并删除段
  const expanded = deleteList.map(seg => ({
    start: Math.max(0, seg.start - BUFFER_SEC),
    end: Math.min(DURATION, seg.end + BUFFER_SEC)
  })).sort((a, b) => a.start - b.start);

  const merged = [];
  for (const seg of expanded) {
    if (merged.length === 0 || seg.start > merged[merged.length - 1].end) {
      merged.push({ ...seg });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, seg.end);
    }
  }

  // 计算保留片段
  const keepSegments = [];
  let cursor = 0;
  for (const del of merged) {
    if (del.start > cursor) {
      keepSegments.push({ start: cursor, end: del.start });
    }
    cursor = del.end;
  }
  if (cursor < DURATION) {
    keepSegments.push({ start: cursor, end: DURATION });
  }

  const MAX_SEGMENTS = 100; // filter_complex 上限
  if (keepSegments.length > MAX_SEGMENTS) {
    console.log(`⚠️ 片段数 ${keepSegments.length} > ${MAX_SEGMENTS}，使用分段切割方案`);
    await executeFFmpegCutFallback(input, keepSegments, output, outputFormat);
    return;
  }

  broadcastProgress({ type: 'start', message: '准备剪辑...', total: keepSegments.length });

  // 获取视频时长用于计算进度
  let totalDuration = 0;
  try {
    const probeCmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${input}"`;
    totalDuration = parseFloat(execSync(probeCmd).toString().trim());
  } catch (e) {
    console.log('无法获取视频时长');
  }

  const scriptPath = path.join(__dirname, 'cut_video.sh');
  const child = spawn('bash', [scriptPath, input, 'delete_segments.json', output], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderrBuffer = '';

  child.stderr.on('data', (data) => {
    const text = data.toString();
    stderrBuffer += text;

    // 解析 FFmpeg 进度
    // 格式: frame=  123 fps= 45 q=28.0 size=    1024kB time=00:00:05.12 bitrate=...
    const frameMatch = text.match(/frame=\s*(\d+)/);
    const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
    const sizeMatch = text.match(/size=\s*(\d+)kB/);

    if (timeMatch && totalDuration > 0) {
      const hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      const seconds = parseFloat(timeMatch[3]);
      const currentTime = hours * 3600 + minutes * 60 + seconds;
      const percent = Math.min(Math.round((currentTime / totalDuration) * 100), 99);

      broadcastProgress({
        type: 'progress',
        percent: percent,
        current: currentTime.toFixed(1),
        total: totalDuration.toFixed(1),
        message: `剪辑中... ${percent}%`
      });
    }

    // 检测关键日志
    if (text.includes('视频时长')) {
      broadcastProgress({ type: 'info', message: text.trim() });
    }
  });

  child.stdout.on('data', (data) => {
    const text = data.toString();
    console.log(text);
    // 解析脚本输出的关键信息
    if (text.includes('保留片段数')) {
      const match = text.match(/保留片段数:\s*(\d+)/);
      if (match) {
        broadcastProgress({ type: 'info', message: `保留 ${match[1]} 个片段` });
      }
    }
  });

  child.on('close', (code) => {
    if (code === 0) {
      // 获取输出文件信息
      let fileInfo = { size: '未知', duration: '未知' };
      try {
        const stats = fs.statSync(output);
        fileInfo.size = (stats.size / 1024 / 1024).toFixed(1) + ' MB';

        const durationCmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${output}"`;
        const duration = parseFloat(execSync(durationCmd).toString().trim());
        fileInfo.duration = duration.toFixed(2) + 's';
      } catch (e) {
        // 忽略
      }

      broadcastProgress({
        type: 'complete',
        output: output,
        size: fileInfo.size,
        duration: fileInfo.duration,
        message: '✅ 剪辑完成!'
      });
      console.log(`✅ 输出: ${output}`);
    } else {
      broadcastProgress({
        type: 'error',
        message: '❌ 剪辑失败，请查看终端日志'
      });
      console.error('剪辑失败，退出码:', code);
    }
  });

  child.on('error', (err) => {
    broadcastProgress({
      type: 'error',
      message: '❌ 启动剪辑失败: ' + err.message
    });
    console.error('启动剪辑失败:', err);
  });
}

// 内置 FFmpeg 剪辑逻辑（filter_complex 精确剪辑 + buffer + crossfade）
function executeFFmpegCut(input, deleteList, output, outputFormat = 'mp4') {
  const isAudioOnly = outputFormat === 'mp3';
  // 配置参数
  const BUFFER_MS = 50;     // 删除范围前后各扩展 50ms（吃掉气口和残音）
  const CROSSFADE_MS = 30;  // 音频淡入淡出 30ms

  console.log(`⚙️ 优化参数: 扩展范围=${BUFFER_MS}ms, 音频crossfade=${CROSSFADE_MS}ms`);
  console.log(`🎵 音频-only 模式: ${isAudioOnly}`);

  // 检测音频偏移量（audio.mp3 的 start_time）
  let audioOffset = 0;
  try {
    const offsetCmd = `ffprobe -v error -show_entries format=start_time -of csv=p=0 audio.mp3`;
    audioOffset = parseFloat(execSync(offsetCmd).toString().trim()) || 0;
    if (audioOffset > 0) {
      console.log(`🔧 检测到音频偏移: ${audioOffset.toFixed(3)}s，自动补偿`);
    }
  } catch (e) {
    // 忽略，使用默认 0
  }

  // 获取视频总时长
  const probeCmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${input}"`;
  const duration = parseFloat(execSync(probeCmd).toString().trim());

  const bufferSec = BUFFER_MS / 1000;
  const crossfadeSec = CROSSFADE_MS / 1000;

  // 补偿偏移 + 扩展删除范围（前后各加 buffer）
  const expandedDelete = deleteList
    .map(seg => ({
      start: Math.max(0, seg.start - audioOffset - bufferSec),
      end: Math.min(duration, seg.end - audioOffset + bufferSec)
    }))
    .sort((a, b) => a.start - b.start);

  // 合并重叠的删除段
  const mergedDelete = [];
  for (const seg of expandedDelete) {
    if (mergedDelete.length === 0 || seg.start > mergedDelete[mergedDelete.length - 1].end) {
      mergedDelete.push({ ...seg });
    } else {
      mergedDelete[mergedDelete.length - 1].end = Math.max(mergedDelete[mergedDelete.length - 1].end, seg.end);
    }
  }

  // 计算保留片段
  const keepSegments = [];
  let cursor = 0;

  for (const del of mergedDelete) {
    if (del.start > cursor) {
      keepSegments.push({ start: cursor, end: del.start });
    }
    cursor = del.end;
  }
  if (cursor < duration) {
    keepSegments.push({ start: cursor, end: duration });
  }

  console.log(`保留 ${keepSegments.length} 个片段，删除 ${mergedDelete.length} 个片段`);

  // 如果片段太多，使用分段方案（更稳定）
  const MAX_SEGMENTS = 50;
  if (keepSegments.length > MAX_SEGMENTS) {
    console.log(`⚠️ 片段数 ${keepSegments.length} > ${MAX_SEGMENTS}，使用分段切割方案`);
    executeFFmpegCutFallback(input, keepSegments, output, outputFormat);
    return;
  }

  // 生成 filter_complex（带 crossfade）
  let filters = [];
  let vconcat = '';

  for (let i = 0; i < keepSegments.length; i++) {
    const seg = keepSegments[i];
    if (!isAudioOnly) {
      filters.push(`[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    }
    filters.push(`[0:a]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    vconcat += `[v${i}]`;
  }

  // 视频直接 concat（仅视频模式）
  if (!isAudioOnly) {
    filters.push(`${vconcat}concat=n=${keepSegments.length}:v=1:a=0[outv]`);
  }

  // 音频使用 acrossfade 逐个拼接（消除接缝咔声）
  if (keepSegments.length === 1) {
    filters.push(`[a0]anull[outa]`);
  } else {
    let currentLabel = 'a0';
    for (let i = 1; i < keepSegments.length; i++) {
      const nextLabel = `a${i}`;
      const outLabel = (i === keepSegments.length - 1) ? 'outa' : `amid${i}`;
      filters.push(`[${currentLabel}][${nextLabel}]acrossfade=d=${crossfadeSec.toFixed(3)}:c1=tri:c2=tri[${outLabel}]`);
      currentLabel = outLabel;
    }
  }

  const filterComplex = filters.join(';');

  console.log('✂️ 执行 FFmpeg 精确剪辑（带 buffer + crossfade）...');

  // 根据输出格式生成不同命令
  let cmd;
  if (isAudioOnly) {
    // 纯音频输出 (MP3)
    cmd = `ffmpeg -y -i "file:${input}" -filter_complex "${filterComplex}" -map "[outa]" -vn -c:a libmp3lame -q:a 2 "file:${output}"`;
  } else {
    // 视频输出 (MP4)
    cmd = `ffmpeg -y -i "file:${input}" -filter_complex "${filterComplex}" -map "[outv]" -map "[outa]" -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k "file:${output}"`;
  }

  try {
    execSync(cmd, { stdio: 'pipe' });
    console.log(`✅ 输出: ${output}`);

    const newDuration = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${output}"`).toString().trim());
    console.log(`⏱️ 新时长: ${newDuration.toFixed(2)}s`);
  } catch (err) {
    console.error('FFmpeg 执行失败，尝试分段方案...');
    executeFFmpegCutFallback(input, keepSegments, output, outputFormat);
  }
}

// 备用方案：分段切割 + concat（当 filter_complex 失败时使用）
async function executeFFmpegCutFallback(input, keepSegments, output, outputFormat = 'mp4') {
  const isAudioOnly = outputFormat === 'mp3';
  const tmpDir = `tmp_cut_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  broadcastProgress({ type: 'start', total: keepSegments.length, format: outputFormat });

  try {
    const partFiles = [];
    for (let i = 0; i < keepSegments.length; i++) {
      const seg = keepSegments[i];
      const ext = isAudioOnly ? '.mp3' : '.mp4';
      const partFile = path.join(tmpDir, `part${i.toString().padStart(4, '0')}${ext}`);
      const segDuration = seg.end - seg.start;

      let cmd;
      if (isAudioOnly) {
        // 纯音频切割
        cmd = `ffmpeg -y -ss ${seg.start.toFixed(3)} -i "file:${input}" -t ${segDuration.toFixed(3)} -vn -c:a libmp3lame -q:a 2 -avoid_negative_ts make_zero "${partFile}"`;
      } else {
        // 视频切割
        cmd = `ffmpeg -y -ss ${seg.start.toFixed(3)} -i "file:${input}" -t ${segDuration.toFixed(3)} -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 128k -avoid_negative_ts make_zero "${partFile}"`;
      }

      broadcastProgress({ type: 'progress', current: i + 1, total: keepSegments.length, percent: Math.round(((i + 1) / keepSegments.length) * 100), start: seg.start.toFixed(2), end: seg.end.toFixed(2) });
      console.log(`[${i + 1}/${keepSegments.length}] 切割: ${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s`);

      // 使用异步 exec，避免阻塞事件循环
      await execAsync(cmd, { stdio: 'pipe' });
      partFiles.push(partFile);
    }

    broadcastProgress({ type: 'merge', message: '合并片段中...' });
    console.log('合并片段...');

    const listFile = path.join(tmpDir, 'list.txt');
    const listContent = partFiles.map(f => `file '${path.resolve(f)}'`).join('\n');
    fs.writeFileSync(listFile, listContent);

    let concatCmd;
    if (isAudioOnly) {
      // 音频合并（使用 concat demuxer）
      concatCmd = `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${output}"`;
    } else {
      // 视频合并
      concatCmd = `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${output}"`;
    }
    await execAsync(concatCmd, { stdio: 'pipe' });

    console.log(`✅ 输出: ${output}`);

    // 显示输出文件信息
    let fileInfo = {};
    try {
      const stats = fs.statSync(output);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
      fileInfo.size = sizeMB + ' MB';
      console.log(`📁 文件大小: ${sizeMB} MB`);

      const durationCmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${output}"`;
      const duration = parseFloat(execSync(durationCmd).toString().trim());
      fileInfo.duration = duration.toFixed(2) + 's';
      console.log(`⏱️ 新时长: ${duration.toFixed(2)}s`);
    } catch (e) {
      // 忽略
    }
    broadcastProgress({ type: 'complete', output, ...fileInfo });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

server.listen(PORT, () => {
  console.log(`
🎬 审核服务器已启动
📍 地址: http://localhost:${PORT}
📹 视频: ${VIDEO_FILE}

操作说明:
1. 在网页中审核选择要删除的片段
2. 点击「🎬 执行剪辑」按钮
3. 等待剪辑完成
  `);
});
