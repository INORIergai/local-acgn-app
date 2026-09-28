/**
 * Ollama 本地AI客户端
 * 直接使用fetch调用API，不需要额外安装ollama包
 */

const config = require('./config');

const baseUrl = config.ollama?.baseUrl || 'http://127.0.0.1:11434';
const defaultModel = config.ollama?.model || 'qwen2.5:3b';

/**
 * 检查Ollama是否可用
 */
async function checkHealth() {
    try {
        const res = await fetch(`${baseUrl}/api/tags`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        if (res.ok) {
            const data = await res.json();
            return {
                available: true,
                models: data.models || [],
                baseUrl
            };
        }
        return { available: false, error: `HTTP ${res.status}` };
    } catch (e) {
        return { available: false, error: e.message };
    }
}

/**
 * AI对话
 */
async function chat(prompt, history = [], model = defaultModel) {
    try {
        const res = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                messages: [...history, { role: 'user', content: prompt }],
                stream: false
            })
        });
        
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        }
        
        const data = await res.json();
        return data.message?.content || '';
    } catch (e) {
        console.error('[Ollama] 对话失败:', e.message);
        throw e;
    }
}

/**
 * 生成文本（补全）
 */
async function generate(prompt, model = defaultModel) {
    try {
        const res = await fetch(`${baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                prompt: prompt,
                stream: false
            })
        });
        
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        }
        
        const data = await res.json();
        return data.response || '';
    } catch (e) {
        console.error('[Ollama] 生成失败:', e.message);
        throw e;
    }
}

/**
 * 翻译文本
 */
async function translate(text, targetLang = '中文') {
    const prompt = `请将以下文本翻译成${targetLang}，只输出翻译结果，不要解释：

${text}`;
    return await generate(prompt);
}

/**
 * 根据影片列表智能推荐
 */
async function recommendMovies(movieList) {
    const prompt = `根据下面影片清单，推荐风格相近的影片，简短说明理由：
${JSON.stringify(movieList.map(m => m.title))}
只输出推荐结果，简洁。`;
    return await generate(prompt);
}

/**
 * 生成标签
 */
async function generateTags(title, overview = '') {
    const prompt = `根据以下影片信息，生成5-8个中文标签，用逗号分隔，只输出标签：
标题：${title}
简介：${overview || '无'}`;
    const result = await generate(prompt);
    return result.split(/[,，、\n]/).map(t => t.trim()).filter(t => t);
}

module.exports = { 
    chat, 
    generate,
    translate,
    recommendMovies, 
    generateTags,
    checkHealth,
    baseUrl,
    defaultModel
};
