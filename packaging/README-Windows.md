# Windows x64 便携版构建

`Build-Windows.ps1` 生成 `release/` 目录形式的 Windows x64 便携软件。解压整个文件夹后双击 `D2Checkpoint.exe` 启动。服务仅绑定 `127.0.0.1`，提供直播画面识别、检查点推荐和频道申请指令。

## 发布构建先决条件

- Windows x64。
- .NET 10 SDK（仅构建机需要），可从 [Microsoft .NET 10 下载页](https://dotnet.microsoft.com/download/dotnet/10.0) 安装。发布产物使用 `--self-contained true`，最终用户不需安装 .NET。WebView2 NuGet SDK 包在构建期间恢复；WebView2 运行时本身不捆绑。
- 构建期间可访问 `nodejs.org` 下载官方 x64 Node.js 与校验和；NuGet 可访问，用于恢复 WebView2 SDK 包。
- 合并完成后的 `desktop/` 服务应包含 `desktop/main.js`、`desktop/ui/index.html`、`desktop/ui/app.js`、`desktop/ui/styles.css` 及其他服务帮助文件。构建脚本只收集 `desktop/` 服务和显式 npm 清单，不复制根目录历史原型或整个个人工作目录。

在项目根目录运行：

```powershell
.\packaging\Build-Windows.ps1
```

脚本使用官方 Node.js `22.23.3` Windows x64 压缩包并校验官方 SHA-256，然后生成 `release/D2Checkpoint.exe`、`release/runtime/node.exe`、`release/app/desktop/**` 及说明文件。Node.js 运行时许可一同放在 `release/runtime/`。分发时请包含完整目录。

## 启动行为

- 启动器以无窗口方式启动内置 Node 服务，选择系统分配的临时端口，并读取 `D2_READY http://127.0.0.1:<port>/` 就绪行。
- 启动秘钥通过原生 HTTP header 仅用于本机首次根页面请求。它不写入网址、子进程参数、程序日志或提示框；会话以服务端设置的 `HttpOnly`、`SameSite=Strict` cookie 继续。
- 默认由用户在程序内打开 Twitch 官方网页登录，再在工作台确认并发送指令。发送使用已登录的 Twitch 网页会话。机器人回复确认入队结果。
- 分发者设置公共 `D2_TWITCH_CLIENT_ID` 后，可通过 Twitch API 自动检查已配置频道的在线状态和公开预览。Windows 启动器为 Node 启用系统信任证书和 HTTPS 代理，回环地址始终直连。
- WebView2 Runtime 可用时显示本机工作台与独立 Twitch 浏览窗口。Twitch 窗口只允许 Twitch 官方 HTTPS 页面；用户必须自行完成登录和播放。
- 工作台的「一键读取进度」会在内置 Twitch 窗口依次读取监测频道的可见直播画面，逐频道显示结果。捕获图片仅传入本机 OCR。工作台会在读取失败时继续下一频道，用户可取消批次。
- Twitch 窗口的“识别当前画面”按钮手动触发截图。每 15 秒自动识别默认关闭，且在导航、离开窗口或捕获页面无效时自动停止。截图由本机 OCR 处理，不写入截图文件；本机状态只保存识别结果和有限的频道观察。
- 截图是当前 WebView 可见页面，不一定仅包含视频内容。请勿在登录、密码、验证码或账号安全验证页面捕获；页面弹层也可能包含额外文字，开启自动识别前请确认画面并在切页前关闭。
- 本机 WebView2 用户数据目录用于维持用户自行进行的网页登录会话；程序不读取或导出该目录的 Cookie/凭据。若 WebView2 Runtime 不可用，桌面 Twitch 捕获功能不可用，需安装 Microsoft Edge WebView2 Runtime 后重试。
- 启动器会在 `%LOCALAPPDATA%\D2Checkpoint\startup.log` 记录脱敏启动阶段和错误，不记录截图、密钥、Cookie、OCR 内容或服务输出。

## 项目自检

服务和会话握手（本机需已有 Node.js）：

```powershell
.\packaging\Smoke-Test.ps1
```

项目单元测试：

```powershell
npm test
```

测试打包时，可用 `Smoke-Test.ps1 -ReleaseRoot release` 验证便携包中的 Node 服务、启动会话与 screen-scan API。桌面集成测试还应确认 Twitch 窗口中手动捕获、默认关闭的 15 秒自动识别、导航/失焦时暂停，以及只将成功截图送入本地工作台。不记录截图或个人账号数据。
