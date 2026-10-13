# dsh-den 设计文档

> 目标：在 DSH 上做出一个 **7×24 常驻运转的真正个人助理**。
> 版本基线：`@deepseek-ai/dsh@0.2.0-rc.2`（与本机一致）。
> 参考实现（只读，不 fork）：
> - `D:\Projects\dsh-muse` — 人类授权绑定的持久自治、keeper 重新武装、带 TTL 的信箱
> - `D:\Projects\dsh-bot` — 多 Bot 隔离、记忆分域、Bot 空间 UI

---

## 0. 一句话定位

**Dot/Muse 与普通 agent 的分界不是模型能力，是占空比。**
普通 agent「你问→它做→它停」；dsh-den 要的是「它一直在，有自己的身份、记忆、授权边界，没事自己找活干，要花钱/对外发信时回头问你」。

因此 dsh-den 必须同时具备四件普通 agent 没有的东西，缺一不可：

| # | 能力 | 为什么不可少 |
|---|---|---|
| 1 | **持久自治（授权绑定真实人类消息）** | 没有它，7×24 就是「一个没人管的脚本」，不敢给它任何权限 |
| 2 | **跨重启自我唤醒** | 没有它，「常驻」在进程重启那一刻就断了 |
| 3 | **值得说才开口的判断门 + 通知保质期** | 没有它，就是每 30 分钟骚扰你一次，会被卸载 |
| 4 | **独立于 agent 的出站审批** | 没有它，「能对外发信、能花钱」这件事本身不成立 |

---

## 1. 三条用事故换来的设计纪律（直接继承）

这三条来自参考实现的真实教训，全部写进本项目的硬约束。

### 1.1 授权必须绑定宿主认证过的真实人类消息

**不许**把「自动续跑」「子代理」「定时器」「脚本」当成授权来源。

```
授权记录 = { sessionId, autonomy, humanMessageId, humanSeq, recordedAfterSeq }
校验 = 回到 session 事件流核对：
       存在 seq === humanSeq 且 type === 'user/message'
       且 data.id === humanMessageId
       且 data.source.kind === 'user'
       对不上 → 静默降级为「未授权」，不抛错、不放行
```

理由：如果校验失败就抛错，一个坏掉的记录会变成拒绝服务；如果放行，一个伪造的记录会变成授权提权。**降级为未授权**是唯一安全且可用的选择。

### 1.2 定时器不是授权

- 定时任务本身**不携带**任何权限，它只是一个「到点了」的信号。
- 每次真正执行前**重新校验**当前授权状态（授权可能已被撤销）。
- 硬上限：单任务 `maxRuns ≤ 1000`、最小间隔 `≥ 300s`、prompt `≤ 8000` 字符。
- 手动撤销**永远优先**于任何自动重新武装。

### 1.3 通知有保质期，过期不投

- 观察/提醒类通知 `TTL = 12h`；过期直接丢弃，**不补投**。
- 理由（参考实现实测记录）：过期提醒会在信箱里排队 37–80 小时，等目标会话醒来时投递一条早已失效的日程——**送晚了比不送更糟**。
- 「想法（idea）」类不限时——想法没有保质期。
- 内容去重：通知 ID = `sha256(sessionId + kind + 归一化文本)`，同内容只存一条。

---

## 2. 架构

```
┌─────────────────────────────────────────────────────────────┐
│  DSH Host（web profile，由看门狗保活 → 7×24 的载体）        │
│                                                             │
│  ┌─────────────────── dsh-den 插件 ──────────────────────┐  │
│  │                                                       │  │
│  │  kernel.js     心跳 + 四闸决策 + 冷唤醒编排            │  │
│  │      │                                                │  │
│  │      ├── atom.js     持久化原子层（原子写 + 校验 + 目录 fsync 降级）│
│  │      ├── grant.js    人类授权（绑定 humanMessageId）   │  │
│  │      ├── notices.js  通知（去重 + 12h TTL）            │  │
│  │      ├── triggers.js 定时触发源（once/interval/daily/weekly）│
│  │      ├── gate.js     出站审批闸门（guard + pre-execute）│  │
│  │      └── memory.js   分域长期记忆（每场景一文件，结构化隔离）│
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│          ▲                        │                          │
│          │ agent/status           │ tools/pre-execute        │
│          │ session/created        │ (waterfall, prepend)     │
└──────────┼────────────────────────┼──────────────────────────┘
           │                        ▼
      ┌─────────┐            ┌──────────────┐
      │ 心跳/触发 │           │ 工具真正执行  │
      └─────────┘            └──────────────┘
```

### 2.1 四闸决策（「值得说才开口」）

每次心跳产生候选动作后，必须依次通过四道**机械可判**的闸，任一不过就**只记日志、不打扰**：

| 闸 | 判据 | 不过时的行为 |
|---|---|---|
| **① 授权** | 本会话的常驻授权**此刻**是否仍然有效 | 拒绝并记账；撤销永远优先于自动重臂 |
| **② 预算** | 今日自发起轮次是否超限 | 推迟到明日窗口 |
| **③ 静默期** | 用户设定的睡眠/专注时段 | 攒进待办，合并到下次 |
| **④ 节奏** | 距上次开口 < cooldown | 攒进待办，合并到下次 |

**第五道闸（价值）由模型执行**：给它一段有界指令，不值得说就回一个 `SKIP`。前四道必须由宿主侧代码强制，不能依赖模型配合——这是「不骚扰」与「不越权」的分界。

