# 安全模型 / Security model

这份文档说明 **dsh-den** 信任什么、能读什么、会在你不在的时候做什么、以及它那道
"审批闸门"到底拦得住什么。它从实现（`src/gate.js`、`src/grant.js`、`src/watcher.js`、
`src/index.js`、`src/conversation.js`、`src/panel-api.js`）里读出来；**如果文档和代码
不一致，以代码为准，那说明这份文档是个 bug。**

> 一句话：这是一个**常驻**的助手——它按 60 秒心跳观察这台机器上所有会话，把结论写进
> `$DSH_HOME/den/`，并且**只有你亲手打出一条带 token 的消息**之后，它才会在你不在的
> 时候自己花一轮模型调用、往某个会话里说一句话。它自己不改你的项目文件；它装的那道
> 闸门是**按工具参数做正则分类**，不是沙箱。

## 信任边界

插件跑在 DSH 宿主进程里，`inject: ['agents', 'tools', 'webServer']`（`src/index.js`）。
它有三块对外表面：

| 表面 | 谁触发 | 这一层有没有鉴权 |
| --- | --- | --- |
| **审批闸门**：`tools.guard` + `tools/pre-execute`（`src/gate.js`） | 本 profile 里**每一次**工具调用（包括它自己的） | 不是鉴权，是启发式分类：allow / ask / deny |
| **面板路由** `/dsh-den`（`ctx.webServer.register`，`src/panel-route.js`） | 能访问 DSH web server 的人 | **没有自己的 token**；边界是宿主 web server |
| **心跳与自唤醒**（`timer`，`src/index.js`） | 插件自己，每 60 秒一跳 | 花费模型调用前要求"人权"（见下） |

**视为不可信输入的**：

- **宿主里发生的每一次工具调用**——工具名、参数文本都会进 `classifyCall`，闸门据此决定
  放行/询问/拒绝；
- **磁盘上的会话日志**：`$DSH_HOME/sessions` 下**所有**会话（最多 300 个，每个只读尾部
  256 KiB，最多 4 MiB），用来发现"某个会话上一轮失败了"；日志内容由别的会话/模型写入，
  本插件不信任它的格式，解析失败就当作没有；
- **`$DSH_HOME/den/` 下的每个文件**：grants、tasks、memory、triggers、notices 都是
  JSON，读的时候逐字段校验，坏文件降级成"没有"，**不当作授权**；
- **面板请求体**：`/dsh-den` 的 POST body，动作名与参数都当字符串处理，未知动作 404。

## 那道闸门拦什么、拦不住什么（照实写）

`src/gate.js` 对每次工具调用做两件事：

- **拒绝（不可翻案）**：凭据形状的路径（`.dsh/.credentials.yaml`、`.codex/auth.json`、
  `.codex/rules/default.rules`、`%APPDATA%\GitHub CLI\hosts.yml` 等）、私钥、`.env`；
  这些规则装在 `tools.guard` 上，**后注册的监听器不能把 deny 改回 allow**（代码注释里
  写明了原因）；
- **询问（可被宿主策略降级）**：shell 里的上传/发布/递归删除、`web_fetch`、未知工具
  默认 `ask`。在 `approval: never` 的 profile（`danger-full-access` 就是这种）里，
  **`ask` 等于静默拒绝**，不是"稍后放行"。

所以：**闸门是"降低误操作概率"的，不是"阻止恶意代码"的。** 它只看得到工具调用和它们的
参数文本，看不到 shell 里最终执行了什么；一个已经拿到本机任意命令执行能力的进程不需要
经过它。别把它当成 OS 沙箱或 EDR。

## 什么时候它会自己动（授权模型）

这是这个插件最需要被看懂的一处（`src/grant.js`）：

- 面板可以**生成**一个一次性 token（`autonomy/request`），但生成 token 本身不授予任何
  权力；
- 只有当**你本人**在下一条用户消息里打出这个 token，并且这条消息属于**当前这一轮**
  （`currentTurnHumanMessages` 从最近的 `turn/start` 之后找 `source.kind === 'user'`
  的消息），`den_set_autonomy` 才会通过：记录里同时写入 `humanMessageId`、`humanSeq`、
  `recordedAfterSeq`；
- 定时器、自动续跑、子代理、脚本都拿不到这条人类消息——它们尝试授权会**在认证这一步失败**；
- 记录缺失、损坏、来自别的会话，一律降级为"未授权"，不抛错、不升级权限。

未授权时它仍然观察，但**不花你的模型调用**；授权后，每个到期的自检会消耗**真实的一轮
模型调用**，并通过 `Agent.followup`（或 `sessionController.prompt`）把一句话投进目标
会话——这句话在你看来会像一条用户消息，也会被写进那个会话的日志。**这是要花钱的**，
账单会在你的模型用量里出现。

## 它读什么

- `$DSH_HOME/sessions/**`：所有会话日志的尾部，用于发现失败轮次与会话活动；
- `$DSH_HOME/den/**`：它自己的状态（见下）；
- 会话事件流：`session.snapshotEvents()`（或 `session.events`）——只为了核对"授权是不是
  你这一轮亲口说的"；
- 桌面/宿主的只读状态：文件是否新鲜、心跳、路由是否挂上。

