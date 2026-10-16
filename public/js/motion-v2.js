/**
 * motion-v2.js —— r82 动效行为层（与 motion-v2.css 配套）
 * 职责只有两件：
 *   1. 图片淡入：封面 onload 后 360ms 浮现，杜绝白闪（含缓存图补标）
 *   2. 「立即检查 / 检查漫画」busy 态：点击转细环，app.js 在检查结束时调 mvSetNrBusy(false)
 * 其余全部交给 CSS（通知弹层进出场 / 侧栏微移），此处不碰。
 */
(function () {
    'use strict';
    document.documentElement.classList.add('mv-on');

    /* ---------- 1. 图片淡入 ---------- */
    function markLoaded(img) {
        if (img && img.tagName === 'IMG' && !img.classList.contains('mv-loaded')) {
            img.classList.add('mv-loaded');
        }
    }
    // capture 捕获所有 IMG 的 load（包括 lazy / 动态插入的）
    document.addEventListener('load', function (e) {
        if (e.target && e.target.tagName === 'IMG') markLoaded(e.target);
    }, true);
    document.addEventListener('error', function (e) {
        // 加载失败的图直接视为已就位，保持可见（占位符兜底逻辑照旧）
        if (e.target && e.target.tagName === 'IMG') markLoaded(e.target);
    }, true);
    // 缓存图可能在监听器挂上前就已 complete，扫一遍补标
    function sweep() {
        document.querySelectorAll('html.mv-on .movie-card img, html.mv-on .nr-card img, html.mv-on .series-stack img')
            .forEach(function (img) {
                if (img.complete && img.naturalWidth > 0) markLoaded(img);
            });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', sweep);
    } else {
        sweep();
    }
    // 视图切换会批量插入缓存图，两次兜底扫描
    setTimeout(sweep, 1500);
    setTimeout(sweep, 4000);

    /* ---------- 2. 检查按钮 busy 态（供 app.js 调用） ---------- */
    // app.js：点击成功启动检查后保持 busy，直到 stopNewReleasePolling()
    //（检查结束 / 离开视图 / 轮询超时）调用解除 —— busy 与真实后台状态同寿命。
    window.mvSetNrBusy = function (on) {
        ['nrCheckAllBtn', 'nrCheckComicBtn'].forEach(function (id) {
            const b = document.getElementById(id);
            if (b) b.classList.toggle('is-busy', !!on);
        });
    };

    /* ---------- 3. 切片器滑动指示背板 ----------
     * 支持 .f-pill / .r34-slice-tab / .nr-tab 通用切片器
     * 金色物理滑块 240ms 丝滑平移 + 尺寸动态拉伸自适应 */
    window.mvInitSlidePill = function (bar) {
        if (!bar) return;
        const active = bar.querySelector('.f-pill.active, .nr-tab.active, .r34-slice-tab.active');
        if (!active) return;
        let pill = bar.querySelector('.mv-slide-pill');
        if (!pill) {
            pill = document.createElement('span');
            pill.className = 'mv-slide-pill';
            bar.insertBefore(pill, bar.firstChild);
        }
        // 瞬时对位（无过渡）
        pill.style.transition = 'none';
        pill.style.top = active.offsetTop + 'px';
        pill.style.height = active.offsetHeight + 'px';
        pill.style.width = active.offsetWidth + 'px';
        pill.style.transform = 'translateX(' + active.offsetLeft + 'px)';
        void pill.offsetWidth; // 强制 reflow
        pill.style.transition = '';
    };

    window.mvSlidePillTo = function (btn) {
        if (!btn) return;
        const bar = btn.parentElement;
        if (!bar) return;
        let pill = bar.querySelector('.mv-slide-pill');
        if (!pill) { window.mvInitSlidePill(bar); pill = bar.querySelector('.mv-slide-pill'); }
        if (!pill) return;
        pill.style.top = btn.offsetTop + 'px';
        pill.style.height = btn.offsetHeight + 'px';
        pill.style.width = btn.offsetWidth + 'px';
        pill.style.transform = 'translateX(' + btn.offsetLeft + 'px)';
    };

    /* ---------- 4. 热门排行入场（stagger + 数字滚动 + 热度条） ----------
     * renderHotRanking 渲染完调用：领奖台与榜单行错峰浮现，
     * 播放次数 0→N 滚动，热度条以 scaleX 从 0 展开（只动 transform/opacity）。 */
    window.mvHotReveal = function (root) {
        if (!root) return;
        const steps = root.querySelectorAll('.hp-step');
        const rows = root.querySelectorAll('.hr-row');
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        const reveal = (els) => els.forEach((el, i) => {
            if (reduce) return;
            el.style.opacity = '0';
            el.style.transform = 'translateY(12px)';
            el.style.transition = 'opacity 360ms cubic-bezier(0.16,1,0.3,1), transform 360ms cubic-bezier(0.16,1,0.3,1)';
            setTimeout(() => {
                el.style.opacity = '1';
                el.style.transform = 'none';
            }, 60 + i * 60);
        });
        reveal(steps);
        reveal(rows);

        // 数字滚动（播放次数）：▶ N 次
        const countUp = (el) => {
            const target = parseInt(el.dataset.count, 10) || 0;
            if (reduce || target <= 0) { el.textContent = '▶ ' + target + ' 次'; return; }
            const dur = 700, t0 = performance.now();
            const tick = (now) => {
                const t = Math.min(1, (now - t0) / dur);
                const eased = 1 - Math.pow(1 - t, 3);
                el.textContent = '▶ ' + Math.round(target * eased) + ' 次';
                if (t < 1) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        };
        root.querySelectorAll('[data-count]').forEach(countUp);

        // 热度条：width 目标存 data-w，实际用 scaleX 从 0 展开
        root.querySelectorAll('.hr-hotbar i').forEach((bar) => {
            const w = bar.style.width;
            bar.dataset.w = w;
            bar.style.width = '100%';
            bar.style.transform = 'scaleX(0)';
            bar.style.transformOrigin = 'left center';
            setTimeout(() => {
                bar.style.transition = 'transform 600ms cubic-bezier(0.16,1,0.3,1)';
                bar.style.transform = 'scaleX(' + (parseFloat(w) / 100 || 0.04) + ')';
            }, 150);
        });
    };

    /* ---------- 5. 年度报告动效（核心数字平滑滚动 + 错峰浮现） ---------- */
    window.mvAnnualReveal = function (root) {
        if (!root) return;
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        // Bento 卡片错峰浮现
        const cards = root.querySelectorAll('.bento-card, .annual-card');
        cards.forEach((card, idx) => {
            card.style.setProperty('--bi', idx);
            card.style.setProperty('--i', idx);
            card.classList.add('mv-in');
        });

        // 数字从 0 平滑滚动（支持解析 "12h"、"45m" 等复合数字）
        root.querySelectorAll('.bento-num, .annual-card .num').forEach((numEl) => {
            const raw = numEl.dataset.val !== undefined ? numEl.dataset.val : numEl.textContent.trim();
            const unit = numEl.dataset.unit || (numEl.textContent.trim().match(/[a-zA-Z%]+$/)?.[0] || '');
            const target = parseFloat(raw);
            if (reduce || isNaN(target) || target <= 0) return;

            numEl.textContent = '0' + unit;
            const dur = 950;
            const t0 = performance.now();
            const tick = (now) => {
                const t = Math.min(1, (now - t0) / dur);
                const eased = 1 - Math.pow(1 - t, 3);
                const cur = target % 1 === 0 ? Math.round(target * eased) : (target * eased).toFixed(1);
                numEl.textContent = cur + unit;
                if (t < 1) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
    };

    /* ---------- 6. 新作监视流式入场（日期组层叠） ---------- */
    window.mvNrReveal = function (root) {
        if (!root) return;
        root.querySelectorAll('.nr-day').forEach((day, idx) => {
            day.style.setProperty('--di', Math.min(idx, 10));
        });
    };

    /* ---------- 7. 我的收藏：展品优雅挂墙 ---------- */
    window.mvExhibitsReveal = function (root) {
        if (!root) return;
        root.querySelectorAll('.exhibit').forEach((ex, idx) => {
            ex.style.setProperty('--ei', Math.min(idx, 24));
            ex.classList.add('mv-hang');
        });
    };

    /* ---------- 8. 收藏爱心物理微弹跳 ---------- */
    window.mvHeartPop = function (el) {
        if (!el) return;
        el.classList.remove('mv-heart-pop');
        void el.offsetWidth; // 触发 reflow
        el.classList.add('mv-heart-pop');
        setTimeout(() => el.classList.remove('mv-heart-pop'), 450);
    };

    /* ---------- 9. AI Agent 前端动作执行器 (UI Actions) ---------- */
    window.executeAIUiActions = function (actions) {
        if (!Array.isArray(actions) || !actions.length) return;
        actions.forEach(function (act) {
            if (!act || !act.type) return;
            console.log('[AI Agent Action]', act.type, act.payload);
            const p = act.payload || {};
            if (act.type === 'play_movie' && p.movieId) {
                setTimeout(function () {
                    if (typeof window.playMovieInline === 'function') window.playMovieInline(p.movieId);
                    else if (typeof window.showMovieDetail === 'function') window.showMovieDetail(p.movieId);
                }, 500);
            } else if (act.type === 'switch_view' && p.view) {
                setTimeout(function () {
                    if (typeof window.switchView === 'function') window.switchView(p.view);
                }, 400);
            } else if (act.type === 'show_notification') {
                if (typeof window.showNotification === 'function') {
                    window.showNotification(p.title || 'AI提示', p.message || '');
                }
            }
        });
    };

    /* ---------- 10. AI Agent 沙箱步骤条与审批卡片模板 ---------- */
    const PRIV_LABELS = {
        read_only: '🛡️ 只读',
        interactive: '🎬 交互',
        mutating: '✏️ 变更',
        destructive: '⚠️ 高危'
    };

    window.renderAIStepsHtml = function (steps) {
        if (!Array.isArray(steps) || !steps.length) return '';
        const items = steps.map(function (s) {
            const priv = s.privilege || 'read_only';
            const privTag = '<span class="ai-step-priv priv-' + priv + '">' + (PRIV_LABELS[priv] || priv) + '</span>';
            const costTag = s.costMs ? '<span class="ai-step-cost">' + s.costMs + 'ms</span>' : '';
            return '<div class="ai-step ' + (s.ok !== false ? 'ok' : 'fail') + '">' +
                '<span class="ai-step-ic">' + (s.ok !== false ? '✅' : '❌') + '</span>' +
                privTag +
                '<span class="ai-step-label">' + (s.label || s.tool || '操作') + '</span>' +
                (s.summary ? '<span class="ai-step-sum">' + s.summary + '</span>' : '') +
                costTag +
                '</div>';
        }).join('');
        return '<div class="ai-agent-steps">' +
            '<div class="ai-steps-title">🗂️ 沙箱任务链 · ' + steps.length + ' 步</div>' +
            items +
            '</div>';
    };

    window.renderAIApprovalCardHtml = function (approval, cardId) {
        if (!approval) return '';
        return '<div class="ai-approval-box" id="' + cardId + '">' +
            '<div class="aab-head">🛡️ 沙箱安全门禁 · 待授权操作</div>' +
            '<div class="aab-warn">⚠️ ' + (approval.warning || '此操作不可逆，需用户明确授权后方可执行') + '</div>' +
            '<div class="aab-args"><strong>操作项：</strong>' + (approval.label || approval.name) + '<br>' +
            '<strong>参数：</strong><code>' + JSON.stringify(approval.args || {}) + '</code></div>' +
            '<div class="aab-actions">' +
            '<button class="btn btn-sm btn-secondary aab-btn-reject">✕ 拒绝执行</button>' +
            '<button class="btn btn-sm btn-primary aab-btn-approve">✓ 允许并执行</button>' +
            '</div>' +
            '</div>';
    };

    /* ---------- 11. SSE 实时流式请求器 (ReadableStream 协议) ---------- */
    window.fetchAIStream = async function (message, opts, callbacks) {
        opts = opts || {};
        callbacks = callbacks || {};
        const url = '/api/ai/chat/stream';
        const body = JSON.stringify({
            message: message,
            sessionId: opts.sessionId || 'main',
            userApproved: !!opts.userApproved
        });

        if (callbacks.onStart) callbacks.onStart();

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: body
            });

            if (!res.ok) {
                throw new Error('HTTP ' + res.status);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n\n');
                buffer = lines.pop() || ''; // 留下未完整的尾巴

                for (const block of lines) {
                    const line = block.trim();
                    if (!line.startsWith('data:')) continue;
                    let json = null;
                    try { json = JSON.parse(line.slice(5).trim()); } catch (e) {}
                    if (!json) continue;

                    if (json.type === 'token' && callbacks.onToken) {
                        callbacks.onToken(json.token);
                    } else if (json.type === 'step' && callbacks.onStep) {
                        callbacks.onStep(json.step);
                    } else if (json.type === 'action' && callbacks.onAction) {
                        callbacks.onAction(json.action);
                    } else if (json.type === 'approval' && callbacks.onApproval) {
                        callbacks.onApproval(json.approval);
                    } else if (json.type === 'done' && callbacks.onDone) {
                        callbacks.onDone(json);
                    } else if (json.type === 'error' && callbacks.onError) {
                        callbacks.onError(new Error(json.error || 'AI流式异常'));
                    }
                }
            }
        } catch (err) {
            console.warn('[AI Stream] 流式连接异常，自动回退基础路径:', err);
            // 降级为非流式 POST /api/ai/chat
            try {
                const res = await fetch('/api/ai/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: body
                });
                const d = await res.json();
                if (d.code === 0 && d.data) {
                    if (d.data.steps && callbacks.onStep) {
                        d.data.steps.forEach(s => callbacks.onStep(s));
                    }
                    if (d.data.reply && callbacks.onToken) callbacks.onToken(d.data.reply);
                    if (d.data.uiActions && callbacks.onAction) {
                        d.data.uiActions.forEach(a => callbacks.onAction(a));
                    }
                    if (d.data.pendingApproval && callbacks.onApproval) {
                        callbacks.onApproval(d.data.pendingApproval);
                    }
                    if (callbacks.onDone) callbacks.onDone(d.data);
                } else if (callbacks.onError) {
                    callbacks.onError(new Error(d.msg || 'AI 回应失败'));
                }
            } catch (fallbackErr) {
                if (callbacks.onError) callbacks.onError(fallbackErr);
            }
        }
    };

    /* ---------- 12. 全天候拟人陪伴事件总线 (Proactive Companion Event Bus) ---------- */
    window.CompanionEventBus = (function () {
        let lastIdleCheck = Date.now();
        let lastLateNightAlert = 0;
        let lastIdlePrompt = 0;

        function safeRandom(max) {
            try {
                const u = new Uint32Array(1);
                window.crypto.getRandomValues(u);
                return u[0] % max;
            } catch(e) {
                return Math.floor(Math.random() * max);
            }
        }

        // 1. 播放结束主动点评 (由 player 关闭时触发)
        function onPlayFinished(movie) {
            if (!window.CVCompanion || !movie) return;
            const title = movie.title || movie.fileName || '';
            const lines = [
                `前辈，刚刚那部《${title}》看完了呀！感觉怎么样？要不要接着看同系列的下一卷？✨`,
                `辛苦啦前辈~《${title}》播完咯！要不要让我帮你打个分，顺便收藏进珍藏馆？⭐`,
                `看完一部啦！需要达妮娅接着帮你放下一部，还是想歇一歇眼睛？🦊`
            ];
            const say = lines[safeRandom(lines.length)];
            setTimeout(() => {
                window.CVCompanion.aiEvent('reply', say);
            }, 800);
        }

        // 2. 列表发呆 > 60s 主动推荐
        function checkIdleBrowsing() {
            const now = Date.now();
            if (now - lastIdlePrompt < 10 * 60 * 1000) return; // 10 分钟最多搭话一次
            if (now - lastIdleCheck > 65 * 1000) {
                lastIdlePrompt = now;
                if (!window.CVCompanion) return;
                const lines = [
                    '在影库里挑花眼了吗前辈？要不要让达妮娅帮你抽一张灵感牌堆？🃏',
                    '停在这里好久啦，找不到想看的吗？试试问我“帮我推荐两部高分好片”哦~✨',
                    '茫茫片海不知道看啥？点击右下角找我，一秒帮你选好今晚的电影！🍿'
                ];
                const say = lines[safeRandom(lines.length)];
                window.CVCompanion.aiEvent('reply', say);
            }
        }

        // 3. 深夜 23:30+ 温馨问候
        function checkLateNight() {
            const now = new Date();
            const h = now.getHours(), m = now.getMinutes();
            const isLate = (h === 23 && m >= 30) || (h >= 0 && h < 5);
            const todayStr = now.toDateString();
            if (isLate && lastLateNightAlert !== todayStr) {
                lastLateNightAlert = todayStr;
                setTimeout(() => {
                    if (window.CVCompanion) {
                        window.CVCompanion.aiEvent('reply', '已经很晚啦前辈，夜深了注意休息哦，熬夜对身体可不好呢……要早点睡呀~🌙');
                    }
                }, 2000);
            }
        }

        // 4. 切换特定库彩蛋 (里番/漫画)
        function onViewChanged(view) {
            lastIdleCheck = Date.now(); // 重置闲置计时
            if (!window.CVCompanion) return;
            if (view === 'anime' || view === 'watch-hanime') {
                const eggs = [
                    '哇…前辈切到这里来了呀~ 达妮娅什么都不知道哦，脸红红.jpg 🌸',
                    '嘻嘻，这是深夜专属频道呢…前辈要悄悄看哦~ (尾巴轻轻摇动)'
                ];
                if (safeRandom(100) < 45) {
                    setTimeout(() => window.CVCompanion.aiEvent('reply', eggs[safeRandom(eggs.length)]), 600);
                }
            } else if (view === 'comic') {
                if (safeRandom(100) < 35) {
                    setTimeout(() => window.CVCompanion.aiEvent('reply', '翻开漫画馆啦！躺在沙发上读最舒服了，慢慢翻阅吧~📚'), 600);
                }
            }
        }

        // 全局事件监听挂载
        document.addEventListener('mousemove', () => { lastIdleCheck = Date.now(); }, { passive: true });
        document.addEventListener('keydown', () => { lastIdleCheck = Date.now(); }, { passive: true });
        setInterval(checkIdleBrowsing, 20000);
        setInterval(checkLateNight, 60000);
        checkLateNight();

        return {
            onPlayFinished,
            onViewChanged
        };
    })();

    /* ---------- 13. ASR 语音识别与 Push-to-Talk 麦克风控制器 ---------- */
    window.CinemaASR = (function () {
        const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
        let recognition = null;
        let isRecording = false;
        let activeInput = null;
        let recordingIndicator = null;

        function ensureIndicator() {
            if (recordingIndicator) return recordingIndicator;
            const el = document.createElement('div');
            el.id = 'asrIndicator';
            el.className = 'asr-indicator';
            el.innerHTML = '<span class="asr-dot"></span><span>🎙️ 正在倾听... 请说话</span>';
            document.body.appendChild(el);
            recordingIndicator = el;
            return el;
        }

        function getActiveChatInput() {
            const aiInput = document.getElementById('aiInput');
            const homeInput = document.getElementById('homeChatInput');
            if (document.activeElement === aiInput || (aiInput && aiInput.offsetParent !== null)) {
                return aiInput;
            }
            if (document.activeElement === homeInput || (homeInput && homeInput.offsetParent !== null)) {
                return homeInput;
            }
            return homeInput || aiInput;
        }

        function updateMicBtnState(recording) {
            document.querySelectorAll('.home-chat-mic-btn, #aiModalMic').forEach(btn => {
                btn.classList.toggle('recording', !!recording);
            });
        }

        function startListening(targetInput, onFinalCallback) {
            if (!SpeechRec) {
                if (typeof showNotification === 'function') {
                    showNotification('语音识别', '当前浏览器缺少 SpeechRecognition 麦克风支持', 3000, 'error');
                }
                return false;
            }
            if (isRecording) return true;

            activeInput = targetInput || getActiveChatInput();
            if (!activeInput) return false;

            try {
                recognition = new SpeechRec();
                recognition.continuous = true;
                recognition.interimResults = true;
                recognition.lang = (window._aiAsrConfig && window._aiAsrConfig.lang) || 'zh-CN';

                const ind = ensureIndicator();
                ind.classList.add('show');
                isRecording = true;
                updateMicBtnState(true);

                let startVal = activeInput.value || '';
                if (startVal && !startVal.endsWith(' ')) startVal += ' ';

                recognition.onresult = (event) => {
                    let interim = '';
                    let finalStr = '';
                    for (let i = event.resultIndex; i < event.results.length; ++i) {
                        if (event.results[i].isFinal) {
                            finalStr += event.results[i][0].transcript;
                        } else {
                            interim += event.results[i][0].transcript;
                        }
                    }
                    if (activeInput) {
                        activeInput.value = startVal + finalStr + interim;
                        activeInput.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                };

                recognition.onerror = (e) => {
                    console.warn('[ASR Error]', e.error);
                    stopListening(false);
                };

                recognition.onend = () => {
                    stopListening(false);
                    if (onFinalCallback) onFinalCallback(activeInput ? activeInput.value : '');
                };

                recognition.start();
                return true;
            } catch (err) {
                console.error('[ASR Start Error]', err);
                stopListening(false);
                return false;
            }
        }

        function stopListening(triggerSend = false) {
            if (!isRecording) return;
            isRecording = false;
            updateMicBtnState(false);
            if (recordingIndicator) recordingIndicator.classList.remove('show');
            if (recognition) {
                try { recognition.stop(); } catch(e) {}
                recognition = null;
            }
            if (triggerSend && activeInput) {
                const text = (activeInput.value || '').trim();
                if (text) {
                    if (activeInput.id === 'homeChatInput') {
                        const send = document.getElementById('homeChatSend');
                        if (send) setTimeout(() => send.click(), 100);
                    } else if (activeInput.id === 'aiInput') {
                        if (typeof sendAIMessage === 'function') setTimeout(() => sendAIMessage(), 100);
                    }
                }
            }
        }

        function toggle(targetInput) {
            if (isRecording) stopListening(true);
            else startListening(targetInput);
        }

        // 全局快捷键监听（默认 F2 单键长按说话，松开即发）
        let keyHolding = false;
        document.addEventListener('keydown', (e) => {
            const hotkey = (window._aiAsrConfig && window._aiAsrConfig.hotkey) || 'F2';
            if (e.key === hotkey && !keyHolding && !e.repeat) {
                keyHolding = true;
                const ok = startListening();
                if (ok) e.preventDefault();
            }
        });

        document.addEventListener('keyup', (e) => {
            const hotkey = (window._aiAsrConfig && window._aiAsrConfig.hotkey) || 'F2';
            if (e.key === hotkey && keyHolding) {
                keyHolding = false;
                const autoSend = (window._aiAsrConfig && window._aiAsrConfig.autoSend) !== false;
                stopListening(autoSend);
                e.preventDefault();
            }
        });

        // 全局浮动麦克风按钮自动绑定
        document.addEventListener('DOMContentLoaded', () => {
            const fab = document.getElementById('globalAsrFab');
            if (fab) {
                fab.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggle();
                });
            }
        });
        setTimeout(() => {
            const fab = document.getElementById('globalAsrFab');
            if (fab && !fab.__bound) {
                fab.__bound = true;
                fab.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggle();
                });
            }
        }, 500);

        return {
            start: startListening,
            stop: stopListening,
            toggle: toggle,
            get isRecording() { return isRecording; }
        };
    })();
})();