**核心原则：唤醒 ≠ 打扰。** 心跳可以固定频率，开口必须过闸。

> **实现修正（2026-10-12）**：投递顺序必须「先送达、后记账」。早期实现把 `markFired` 放在投递之前，导致一次瞬时投递失败（模型不可用）就把这次触发**永久消耗**掉，下一次要等整整一个间隔。现在投递失败只推进重试节流（15 分钟），不动 `lastFiredAt`/`fireCount`，触发保持原锚点并会被重试。回归测试 `a wake that fails once is retried and then delivered, not lost` 覆盖此点。

### 2.2 执行侧（唤醒后怎么跑）

- 有活会话 → `agent.followup(msg)` 追加，不打断用户当前输入；
- 无活会话 → `ctx.agentLoop.createAgent()` / `resume()` 冷启该助理的会话；
- 每轮**前**落检查点、**后**写记忆 —— 因为 `dsh-jobs` **不跨重启存活**，所有持久化自己负责。

### 2.3 出站审批闸门

挂在 `tools/pre-execute` 的 waterfall 上，**prepend** 优先于其他 listener：

```
判定分类：
  项目内普通工作 / 清理本会话自建对象        → 低危：放行
  对外发信、下单、改安全配置、不可逆删除      → 中危：返回 ask，等人批
  凭据外泄、越过信任边界                     → 高危：直接拒
  拿不准 / 授权冲突                          → 拒（fail-closed）
```

关键点：这一层**不在 assistant 的人格提示词里**，所以**它改不了自己的闸门**。这是「独立审批」的全部意义。

**覆盖审计（2026-10-12）**：拿宿主自己报告的工具清单（`cordis_inspect_query` 的 host `Tool` provider）逐个对照门控表，发现 **17 个已暴露的工具落到 `defaultRisk: ask` 而没有记录决定**。在有审批提示的会话里这只是多问一次；在**审批被禁用**的会话里，`ask` 就是自动 `user rejected`——于是 `skill`、`create_goal`、`todo_write`、`wait_agent`、`spawn_teammate`、`subagent` 全部变成「用户拒绝」，**与文件工具当初的故障同源同因**：门控把本 profile 自己的词汇当成了外来能力。全部显式分类后，**没有任何工具靠省略来定级**，`test/gate-coverage.test.mjs` 会在将来出现新工具时报错。

分类规则始终是同一条，写在这里以免再次漂移：

- **读**（`read_image`、`job_output`、`get_goal`、`load_workspace_dependencies`、`vision_diff`）→ 放行
- **本地簿记**（`todo_write`、`create_goal`、`update_goal`、`skill`、`present`、`team_task_*`）→ 放行
- **委派与协作**（`send_message`、`spawn_teammate`、`subagent*`、`wait_agent`、`interrupt_agent`、`job_kill`、`workflow`）→ 放行。它们只在本机内启动工作，**委派者随后尝试的动作仍要各自过这道闸门**，所以放行「生成」不等于预授权「后果」。
- **改自己的权限或持久状态**（`den_set_autonomy`、`den_configure`、`den_schedule_*`、`den_remember`、`den_forget`）→ 保持 `ask`
- **出网拉取**（`web_fetch`）→ 保持 `ask`
- **凭据** → 一律 `deny`，且**与工具名无关**：规则按路径/文本匹配，所以 `pwsh`、`workflow`、`ship_receipt` 这些能跑命令的工具不需要被禁——禁工具只会把同一件事挤到另一个工具里，同时让闸门不可用。这与「放行 `read`/`write`/`edit` 是安全的」是同一个理由。

### 2.4 状态面板 = 控制面，不是一个只读挂件

面板走**一条精确的 Fetch 路由**（`HostConnectionFetch.register`），按 `payload.action` 派发 6 个具名动作。分派点的选择是有意的：**能改权限的那个动作，绕开了面板自己。**

理由不是谨慎，是一个会真实发生的正确性错误：

> 常驻授权只有在四道闸跑起来时才被承认，而授权闸读的是**绑定到人类消息 id** 的授权记录。
> 一条没有人类消息背书的授权，会让 `den_status` 报「已授权」，而每一次自发起运行仍被拒绝。
> 面板上就是**一盏绿灯照着一条断路**。

所以：

| 动作 | 风险类 | 处理 |
|---|---|---|
| `status` / `schedules/list` | 只读 | 直接执行 |
| `schedules/create` / `schedules/delete` | 排程，**不是授权** | 直接写入；每次运行仍重过四闸 |
| `autonomy/request` | 改权限 | **只铸造**一枚一次性 10 分钟令牌并回显 |
| `autonomy/confirm` | 改权限 | 需要令牌 **+ 活的直接人类驱动者**，写真实证据；令牌用掉即废 |

人类把令牌带回对话，由正常的 `den_set_autonomy` 路径完成写入。**点击永远不产生授权**，因此面板不会撒谎。

配套纪律：

