# WeLearn 试卷分析与自动回填助手

一个适配 [WE Test 智能测试系统](https://wetest.sflep.com/test/welearnTest.html)（wetest.sflep.com）的 Tampermonkey 油猴脚本。自动提取全卷题目（选择 + 填空 + 翻译），调用 AI 分析作答后回填，并稳定触发答题卡变绿与服务端保存。**不会自动提交**，请核对后自行交卷。

当前版本：`3.12-exam-fill`

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
2. 新建脚本，将 `WeLearn-exam-fill-3.12.user.js` 的全部内容粘贴进去，保存。
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
| 保存请求的 `partNum` 取全局 `curPartNum`，而非题目所属 Part | "绿了但没保存，刷新就没了"；切到对应 Part 再回填才成功 | `directSaveAnswer` 用题目所属 Part 号保存 |
| 脚本因 `@grant` 运行在 Tampermonkey 沙箱，`window` ≠ 页面真实 window | `paperAnswer`/`autoSaveData` 等平台变量访问不到 → 保存请求不发、paperAnswer 不写 → "绿了但不保存" | 用 `unsafeWindow`（别名 `pageWin`）访问平台真实变量 |

### 最终方案：`directSaveAnswer`

即便用赋值法 + 临时摘除 `window.onblur`，async 的 `await sleep()` 会让出主线程，期间真实 blur 仍可能把 `isLeave` 设回 true，导致批量回填时"只绿第一道、后面被吞"。

**釜底抽薪**：新增 `directSaveAnswer(el, partNum)`，直接复刻 `autoSaveAnswer` 的变绿 + 存档核心逻辑（写 `paperAnswer` → 加 `answer_sheet_2` → 调 `autoSaveData` POST），**完全不读 `isLeave`**，免疫一切时序问题。`triggerPlatformSave` 优先走它，`bankedCloze` 类型先过 `CheckBankedClozeInput` 校验再保存。

**沙箱隔离修复**：脚本因 `@grant GM_*` 运行在 Tampermonkey 沙箱里，`window` 是沙箱 window，不是页面真实 window。所有平台变量（`paperAnswer`、`autoSaveAnswer`、`autoSaveData`、`curPartNum`、`isLeave`、`testEnv`、`jQuery` 等）都挂在页面真实 window 上，沙箱访问不到。诊断日志显示 `paperAnswer不存在！` 正是此因——value 取到了、变绿了（DOM 操作不依赖 window），但 paperAnswer 写不进、保存请求发不出。改用 `unsafeWindow`（脚本内别名 `pageWin`）后，平台变量全部可访问，保存链路打通。

**partNum 修复**：`directSaveAnswer` 的保存请求用题目所属 Part 号（`collectAllQuestions` 时从 `.partDiv` 容器 id 解析记录），而非全局 `curPartNum`。平台服务端按 `partNum` 归档答案——若翻译题在 Part 3 但 `curPartNum=1`，请求带 `partNum=1` 会被拒收，表现为"前端变绿但服务端没存，刷新就没了"。用题目自身 Part 号后即稳定保存。

**SelPart 切换修复**：仅给请求带正确 `partNum` 还不够——服务端保存还要求题目所在 Part 当前可见（`curPartNum` 已更新 + `.partDiv` 已 show）。实测：停在 Part 1 回填 Part 3 翻译题、或在 Part 3 回填 Part 2 填空题，都会"绿了但不保存"；只有当前可见 Part 的题能保存。因此回填每题前先 `ensurePart(q.partNum)` → `SelPart(partNum)` 真正切过去，让保存走平台期望的完整路径。

实测：手动同步连调多道翻译题可全部变绿；脚本批量回填经 `directSaveAnswer` 后翻译题不再"每次只绿一道"。

## 文件结构

```
WeLearnScripts/
├── WeLearn-exam-fill-3.12.user.js   # 主脚本
└── README.md
```

## 免责声明

- 本脚本仅用于**个人学习与作业辅助**，请遵守学校与平台的考试纪律。正式考试请诚信作答，自行承担使用风险。
- 脚本不会自动提交，所有作答需你本人核对后手动交卷。
- AI 生成的答案不保证正确，务必复核。

## License

MIT
