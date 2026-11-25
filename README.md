# 命运 2 检查点本机识别工具

Windows 桌面工具：在内嵌的 Twitch 官方网页中自行登录或观看公开频道，再由本机截取当前可见页面并用 Windows OCR 识别检查点。**不需要 Twitch 开发者应用、Client ID 或 API OAuth**；不发送聊天，也不读取密码/Cookie或绕过 Twitch 的登录与 2FA。

## 使用

1. 解压完整便携包，双击 `D2Checkpoint.exe`。
2. 在工作台输入 Twitch 频道登录名并打开页面；在 Twitch 窗口中自行登录、完成安全验证并播放频道。
3. 确认显示的是公开频道页面且视频清晰后，点击窗口工具栏的“识别当前画面”。15 秒自动识别默认关闭；仅在确认画面适合持续识别时手动勾选启用。
4. 在工作台查看 OCR 候选并人工核对。连续两张不同画面识别到相同进度才会标记为已确认；OCR 仍可能误读。队列估时只在本机观察到足够的队列变化样本后给出，否则显示未知。

**隐私提醒：**截取的是 Twitch WebView 当前显示的整页，不保证只包含直播视频；网页覆盖层和聊天也可能进入截图。不要在登录、密码、验证码或账号安全验证页面截取。切换页面或离开 Twitch 窗口会停止自动识别。截图仅在本机内存中传给 OCR 处理，不写成截图文件、不发往外部服务；本机只保留 OCR 状态、频道及检查点结果等必要数据。Twitch WebView 使用单独的本地浏览器配置目录以维持用户自行进行的网页登录会话，程序不读取或导出该会话数据。

## 从源码运行与验证

最终桌面捕获功能要求 Windows 和 Microsoft Edge WebView2 Runtime。便携包包含 Node.js，无须用户另装 Node.js。

构建机需要 Windows x64、.NET 10 SDK，以及可访问 `nodejs.org` 和 NuGet；在仓库目录运行：

```powershell
.\packaging\Build-Windows.ps1 -OutputDirectory release-screen-ocr
```

项目测试：

```powershell
npm test
.\packaging\Smoke-Test.ps1
```

对已构建的便携目录运行服务冒烟检查：

```powershell
.\packaging\Smoke-Test.ps1 -ReleaseRoot .\release-screen-ocr
```

## 主要组成

- `desktop/main.js`：仅监听回环地址的本地会话、画面 OCR API 与频道观察数据。
- `desktop/vision.js`、`desktop/vision-ocr.ps1`：画面解析与本机 Windows OCR；图片通过标准输入和内存流处理。
- `launcher/Program.cs`：Windows 托盘启动器、本机工作台和隔离的 Twitch WebView2 窗口；页面变化或失焦时停止捕获。
- `desktop/ui/`：简体中文本机工作台。
