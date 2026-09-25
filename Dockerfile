# 本地影库 Dockerfile
FROM docker.m.daocloud.io/library/node:20-bookworm

# 设置工作目录
WORKDIR /app

# apt 换国内镜像：构建时从 deb.debian.org 拉包实测会 500 / unexpected EOF（等了 6 分钟才失败）
RUN set -eux; \
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do \
      [ -f "$f" ] || continue; \
      sed -i 's|https\?://deb\.debian\.org|https://mirrors.aliyun.com|g' "$f"; \
    done; \
    cat /etc/apt/sources.list.d/*.sources 2>/dev/null | head -5 || true

# 安装编译工具（better-sqlite3需要）和ffmpeg
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# 复制package.json并安装依赖
COPY package.json ./
RUN npm install --production

# 装 Playwright 的 chromium：hanime-pw / jable 这类被 Cloudflare 挡的站必须有真浏览器才过得去。
# 装在 /ms-playwright（不在 /app 里），所以不会被 /app/node_modules 那个匿名卷遮掉，重建容器也还在。
# 下载源必须是 npmmirror 的 /-/binary/playwright（实测 12MB/s；`cdn.npmmirror.com/binaries/playwright`
# 那个老地址对当前的 builds/cft/... 布局是 404，官方 cdn.playwright.dev 只有 138KB/s）。
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright
RUN npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*

# 复制项目文件
COPY . .

# 暴露端口
EXPOSE 3000

# 启动服务（先转换路径，再启动）
CMD ["node", "docker-entrypoint.js"]