- **失败必须带内可见。** 每个动作分支返回 `{ok:false, error}`，不抛穿透传输层——否则面板只能显示一个不透明的错误。`schedules/delete` 早期就漏了 try/catch，已修。
- **心跳被推迟时要报成问题，而不是沉默。** 早期实现把「交付通道不存在」当成永久判决，于是心跳永不启动、只留一条事件：**assistant 并不常驻，而它的状态看起来健康**。现在会重试（5 秒 × 24 次）、报告进度、并在恢复或放弃时各记一条事件。
- **节奏改动必须落到跑着的定时器上。** 定时器只在构造时武装一次，所以 `den_configure` 改 `tickSeconds` 会「写进状态、报成已生效、而活着的 timer 用旧值」。`Kernel.retime()` 负责重武装——**一个看起来生效、实际没生效的设置，比一个明确拒绝的设置更糟**。
- **浏览器半边的调试钩子只报回复的形状，不报内容。** 早期版本把整个返回值交给 `window.__dshDenDebug`，等于把刚铸造的授权令牌写进页面全局变量；能装钩子的脚本本来就能从屏幕上读令牌，所以毫无收益、只是多一处泄漏面。

---

## 3. 7×24 落地方案（本机 → 云主机）

用户要 7×24，但不必一上来就买云主机。分两段：

| 段 | 做法 | 覆盖时长 | 成本 |
|---|---|---|---|
| **A. 本机常驻** | 把 DSH 纳入已有的 `services-watchdog.ps1`（manage 模式，掉了自动拉起），den 跑在 DSH 内 | 电脑开机即 7×24 | 0 |
| **B. 云主机常驻** | 云主机跑 `dsh web` + 看门狗；den 状态目录整体迁移（`~/.dsh/den` 自包含），凭据改用一次性授权 | 真正 7×24（含本机关机） | 云主机费用 |

**设计约束（为 B 段提前准备）**：
- `~/.dsh/den/` 必须是**自包含**的：状态、通知、记忆、授权全在这里，可整体打包搬走。
- 依赖的 DSH 目录（`sessions/`、`storages/`）单独列出，迁移脚本负责。

**激活这一步现在由 `tools/check-deployment.mjs` 断言，而不是靠叙述。** 仓库里其他所有检查都是**封闭的**：在本进程里把插件拉起来，断言它的行为。没有一个能回答真正卡住验收的那个问题——**profile 服务的到底是不是磁盘上这份代码**。这个问题只有一个诚实的答案：问活宿主，然后比较。

脚本对活宿主提出三项主张并试图证伪，未证实就以非零退出：

| # | 主张 | 观测方式 |
|---|---|---|
| 1 | 面板路由活着 | `GET /dsh-den` 必须是 200 + JSON；未激活时是 404，因为那条路由**由被激活的代码注册** |
| 2 | 本次启动写过状态 | `~/.dsh/den/state.json` 存在——跑过这个插件的宿主在启动路径上会写它 |
| 3 | 浏览器真的到过那条路由 | 回读 `transport.browserReachable`；这是**最后一段尚未观测的接缝**，而它会自报 |

它**看不到** Cordis 的 Tool 注册表（那只能通过宿主 inspect provider），所以工具数是与**源码**对照的，并且只作为指针报告，不作为测量。

2026-10-12 实测输出（**重启前**）：`GET /dsh-den -> 404`、`state.json` 不在、兄弟路由 `/dsh-warden` 与 `/dsh-vision-diff` 都是 `200`。**这是「宿主仍在跑改前代码」的直接证据**，而且它同时证明了机制本身是好的——同一种注册方式在别的插件上返回 200。

**重启后同一脚本的全部主张都转为通过**，这正是它必须能拒绝的意义：

| 主张 | 重启前 | 重启后 |
|---|---|---|
| `GET /dsh-den` 是 200 + JSON | 404 | **200**，信封完好 |
| 本次启动写过 `state.json` | 不存在 | **存在**，含 8 个配置键 |
| 浏览器到过这条路由 | 从未 | **已置位** |
| `Tool` provider 报的工具数 | 与源码不符 | **11，与源码逐名一致** |

所以「运行的是哪份构建」这个问题，现在由**一个会自己改变结论的脚本**回答，而不是一段散文。

**重启之后跑 `npm run verify:live`（`tools/verify-after-restart.mjs`）。** 它把验收做成可执行判定，而不是叙述，并且**在有旧构建运行时拒绝报成功**：先跑部署检查作为证伪步骤，`GET /dsh-den` 不是 200 就直接停——后续断言都不构成关于这份代码的证据。

它里面有一处刻意的设计，因为不这样做就又会骗过自己：

> **脚本自己发请求，所以它自己的请求和用户的点击长得一模一样。** 如果它请求完再去读 `transport.browserReachable`，那么无论谁来读都是非空，而**那一段从未被观测过的接缝仍然没被观测到**——只是看起来被观测了。
>
> 所以它**先读一次**（发任何自己的探测之前），再发探测，再读一次。两次读数之间的变化**不能归因于脚本自己**。在没有别人点击的机器上，那就是 app。做不到这个前后切分，这个脚本就只是在给自己制造证据。
- **凭据绝不落到云主机长期存储**——`~/.dsh/.credentials.yaml` 是明文，云主机上只放短期 token。

---

## 4. 阶段与验收标准

每个阶段都必须可执行、可复现地验收，不达标不进下一阶段。

