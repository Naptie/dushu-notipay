# dushu-notipay

基于 Node.js 与 node-napcat-ts 的应用程序，用于查询并提醒苏州独墅湖科教创新区（慧湖通科教服务）学生公寓的水电缴费事项。

## 功能

- **获取账号 ID**：按 Win+R 运行 [wxmp-storage-dumper](https://github.com/Naptie/wxmp-storage-dumper) 的一行命令，读取 `openId`。
- **绑定账号**：私聊 Bot 发送 `bind <openId>`，自动校验并列出你名下登记的全部房间。
- **余额查询**：`query` 实时查询所有绑定房间的余额，并附带历史趋势图（chart.js 渲染 PNG）。
- **定时通知**：`notify <小时> [阈值]` 每天固定时间（或仅当余额低于阈值时）推送账单报告。
- **自动更新**：每天固定 10:00 自动采集一次余额并记录历史，用于趋势与 24 小时变化。

## 工作原理

「慧湖通」小程序通过 `satoken`（JWT）访问 `https://api.215123.cn`。本项目使用你在小程序中留下的微信 openId 调用 `certificateLogin` 接口换取新的 satoken，随后即可查询余额。

注意事项：

- 每次换取新 token 都会使旧 token 失效（包括你手机/电脑上小程序正在使用的会话）。小程序会在下次需要登录时静默重新登录，通常无感知。
- 未携带有效 token 时，余额接口会返回 `--` 而不是报错，因此本项目在拿到 `--` 时会自动换发 token 并重试。
- openId 是账号凭证；只通过 Bot 私聊的 `bind` 流程提交。本项目使用 AES-256-GCM 将其加密存储。

## 找到自己的 ID

无需克隆本项目或安装开发环境。需要一台 Windows 10/11 x64 电脑，并登录微信 Windows 4.x 客户端。

1. 按 **Win+R**，粘贴并运行：

   ```powershell
   powershell -NoProfile -c "iex (irm https://raw.githubusercontent.com/Naptie/wxmp-storage-dumper/main/scripts/install.ps1)"
   ```

2. 按提示在微信中打开「慧湖通」小程序；若它已经打开，请先完全关闭再重新打开。
3. 确认输出的 `appId` 是 `wx2660b404a3b7575a`，然后复制 `openId`。
4. 私聊 Bot 发送 `dushu-notipay bind <openId>`。Bot 会验证账号并回复已登记房间。

`openId` 是账号凭证，请只通过 Bot 私聊发送，不要公开分享。提取器默认只读取 `openId`，无需使用 `--dump`。

## 配置

复制 `config.example.json` 为 `config.json` 并填写：

```json
{
  "napcatWs": "ws://127.0.0.1:3001",
  "napcatToken": "your_napcat_token",
  "encryptionKey": "your_encryption_key_64_hex_chars",
  "commandNames": ["dushu-notipay", "dnp"],
  "billingRetryCount": 3,
  "apiBaseUrl": "https://api.215123.cn"
}
```

- `napcatWs` / `napcatToken`：NapCat（OneBot 实现）的 WebSocket 地址与 Access Token。
- `encryptionKey`：用于加密存储 openId 的主密钥，可用
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 生成。
- `commandNames`：群聊/私聊中触发本 Bot 的命令词。
- `apiBaseUrl`：慧湖通 API 地址，一般无需修改。

`config.json` 已被 gitignore，请勿提交到仓库。

## Bot 命令

| 命令                                | 说明                                               |
| ----------------------------------- | -------------------------------------------------- |
| `<cmd> bind`                        | 查看如何获取自己的 openId                          |
| `<cmd> bind <openId>`               | 绑定账号（仅限私聊），自动列出并绑定名下登记房间   |
| `<cmd> unbind`                      | 解绑账号及其全部数据                               |
| `<cmd> rooms`                       | 查看已绑定房间及最新余额                           |
| `<cmd> query [起始时间] [结束时间]` | 查询当前余额与历史趋势（别名 `bills`）             |
| `<cmd> notify list`                 | 查看定时通知                                       |
| `<cmd> notify <小时> [阈值]`        | 设置每日定时通知（设置阈值后仅余额低于阈值时发送） |
| `<cmd> unnotify`                    | 取消当前会话的定时通知                             |
| `<cmd> help`                        | 帮助                                               |

时间格式支持：`7h` / `3d` / `2w`（相对时间）、`1030`、`10302330`（MMDD / MMDDHHMM）、`10-30|23:30`（带分隔符）。

## 自动更新时间

账单历史每天 **10:00**（服务器本地时间 UTC+8）自动更新一次，所有用户同一时刻更新，因此历史记录始终是「一天一个点」的均匀网格，趋势图不会因为各用户绑定时间不同而参差不齐。

- 该时间点由 `src/core/constants.ts` 中的 `DAILY_UPDATE_HOUR` 统一控制。
- 定时通知（`notify`）在各自设定的小时触发，会实时查询余额，但**不会**写入历史，因此不会打乱每日网格。
- 若进程在 10:00 处于离线状态，恢复后会在当天的下一个整点补采一次，记录的时间戳仍固定为当天的 10:00。

## 管理员工具

```bash
pnpm db-cli help             # 用户/房间/历史记录管理
pnpm notify-cli help         # 定时通知管理
pnpm chart-harness           # 渲染图表并逐字测量字体基线（排查中英文错位）
```

图表文字统一使用随仓库分发的 Noto Sans SC（`fonts/`，SIL OFL 许可）。不要把仅含拉丁字形
的字体放在字族栈首位：node-canvas 会让回退的中文字形下沉约 0.2em，导致「8号楼7F709」这类
中英混排标题出现错位。`pnpm chart-harness` 会渲染生产配置与若干备选字族栈，输出对比图到
`tmp/chart-harness/`，并对 `CHART_FONT_STACK` 做基线对齐断言（错位超限时退出码非 0）。

## 部署运行

```bash
pnpm install
pnpm build
pnpm start          # 生产（需先 build）
# 或
pnpm dev            # 开发热重载
```

### 以 pm2 常驻（mac）

```bash
pm2 start dist/index.js --name dushu-notipay --interpreter /opt/homebrew/bin/node --cwd /Users/naptie/dushu-notipay
pm2 save            # 重要：机器重启后 pm2 resurrect 依赖这份 dump
```

注意事项：

- `better-sqlite3` 与 `canvas` 是原生模块。升级 Node 后必须重新编译，否则进程会因 `ERR_DLOPEN_FAILED` 反复崩溃：

  ```bash
  pnpm rebuild better-sqlite3 canvas
  codesign --force --sign - node_modules/.pnpm/canvas@*/node_modules/canvas/build/Release/canvas.node
  ```

  `canvas` 的预编译包在重装时会覆盖写入，导致原有代码签名失效，macOS 会在 dlopen 时直接杀掉进程（`SIGKILL (Code Signature Invalid)`），因此重装后需要重新签名。

- `napcatWs` 指向服务器的 Tailscale 地址。Tailscale 掉线时 Bot 收不到任何消息，但进程不会退出，会自动重连；恢复后自动继续。

## 代理配置

如果需要通过代理访问网络，可以设置以下环境变量：

```bash
# HTTP/HTTPS 代理
export HTTP_PROXY=http://username:password@proxy-host:port
export HTTPS_PROXY=http://username:password@proxy-host:port

# SOCKS5 代理（优先级高于 HTTP 代理）
export SOCKS_PROXY=socks5://username:password@proxy-host:port
export SOCKS5_PROXY=socks5://username:password@proxy-host:port
```

应用程序将自动检测并使用配置的代理进行所有 HTTP/HTTPS 请求。

## 免责声明

本项目仅供学习与个人查询使用，请勿用于任何商业用途。使用本项目产生的任何问题与开发者无关。请合理控制查询频率，避免对慧湖通服务造成压力。
