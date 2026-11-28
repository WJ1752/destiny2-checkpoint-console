# 命运 2 检查点指挥台

Windows 桌面工具。在本机识别公益频道的直播画面，推荐检查点来源，并按频道规则提交申请指令。

## 使用

1. 解压完整便携包，双击 `D2Checkpoint.exe`。勾选「自动轮询」后，程序会在后台依次读取监测频道，每轮结束约 2 分钟后再读。设置会保留，工作台收起到托盘后仍可轮询。点击「一键读取进度」可随时启动一轮后台读取。取消或中断后，等当前读取停止即可重新开始。
2. 默认频道为 `d2checkpoints`、`soloraidsbot`、`luckbot9`、`destinycheckpoints`、`travelerschosenteam`、`d2chests` 和 `destiny2checkpoints`。两张不同画面都识别到同一节点后，工作台将其标为已确认。也可打开单个频道手动识别，或导入浏览器里的直播截图。
3. 首次使用时点击工作台的「登录 Twitch」，在程序打开的 Twitch 官方网页中完成登录。同一 Windows 用户重启程序或切换频道时会复用仍有效的会话，Twitch 要求重新验证时请在网页中完成。
4. 输入完整 Bungie ID（例如 `Guardian#1234`），选择活动节点和难度，点击「匹配并发送」。程序会跳过队列已关闭的频道，比较等待估时和队列长度，并在匹配到的频道提交一次申请指令。是否入队以频道机器人回复为准。

便携版通过 Twitch 网页会话发送申请，无需配置 Twitch 开发者应用。分发者也可通过 `D2_TWITCH_CLIENT_ID` 启用可选 API 授权，用于每分钟检查这些频道的公开直播预览。 [Twitch 应用注册](https://dev.twitch.tv/docs/authentication/register-app/) · [直播接口](https://dev.twitch.tv/docs/api/reference/streams#get-streams)

7 个默认频道均支持按频道规则自动生成申请指令。申请要求进度已确认并仍有效，且活动、节点与难度有对应规则。部分机器人自定义节点会显示直播看板名称。 [运营方队列助手](https://www.travelerschosen.org/#/queuehelper) · [Bungie Manifest](https://bungie-net.github.io/multi/operation_get_Destiny2-GetDestinyManifest.html)

直播预览和手动截图在本机内存中识别。WebView2 在本机保存网页登录会话。提交申请时，指令中的 Bungie ID 会出现在所选频道的聊天中。

## 自动更新

每次启动时，便携版会检查项目的 GitHub Releases。发现新版会自动下载、校验并启动新版。检查或下载失败时会继续打开本机版本。安装目录需要有当前用户的写入权限，频道设置和 Twitch 登录仍保存在用户目录。旧便携包需要先手动解压一次支持自动更新的版本。 [Windows 发布页](https://github.com/WJ1752/destiny2-checkpoint-console/releases/latest)

## 从源码运行与验证

截图与直播预览识别要求 Windows。内嵌直播要求 Microsoft Edge WebView2 Runtime。便携包包含 Node.js。

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

- `desktop/main.js`：仅监听回环地址的本地会话、频道监测、进度推荐与申请。
- `desktop/twitch.js`、`desktop/checkpoint-sources.js`：Twitch 官方接口、已核实的频道指令及其来源。
- `desktop/vision.js`、`desktop/vision-ocr.ps1`：画面解析与本机 Windows OCR；图片通过标准输入和内存流处理。
- `launcher/Program.cs` 提供 Windows 托盘启动器、本机工作台以及用于手动读取和后台轮询的 Twitch WebView2 窗口。
- `desktop/ui/`：简体中文本机工作台。
