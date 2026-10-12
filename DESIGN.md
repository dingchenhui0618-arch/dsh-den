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
- **凭据绝不落到云主机长期存储**——`~/.dsh/.credentials.yaml` 是明文，云主机上只放短期 token。

---

## 4. 阶段与验收标准

每个阶段都必须可执行、可复现地验收，不达标不进下一阶段。

| 阶段 | 交付 | 验收标准 |
|---|---|---|
| **D1 骨架** | 插件能装、状态持久化、状态查询可用 | **达成**：bundle 在 profile 的 `dependencies` + `bundles` 中，`fiberPhase` 已为 `active`；11 个工具、1 个单调 guard、`tools/pre-execute` 监听均注册成功；卸载后 tools/guards/listeners/service 全部归零。199/199 单测通过 |
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

---

## 5. 与参考实现的边界

- `dsh-muse`、`dsh-bot` 只作**只读参考**，不 fork、不复制代码进本仓库。
- 借鉴的是**机制与教训**（授权绑定、keeper 重新武装、TTL、多域隔离），实现代码自己写。
- 两者均为 MIT；本项目同样 MIT，若未来复制其代码片段须保留原始版权声明。

---

## 6. 本仓库不做什么

- 不做「每用户独立云 VM」硬隔离（gVisor/Firecracker 级）——那是 Dot/Muse 的护城河，本机场景不划算。
- 不做 4000 连接器目录。
- 不把「凭证不出域」说成已实现，除非真的验证过。
