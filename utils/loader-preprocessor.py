import sys
import os
import cv2
import numpy as np
import subprocess

def process_loader(input_path, output_dir):
    """
    智能预处理用户上传的加载动画：
    1. 自动探测背景色（纯黑/绿色色度/纯白）
    2. 提取主体运动范围并智能居中裁剪
    3. 生成 120x120 具备完美透明 Alpha 通道的 WebP 动画与 WebM 视频
    """
    os.makedirs(output_dir, exist_ok=True)
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        print(f"Error: Cannot open {input_path}")
        return False

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 30

    # 抽取前 60 帧（最多 2 秒，适合循环加载器）
    num_frames = min(60, total_frames)
    raw_frames = []
    for _ in range(num_frames):
        ret, f = cap.read()
        if not ret:
            break
        # 预先缩放至适中工作分辨率（如 960x540），极大提升处理速度与内存安全性
        h, w, _ = f.shape
        if h > 720 or w > 1280:
            scale = 720.0 / h
            f = cv2.resize(f, (int(w * scale), 720), interpolation=cv2.INTER_AREA)
        raw_frames.append(f)
    cap.release()

    if not raw_frames:
        return False

    # 1. 探测背景类型（采样四角与边缘）
    corners = []
    for f in raw_frames[:5]:
        h, w, _ = f.shape
        corners.extend([f[5, 5], f[5, -6], f[-6, 5], f[-6, -6]])
    avg_corner = np.mean(corners, axis=0)

    # 判定背景：黑底 (mean < 35)、白底 (mean > 200)、绿幕 (G > R+30 and G > B+30)
    is_black_bg = np.max(avg_corner) < 40
    is_green_bg = (avg_corner[1] > avg_corner[0] + 30) and (avg_corner[1] > avg_corner[2] + 30)
    is_white_bg = np.min(avg_corner) > 190

    # 2. 逐帧计算 Alpha 与主体包围盒
    processed_frames = []
    all_coords = []

    for f in raw_frames:
        h, w, _ = f.shape
        if is_black_bg:
            max_v = np.max(f, axis=2).astype(float)
            alpha = np.clip((max_v - 12) * 12, 0, 255).astype(np.uint8)
        elif is_green_bg:
            # 绿幕色度距离
            green_dist = (f[:,:,1].astype(float) - np.maximum(f[:,:,0], f[:,:,2]).astype(float))
            alpha = np.where(green_dist > 25, 0, 255).astype(np.uint8)
        elif is_white_bg:
            diff_rg = np.abs(f[:,:,2].astype(float) - f[:,:,1].astype(float))
            diff_gb = np.abs(f[:,:,1].astype(float) - f[:,:,0].astype(float))
            is_neutral = (diff_rg < 16) & (diff_gb < 16)
            is_bright = (f[:,:,0] > 195) & (f[:,:,1] > 195) & (f[:,:,2] > 195)
            alpha = np.where(is_neutral & is_bright, 0, 255).astype(np.uint8)
        else:
            # 兜底：暗角与极端像素
            diff_corner = np.linalg.norm(f.astype(float) - avg_corner, axis=2)
            alpha = np.where(diff_corner < 35, 0, 255).astype(np.uint8)

        # 滤波羽化
        alpha = cv2.GaussianBlur(alpha, (3, 3), 0)
        coords = np.column_stack(np.where(alpha > 30))
        if len(coords):
            all_coords.append(coords)

        rgba = cv2.cvtColor(f, cv2.COLOR_BGR2BGRA)
        rgba[:, :, 3] = alpha
        processed_frames.append(rgba)

    # 3. 统计整个动效周期中主体的大致范围
    if all_coords:
        cat_coords = np.concatenate(all_coords, axis=0)
        ymin, xmin = np.percentile(cat_coords[:, 0], 1), np.percentile(cat_coords[:, 1], 1)
        ymax, xmax = np.percentile(cat_coords[:, 0], 99), np.percentile(cat_coords[:, 1], 99)
        ymin, xmin = max(0, int(ymin) - 10), max(0, int(xmin) - 10)
        ymax, xmax = min(h, int(ymax) + 10), min(w, int(xmax) + 10)
    else:
        ymin, xmin, ymax, xmax = 0, 0, h, w

    crop_h = max(10, ymax - ymin)
    crop_w = max(10, xmax - xmin)

    # 4. 居中放入 120x120 方形画布
    tmp_dir = os.path.join(output_dir, '_loader_tmp')
    os.makedirs(tmp_dir, exist_ok=True)

    target_size = 120
    aspect = crop_w / crop_h
    if aspect > 1.0:
        new_w = target_size - 10
        new_h = int(new_w / aspect)
    else:
        new_h = target_size - 10
        new_w = int(new_h * aspect)

    new_w = max(4, new_w)
    new_h = max(4, new_h)

    for idx, rgba in enumerate(processed_frames):
        c = rgba[ymin:ymax, xmin:xmax]
        resized = cv2.resize(c, (new_w, new_h), interpolation=cv2.INTER_AREA)

        canvas = np.zeros((target_size, target_size, 4), dtype=np.uint8)
        x_off = (target_size - new_w) // 2
        y_off = (target_size - new_h) // 2
        canvas[y_off:y_off+new_h, x_off:x_off+new_w] = resized
        cv2.imwrite(os.path.join(tmp_dir, f'f_{idx:03d}.png'), canvas)

    # 5. 生成高质量透明 WebP 与 WebM
    out_webp = os.path.join(output_dir, 'anim-loader.webp')
    out_webm = os.path.join(output_dir, 'anim-loader.webm')

    # ffmpeg 转为 animated webp
    subprocess.run([
        'ffmpeg', '-y', '-framerate', '30',
        '-i', os.path.join(tmp_dir, 'f_%03d.png'),
        '-vcodec', 'libwebp', '-lossless', '0', '-qscale', '80',
        '-loop', '0', '-an', '-vsync', '0', out_webp
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # ffmpeg 转为 webm
    subprocess.run([
        'ffmpeg', '-y', '-framerate', '30',
        '-i', os.path.join(tmp_dir, 'f_%03d.png'),
        '-c:v', 'libvpx-vp9', '-b:v', '500k', out_webm
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # 清理临时帧
    for f in os.listdir(tmp_dir):
        try: os.remove(os.path.join(tmp_dir, f))
        except: pass
    try: os.rmdir(tmp_dir)
    except: pass

    print(f"Processed loader: webp={os.path.exists(out_webp)}, webm={os.path.exists(out_webm)}")
    return True

if __name__ == '__main__':
    if len(sys.argv) >= 3:
        process_loader(sys.argv[1], sys.argv[2])
    else:
        print("Usage: python loader-preprocessor.py <input> <output_dir>")
