// ==UserScript==
// @name         WeLearn 试卷分析与自动回填助手
// @namespace    http://tampermonkey.net/
// @version      3.9-exam-fill
// @description  适配 wetest.sflep.com：以 .test_hov 为题容器提取全卷（选择+填空+翻译），AI 分析后回填。新增 directSaveAnswer 直接复刻 autoSaveAnswer 变绿+存档逻辑，完全绕开 isLeave 检查，稳定触发答题卡变绿与服务端保存。默认模型 deepseek-v4-flash。
// @match        https://wetest.sflep.com/test/welearnTest.html*
// @match        https://wetest.sflep.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      api.deepseek.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const APP = Object.freeze({
        id: 'wl-exam-fill-helper',
        name: 'WeLearn 试卷分析与自动回填助手',
        version: '3.9-exam-fill',
        settingsKey: 'WL_EXAM_SETTINGS',
        apiKeyKey: 'WL_EXAM_API_KEY',
        autoFillKey: 'WL_EXAM_AUTOFILL'
    });

    const DEFAULT_SETTINGS = Object.freeze({
        aiApiBase: 'https://api.deepseek.com',
        aiApiKey: '',
        aiModel: 'deepseek-v4-flash',
        temperature: 0.2,
        maxTokens: 2048
    });

    function normalizeText(value) {
        return String(value ?? '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .replace(/\r/g, '')
            .trim();
    }

    function normalizeBaseUrl(value) {
        return normalizeText(value).replace(/\/+$/, '');
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // 选择题回填：点击 .radio 触发平台原生选中逻辑，再确保 autoSaveAnswer 执行
    // （autoSaveAnswer 由 .choiceList 的 change 事件触发，但合成 change 不一定可靠
    //  走到 jQuery 监听器，因此直接调用一次作为兜底，已变绿则跳过避免重复保存）。
    function fillChoice(radioDiv) {
        if (!radioDiv) return false;
        const input = radioDiv.querySelector('input[type="radio"], input[type="checkbox"]');
        if (input) {
            try { input.checked = true; } catch (_) { /* ignore */ }
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        radioDiv.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        // 兜底：若答题卡仍未变绿，直接保存（directSaveAnswer 绕开 isLeave）
        if (input && input.dataset && input.dataset.qnum) {
            const qnum = input.dataset.qnum;
            const sheetItem = document.getElementById('aQuestion' + qnum);
            if (sheetItem && !sheetItem.classList.contains('answer_sheet_2')) {
                triggerPlatformSave(input);
            }
        }
        return true;
    }

    // 回填批次进行中标志：为 true 时把平台 isLeave 钉死为 false，
    // 避免 autoSaveAnswer 第一行 `if(isLeave) return` 把变绿+保存全吞掉。
    // 根因：自动化/Console 操作期间 window.onblur 会把 isLeave 设成 true，
    // 实测清掉后 autoSaveAnswer 立即可正常变绿并存档。
    //
    // 注意：isLeave 是 WelearnTest.js 顶层 `var isLeave` 挂到 window 的，
    // 其属性 configurable:false（var 全局变量特性），不能用 Object.defineProperty
    // 重定义（会抛 Cannot redefine property），只能直接赋值（writable:true）。
    // 但单赋值不够——window.onblur 会在批次中途再设回 true。所以同时临时摘除 onblur。
    let fillingBatch = false;
    let savedOnBlur = null;
    let hasSavedOnBlur = false;

    function suppressIsLeave(suppress) {
        try {
            if (suppress) {
                // 首次进入：保存原 onblur（可能为 null），然后摘除，防止它中途把 isLeave 设回 true
                if (!hasSavedOnBlur) {
                    savedOnBlur = window.onblur;
                    hasSavedOnBlur = true;
                }
                window.onblur = null;
                // 直接赋值 false（isLeave 是 var 全局变量，configurable:false，不可 defineProperty）
                window.isLeave = false;
            } else {
                window.isLeave = false;
                if (hasSavedOnBlur) {
                    window.onblur = savedOnBlur;
                    hasSavedOnBlur = false;
                    savedOnBlur = null;
                }
            }
        } catch (_) { /* ignore */ }
    }

    // 直接复刻 autoSaveAnswer 的变绿+存档核心逻辑，完全绕开 isLeave 检查。
    // 根因：autoSaveAnswer 第一行 `if(isLeave) return` 会吞掉变绿和保存。
    // 即便每题重新 suppressIsLeave，async 的 await sleep 期间主线程让出，
    // 真实 window blur 仍可能把 isLeave 设回 true，导致后续题失败。
    // 此函数直接操作 paperAnswer / .answer_sheet_2 / autoSaveData，
    // 不读 isLeave，免疫一切时序问题。
    function directSaveAnswer(el) {
        try {
            const qnum = el.dataset && el.dataset.qnum;
            if (!qnum || isNaN(qnum) || parseInt(qnum, 10) <= 0) return false;

            // 取值：与 autoSaveAnswer 一致，用 jQuery val()（处理 select 的 data-select 前缀）
            let value = '';
            const nodeName = el.nodeName === 'INPUT' ? (el.attributes.type && el.attributes.type.nodeValue) : el.nodeName;
            if (nodeName === 'radio') {
                value = el.dataset.id || '';
            } else {
                if (window.jQuery) value = window.jQuery('#' + el.id).val() || '';
                else value = el.value || '';
                if (el.dataset && el.dataset.select) value = el.dataset.select + ',' + value;
            }

            // 写 paperAnswer（与平台一致）
            if (window.paperAnswer) {
                window.paperAnswer[qnum] = { key: qnum, value: encodeURIComponent(value), type: 'question' };
            }

            // 变绿 / 取消变绿
            const cell = document.getElementById('aQuestion' + qnum);
            if (cell) {
                if (value.length === 0) cell.classList.remove('answer_sheet_2');
                else cell.classList.add('answer_sheet_2');
            }

            // 触发服务端保存（与 autoSaveAnswer 调用 autoSaveData 一致）
            if (typeof window.autoSaveData === 'function') {
                window.autoSaveData({
                    testId: window.testEnv && window.testEnv.testId,
                    partNum: window.curPartNum,
                    answerDetail: {
                        key: qnum,
                        value: encodeURIComponent(value),
                        type: 'question',
                        clientTime: new Date().toLocaleString()
                    }
                }, 'autoSaveAnswer');
            }
            return true;
        } catch (_) { return false; }
    }

    // 调用平台自身的保存函数，绕开合成事件不可靠 / jQuery 监听器不触发 / isLeave 拦截等问题。
    // 优先用 directSaveAnswer（完全不碰 isLeave，免疫时序）；
    // bankedCloze 仍需 CheckBankedClozeInput（校验+大写）；
    // 其余兜底走 autoSaveAnswer（每题重新 suppressIsLeave 防中途失守）。
    function triggerPlatformSave(el) {
        try {
            const qtype = el.dataset && el.dataset.qtype;
            const wasFilling = fillingBatch;
            suppressIsLeave(true);
            try {
                if (qtype === 'bankedCloze' && typeof window.CheckBankedClozeInput === 'function') {
                    // bankedCloze 必须先校验（会清空非法输入并转大写），再 directSave
                    window.CheckBankedClozeInput({ target: el });
                    directSaveAnswer(el);
                } else {
                    // 优先直接保存，绕开 isLeave（免疫 await sleep 期间的时序问题）
                    directSaveAnswer(el);
                }
            } finally {
                if (!wasFilling) suppressIsLeave(false);
            }
        } catch (_) { /* ignore */ }
    }

    // 填空/翻译回填：async，逐题延时。
    // 关键：写入 value 后直接调用平台 autoSaveAnswer（绑在 blur 上），
    // 不再依赖 execCommand / 合成事件链 —— 平台并不检查 isTrusted，
    // 答题卡变绿与保存完全由 autoSaveAnswer 驱动。
    async function fillText(el, value) {
        if (!el) return false;
        const val = String(value ?? '');
        if (!val) return false;

        // 0) 最优先：摘 onblur + isLeave=false。
        // 必须在 focus 之前，因为 focus 会触发前一个元素的 blur，
        // 而平台给 textarea 绑了 obj.blur(autoSaveAnswer)——若此时 isLeave=true，
        // 那次 blur 触发的 autoSaveAnswer 会被吞，且可能把 isLeave 留在 true。
        // 每题都重置，防止批量中途某题让 isLeave 失守。
        suppressIsLeave(true);

        // 1) 聚焦
        try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (_) { /* ignore */ } }
        await sleep(40);

        // 2) 用原生 setter 写入 value（可靠；execCommand 已废弃且在此场景无必要）
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        try {
            if (desc && desc.set) desc.set.call(el, val);
            else el.value = val;
        } catch (_) { el.value = val; }

        // 3) 派发 input 事件，覆盖题目 HTML 中可能存在的内联 oninput/onkeyup 处理器
        try {
            el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
        } catch (_) {
            try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) { /* ignore */ }
        }

        // 4) 同步字数统计：优先用平台自带函数，保证与平台口径一致
        try {
            if (typeof window.StatWritingWordsCount === 'function' && el.id) {
                window.StatWritingWordsCount(el.id, true);
            } else {
                const rawId = (el.id || '').replace(/^ta_/, '');
                if (rawId) {
                    const wc = document.getElementById('spWordCount_' + rawId);
                    if (wc) {
                        const words = val.trim().split(/\s+/).filter(Boolean).length;
                        wc.textContent = String(words);
                    }
                }
            }
        } catch (_) { /* ignore */ }

        // 5) 调用前再确保一次 isLeave=false（防止 1-4 步中间被设回 true）
        window.isLeave = false;

        // 6) 核心：直接调用平台 autoSaveAnswer（等价于真实 blur 触发的保存链路）
        //    它会同步为 #aQuestion<qnum> 加 answer_sheet_2，并把答案写入 paperAnswer 并 POST 保存。
        triggerPlatformSave(el);

        // 7) 失焦收尾
        await sleep(20);
        try { el.blur(); } catch (_) { /* ignore */ }
        return true;
    }

    function isChoiceAnswered(hov) {
        return !!hov.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked');
    }

    class SettingsStore {
        load() {
            try {
                const parsed = JSON.parse(localStorage.getItem(APP.settingsKey) || '{}');
                const settings = { ...DEFAULT_SETTINGS, ...parsed };
                if (/^https:\/\/api\.deepseek\.com\/v1\/?$/i.test(normalizeText(settings.aiApiBase))) {
                    settings.aiApiBase = 'https://api.deepseek.com';
                }
                if (typeof GM_getValue === 'function') {
                    const secureKey = GM_getValue(APP.apiKeyKey, '');
                    if (secureKey) settings.aiApiKey = secureKey;
                }
                return settings;
            } catch (error) {
                return { ...DEFAULT_SETTINGS };
            }
        }

        save(settings) {
            const safeCopy = { ...settings };
            delete safeCopy.aiApiKey;
            if (typeof GM_setValue === 'function') {
                if (settings.aiApiKey) GM_setValue(APP.apiKeyKey, settings.aiApiKey);
                else if (typeof GM_deleteValue === 'function') GM_deleteValue(APP.apiKeyKey);
                else GM_setValue(APP.apiKeyKey, '');
                localStorage.setItem(APP.settingsKey, JSON.stringify(safeCopy));
                return;
            }
            localStorage.setItem(APP.settingsKey, JSON.stringify(settings));
        }

        getAutoFill() {
            try {
                if (typeof GM_getValue === 'function') return GM_getValue(APP.autoFillKey, true) === true;
                return localStorage.getItem(APP.autoFillKey) !== '0';
            } catch { return true; }
        }

        setAutoFill(value) {
            const v = !!value;
            try {
                if (typeof GM_setValue === 'function') GM_setValue(APP.autoFillKey, v);
                else localStorage.setItem(APP.autoFillKey, v ? '1' : '0');
            } catch { /* ignore */ }
        }
    }

    class AIClient {
        constructor(settingsStore) {
            this.settingsStore = settingsStore;
        }

        resolveProviderSettings() {
            const settings = this.settingsStore.load();
            let apiBase = normalizeBaseUrl(settings.aiApiBase || DEFAULT_SETTINGS.aiApiBase);
            const apiKey = normalizeText(settings.aiApiKey || '');
            const model = normalizeText(settings.aiModel || DEFAULT_SETTINGS.aiModel);
            if (!apiKey) throw new Error('未配置 API Key，请先在设置中填写并保存');
            if (!/^https?:\/\//i.test(apiBase)) throw new Error('Base URL 格式不正确');

            let isOfficialDeepSeek = false;
            try { isOfficialDeepSeek = new URL(apiBase).hostname.toLowerCase() === 'api.deepseek.com'; }
            catch { throw new Error('Base URL 不是有效网址'); }
            if (isOfficialDeepSeek) apiBase = apiBase.replace(/\/v1\/?$/i, '');

            const normalizedBase = normalizeBaseUrl(apiBase);
            const url = /\/chat\/completions$/i.test(normalizedBase) ? normalizedBase : `${normalizedBase}/chat/completions`;
            return { apiKey, model, url };
        }

        request(messages, options = {}) {
            const provider = this.resolveProviderSettings();
            const payload = {
                model: provider.model,
                messages,
                temperature: Number(options.temperature ?? DEFAULT_SETTINGS.temperature),
                max_tokens: Number(options.maxTokens ?? DEFAULT_SETTINGS.maxTokens)
            };

            return new Promise((resolve, reject) => {
                if (typeof GM_xmlhttpRequest !== 'function') {
                    reject(new Error('GM_xmlhttpRequest 不可用，请确认脚本管理器授权正常'));
                    return;
                }
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: provider.url,
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
                    data: JSON.stringify(payload),
                    timeout: 60000,
                    onload: (response) => {
                        try {
                            if (response.status < 200 || response.status >= 300) {
                                reject(new Error(this.describeHttpError(response.status, response.statusText, response.responseText)));
                                return;
                            }
                            let json;
                            try { json = JSON.parse(response.responseText || '{}'); }
                            catch (e) {
                                reject(new Error(`响应不是合法 JSON：${normalizeText(response.responseText).slice(0, 200)}`));
                                return;
                            }
                            if (json.error) {
                                reject(new Error(`API 返回错误：${normalizeText(json.error.message || JSON.stringify(json.error)).slice(0, 200)}`));
                                return;
                            }
                            const choice = json.choices?.[0];
                            const message = choice?.message ?? choice?.delta ?? {};
                            let content = this.normalizeMessageContent(message.content).trim();
                            if (!content && message.reasoning_content) {
                                content = this.normalizeMessageContent(message.reasoning_content).trim();
                            }
                            if (!content) {
                                const debug = JSON.stringify({
                                    finish_reason: choice?.finish_reason ?? null,
                                    model: json.model ?? null,
                                    usage: json.usage ?? null,
                                    has_choices: Array.isArray(json.choices)
                                });
                                reject(new Error(`AI 没有返回有效内容。${debug} 原始响应前200字：${normalizeText(response.responseText).slice(0, 200)}`));
                                return;
                            }
                            resolve(content);
                        } catch (error) { reject(error); }
                    },
                    onerror: () => reject(new Error('网络请求失败，请检查网络、代理或 @connect 设置')),
                    ontimeout: () => reject(new Error('请求超时'))
                });
            });
        }

        normalizeMessageContent(value) {
            if (typeof value === 'string') return value;
            if (Array.isArray(value)) return value.map(p => typeof p === 'string' ? p : p?.text ?? '').join('');
            if (value && typeof value === 'object') return String(value.text ?? '');
            return '';
        }

        describeHttpError(status, statusText, bodyText = '') {
            let detail = '';
            try { detail = normalizeText(JSON.parse(bodyText || '{}')?.error?.message || ''); }
            catch { detail = normalizeText(bodyText).slice(0, 160); }
            const hints = { 400: '请求参数错误', 401: 'API Key 无效或未授权', 402: '余额不足', 404: '模型或地址不存在', 429: '请求频率受限', 500: '服务端错误' };
            return `HTTP ${status}：${hints[status] || statusText || '请求失败'}${detail ? ` (${detail})` : ''}`;
        }

        extractJsonObject(raw) {
            let s = normalizeText(raw);
            const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
            if (fence) s = fence[1].trim();
            else s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
            if (!s.startsWith('{')) { const m = s.match(/\{[\s\S]*\}/); if (m) s = m[0]; }
            return JSON.parse(s);
        }

        async analyzeChoicesBatch(choices) {
            const list = choices.map(q => {
                const ctx = q.passage ? `\n【阅读材料】\n${q.passage}\n` : '';
                return `${ctx}[题${q.no}] ${q.stem}\n${q.options.map((o, i) => `${i}. ${o}`).join('\n')}`;
            }).join('\n\n');

            const system = [
                '你是英语考试答题助手。我会给你若干选择题，每题有题号、题干、选项（0=A,1=B,2=C,3=D）。',
                '阅读题会附带阅读材料，请基于材料作答。',
                '必须只返回合法 JSON：{"answers":[{"no":"题号字符串","answer_index":数字索引,"reason":"极简理由"}]}',
                '无法判断的题 answer_index 填 -1。不要输出 markdown 代码块或其他文字。'
            ].join('\n');

            const raw = await this.request(
                [{ role: 'system', content: system }, { role: 'user', content: list }],
                { temperature: 0.1, maxTokens: 4096 }
            );

            try {
                const parsed = this.extractJsonObject(raw);
                const answers = Array.isArray(parsed.answers) ? parsed.answers : [];
                return answers.map(a => ({
                    no: String(a.no ?? ''),
                    answer_index: typeof a.answer_index === 'number' ? a.answer_index : parseInt(a.answer_index, 10),
                    reason: normalizeText(a.reason || '')
                }));
            } catch (e) {
                throw new Error(`选择题 JSON 解析失败：${e.message}；原始返回：${raw.slice(0, 240)}`);
            }
        }

        async analyzeTextBatch(texts, task) {
            const list = texts.map(q => `[题${q.no}] ${q.stem}`).join('\n\n');

            const system = task === 'translate'
                ? '你是翻译助手。英译汉或汉译英，根据原文语言判断方向，给出地道译文。只返回合法 JSON：{"answers":[{"no":"题号","answer_text":"译文"}]}。不要输出 markdown 代码块或多余解释。'
                : '你是英语词汇填空助手。根据句意和括号内提示词，给出该词的正确形式（只填变化后的单词本身）。只返回合法 JSON：{"answers":[{"no":"题号","answer_text":"答案单词"}]}。不要输出 markdown 代码块或多余解释。';

            const raw = await this.request(
                [{ role: 'system', content: system }, { role: 'user', content: list }],
                { temperature: 0.2, maxTokens: 4096 }
            );

            try {
                const parsed = this.extractJsonObject(raw);
                const answers = Array.isArray(parsed.answers) ? parsed.answers : [];
                return answers.map(a => ({
                    no: String(a.no ?? ''),
                    answer_text: normalizeText(a.answer_text || '')
                }));
            } catch (e) {
                throw new Error(`填空题 JSON 解析失败：${e.message}；原始返回：${raw.slice(0, 240)}`);
            }
        }
    }

    class ExamController {
        constructor(ui, aiClient, settingsStore) {
            this.ui = ui;
            this.aiClient = aiClient;
            this.settingsStore = settingsStore;
            this.autoFillEnabled = this.settingsStore.getAutoFill();
            this.running = false;
            this.bindEvents();
            this.ui.updateAutoFillButton(this.autoFillEnabled);
        }

        bindEvents() {
            this.ui.analyzeBtn.addEventListener('click', () => this.analyzeAll());
            this.ui.autoFillBtn.addEventListener('click', () => this.toggleAutoFill());
            this.ui.copyPageTextBtn.addEventListener('click', () => this.copyCollectedText());
        }

        toggleAutoFill() {
            this.autoFillEnabled = !this.autoFillEnabled;
            this.settingsStore.setAutoFill(this.autoFillEnabled);
            this.ui.updateAutoFillButton(this.autoFillEnabled);
            this.ui.log(this.autoFillEnabled ? 'success' : 'warn',
                this.autoFillEnabled ? '已开启自动回填：分析后将自动填入（不提交）' : '已关闭自动回填：仅分析展示不填入');
        }

        collectAllQuestions() {
            const passages = [];
            document.querySelectorAll('.test_sty_4').forEach(sty4 => {
                const passageHov = sty4.closest('.test_hov');
                if (passageHov) {
                    passages.push({ el: passageHov, text: normalizeText(sty4.innerText || sty4.textContent) });
                }
            });

            const allHov = Array.from(document.querySelectorAll('.test_hov'));
            const questionHovs = allHov.filter(h => !h.querySelector('.test_hov'));

            const questions = [];
            for (const hov of questionHovs) {
                const choiceList = hov.querySelector('.choiceList');
                const textInput = hov.querySelector('input[type="text"], textarea, input:not([type]):not([type="radio"]):not([type="checkbox"])');
                const noEl = hov.querySelector('[data-qnum]');
                const no = noEl ? String(noEl.getAttribute('data-qnum')) : (normalizeText(hov.querySelector('.test_number')?.textContent || '').match(/\d+/)?.[0] || '');

                const clone = hov.cloneNode(true);
                clone.querySelectorAll('.choiceList, input, textarea').forEach(e => e.remove());
                const stem = normalizeText(clone.innerText || clone.textContent || '');

                let passage = '';
                for (const p of passages) {
                    if (p.el.contains(hov)) { passage = p.text; break; }
                }

                if (choiceList) {
                    const optionEls = Array.from(choiceList.querySelectorAll('.radio')).filter(el => el);
                    const options = optionEls.map(el => normalizeText(el.innerText || el.textContent));
                    if (options.length) {
                        questions.push({ type: 'choice', no, stem, options, optionEls, passage });
                    }
                } else if (textInput) {
                    questions.push({ type: 'text', no, stem, inputEl: textInput, isTranslate: textInput.tagName === 'TEXTAREA', passage });
                }
            }

            return questions;
        }

        async analyzeAll() {
            if (this.running) {
                this.ui.log('warn', '正在处理中，请稍候');
                return;
            }
            this.running = true;
            this.ui.setStatus('提取题目中...', true);

            // 批次级：钉死 isLeave=false，避免回填期间 autoSaveAnswer 被吞。
            // 用 try/finally 保证无论是否抛错都还原，不影响平台正常防作弊逻辑。
            fillingBatch = true;
            suppressIsLeave(true);
            try {
            const questions = this.collectAllQuestions();
            if (!questions.length) {
                this.ui.log('error', '未识别到任何题目。请确认页面已加载出 .test_hov 内容');
                this.ui.setStatus('待机', false);
                this.running = false;
                return;
            }

            const choices = questions.filter(q => q.type === 'choice');
            const fillIns = questions.filter(q => q.type === 'text' && !q.isTranslate);
            const translations = questions.filter(q => q.type === 'text' && q.isTranslate);

            this.ui.log('info', `识别到 ${choices.length} 道选择题、${fillIns.length} 道填空题、${translations.length} 道翻译题`);

            const unansweredChoices = choices.filter(q => {
                const hov = q.optionEls[0]?.closest('.test_hov');
                return !(hov && isChoiceAnswered(hov)) && !q.optionEls.some(o => o.querySelector('input:checked'));
            });
            const skippedChoice = choices.length - unansweredChoices.length;
            if (skippedChoice) this.ui.log('info', `跳过已作答选择题 ${skippedChoice} 道`);

            const summary = [];

            // 1) 选择题
            this.ui.setStatus('分析选择题中...', true);
            const choiceMap = new Map();
            if (unansweredChoices.length) {
                const groups = [];
                const noPass = unansweredChoices.filter(q => !q.passage);
                if (noPass.length) groups.push(noPass);
                const byPassage = new Map();
                for (const q of unansweredChoices.filter(q => q.passage)) {
                    const key = q.passage.slice(0, 60);
                    if (!byPassage.has(key)) byPassage.set(key, []);
                    byPassage.get(key).push(q);
                }
                for (const g of byPassage.values()) groups.push(g);

                for (let gi = 0; gi < groups.length; gi++) {
                    const g = groups[gi];
                    try {
                        const answers = await this.aiClient.analyzeChoicesBatch(g);
                        for (const a of answers) choiceMap.set(String(a.no), a);
                        this.ui.log('info', `选择题批次 ${gi + 1}/${groups.length} 完成（${g.length} 题，返回 ${answers.length} 条）`);
                    } catch (e) {
                        this.ui.log('error', `选择题批次 ${gi + 1} 失败：${e.message}`);
                    }
                }
            }

            let filledChoice = 0;
            for (const q of unansweredChoices) {
                const a = choiceMap.get(String(q.no));
                if (a && a.answer_index >= 0 && a.answer_index < q.optionEls.length) {
                    const optText = q.options[a.answer_index] || '';
                    summary.push(`题${q.no} [选择] → ${optText}${a.reason ? `  (${a.reason})` : ''}`);
                    if (this.autoFillEnabled) {
                        fillChoice(q.optionEls[a.answer_index]);
                        filledChoice++;
                    }
                } else {
                    summary.push(`题${q.no} [选择] → AI 未确定`);
                }
            }
            this.ui.log(this.autoFillEnabled ? 'success' : 'info',
                `选择题：${this.autoFillEnabled ? `已回填 ${filledChoice}/${unansweredChoices.length}` : `分析 ${unansweredChoices.length} 道（未开启回填）`}`);

            // 2) 填空题：逐题延时填充
            let filledFill = 0;
            if (fillIns.length) {
                this.ui.setStatus('分析填空题中...', true);
                const pendingFill = fillIns.filter(q => !normalizeText(q.inputEl.value));
                if (pendingFill.length) {
                    try {
                        const answers = await this.aiClient.analyzeTextBatch(pendingFill, 'fill');
                        const m = new Map(answers.map(a => [String(a.no), a.answer_text]));
                        for (let i = 0; i < pendingFill.length; i++) {
                            const q = pendingFill[i];
                            const ans = m.get(String(q.no)) || '';
                            summary.push(`题${q.no} [填空] → ${ans || 'AI 未给出'}`);
                            if (this.autoFillEnabled && ans) {
                                this.ui.setStatus(`回填填空题 ${i + 1}/${pendingFill.length}（题${q.no}）...`, true);
                                await fillText(q.inputEl, ans);   // 直接调用平台 autoSaveAnswer
                                await sleep(220);                  // 题间延时，让保存请求排队
                                filledFill++;
                            }
                        }
                    } catch (e) {
                        this.ui.log('error', `填空题分析失败：${e.message}`);
                    }
                }
                this.ui.log(this.autoFillEnabled ? 'success' : 'info', `填空题：已处理 ${fillIns.length} 道${this.autoFillEnabled ? `（回填 ${filledFill}）` : ''}`);
            }

            // 3) 翻译题：逐题延时填充
            let filledTrans = 0;
            if (translations.length) {
                this.ui.setStatus('分析翻译题中...', true);
                const pendingTrans = translations.filter(q => !normalizeText(q.inputEl.value));
                if (pendingTrans.length) {
                    try {
                        const answers = await this.aiClient.analyzeTextBatch(pendingTrans, 'translate');
                        const m = new Map(answers.map(a => [String(a.no), a.answer_text]));
                        for (let i = 0; i < pendingTrans.length; i++) {
                            const q = pendingTrans[i];
                            const ans = m.get(String(q.no)) || '';
                            summary.push(`题${q.no} [翻译] → ${ans.slice(0, 50)}${ans.length > 50 ? '...' : ''}`);
                            if (this.autoFillEnabled && ans) {
                                this.ui.setStatus(`回填翻译题 ${i + 1}/${pendingTrans.length}（题${q.no}）...`, true);
                                await fillText(q.inputEl, ans);
                                await sleep(280);
                                filledTrans++;
                            }
                        }
                    } catch (e) {
                        this.ui.log('error', `翻译题分析失败：${e.message}`);
                    }
                }
                this.ui.log(this.autoFillEnabled ? 'success' : 'info', `翻译题：已处理 ${translations.length} 道${this.autoFillEnabled ? `（回填 ${filledTrans}）` : ''}`);
            }

            this.ui.setResult(summary.join('\n'));
            this.ui.log('success', this.autoFillEnabled ? '全部处理完成，请核对后自行提交' : '全部分析完成（未开启自动回填）');
            this.ui.setStatus('待机', false);
            this.running = false;
            } finally {
                // 批次结束：还原 isLeave，恢复平台正常防作弊行为
                fillingBatch = false;
                suppressIsLeave(false);
            }
        }

        async copyCollectedText() {
            const questions = this.collectAllQuestions();
            if (!questions.length) {
                this.ui.log('warn', '未识别到题目');
                return;
            }
            const text = questions.map(q => {
                if (q.type === 'choice') {
                    const ctx = q.passage ? `\n[阅读材料] ${q.passage.slice(0, 200)}...\n` : '';
                    return `${ctx}[题${q.no} 选择] ${q.stem}\n${q.options.map((o, i) => `${i}. ${o}`).join('\n')}`;
                }
                return `[题${q.no} ${q.isTranslate ? '翻译' : '填空'}] ${q.stem}`;
            }).join('\n\n');
            try {
                await navigator.clipboard.writeText(text);
                this.ui.log('success', `已复制 ${questions.length} 道题`);
            } catch {
                this.ui.setResult(text);
                this.ui.log('warn', '浏览器不允许自动复制，已显示在结果框');
            }
        }
    }

    class PanelUI {
        constructor(settingsStore, aiClient) {
            this.settingsStore = settingsStore;
            this.aiClient = aiClient;
            this.shadowHost = null;
            this.shadow = null;
            this.init();
        }

        init() {
            const existing = document.getElementById(`${APP.id}-host`);
            if (existing) existing.remove();

            this.shadowHost = document.createElement('div');
            this.shadowHost.id = `${APP.id}-host`;
            this.shadowHost.style.cssText = 'position:fixed;top:20px;right:20px;z-index:2147483647;';
            document.body.appendChild(this.shadowHost);

            this.shadow = this.shadowHost.attachShadow({ mode: 'open' });
            this.shadow.innerHTML = `
                <style>
                    :host { all: initial; }
                    * { box-sizing:border-box; font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
                    .panel { width:400px; max-width:calc(100vw - 24px); background:#1e1e2e; color:#cdd6f4; border:1px solid rgba(255,255,255,.1); border-radius:13px; overflow:hidden; box-shadow:0 10px 36px rgba(0,0,0,.38); font-size:12px; user-select:text; }
                    .header { display:flex; align-items:center; justify-content:space-between; padding:12px 14px; background:#313244; cursor:move; user-select:none; }
                    .header h3 { margin:0; font-size:14px; color:#cdd6f4; }
                    .toggle-btn { background:transparent; color:#cdd6f4; border:0; font-size:18px; cursor:pointer; }
                    .body { padding:12px 14px; max-height:calc(100vh - 80px); overflow:auto; }
                    .status { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
                    .dot { width:8px; height:8px; border-radius:50%; background:#f38ba8; flex:none; }
                    .dot.active { background:#a6e3a1; animation:pulse 1.4s infinite; }
                    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.45} }
                    .hint { padding:9px 10px; border-radius:8px; background:#181825; color:#a6adc8; line-height:1.55; margin-bottom:12px; border:1px solid rgba(255,255,255,.07); }
                    .section-title { margin:12px 0 7px; color:#f5c2e7; font-weight:700; font-size:12px; }
                    .settings { display:flex; flex-direction:column; gap:7px; }
                    label { color:#bac2de; font-size:11px; }
                    input { width:100%; border:1px solid rgba(255,255,255,.1); border-radius:8px; background:#181825; color:#cdd6f4; outline:none; padding:8px 9px; font-size:12px; user-select:text !important; pointer-events:auto !important; }
                    input:focus { border-color:#89b4fa; }
                    .btn-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:2px; }
                    button { border:0; border-radius:8px; padding:8px 9px; font-size:12px; font-weight:700; cursor:pointer; }
                    button:hover { opacity:.88; }
                    .btn-save { background:#89b4fa; color:#1e1e2e; }
                    .btn-test { background:#a6e3a1; color:#1e1e2e; }
                    .btn-main { background:#cba6f7; color:#1e1e2e; }
                    .btn-ghost { background:#45475a; color:#cdd6f4; }
                    .btn-autofill { background:#fab387; color:#1e1e2e; }
                    .btn-autofill.on { background:#a6e3a1; color:#1e1e2e; }
                    .result-box, .log-box { white-space:pre-wrap; word-break:break-word; background:#181825; border:1px solid rgba(255,255,255,.07); border-radius:8px; padding:10px; line-height:1.65; }
                    .result-box { min-height:90px; max-height:280px; overflow:auto; }
                    .log-box { height:140px; overflow:auto; font-size:11px; }
                    .log-item { margin-bottom:4px; }
                    .log-info { color:#89b4fa; } .log-success { color:#a6e3a1; } .log-error { color:#f38ba8; } .log-warn { color:#f9e2af; }
                </style>

                <div class="panel">
                    <div class="header" id="dragHeader">
                        <h3>📋 WeLearn 试卷回填助手</h3>
                        <button class="toggle-btn" id="minimizeBtn" type="button">−</button>
                    </div>
                    <div class="body" id="body">
                        <div class="status"><span class="dot" id="statusDot"></span><span id="statusText">待机</span></div>

                        <div class="section-title">🎯 试卷提取与回填</div>
                        <div class="hint">以 .test_hov 为题容器提取全卷（选择+填空+翻译），AI 分析后自动回填。<b>不会自动提交</b>，请核对后自行交卷。回填直接调用平台 autoSaveAnswer，稳定触发答题卡变绿与保存。先点“🔄 重新提取”确认题目数。</div>
                        <div class="btn-row">
                            <button class="btn-main" id="analyzeBtn" type="button">✨ 分析并回填全部</button>
                            <button class="btn-autofill" id="autoFillBtn" type="button">🤖 自动回填：开</button>
                        </div>
                        <div class="btn-row" style="margin-top:8px;">
                            <button class="btn-ghost" id="copyPageTextBtn" type="button">📋 复制识别题目</button>
                            <button class="btn-ghost" id="refreshBtn" type="button">🔄 重新提取</button>
                        </div>

                        <div class="section-title">API 设置</div>
                        <div class="settings">
                            <label>Base URL</label>
                            <input id="apiBaseInput" data-paste-safe="1" placeholder="https://api.deepseek.com">
                            <label>API Key</label>
                            <input id="apiKeyInput" data-paste-safe="1" type="password" placeholder="sk-...">
                            <label>Model</label>
                            <input id="modelInput" data-paste-safe="1" placeholder="deepseek-v4-flash">
                            <div class="btn-row">
                                <button class="btn-save" id="saveBtn" type="button">💾 保存配置</button>
                                <button class="btn-test" id="testBtn" type="button">🔌 测试连接</button>
                            </div>
                        </div>

                        <div class="section-title">回填结果</div>
                        <div class="result-box" id="resultBox">等待操作...</div>

                        <div class="section-title">日志</div>
                        <div class="log-box" id="logBox"></div>
                    </div>
                </div>
            `;

            this.cacheElements();
            this.loadSettingsToForm();
            this.bindInputEventShield();
            this.bindActions();
            this.enableDrag();
            this.log('success', `面板已加载 (${APP.version})`);
        }

        cacheElements() {
            const $ = selector => this.shadow.querySelector(selector);
            this.bodyEl = $('#body');
            this.statusText = $('#statusText');
            this.statusDot = $('#statusDot');
            this.logBox = $('#logBox');
            this.resultBox = $('#resultBox');
            this.apiBaseInput = $('#apiBaseInput');
            this.apiKeyInput = $('#apiKeyInput');
            this.modelInput = $('#modelInput');
            this.analyzeBtn = $('#analyzeBtn');
            this.autoFillBtn = $('#autoFillBtn');
            this.copyPageTextBtn = $('#copyPageTextBtn');
            this.refreshBtn = $('#refreshBtn');
        }

        updateAutoFillButton(enabled) {
            this.autoFillBtn.textContent = enabled ? '🤖 自动回填：开' : '🤖 自动回填：关';
            this.autoFillBtn.classList.toggle('on', enabled);
            this.analyzeBtn.textContent = enabled ? '✨ 分析并回填全部' : '✨ 仅分析全部';
        }

        loadSettingsToForm() {
            const settings = this.settingsStore.load();
            this.apiBaseInput.value = settings.aiApiBase;
            this.apiKeyInput.value = settings.aiApiKey;
            this.modelInput.value = settings.aiModel;
        }

        bindInputEventShield() {
            const stop = event => { if (event.target?.matches?.('input,textarea')) event.stopPropagation(); };
            ['paste', 'keydown', 'input', 'keyup', 'keypress'].forEach(t => this.shadow.addEventListener(t, stop, true));
        }

        bindActions() {
            const $ = selector => this.shadow.querySelector(selector);
            $('#minimizeBtn').onclick = () => { this.bodyEl.style.display = this.bodyEl.style.display === 'none' ? 'block' : 'none'; };
            $('#saveBtn').onclick = () => this.saveSettings();
            $('#testBtn').onclick = async () => {
                if (!this.saveSettings()) return;
                this.setStatus('测试中...', true);
                try {
                    const response = await this.aiClient.request([{ role: 'user', content: '请只回复 OK' }], { maxTokens: 64 });
                    this.log('success', `连接成功：${response}`);
                } catch (error) { this.log('error', error.message); }
                finally { this.setStatus('待机', false); }
            };
        }

        saveSettings() {
            const settings = {
                aiApiBase: normalizeBaseUrl(this.apiBaseInput.value),
                aiApiKey: normalizeText(this.apiKeyInput.value),
                aiModel: normalizeText(this.modelInput.value),
                temperature: 0.1, maxTokens: 2048
            };
            if (!settings.aiApiBase || !settings.aiApiKey) { this.log('error', 'Base URL 和 API Key 不能为空'); return false; }
            this.settingsStore.save(settings);
            this.log('success', '配置已保存');
            return true;
        }

        enableDrag() {
            const header = this.shadow.querySelector('#dragHeader');
            let isDragging = false, startX = 0, startY = 0, startRight = 0, startTop = 0;
            header.onmousedown = event => {
                if (event.target.closest('button,input')) return;
                isDragging = true; startX = event.clientX; startY = event.clientY;
                const rect = this.shadowHost.getBoundingClientRect();
                startRight = window.innerWidth - rect.right; startTop = rect.top;
                event.preventDefault();
            };
            document.addEventListener('mousemove', event => {
                if (!isDragging) return;
                this.shadowHost.style.right = `${startRight - (event.clientX - startX)}px`;
                this.shadowHost.style.top = `${startTop + (event.clientY - startY)}px`;
            });
            document.addEventListener('mouseup', () => { isDragging = false; });
        }

        setStatus(text, active = false) { this.statusText.textContent = text; this.statusDot.classList.toggle('active', active); }
        setResult(text) { this.resultBox.textContent = text; }
        log(type, message) {
            const item = document.createElement('div');
            item.className = `log-item log-${type}`;
            item.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
            this.logBox.appendChild(item);
            this.logBox.scrollTop = this.logBox.scrollHeight;
        }
    }

    function boot() {
        console.log(`%c[WL-ExamFill] ${APP.version} boot @ ${location.href}`, 'color:#cba6f7;font-weight:bold');
        try {
            const settingsStore = new SettingsStore();
            const aiClient = new AIClient(settingsStore);
            const ui = new PanelUI(settingsStore, aiClient);
            const controller = new ExamController(ui, aiClient, settingsStore);
            ui.refreshBtn.addEventListener('click', () => {
                const qs = controller.collectAllQuestions();
                const c = qs.filter(q => q.type === 'choice').length;
                const f = qs.filter(q => q.type === 'text' && !q.isTranslate).length;
                const t = qs.filter(q => q.type === 'text' && q.isTranslate).length;
                ui.log('info', `重新提取：选择题 ${c}，填空题 ${f}，翻译题 ${t}（共 ${qs.length}）`);
                ui.setResult(qs.map(q => {
                    if (q.type === 'choice') return `题${q.no} [选择] ${q.stem.slice(0, 40)}... (${q.options.length}项${q.passage ? '+材料' : ''})`;
                    return `题${q.no} [${q.isTranslate ? '翻译' : '填空'}] ${q.stem.slice(0, 40)}...`;
                }).join('\n'));
            });
        } catch (error) {
            console.error(`[${APP.name}] 启动失败：`, error);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