它**不直接发网络请求**：`src/` 里没有 `fetch`/`http`/`spawn` 调用。摘要类脚本
（`tools/github-digest.mjs`）是开发者在终端手动跑的工具，不在心跳路径上。

## 它写什么

只写自己的目录（`$DSH_HOME/den/`，目录以 `mode: 0o700` 创建，写 JSON 用临时文件 +
`renameSync` 原子替换）：

| 路径 | 内容 |
| --- | --- |
| `state.json` | 观察到的会话活动、已提醒记录 |
| `tasks.json` | 任务与"常驻对话"指针 |
| `profile.json` | 它记住的关于你的偏好（`den_remember` 写这里） |
| `memory/<scenario>.json` | 分场景记忆 |
| `notices/*.json` | 待投递的通知，正文最多 12000 字符，观察类 12 小时过期 |
| `triggers/*.json` | 自检/自唤醒的到期项 |
| `grants/*.json` | 你授予的常驻授权，绑定到具体的用户消息 id |
| `ledger/<日期>.json` | 每天自己花了多少轮、说了几句 |
| `gate-audit.json` | 最近 `MAX_AUDIT` 条闸门判决 |
| `kernel-lease.json`、`conversation.json`、`pacing.json` | 单实例租约与节流 |

它**不写你的项目文件**，也不删 `$DSH_HOME/den/` 之外的东西；唯一会改动别处的是
"投递一句话"这件事——那是往会话里追加一条消息，由宿主落盘。注意：记忆与通知里会存
你告诉它的内容，**明文，没有加密**，只是目录权限 0700。

## 路由与面板

`/dsh-den` 的动作全集（`src/panel-api.js` 的 `PANEL_ACTIONS`）：

- `status`、`schedules/list`、`notices/ack`——读状态/确认通知；
- `autonomy/request`、`autonomy/confirm`——发放/确认授权；confirm 的凭据是你消息里的 token；
- `conversation/read`、`conversation/say`——读目标会话尾部、往目标会话说一句话；
- `schedules/create`、`schedules/delete`——增删自检。

`conversation/say` 与 `schedules/create` **需要一个真实的会话 id**，没有就拒绝；但这两个
动作本身**没有再校验"调用者是不是面板"**——路由的鉴权就是宿主 web server 的鉴权。能访问
那个 web server 的人可以让 den 往会话里说话、建自检。授权（存续的自主权）仍然只能靠
人类消息拿到，这一条不被路由绕过。

## 已知限制（都是设计取舍，不是 bug——但你应该知道）

1. **闸门是正则 + 工具名表**，不是沙箱，也看不到 shell 内部；未知工具一律 `ask`，
   在关掉审批的 profile 里等于拒绝。它会让某些正常的调用也被问一次，这是故意的。
2. **它会读你所有会话的日志尾部**——这是"发现别的会话失败了"的唯一办法。不想被读的
   会话，不要放在同一个 `DSH_HOME` 下。
3. **自主唤醒会花钱**：每唤醒一次就是一轮真实模型调用；`ledger/` 里记的是次数与是否
   说过话，不是金额。
4. **投递出去的消息看起来像用户消息**：`Agent.followup` 走的是宿主的普通下一轮投递，
   没有"这是助手自己说的"UI 标记；它会被写进那个会话的历史。
5. **记忆与通知是明文**：`$DSH_HOME/den/` 没有加密、没有口令；本机同用户的其他进程
   都能读。权限只挡住了别的用户。
6. **单实例靠租约文件**：`kernel-lease.json` 防止两个进程同时跑心跳；进程被硬杀后租约
   可能短暂残留（有 `resident.js` 的陈旧判定，但它不是分布式锁）。
7. **没有限速**：闸门不做速率限制，自检最小间隔是 300 秒，但同一 profile 里多个会话
   各自自检会叠加模型调用。
8. **审计是有限环形**：`gate-audit.json` 只保留最近若干条，早先的判决会被覆盖，不是
   完整审计日志。

## 明确不算漏洞的

- **den 读会话日志、读 `$DSH_HOME/den` 下的文件**：这是它的职责，见限制 2；
- **自唤醒花掉模型调用**：授权时你已经同意，见上面"什么时候它会自己动"；
- **`ask` 在关掉审批的 profile 里表现为"被拒绝"**：宿主策略决定的，不是闸门坏了；
- **闸门没有拦住某个高危命令**：它是启发式分类器，安全边界在"谁能改这个 profile 的
  权限策略"，不在这些正则；
- **面板路由没有独立 token**：它和这个 profile 里其他客户端插件一样，边界是 DSH web
  server；
- **通知/记忆里有你给的敏感文本**：这是用户主动让它记的内容，明文存储见限制 5。

## 报告漏洞

用 GitHub 的私密渠道：<https://github.com/dingchenhui0618-arch/dsh-den/security/advisories/new>

这是个人维护的项目，**不承诺响应时限**；但我会读、会修，修完会在 `DESIGN.md` 的对应
小节与提交信息里写清影响面。请不要把还在生效的问题直接发到公开 issue 里。

## 支持范围

只维护 `master` 上的最新一版（当前 `0.1.0`，见 `package.json`），要求 Node
`^22.19.0 || >=24`、DSH `>=0.2.1-rc.2 <0.3.0`。这个包没有发布到 npm，没有旧版本渠道
需要回补；升级就是 `git pull` 后重启宿主。