| 阶段 | 交付 | 验收标准 |
|---|---|---|
| **D1 骨架** | 插件能装、状态持久化、状态查询可用 | **达成**：bundle 在 profile 的 `dependencies` + `bundles` 中，`fiberPhase` 已为 `active`；11 个工具、1 个单调 guard、`tools/pre-execute` 监听均注册成功；卸载后 tools/guards/listeners/service 全部归零。207/207 单测通过 |
| **D2 授权 + 通知** | `grant.js` + `notices.js` | 伪造/过期授权被降级；12h 过期通知不投递；同内容去重 |
| **D3 自治内核** | 心跳 + 四闸 + 冷唤醒 | **完全不跟它说话**，到点自己醒来产出结果；重启后仍有效；投递失败会重试而非丢失 |
| **D4 审批闸门** | `gate.js` | 对外动作必然停下问；改人格提示词绕不过 |
| **D5 记忆 + UI** | 分域记忆 + 状态面板 | 分域记忆**已达成**（跨会话记得住、不同场景隔离已实测）；**交互面板已达成**：注册进真实 sidebar 的 `panellist`（order 245），6 个动作走真实路由，39 项交互检查 + 19 项路由测试通过 |
| **D6 7×24** | 看门狗纳管 | 连续运行 24h 无人工干预，进程被杀后自动恢复。**进行中**：看门狗已能区分「wedge 的 Host」与健康 Host（`StrictHttp`；此前端口在听但 HTTP 已死的 Host 会被记成健康），插件侧心跳改为自愈而非永久推迟。**未达成的是长时间无人值守实跑**——验收标准是观察到的「杀掉→自愈」，不是一份配置 |

**全局验收（D6 必须全过）**：
1. 不主动说话时，它按计划自己醒来并交付有价值结果；
2. DSH 重启后，定义/记忆/任务/预算计数全部还在；**「启动即落盘 `state.json`」已达成并实测**（空 home 启动后文件存在且带 `version`；重启后预算/节奏/静默时段全部保留）。**运行中的 DSH 尚未加载该修复**；
3. 对外发信、花钱、越界写**必然**停下等确认，且能看到它**为什么这么判断**——活着的 Host 已把它记进 `recentEvents`（`secret:dotenv` → `deny`、`outbound:git-push` → `ask`），即门控在助手自身提示词之外**可观测**；
4. 改它自己的配置或提示词**也绕不过**审批闸门；
5. 失败时明确报错，**不编造完成**。

> **未完成的验收（2026-10-12，如实记录）**：把本轮改动送出去只有两条路——推送远端、重新激活插件——两者在本会话都被上层自动拒绝（门控判为 `ask`，而本会话审批被禁用故拒绝）。因此提交目前只在本地，运行中的 Host 仍是旧代码（状态文件尚未出现即为证）。批准其中任意一步即可闭环。不绕过：那属于规避自己的门控。

> **浏览器半边已实测存活（2026-10-12，读自运行中的客户端）**：通过 Client `Slots` provider 查 `sidebar.panellist` 与 `main` 两个精确 root，占用者里都有 `dsh-den` 且 `active: true`——
> `{registrant:"dsh-den", id:"dsh-den.status", order:245}` 与 `{registrant:"dsh-den", key:"dsh-den.status"}`。
> 这比离线测试强得多，因为它顺带证明了整条加载链在真浏览器里跑通：bundle id 与包名一致、`require('react')` **确实解析成功**（否则 factory 会在注册前抛错）、`id` 与 `key` 一致。契约定型为 `test/client-contract.test.mjs`（7 项）。
> **仍未验证的是这条链上剩下的一段**：面板按钮发出 HTTP 调用、经真实浏览器回到宿主。宿主侧已由 `test/panel-actions.test.mjs` 与 `test/panel-route.test.mjs` 走真实 handler 验证；浏览器侧尚未观测到一次真实点击。

