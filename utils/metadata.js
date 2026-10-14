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

function captureFrameAt(videoPath, savePath, targetTime, thumbWidth) {
    return new Promise((resolve, reject) => {
        const saveDir = path.dirname(savePath);
        if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

        ffmpeg(videoPath)
            .screenshots({
                timestamps: [targetTime],
                filename: path.basename(savePath),
                folder: saveDir,
                size: `${thumbWidth}x?`
            })
            .on('end', () => resolve(savePath))
            .on('error', reject);
    });
}

/**
 * 截取视频帧（智能防黑帧避让）
 * 视频多段拼接处、转场淡出、片头黑屏时，固定数学时间点极易命中纯黑帧（420px 纯黑 JPG 仅 ~850B）。
 * 此处检测生成图片大小，若 < 2500B 则判定为纯黑过渡帧，自动向后/向前微调重试，确保输出色彩丰富的内容帧。
 */
async function captureVideoThumb(videoPath, savePath, videoDuration = 0, atTime = 0) {
    // atTime > 0 时截指定秒数（用于「挑封面」时给出多个位置的候选帧）
    let baseTime = atTime > 0 ? atTime : (config.ffmpeg?.screenshotTime || 15);

    // 时长非法/过短，强制截取第1秒
    if (isNaN(videoDuration) || videoDuration <= 0) {
        baseTime = Math.max(1, baseTime);
    } else if (baseTime >= videoDuration) {
        baseTime = Math.max(1, videoDuration * 0.3);
    }
    if (isNaN(baseTime) || baseTime <= 0) baseTime = 1;

    const thumbWidth = config.ffmpeg?.thumbnailWidth || 420;
    // 偏移候选序列：先试目标点，若为纯黑帧则依次避让 +4s, +8s, -4s, +15s, -10s, +30s
    const offsets = [0, 4, 8, -4, 15, -10, 25, 45];
    let lastErr = null;

    for (const off of offsets) {
        let t = baseTime + off;
        if (videoDuration > 0) {
            t = Math.max(1, Math.min(Math.max(1, videoDuration - 1), t));
        } else {
            t = Math.max(1, t);
        }

        try {
            await captureFrameAt(videoPath, savePath, t, thumbWidth);
            if (fs.existsSync(savePath)) {
                const sz = fs.statSync(savePath).size;
                if (sz >= 2500) {
                    return savePath;
                }
                // 小于 2500 字节通常为纯黑帧/转场黑幕，记录并继续寻找有内容的帧
            }
        } catch (err) {
            lastErr = err;
        }
    }

    // 保底：若所有偏移都未能获取到 >2500B（极度罕见），尝试截取第 1 秒或保留当前帧
    try {
        if (!fs.existsSync(savePath) || fs.statSync(savePath).size === 0) {
            await captureFrameAt(videoPath, savePath, 1, thumbWidth);
        }
        return savePath;
    } catch (e) {
        if (fs.existsSync(savePath)) return savePath;
        throw lastErr || e;
    }
}

module.exports = { getVideoMetadata, captureVideoThumb };