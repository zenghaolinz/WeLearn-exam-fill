# WeLearn 试卷分析与自动回填助手

一个适配 [WE Test 智能测试系统](https://wetest.sflep.com/test/welearnTest.html)（wetest.sflep.com）的 Tampermonkey 油猴脚本。自动提取全卷题目（选择 + 填空 + 翻译），调用 AI 分析作答后回填，并稳定触发答题卡变绿与服务端保存。**不会自动提交**，请核对后自行交卷。

当前版本：`3.9-exam-fill`

## 功能特性

- **全卷提取**：以 `.test_hov` 为题容器，提取选择题、填空题、翻译题，阅读题自动附带材料。
- **AI 批量分析**：选择题按"无材料 / 按材料"分组批量请求；填空、翻译分别走专用 prompt。
- **稳定回填**：
  - 选择题：点击 `.radio` 触发平台选中态 + 兜底保存。
  - 填空 / 翻译：写入 value 后直接调用平台保存逻辑，逐题延时。
- **绕开 isLeave 拦截**：核心修复。详见下方[技术说明](#技术说明)。
- **悬浮面板**：Shadow DOM 隔离，可拖动，含 API 设置、测试连接、日志、结果框。
- **API Key 安全存储**：Key 走 `GM_setValue` 加密存储，不落 localStorage 明文。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox 均可）。
2. 新建脚本，将 `WeLearn-exam-fill-3.4.user.js` 的全部内容粘贴进去，保存。
   - **重要**：请用文本编辑器（VSCode / 记事本）打开文件后 `Ctrl+A` 全选复制，**不要从网页预览框复制**——预览框会插入"预览已截断"占位文本，导致脚本语法错误无法加载。
3. 打开试卷页 `https://wetest.sflep.com/test/welearnTest.html*`，右上角出现悬浮面板即安装成功。

## 使用

1. 在面板 **API 设置** 区填写：
   - **Base URL**：默认 `https://api.deepseek.com`
   - **API Key**：你的 DeepSeek Key（`sk-...`）
   - **Model**：默认 `deepseek-v4-flash`
2. 点 **保存配置**，再点 **测试连接** 确认通畅。
3. 点 **分析并回填全部**，等待日志框显示"全部处理完成"。
4. 核对答题卡与答案后，**自行点交卷**。

### 关于默认模型

脚本默认模型填 `deepseek-v4-flash`。
## 技术说明

### 为什么自己写保存逻辑，而不是直接填 value？

平台 `WelearnTest.js` 的作答状态（答题卡变绿 + 服务端保存）**完全由 `autoSaveAnswer` 函数驱动**，不是单纯依赖 DOM value。该函数绑定在元素的 `blur` 事件上，而非 `input` / `keyup` / `change`：

```js
$('input:text').each(function(){ ... obj.blur(autoSaveAnswer); });
$('textarea:not([id="txtLogInfo"])').each(function(){
    obj.blur(function(e){ ... autoSaveAnswer(e); });
});
```

`autoSaveAnswer` 内部同步完成两件事：给 `#aQuestion<qnum>` 加 `answer_sheet_2` class（变绿），并把答案写入 `paperAnswer` 后 POST `saveQuestion`。

### 三个坑与对应解法

| 坑 | 现象 | 解法 |
|----|------|------|
| 合成 `blur` 事件走不进 jQuery 1.11 监听器 | 填了 value 但题号不变绿 | 直接调用平台函数，不依赖合成事件 |
| `autoSaveAnswer` 第一行 `if(isLeave) return` | 自动化期间窗口失焦，`isLeave=true`，保存被静默吞掉 | 见下 |
| `isLeave` 是顶层 `var` 全局变量，`configurable:false` | `Object.defineProperty` 重定义会抛 `Cannot redefine property` | 用赋值法 `window.isLeave=false` |

### 最终方案：`directSaveAnswer`

即便用赋值法 + 临时摘除 `window.onblur`，async 的 `await sleep()` 会让出主线程，期间真实 blur 仍可能把 `isLeave` 设回 true，导致批量回填时"只绿第一道、后面被吞"。

**釜底抽薪**：新增 `directSaveAnswer(el)`，直接复刻 `autoSaveAnswer` 的变绿 + 存档核心逻辑（写 `paperAnswer` → 加 `answer_sheet_2` → 调 `autoSaveData` POST），**完全不读 `isLeave`**，免疫一切时序问题。`triggerPlatformSave` 优先走它，`bankedCloze` 类型先过 `CheckBankedClozeInput` 校验再保存。

实测：手动同步连调多道翻译题可全部变绿；脚本批量回填经 `directSaveAnswer` 后翻译题不再"每次只绿一道"。

## 文件结构

```
WeLearnScripts/
├── WeLearn-exam-fill-3.4.user.js   # 主脚本（内容为 3.9 版）
└── README.md
```

## 免责声明

- 本脚本仅用于**个人学习与作业辅助**，请遵守学校与平台的考试纪律。正式考试请诚信作答，自行承担使用风险。
- 脚本不会自动提交，所有作答需你本人核对后手动交卷。
- AI 生成的答案不保证正确，务必复核。

## License

MIT