> **客户端→宿主通道两次都编错了，第三次改为照抄在跑的实现（2026-10-12）**
>
> 这处踩了两次，值得完整记下来，因为**两次的失败方式完全相同、且两次都被测试放行**。
>
> 第一版：客户端调用 `ctx.connection.rpc.call('/api', …)`，并把 `connection` 写进 `inject`。这个形状是本仓库自己编的——宿主 `connection` 契约是 `{rpc, fetch, operator}`，其中 `HostConnectionRpc = {handle, intercept}` **没有 `call`**；客户端服务目录里根本没有 `connection`；`call` 这个名字只出现在本仓库自己的测试替身里。
>
> 第二版：改用 builtin 清单里确实发布的 `host.call(method, args)`，宿主侧相应把路由挂在 `connection.fetch.register` 的 `/api/dsh.den/status` 精确路径上。这一版**每一部分都能在文档里找到出处**，所以看起来已经修好了。但盘点本机**9 个装了客户端半边的插件**后发现：
>
> | | 宿主注册方式 | 客户端调用方式 |
> |---|---|---|
> | dsh-warden | `webServer.register` | `fetch('/dsh-warden')` |
> | dsh-daily | `webServer.register` | `fetch('/dsh-daily')` |
> | dsh-vision-diff | `webServer.register` | `fetch('/dsh-vision-diff')` |
> | dsh-in-hand / dsh-ship-receipt / dsh-signal-pet / dsh-taskwatch / dsh-holdem | `webServer.register` | `fetch(...)` |
> | **dsh-den（第二版）** | `connection.fetch.register` | `host.call` |
>
> **9 个里 8 个走同一条路，没有任何一个用框架 RPC。** 宿主侧我一直有证据（`den_status` 报 `statusRoute.mounted: true`），但**没有任何证据表明浏览器插件页能到达 `/api` 下的精确路由**——而这正是第二版唯一的未知量。
>
> 于是第三版照抄多数派：宿主 `inject = ['agents','tools','webServer']`，用 `ctx.webServer.register({kind:'prefix', path:'/dsh-den', handler})`；客户端用浏览器原生 `fetch('/dsh-den')`。`inject` 的三项都有真实插件背书（`dsh-vision-diff` 是 `['webServer','tools']`，`dsh-warden` 是 `['webServer']`，`dsh-daily` 是 `['timer','webServer']`）。旧的 `connection.fetch` 传输层整体删除，因为它描述的正是被弃用的那套。
>
> **两次都被测试放行的原因值得单独记住**：两个离线校验器都提供一个假 `ctx`/`host`，而假对象是**照着代码的假设写的**。与实现同形的替身无法证伪实现——它会和错代码一致地通过。所以第三次的判据换成了**外部事实**：本机在跑的其他插件怎么写。`test/client-services.test.mjs` 现在断言 bundle 里不出现 `connection.rpc` 或 `host.call`，`test/client-contract.test.mjs` 断言客户端路径与宿主 `ROUTE` 相等且等于 `/<包名>`。
>
> 另外，离线替身现在必须自备 `fetch`——这本身就是个信号：bundle 真的在走浏览器 API 了。
>
> **随后拿宿主自己的 `webServer` 契约逐条核对（同一天）**，结论是这条路选对了，而且顺带查出上面那版第二个真实 bug：
>
> - `webServer.access.hardDependency.inject = ['webServer']`，表达式 `ctx.webServer` —— 与真实插件一致，声明形式正确。
> - `register(route: WebRoute): () => void`，其中 `WebRoute = { kind: 'exact' | 'prefix', path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }`。
> - 文档明确 **`Duplicate (kind, path) throws`** —— 所以 mount 必须捕获注册异常（`fail('register-threw', …)`），这正是 mount 结果要带 `reason` 的原因。
> - **`req` 的类型就是 Node `IncomingMessage`**。这直接证伪了我第一版实现里的 `await req.text()`：`IncomingMessage` 没有 `text()`，`dsh-vision-diff` 也是用 `req.on('data')` / `req.on('end')` 读 body 的。**面板的第一次 POST 会在宿主里当场抛错**，而两个离线替身都不会发现——因为替身的 `req` 是照代码的假设写的（只有一个 `text()`）。这是同一个错误的第三次现形：**替身与实现同形，就无法证伪实现。** 现在替身是真正会 emit `data`/`end` 的 Node 流形状，跑的读路径就是宿主里的读路径。
> - 关于 `res`：检查器把 `WebRoute.handler` 的第二参写成 `ServerResponse`，但那是 `connection` 模块里同名 RPC 类型的引用（同一份输出里它被列在 `referencedTypes` 中），不是 HTTP 响应。实际在跑的三个插件一律按 Node `ServerResponse` 用：`res.statusCode = …`、`res.setHeader(…)`、`res.end(…)`。我的实现走这条，并同时接受 web `Response`，以便 handler 不启 HTTP 服务也能直接调用。
>
> **最有力的证据来自宿主本身（2026-10-12 实测，全部未认证）**：
>
> | 请求 | 结果 |
> |---|---|
> | `GET /dsh-warden` | **200**，返回完整 JSON（含审计日志路径、审查规则预览） |
> | `GET /dsh-vision-diff` | **200**，返回完整 JSON |
> | `GET /dsh-den` | **404** —— 新路由尚未挂载（宿主跑的是改前代码） |
> | `GET /api/dsh.den/status` | **401** —— 被弃用传输的命名空间 |
> | `GET /api` | **401** |
> | `GET /dsh-den-does-not-exist` | **404** |
>
> 这张表就是整条结论，而且**证据来自本仓库之外**——不是替身，也不是我自己写的断言：
>
> 1. `webServer.register` 把路由放到**浏览器真正对话的那个 HTTP 服务**上，且**无需凭证**（兄弟路由 200 直接返回数据）。
> 2. `/api` 命名空间在 connection 认证之后：浏览器 `fetch` 不带 token → **永远 401**。所以旧传输即使挂载成功，面板也**永远拿不到数据**。
>
> 第 2 点把「换个多数派写法」升级成了「**旧写法不可能工作**」。此前我只有宿主侧的自述（`statusRoute.mounted: true`）——那个自述是真的，但它只证明「路由注册进了 connection 的 fetch 表」，**不等于「浏览器能取到它」**。这两件事被我混为一谈整整两轮。
>
> 判别式已固化进 `test/panel-route.test.mjs`：`ROUTE` 必须等于 `/<包名>`，且**不得**以 `/api` 开头。
>
> **最后一块拼图（同一天）：旧传输从来没有挂载成功过。** 宿主当前注册了全部 13 个 den 工具（`listTools` 实测），说明旧代码在跑；而 `GET /dsh-den` 返回 **404**。在 `webServer` 的语义里，**404 是 fallback 的响应**（该路径没有任何命名路由匹配），所以旧传输在 `/dsh-den` 上什么都没留下；它挂的是 `/api/dsh.den/status`，那个地址返回 401。
>
> 于是结论要改写得更重：面板**不是「改前有缺陷」，而是「从未接通过」**。`statusRoute.mounted` 那个 `true` 自述与浏览器可达性之间的落差，**从头到尾都是全部事实**——面板的每一次轮询都注定失败，而宿主侧的报告一直说它挂载正常。这也解释了为什么「面板数据路线会应答」这句话以前能写进 README：**没有人在浏览器里试过一次**，唯一被检查过的是宿主自己的报告。
>
> **随后发现：这条接缝其实不必等重启才能验证（同一轮）。** 此前我的结论是「只剩浏览器那一段，必须重启才能观测」。这个结论是错的，而且错在同一个地方——**我以为接缝两侧必须各有一个替身**。
>
> 真正该做的是**把替身从接缝上拿掉**：`test/roundtrip.test.mjs` 在同一进程里启动**真实**插件，取出它**真正注册**的那条路由，再把**真实**浏览器 bundle 的 `call()` 指向它。跑的是三段真代码：
>
> | 段 | 真实执行的部分 |
> |---|---|
> | `client.js` | 序列化 body、发送、读状态码、读文本、解析、拆信封、返回 `value` 或带 code 抛错 |
> | `panel-route.js` | 切 URL、读流式 body、分发动作、写 JSON 响应 |
> | `panel-api.js` | 从活服务构建快照 |
>
> **不在跑的只有 socket 与浏览器**，文件里明确写了这一句。
>
> 要够到 `call()` 得开一个门：bundle 里加了 `window.__dshDenExposeInternals` 门控的测试出口。生产页面从不设这个标志，且有一项检查**在不设标志的情况下加载 bundle**，断言 `module.exports` 仍然**恰好**是 `{name, inject, apply}`。它开的口子不比「点一下面板按钮」更大——`call` 就是按钮调用的那个函数。
>
> 这条测试当场抓出了我自己的四个错误，而且**四个都是它要猎的那种形状**：
>
> 1. 我第一版把测试出口放在工厂作用域里，而 `call()` 根本不在那个作用域。**它会在每次页面加载时抛 `ReferenceError`。** diff 里看起来完全正确,直到测试真的执行它。
> 2. 替身的 React baseline 把 React 的**成员名**当成了**模块名**,于是解析器回答「非基线模块: react」。**又一个凭想象写出来的替身。**
> 3. `assert.deepEqual` 跨 `vm` realm 会把相等的对象判为不等——两个正确的比较因此失败。
> 4. 我断言快照的 `name` 是 `'dsh-den'`,它其实是**可配置显示名**(`'Den'`)。**错的是测试,不是代码**——而且它是响亮地失败,不是悄悄通过。
>
> 这一轮的教训可以一句话说完：**「只能靠重启验证」是一个关于我造的工具的结论,不是关于这个系统的结论。**

