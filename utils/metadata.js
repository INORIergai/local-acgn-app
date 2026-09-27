const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// 设置FFmpeg路径
// 配置里写的是"目录"，二进制名分平台（Linux 下没有 .exe）；目录里找不到就退回 PATH 查找
function resolveBin(name) {
    const dir = config.ffmpeg?.binPath;
    if (!dir) return name;
    const full = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    return fs.existsSync(full) ? full : name;
}
ffmpeg.setFfmpegPath(resolveBin('ffmpeg'));
ffmpeg.setFfprobePath(resolveBin('ffprobe'));

// 自检：METADATA_SELFTEST=1 node utils/metadata.js 打印实际使用的二进制路径
if (process.env.METADATA_SELFTEST) {
    console.log(`[FFmpeg 自检] platform=${process.platform} binPath=${config.ffmpeg?.binPath || '(未配置)'}`);
    console.log(`[FFmpeg 自检] ffmpeg  -> ${resolveBin('ffmpeg')}`);
    console.log(`[FFmpeg 自检] ffprobe -> ${resolveBin('ffprobe')}`);
}

/**
 * 读取视频元数据，时长异常强制返回0
 */
function getVideoMetadata(file) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(file, (err, metadata) => {
            if (err) return reject(err);
            const stream = metadata.streams?.find(s => s.codec_type === 'video');
            if (!stream) return reject(new Error('无有效视频流'));

            const duration = Number(metadata.format?.duration) || 0;
            const width = Number(stream.width) || 0;
            const height = Number(stream.height) || 0;

            resolve({ duration, width, height });
        });
    });
}

/**
 * 截取视频帧，时长异常强制截取第1秒
 */
function captureVideoThumb(videoPath, savePath, videoDuration = 0, atTime = 0) {
    return new Promise((resolve, reject) => {
        // atTime > 0 时截指定秒数（用于「挑封面」时给出多个位置的候选帧）
        let targetTime = atTime > 0 ? atTime : config.ffmpeg.screenshotTime;

        // 时长非法/过短，强制截取第1秒
        if (isNaN(videoDuration) || videoDuration <= 0) {
            targetTime = 1;
        } else if (targetTime >= videoDuration) {
            targetTime = Math.max(1, videoDuration * 0.3);
        }
        if (isNaN(targetTime)) targetTime = 1;

        const saveDir = path.dirname(savePath);
        if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

        const thumbWidth = config.ffmpeg?.thumbnailWidth || 420;

        ffmpeg(videoPath)
            .screenshots({
                timestamps: [targetTime],
                filename: path.basename(savePath),
                folder: saveDir,
                size: `${thumbWidth}x?`
            })
            .on('end', () => resolve(savePath))
            .on('error', (err) => {
                // 失败重试：强制1秒截图
                ffmpeg(videoPath)
                    .screenshots({
                        timestamps: [1],
                        filename: path.basename(savePath),
                        folder: saveDir,
                        size: `${thumbWidth}x?`
                    })
                    .on('end', () => resolve(savePath))
                    .on('error', reject);
            });
    });
}

module.exports = { getVideoMetadata, captureVideoThumb };