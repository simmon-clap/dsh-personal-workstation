# Mini 失联恢复 + 常驻加固（回家照着做）

> 起因：2026-10-16 上午，mini 在办公室访问时整体失联（Tailscale offline、SSH/屏幕共享/DSH 端口全不通、微信也不回）。
> 根因判断：**mini 睡着了**。Tailscale 与 DSH 都因此停摆。
> 本文是**一次性做完**的恢复 + 加固清单。做完之后，这类失联不该再发生。

---

## 一、回家先恢复（约 2 分钟）

| # | 做什么 | 怎么算成功 |
| --- | --- | --- |
| 1 | 碰一下 mini（动鼠标/键盘，或按一下电源键）把它唤醒 | 屏幕亮、能用 |
| 2 | 看菜单栏有没有 Tailscale 图标 / 或开终端敲 `~/.homebrew/bin/tailscale --socket=~/tailscale-userspace/tailscaled.sock status` | 显示 `Online: True` |
| 3 | **如果显示连不上**：tailscaled 没在跑（它是手动起的，休眠后就没了），重新起： | 见下面「重启 tailscaled」 |

### 重启 tailscaled（不需要 sudo）

```bash
cd ~/tailscale-userspace
nohup ~/.homebrew/bin/tailscaled \
  --tun=userspace-networking \
  --socks5-server=localhost:1055 \
  --state=~/tailscale-userspace/tailscaled.state \
  --socket=~/tailscale-userspace/tailscaled.sock > tailscaled.log 2>&1 &
sleep 3
~/.homebrew/bin/tailscale --socket=~/tailscale-userspace/tailscaled.sock status
```

**不需要重新授权**（状态文件里已有节点身份，之前 `tailscaled.state` 已从 2 字节长到 2,911 字节）。

---

## 二、加固（这次必须做，否则还会断）

### ① 关休眠 —— 最关键

Mac mini 默认会睡。**睡了 = Tailscale 断、DSH 挂、09:30/21:00 的简报不会来。**

```bash
sudo pmset -a sleep 0 disablesleep 1
```

> 要管理员密码。可以在 mini 跟前输，或透过屏幕共享输。
> 验证：`pmset -g | grep -E "^\s*sleep|disablesleep"` → `sleep 0`。

### ② tailscaled 开机自启（不需要 sudo）

写 `~/Library/LaunchAgents/com.simon.tailscaled.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.simon.tailscaled</string>
  <key>ProgramArguments</key><array>
    <string>/Users/simmon/.homebrew/bin/tailscaled</string>
    <string>--tun=userspace-networking</string>
    <string>--socks5-server=localhost:1055</string>
    <string>--state=/Users/simmon/tailscale-userspace/tailscaled.state</string>
    <string>--socket=/Users/simmon/tailscale-userspace/tailscaled.sock</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/simmon/tailscale-userspace/tailscaled.log</string>
  <key>StandardErrorPath</key><string>/Users/simmon/tailscale-userspace/tailscaled.err.log</string>
</dict></plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/com.simon.tailscaled.plist
launchctl list | grep tailscale          # 有输出即成功
```

`KeepAlive=true` 的含义：**它死了会被自动拉起来** —— 不用再等人。

### ③ DSH 开机自启

mini 的 DSH 是**桌面版 App**（`DeepSeek Harness.app`），现在不是开机自启的。

- **简单做法**：系统设置 → 通用 → 登录项 → 加上 `DeepSeek Harness`
- 这样重启后 DSH 自己回来，微信通道也自己恢复

### ④ 顺手清掉三个残留（它之前报过，我确认可以清）

| 是什么 | 处置 |
| --- | --- |
| `com.simon.capture.plist`（开机截图，一直失败） | 删掉 |
| `ai-daily/send_feishu.sh` + `collect_and_send.sh`（0 字节空文件，cron 每天 9:40 空跑） | 删脚本 + 删那条 cron |
| `ai.openclaw.gateway.plist` 里明文 API key | 挪到钥匙串或改成 600 权限的单独文件 |

---

## 三、加固之后应当成立的验收（我从办公室远程做）

| # | 验收 | 怎么测 |
| --- | --- | --- |
| 1 | 三个端口通 | `nc -z 100.103.17.44 22/5900/19387` |
| 2 | SSH 免密进得去 | `ssh simmon@100.103.17.44` |
| 3 | **睡一晚之后仍然通**（最关键的验收） | 第二天早上我再测一次 |
| 4 | 重启 mini 之后自动恢复 | 重启后我不碰它，看 Tailscale/DSH 是否自己回来 |
| 5 | 简报按时到（09:30 / 21:00） | 微信里有没有收到 |

---

## 四、教训（写下来防再犯）

1. **「手动起的、重启不会自恢复」不是可以等等再做的事** —— 我把它标成"等链路定型"，结果当天就因此失联。
2. **常驻节点必须先关休眠** —— 这是常驻的**前提**，不是优化项。没关休眠的机器根本不是常驻节点。
3. **失联时我没有任何后路** —— 因为 mini 上唯一的入口（Tailscale）本身是需要人维护的东西。以后要保证：**至少有两条独立通道**（例：Tailscale + 开机自启的 SSH 兜底）。