---

### 2.5 冷启动测试抓出的三个生产级缺陷

上一节把替身从接缝上拿掉了。这一轮做的是同一件事的**另一半**：拿掉替身的不是「浏览器↔宿主」那条接缝，而是**「心跳自己」这条路径**。

此前的测试全部手工调用 `kernel.tick({ agent })` 并传一个 agent。**生产心跳不这样调用**——`start()` 装的是 `setInterval(() => this.tick())`，一个参数都不传。于是那些测试覆盖的是一条**真实运行中不存在的路径**。写一个走真实心跳的测试（`mock.timers` 让真实回调跑起来）之后，缺陷立刻暴露：

> **缺陷一：每一次自主唤醒都在授权闸被拒绝。**
>
> 授权在这个插件里是**被证实的**，不是被存储的：`currentGrant` 会回去读不可变的会话日志，要求那条绑定的人类消息仍然在。所以它**需要一个会话**。而 `#runDue` 是在解析出 driver **之前**调用 `evaluateGates({ state, agent })` 的——心跳路径下 `agent` 是 `undefined`，`hasAutonomy(undefined)` 返回 `undefined`，于是：
>
> - 每一条唤醒都在 `authority` 闸被拒；
> - **一个授权齐全、心跳正常、预算充足的常驻助理，一次都唤不醒自己**；
> - 而挂载、工具、账本、面板、闸门**全部报告健康**。
>
> 最后一点是它难被发现的原因：**「拒绝一次未授权的唤醒」本来就是正确行为**，它读起来完全正常。`refused` 计数增长，`reason` 写着「没有直接人类请求的常驻授权」——而人类**确实**授权过。修复是把解析 driver 提到闸门之前，并在拒绝事件里加上 `hadDriver`，把「没找到人可问」和「人类没授权」分开。
>
> **缺陷二：通知永远不入队。**
>
> `subagents.sendMessage` 的签名是 `Promise<MessageId>`——它返回的是**被接收消息的 inbox id，不是助手的回复**（这一条是查活的 `subagents` 服务契约确认的，不是猜的）。而「值得说才开口」这个判断（`interpretWakeResult`）需要**回复文本**。于是 `createDeliver` 只能返回一个常量空串，`interpretWakeResult('')` 给出 `{ speak: false, reason: 'empty' }`：
>
> - 每一次唤醒都被判为 `silent`；
> - **`queueNotice` 从来没有被调用过一次**，通知系统在真实路径上产出为零；
> - 而「没什么值得说的」是一个正常的、预期的结论，所以账本上只看到 `skipped` 在涨。
>
> 修复是在投递后**从会话日志回读**唤醒那一轮自己的 `assistant/message`（先记下投递前的 `seq`，只认之后的事件），并且只取 `text` 块——reasoning 和 tool call 不是「说给人类听的话」。读不到时记一条 `wake-reply-unreadable` 事件，而不是谎报成「没什么可说」。

> **缺陷三（在修一和二时发现）：没有人可送时，那次检查会被"吃掉"。**
>
> 修好缺陷二之后立刻暴露：`createDeliver` 在没有投递路径时返回空串，而内核把空串读成「醒过了、看过了、决定不说」——一次**成功**的唤醒。于是这次检查被**记账**（`turn` +1）、**推进节奏**（`markFired`）、然后**被消耗掉**。人类要的那次检查就这么没了。
>
> 修法是**抛错**，走失败路径：只推进重试节流，`lastFiredAt`/`fireCount` 不动，日程保持到期，等有投递路径时再跑。这与缺陷二同源：**空串在内核里有确定含义（成功的沉默），任何"我做不到"都绝不能用它表达。**

两个缺陷的共同形状，值得记下来：

> **替身不只是「假的服务」，还包括「假的调用方式」。** 前两轮我防的是前者（写一个自己想象的 `connection.rpc`）。这一轮两个缺陷都不是替身写错了——`subagents.sendMessage` 的替身形状完全正确——而是**我用一种生产环境不存在的方式去调用真实代码**：手动传一个 `agent`，以及从没检查过 `deliver` 的返回值去了哪里。测试通过，是因为它忠实地测了那条不存在的路径。
>
> 判别式：**一个测试如果替调用方做了生产调用方不会做的事，它验证的是测试自己。** 具体到可检查的动作——验收时问一句「这条路径的生产入口在哪、它传了什么」，找不到入口就是找到了缺口。
>
> `test/cold-start.test.mjs` 现在 9 项：跨重启找到并触发、授权被重新证实、未授权则拒绝、停机一天的追赶、真实心跳（不带 agent）、回复读不回来、拒绝要能区分「没有会话」与「未授权」、拒绝不计账、未授权时**不做任何 cold resume**。
>
> **一处我写错又改回来的数字**：上一条提交信息里我写了「grows to 10 tests」，实际是 9。写提交信息时我没有数，是凭印象写的——和这一整节在讲的毛病是同一种。这条更正在这里留痕，因为**在提交信息里写一个没数过的数字，和在生产代码里写一条没跑过的路径，是同一个错误**。

---

### 2.6 第四个缺陷：替身不只是「假的服务」，还包括「假的运行时」

前三个缺陷都是**冷启动测试**抓出来的——它们要求一条生产里真实存在、而手工调用不存在的路径。第四个不是测试抓出来的，是**读代码读出来的**，而且它把同一类错误换了一张脸。

客户端 `call()` 这样构造中止信号：

```js
typeof AbortSignal !== 'undefined' && AbortSignal.timeout
  ? AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)])
  : undefined
```

**它检查的是 `AbortSignal.timeout`，调用的却是 `AbortSignal.any`。** 这是两个不同的 API，可用版本也不同：`timeout` 是 **Chrome 103**，`any` 要 **116**。在 103–115 之间的 shell 上，这个守卫通过，然后 `any` 抛 `TypeError`，**每一个请求在到达 `fetch` 之前就死了**。

**三个 harness 都看不见它**——`check-client-bundle.mjs`、`check-client-interaction.mjs`、`roundtrip.test.mjs` **全都注入宿主自己的 `AbortSignal`**，而 Node 的这个对象两个方法都有。

所以这次替身扮的不是**服务**，是**运行时**：

| | 前面的缺陷 | 这一个 |
|---|---|---|
| 替身是什么 | 假的**服务**，形状不对 | 假的**运行时**，能力比真实环境多 |
| 例子 | `sendMessage` 返回了它不返回的东西 | `AbortSignal` 有真实 shell 不保证有的方法 |
| 为什么测试同意 | 假服务与代码出自同一个假设 | 假 realm 与代码出自同一个假设 |

**修法有两部分，缺一不可。**

第一，修代码：检查**真正要用的那个能力**。`any` 是锦上添花（同时响应卸载和超时），**超时才是要求**，所以缺 `any` 时单独用 `timeout` 就是正确的降级——不是降级到「没有超时」。

第二，修测试，而且**这一点更值得记**：`test/client-compat.test.mjs` **从 `client.js` 源码里把那段真实表达式抽出来求值**，用两种 `AbortSignal` 形状各跑一遍。它**不重写**那段逻辑——重写就会与代码出自同一个假设，而那正是所有漏掉它的 harness 的失败方式。

写完之后，**回退修复验证它真的会失败**，得到精确的报错：

```
✖ a runtime with `timeout` but no `any` still gets a usable signal
  TypeError: AbortSignal.any is not a function
```

另三个用例（表达式确为源码、有 `any` 时正常组合、完全没有 `AbortSignal` 时不崩）仍然通过——**命中精确**，不是「代码变了就红」。

这里还有一条关于我自己写测试的教训。第一版提取器只认 `var signal = null`，回退修复后它在**导入期**就炸了，报「signal 不在我预期的位置」。那证明了代码变了，**没证明它坏了**。改成同时认识新旧两种写法之后，失败的才是那条关于退化运行时的断言——**也就是真正要主张的那句话**。

### 2.7 第五个缺陷：把「给会话发消息」当成了通用 API

这条是读 DSH 的 `subagents.sendMessage` **实现**读出来的，不是跑出来的——而它证明了**能力 2 的投递通路在真实宿主上从未成功过，且结构上不可能成功**。

`createDeliver` 的投递是：

```js
await subagents.sendMessage(agent, trigger.sessionId, [{ type: 'text', text }], {...})
```

而 `agent` 来自 `createAgentResolver(sessionId)`，它返回的是**被唤醒会话自己的 agent**（`agents.get(sessionId)`，或 `agents.resume({resumeSessionId})`）。于是 **sender 与 targetId 是同一个会话**。

DSH 的实现（`app.asar` 内 `SubagentRuntime` 的 continuations manager）：

```js
async sendMessage(sender, targetId, content, options) {
  if (this.ctx.agents.get(sender.id) !== sender) throw UNAUTHORIZED
  const act = this.activations.get(sender.id)
  if (act && act.handle.agent === sender && act.parentSession === targetId)
      return this.sendToParent(act, sender, content)          // 只有这一条能成功
  if (sender.session.header.parentSession === targetId) throw ...  // 父不是 resident child
  return this.deliverToChild(sender, targetId, {...})          // 否则按「子」处理
}
```

自投递落到 `deliverToChild`，最终在 `coldResume` 里过 `authorizeLineage`：

```js
authorizeLineage(parent, childId, parentSession) {
  if (this.ctx.agents.get(parent.id) !== parent) throw UNAUTHORIZED
  if (parentSession !== parent.id) throw UNAUTHORIZED   // ← 要求被投递的会话是父会话的子
}
```

**要求 `parentSession === parent.id`，而 parent 就是那个会话自己——等于要求会话是自己的父亲。** 所以唯一能走通的交叉是「sender 是 target 的 continuable 子 → `sendToParent`」，而插件的 sender 恰恰是 **target 自己**。

为什么回归测试全绿：`test/support/host.mjs` 的假 `subagents.sendMessage` **无条件接受任何投递**。它造假的不只是「服务」，还有**调用方式**——与 §2.5/§2.6 是同一类错误的第三次出现，而这次掩盖的是产品的主路径。

**修法（已实现）**：不再借道 `subagents`，改用**驱动自己的收件箱**——`Agent.followup(message)`。宿主自己的文档把语义写得毫无歧义：

> *"`followup()` queues an ordinary next-turn prompt and wakes the driver; `steer()` submits next-step input and wakes it; `inject()` adds model-facing context without waking the driver."*

实现就是 `send(message, 'next-turn', true)`：把消息 splice 进 `inbox`，空闲时打开回合边界，忙碌时把唤醒闩住。**不涉及任何 lineage**，消息在人类对话里就是一条可见的待办回合，并durably 落成 `user/message`——正好与下面的回复读回配对。

```js
agent.followup({
  id: `den-wake-${trigger.id}-${baselineSeq}`,
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
})
```

`subagents` 从此**不再被读取**；「有没有投递通路」的判据也随之从 `subagents.sendMessage` 变成 `agents.get`，并且**失败时指名缺的是哪个服务**，而不是给一句笼统的 verdict。

**这里要记的是：我原本以为要「记录创建者身份、以 continuable 子身份投递」，那是对着错误的 API 想补丁。** 真正的问题是我把一个**受限的父子通道**当成了通用投递口。换成收件箱之后，那个「谁是创建者」的问题根本不存在——不需要问。

### 2.8 第三个、也是代价最大的那个假替身：假的是「调用方式」

§2.5/§2.6 的教训是替身会假在服务上。这一条更贵：**替身假在了调用方式上，掩盖的是产品主路径。**

`test/support/host.mjs` 与 `test/cold-start.test.mjs` 里各有一个 `subagents.sendMessage` 假实现，都无条件接受任何投递。于是「唤醒投递」这条链在测试里永远成功，在真实宿主上永远失败。

修的时候我**先改错了一个**：改了 `test/support/host.mjs`，套件**依然全绿**——因为 `cold-start.test.mjs` 自己另有一个，而测试用的是那一个。那一刻我没有下结论，而是去查 sender 的真实形状，才发现有两个替身。**如果当时我信了那一片绿，我会得出「我的分析错了」的结论。**

所以修法不是「把真相抄进两个替身」，而是做成**单一来源** `test/support/subagent-delivery.mjs`，导出 `judgeSendMessage` / `assertSendMessage`，**每个替身都必须调用它**。新加一个忘记调的替身，是一个不会失败的替身——这句话现在写在那个模块的头部。

纪律：**只建模拒绝，不建模接受。** 一个也会放行成功的假替身，会让调用方相信一次宿主本会拒绝的投递发生了。宁可让假替身比真宿主更严格。

**验证方式**：把两处假替身都接上规则后，那 5 个测试立刻变红，报的正是

```
"reason":"subagent \"session-cold\" delivery requires the exact live parent agent:
          the sender has no recorded parent, so it is not a continuable child of the target"
```

——**被准入了、然后送不到**。我先标成 `todo` 并写明缺陷（套件保持诚实），修好投递后再删掉标记；现在 226/226、`todo 0`。

**仍未验证的**：这个修复在回归测试台里成立，**但没有在真实宿主上观察到过**——线上跑的仍是旧构建，需要一次重启；而且要先有人类授权。所以能力 2 的活体验收依旧欠着，只是**拦路的缺陷已经修掉，不再是设计问题**。



- `dsh-muse`、`dsh-bot` 只作**只读参考**，不 fork、不复制代码进本仓库。
- 借鉴的是**机制与教训**（授权绑定、keeper 重新武装、TTL、多域隔离），实现代码自己写。
- 两者均为 MIT；本项目同样 MIT，若未来复制其代码片段须保留原始版权声明。

---

## 6. 本仓库不做什么

- 不做「每用户独立云 VM」硬隔离（gVisor/Firecracker 级）——那是 Dot/Muse 的护城河，本机场景不划算。
- 不做 4000 连接器目录。
- 不把「凭证不出域」说成已实现，除非真的验证过。
