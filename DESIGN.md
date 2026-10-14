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

**这一节此前写错了一件事，而错的是主张、不是验证。** 它连续多轮说「面板从未在真实浏览器里被验证过」。真相是宿主暴露了一个只读的 Inspect provider，它查询的正是**用户真正常开的那个页面**——这个能力一直存在，只是没人去问。实测：

```
(client) Slots.listSubTree → sidebar.panellist occupants
  { registrant: "dsh-den", id: "dsh-den.status", order: 245, active: true }

(client) Slots.listSubTree → main occupants
  { registrant: "dsh-den", key: "dsh-den.status", active: true }
```

**这就是面板挂在真实浏览器里的证据**：两个 slot 都与本仓库的主张一致，而且是从**活页面**读到的，不是从插件自己的注册调用读到的。之前那句「从未观测」把一个**可达的**接缝说成了不可达——这比一个失败的测试更糟，因为它会让人停止去找。

**同一轮里还划清了那条边界的准确位置。** `/` 需要 `dsh web` 打印的令牌（实测返回 68 字节的 `dsh web authentication required; reopen the URL printed by dsh web.`），而 `/dsh-den` **免认证可达**（200 + 完整 JSON 信封）。所以真正剩下的未知不是「面板通不通」，而是**渲染出来的文字与点击路径**：`Slots` 给的是拓扑，不是像素。

**「浏览器到过」这个字段本身也不够。** `firstReachedAt` 只有一个时刻，而部署探针与每 15 秒轮询一次的面板（客户端 `setInterval(load, 15000)`）产生的是同一个时刻。所以路由现在记录**每一个**请求，并保留最新调用者**自己说的**东西：`transport.lastRequest` 原样带上 user-agent / origin / referer，外加 `requestCount`。**原样而不分类**——标签是本插件对「谁打的」的意见，而这个字段存在的意义就是让读它的人自己判断。首次接触仍只写一次、之后不动，否则区分探针与面板的那个字段就被自己抹掉了。

**并且刻意不给面板加一行 UI。** 面板本身就是浏览器，让它把自己的轮询显示给自己，唯一诚实的内容是「是的我在」。这个字段是给人**读**的，不是给人**看**的。顺带一提，这条改动的测试替身原先**没有 `headers`**——真实 `IncomingMessage` 一定带，替身不带，于是归属这条路径可以在全绿的情况下对每个调用者都报 `null`。夹具的形状不对，测的就是别的东西。
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

### 2.9 第四个假替身，落在**授权**路径上

能力 1 的主张是「agent 造不出自己的自治权」。它的实现靠 `tools.guard` 把 `den_set_autonomy` 判成 `ask`，而本机审批设施缺失 → `ask` 变拒绝。

这个主张有一个值得攻击的假设：**闸门是唯一挡路的东西。** 闸门管的是**工具调用**；而面板路由是 HTTP 处理器，且实测**无需认证即可访问**（姊妹插件的路由 200）。所以如果 `autonomy/confirm` 凭一个有效 token 就能授权，那任何本机进程——包括 agent 自己 `curl` 一下——都能自授自治，闸门就是装饰。

**实测（`tools/check-live-grant-bypass.mjs`，用真实活会话 id，不是合成 id）：攻击失败。**

```
ok   a live conversation is available to attack — session-95cc8a8d-…
ok   the panel mints a token — 32 characters
ok   the route refuses autonomy with no message id at all
     — DEN_ACTION_FAILED:dsh-den: autonomy requires a direct human request
ok   the route refuses autonomy with a fabricated message id
     — DEN_ACTION_FAILED:dsh-den: autonomy requires a direct human request
ok   no authority exists after the attack — autonomy=null grantFiles=0
```

两条拒绝**报同一个错**，说明卡点不在 messageId，而在更早的那一步：`isDirectHumanDriver` 要求 `agents.currentInitiator() === agent`，**而 HTTP 路由处理器不在任何 agent 的 async 链里**，所以它永远拿不到 initiator。**闸门确实是唯一能授权的路径面。**

**但审计同时翻出一条假测试。** `test/panel-actions.test.mjs` 有一条断言「有效 token + 真实人类消息 → 路由授权成功」，而它通过的唯一原因是替身把 `currentInitiator` 写死成 `() => agent`。改成 `undefined`（**这才是「一次路由调用」的真实模型**）之后，**恰好只有那一条变红**。已改写为断言拒绝，并补一条互补测试钉住「授权只发生在 agent 自己的回合里，而那正是闸门守着的那条路」。

这是同一个坑的第四次，也是最贵的一次——前三次在投递路径上，这次在**授权**路径上。纪律不变：**只建模拒绝，不建模接受**；而这一次还多一条：**替身要建模调用的形状，不只是服务的形状**。「一次 HTTP 路由调用没有 initiator」和「一次工具调用有 initiator」，正是安全模型本身的分界线。

### 2.10 能力 4 的端到端活体证据，以及一个「永远报告没有判定」的审计面

**先说结论：能力 4 的强制面在真实宿主上跑通了，而且是在我没有刻意安排的情况下。**

闸门的规则是**按路径匹配**的（`/\.dsh[/\\]\.?credentials\.ya?ml/i` → `deny`），并且装成 `ctx.tools.guard`，拦截本 profile 里**所有**工具调用——包括我自己的。于是有一个零风险的测试：读一个**按规则该被拒、但根本不存在**的凭证形状路径。闸门若生效，调用在碰文件系统之前就被拒；若不生效，只会得到 ENOENT，不会泄露任何东西。

结果：

```
Error: refused: this would pull a stored credential into the conversation (credentials-yaml)
```

逐字来自 `src/gate.js`。而宿主的服务事件流里同时记下了这次判定：

```json
{"type":"gate","tool":"read","rule":"secret:credentials-yaml","risk":2,"decision":"deny",
 "sessionId":"session-95cc8a8d-a3e9-4e2a-a67d-12292d17ba24"}
```

同一条流里还有两条我原先归因错误的记录：

```json
{"tool":"pwsh","rule":"outbound:curl-upload","risk":1,"decision":"ask"}
{"tool":"pwsh","rule":"outbound:recursive-delete","risk":1,"decision":"ask"}
```

**那两个我以为是「用户手动拒绝」的调用，其实是 den 自己的闸门判成 `ask`、再因本机审批设施缺失而拒绝的。** 闸门一直在运行，而且一直在影响这个会话——只是我没有把它与那两次拒绝联系起来。

**但同一批证据翻出一个缺陷：审计面永远报告「没有判定」。**

`onDecision` 只调用 `noteEvent`（内存环形缓冲，`status.recentEvents`），**从不调用 `recordAudit`**；而 `gateAudit()` 读的是 `gate-audit.json`——**一个没有任何代码写入的文件**。所以 `status.gate.recent` 恒为 `[]`，即使刚刚发生了三次真实判定。`recordAudit` 是死代码，`MAX_AUDIT` 与整个持久审计设计因此从未生效。

失败方式值得记下来：**读一个从不被写的文件，看起来与一个从未触发过的闸门完全一样。** 没有报错、没有异常、面板显示「一切正常，没有判定」。

已修：`onDecision` 现在同时写内存环与审计文件；`test/gate-installed.test.mjs` 新增一条测试，从**服务读取端**与**磁盘文件**两端各断言一次（只走 `gateAudit()` 的话，读写共用一块内存也能通过），并断言审计**不记录参数**——只记 verdict，因为把参数抄进审计日志就是把秘密泄到第二个地方。

**这个修复需要一次重启才在活体上生效**，与投递修复一样：插件模块在宿主启动时载入。

### 2.11 第三个「报告它没测量过的结论」的字段：`stateSurvivesRestart`

同一类缺陷的第三例。前两例是 `statusSnapshot` 的白名单，和 `gateAudit()` 读一个从不被写的文件。

```js
stateSurvivesRestart: readJson(this.statePath) !== undefined,   // 在 status() 里
```

它上面两行的注释写着：*"Counts come from disk, never from memory, so this cannot overstate what survived a restart."* ——**而它恰恰在过度声称**。

启动时 `saveState({})` 会写下 `state.json`，而 `status()` 在写入**之后**才读它。所以这个字段在**从未重启过的机器的第一次启动**上就是 `true`。**一个以过去事件命名、却用现在时读取来回答的字段，不是测量，是一个碰巧看起来像测量的常量。**

设计者自己的注释把意图说得很清楚：*"A resident assistant that cannot say whether it has ever run is not reporting its state honestly."* ——要回答的是「以前跑过没有」。而这个实现永远回答「有」。

**代价是它已经被当成证据引用了**：`tools/check-acceptance.mjs` 在**全新 home 的第一次启动**上断言 `stateSurvivesRestart === true`，检查名却是「boot persists state」。字段的名字**代替了**测量来提供结论。

**修法**：在启动 claim 目录**之前**捕获，这才是一个「答案还有可能是否」的时刻。

```js
const priorState = readJson(this.statePath)
this.priorStateExisted = priorState !== undefined
this.priorStateCreatedAt = priorState?.createdAt ?? null
```

`status()` 改为报告 `stateSurvivesRestart: this.priorStateExisted`，并新增 `stateCreatedAt`——它是让上面那行**可被读者独立核对**的另一半。

**两个消费方一并改成断言真相**，而且比原来更强：

```
ok   a first boot reports that nothing preceded it, rather than claiming a survival
       stateSurvivesRestart=false
ok   a second boot finds the state a first boot left behind
       stateSurvivesRestart=true
```

那条验收里本来就有**第二次启动**（`afterRestart`），所以能力 2 的持久化主张现在由一个真实的 `false → true` 转变来支撑，而不是由一个恒真的常量。`test/mount.test.mjs` 里也补了一条专用测试，用**同一个 home 上的两次 `apply()`** 钉住这个转变——那是「进程重启」从插件这一侧看到的样子。

**可复用的判据**：一个字段若以**过去事件**命名（survived / recovered / delivered / refused），就必须在**该事件还有可能没发生**的时刻采样。晚一步采样，它就从测量退化成常量，而且**不会报错**——只会安静地为假。

### 2.12 面板承诺了一条没有接线的机制：令牌

面板对用户的原文是：

> Paste this token to the assistant in the conversation; it will grant access with this message as proof. The token is single-use and expires.

**没有任何一条能授权的路径校验过这个令牌。**

- 工具的实现在 `src/index.js`：`service.setGrant(agent, args.autonomy === true, String(args.humanMessageId))`，它的 schema 只要求 `autonomy` 与 `humanMessageId`。**令牌不在这条路径上。**
- `recordGrant` → `isDirectHumanDriver` 校验的是「本回合里存在一条 id 等于 `humanMessageId`、且 `source.kind === 'user'` 的消息」。**它检查的是消息的 id，不是消息的内容**，所以令牌是否出现在那条消息里从未被读过。
- 唯一读令牌的地方是 `autonomy/confirm`，而 §2.9 已实测证明它**永远不可能成功**（路由处理器拿不到 initiator）。

所以令牌在**每一条能授权的路径上都是装饰**。真正阻止 agent 自授的是闸门审批，不是令牌。

**这不是一个漏洞**，但它是一处「机制被声明、却未实现」的界面文案——与本项目反复出现的那一类相同：**面板在描述一个它没有兑现的凭证模型。** 人在按下按钮前会相信令牌是那个证明，而实际起作用的是别的东西。

**已接线**（用户 2026-10-13 决定：收紧，让系统做到它已经承诺的事）。

`recordGrant` 新增 `{ requireToken }`：被引用的人类消息**正文**必须包含那个未过期、未消费的令牌。`setGrant` 负责把令牌取出来并执行单次使用：

```js
setGrant(agent, autonomy, humanMessageId) {
  const request = this.panelAutonomyRequest
  if (!request) throw new Error('dsh-den: no autonomy request is outstanding; mint one from the panel first')
  if (Date.now() > request.expiresAt) { this.panelAutonomyRequest = null; throw new Error('…expired…') }
  const record = recordGrant(this.ctx, agent, autonomy, humanMessageId, { requireToken: request.token })
  this.panelAutonomyRequest = null   // 用后即废
  return record
}
```

**为什么这样就够了**：agent 能铸令牌（`autonomy/request` 本身不设闸），也能引用一个消息 id；但它**无法伪造一条 `user/message`**。所以「正文里有这个令牌」这条证据是它造不出来的——第二因子因此成立。

**两个因子相互独立，谁也不能替代谁**，这一点由测试各自钉住：有请求但消息 id 不是本回合的人类消息 → 拒；有请求、有真实人类消息但正文没有令牌 → 拒（`does not carry the panel token`）；两者齐备 → 授权成功，且令牌随即失效。另有一条断言：**一次失败的尝试不会花掉令牌**——否则一次手抖就会让人类白点一次按钮。

**读取正文时对形状宽容、对主张严格**：`messageText` 同时接受 `data.text` 与 `data.content` 里的文本块。宽容是安全的，因为判据是「这个 32 字符随机串有没有出现」，而不是「消息长什么样」；而**读不出来就拒绝**，是安全的那一侧。

在这次改动之前，正确的说法是：能力 1 的控制点是**闸门审批**，令牌是待接线的第二因子。现在两者都在。

### 2.13 闸门把「将要执行的文本」和「仅仅存在的文本」混为一谈

前面每一节都是「某个面报告了它没测量的结论」。这一节不同：闸门**测量得很准**，但测的是错的东西。

`classifyCall` 拿到一次工具调用后，把 `arguments` 整体摊平成一段文本，再对**每一条**规则逐个测试，**完全不看工具名**：

```js
const text = flattenArgs(args)
for (const rule of SECRET_READ_PATTERNS) { if (rule.pattern.test(text)) ... }
for (const rule of OUTBOUND_PATTERNS) { if (rule.pattern.test(text)) ... }
```

于是「出站/上传」这类描述**动作**的规则，被应用到了**根本不会执行那段文本**的工具上——包括正在写文件的 `edit`。

**三点对照实验（全部在活体宿主上，以只读的 `den_explain_gate` 作为控制组）：**

| 传给 `den_explain_gate` 的参数 | 结果 |
|---|---|
| 含上传命令的字面量 | 被拒（`outbound:curl-upload`） |
| 含推送到远端的字面量 | 被拒（`outbound:git-push`） |
| 不含任何模式 | 正常返回 `allow` |

**后果，逐条实证：**

1. **记录规则的文档会被规则拒绝。** 我想在注释里写明 curl 的判据，那次 `edit` 被拒。
2. **闸门自己的诊断工具答不了关于自己的问题。** `den_explain_gate` 是专门回答「闸门会怎么做」的只读工具；一旦问题里引用那个模式，它**先被闸门拒掉**。你没法拿闸门问闸门。
3. **连被替换的原文也要过闸门。** 给 `test/gate.test.mjs` 加测试时，`old_string` 里包含文件既有的那两个字面量，整次编辑被拒；换成不含模式的锚点才写进去。
4. **规则无法被测试、无法被文档化。** `test/gate.test.mjs` 是在闸门存在**之前**写的，此后它的模式覆盖再也无法扩展——因为扩展它所需的数据正是被禁止的文本。新增那条测试里的命令字符串是**拼接**出来的，注释写明这是症状而非风格。

**这不是「太严」，是判据用错了范畴。** 「上传到服务器」是一个**动作**断言；一个不执行任何东西的工具不可能做出这个动作。当前实现把「文本会执行」和「文本存在」当成了同一件事。

**修法（原则）**：出站类规则只能施加在工具**真正会执行**的参数上。

- `bash` / `pwsh` / `shell` → 扫描命令字符串（不变）
- 其余工具 → 不存在「会执行的文本」，出站规则不适用

这**不打开任何执行路径**：任何真正跑命令的方式都要经过 shell 工具，而那条路仍然被完整扫描。真正的变化只是：**一次不会造成该后果的调用，不再被指控为造成了它。**

**上面那句「写一个危险脚本本身没有效果，运行它照样会被拦」后来被量了一次，两半都不准**——一半比它说的更好，一半比它说的更弱：

| 调用 | 判定 |
| --- | --- |
| `read` 凭据文件 / shell `Get-Content <凭据>` / 把凭据路径内联进 `node -e` | `deny secret:codex-sandbox-secrets` |
| **`write` 一个正文里点名凭据路径的脚本** | **`deny`**——比「没有效果」更强：这个写入**根本不会被放行** |
| **`node <那个脚本>`，或者 `node tools/check-deployment.mjs`** | **`allow`**——比「照样会被拦」更弱：闸门看不见文件里写了什么 |

原因是**凭据形状的路径规则作用于所有工具的参数文本**（2.13 里那条「与工具名无关」），而 `write` 的正文也是参数文本。所以把凭据读进对话这条**非故意**的路，两端都是关着的：**要么在 `read` 那一步被拒，要么在把它写进文件那一步被拒**。留下的缝只能靠**在脚本里把路径拼出来**——那已经是故意行为，任何基于文本的闸门都拦不住，也正是 2.14 末尾明确不承诺「凭证不出域」的理由。

这条边界现在有测试钉住（`test/gate-coverage.test.mjs`）：写侧必须 `deny`，解释器侧必须 `allow`。钉住后者不是为了认可它，而是因为**它是一个已知的、被写下来的边界**；哪天真收窄了，这两条测试会先失败，文档必须跟着改。

**为什么没有当场改**：这改变了升级范围，属于权限语义的改动，按项目约定先问用户。

**这一节还顺带解释了本项目里几次「用户拒绝了工具」的误判**——出站与递归删除的升级在审批关闭时落为拒绝，而拒绝信息与人类拒绝**完全同形**，读的人只能猜。判别方法是查 `den_status.recentEvents`，不是问自己「用户为什么拒我」。

### 2.14 闸门能挡什么，不能挡什么

能力 4 的招牌说法是「凭证不出域」。这个说法必须按机制的**实际能力**收窄，否则它就比证据强——而这正是本仓库反复在修的那一类毛病，只不过这次要修的是我们自己的措辞。

**已测量的部分（全部在活体宿主上）：**

- 闸门挂在 profile 的**每一次**工具调用上。`gate-audit.json` 里除了 den 自己的工具，还记着 `plugin_manager` 的判定——一个与本插件毫无关系的工具。所以「覆盖」不是靠列举，是靠拦截点本身。
- 凭据形状的**文本**一律 `deny`，且装在最里层的单调 guard 上。实测：对形状匹配的路径做 `read`，得到 `refused: this would pull a stored credential into the conversation (credentials-yaml)`，并在审计里留下一条 `risk: 2`。
- 每一次判定**跨进程留痕**（见 2.10 的补救），所以「它为什么拒」在事后可查，且记录**不含参数**。

**不能测量的部分，必须说清楚：**

闸门是**对调用参数做模式匹配**的。一个有 shell 的 agent 可以把路径拼接出来、把请求写进脚本，让任何模式都不匹配。所以：

- 它关掉的是**反射性的、直接的那条路**——不假思索地读凭据、顺手把数据传出去。
- 它**不是**对抗性 agent 的隔离边界。它与 agent 同进程，而 agent 有文件系统权限；把「凭证永不出域」建立在一个模式匹配器上，是把愿望当结论。
- 它真正的价值是**让代价可见**：该停下来询问的动作会停下来，被拒的动作留下跨进程可查的记录；而闸门不写进 assistant 的提示词，所以它改不了自己（2.3 的全部意义）。

**因此准确的表述是**：直接路径已关闭并被记录在案；「凭证永不出域」不是这个机制能支撑的断言，本仓库不说这句话。第 6 节把这一条列进了「不做什么」。

**闸门一直被审计的是「太宽」,没人审计过「太窄」——而漏洞在后者。** 前几轮里它两次拒绝一条 `edit`,理由仅仅是那条 `edit` 的**参数里含有某条规则自己的文字**。于是「关得太宽」被反复修。反方向从来没查过:直到把 `TOOL_RISK` 表**逐条**对着**宿主真实工具注册表**读一遍。

`web_search` 是 `allow`,这是**有意的决定**,而且在 5 处被测试钉住。但那个决定依赖一句理由,写在 `test/gate-coverage.test.mjs` 自己的文件头里:

> `pwsh`、`workflow`、`ship_receipt` 可以放行,是因为 deny/ask 规则是**基于模式而非工具**的,所以凭证读取或出站动作**无论由哪个工具承载都会被抓住**。

**对 `web_search` 而言这句话是假的。** 两个机制都不适用:

- **路径规则匹配的是路径**,不是值。`id_rsa` 能被抓住,`sk-` 后面跟三十个字符抓不住——因为那个字符串里没有路径。
- **出站动作规则只对 `EXECUTING_TOOLS` 生效**,而一次搜索不会去推送代码。

后果是具体的:把一段密钥粘进搜索词,**既不询问、也不留痕**;同一段密钥经由一条会外发请求体的 shell 命令,则会停下来询问并被记进 `gate-audit.json`。**这正是能力 4 存在的那类洞:一条出站通道,既无判定也无痕迹。**

**修法不是把 `web_search` 改成 `ask`。** 那等于用「拿掉能力」来堵洞:常驻助理不能搜索就不再是常驻助理,而在审批提示被关掉的 profile 里 `ask` 等于静默拒绝——那正是让人干脆把闸门整个关掉的压力(2.13 已经量过一次)。所以补的是**缺失的那个机制**:一组**凭证取值形状**规则,只作用于「参数本身就是外发载荷」的工具(`web_search` / `web_fetch`),命中判 `ask` 而**不是** `deny`——因为形状是比文件名更弱的证据,而一个人完全可能在搜索「API key 怎么轮换」。

三个后果都被钉住了:

1. **普通搜索不受影响**(`allow`)——所以没有拿能力换安全。
2. **作用域是刻意的**,而且有测量依据:同一条取值规则若作用于 shell 文本,会拒绝本仓库**自己的凭证扫描器**——那条命令里搜的正是 `sk-` 后跟十六个字符这个形状。这与「把删除规则压在‘删除’这个词上」是同一个错误,本仓库已经量过一次。
3. **归因更细**:`rule` 现在是 `outbound:secret-value:openai-key`,审计里能看出是哪一类形状,而不是笼统一句「看着像密钥」。

**同一条纪律再次兑现:证伪。** 把 `NETWORK_PAYLOAD_TOOLS` 清空,新测试以 `a query carrying a key shape must stop, not run` 失败——所以它不是空过。

**紧接着,同一把尺子量到了第二个洞——这次基准是文件系统。** 工具表有「拿宿主真实注册表来核对」的机制,凭据路径表**没有对应的机制**。把本机**实际存在**的凭据存储逐个列出来(包括用户自己的 home 级指令里逐条点名的那些),再拿闸门去问:

| 结果 | 存储 | 说明 |
|---|---|---|
| `ALLOW` | 用户 codex 目录下的 `rules/default.rules` | 用户指令明说**里面有一条真实 token** |
| `ALLOW` | 同一目录下的 `.sandbox-secrets` | 用户指令列为凭据目录 |
| `ALLOW` | 同一目录下的 `tokenrouter.config.toml` | 用户指令列为凭据文件 |
| `ALLOW` | 用户 kimi-code 目录下的 `credentials` | 用户指令列为凭据目录 |
| `ALLOW` | 用户 docker 目录下的 `config.json` | 容器仓库认证 |
| `DENY` | 用户云服务商目录下的凭据文件 | **本机不存在** |
| `DENY` | 用户 ssh 目录下的私钥 | **本机不存在** |

**五个真实存在的,全部放行;两条规则保护的是本机根本没有的路径。** 这张表是照着「凭据文件一般长什么样」写的,从没拿磁盘核对过。**凭记忆写出的清单,保护的是记忆。**

**同一个教训在修的过程中又重演了一次。** 我给 `gh` CLI 凭据写了一条 POSIX 惯例位置——**本机不存在**。量了一下,真身在 Windows 的 `%APPDATA%\GitHub CLI\hosts.yml`。于是规则同时覆盖两者,并在注释里写明**哪个是本机实测的、哪个是别的平台惯例**,不把两者混为一谈。

**修法与上一节同源:补机制,不喊口号。** 五条路径规则加进 `SECRET_READ_PATTERNS`。更要紧的是补上**缺失的那套核对**:`test/gate-coverage.test.mjs` 现在对着一份「本机已知凭据存储」清单逐条断言必须 `deny`,**并且对不存在的条目也断言**——跳过不存在的那些,等于在无人值守的地方把这条测试悄悄变弱。于是一个新出现的凭据存储会变成一条失败测试,而不是一声不响。

**证伪是前后对照,而且是在真实文件系统上量的:** 加规则**之前**那份审计打印的是五个 `ALLOW`,加完之后断言通过。另有一条钉住「路径表独立于工具」——同样的存储经由 shell 读取同样是 `deny`,因为这条表**对每个工具生效**,那才是承重的那条规则。

**第三次,同一个毛病,这次最大:规则是照着作者想象中的平台写的。** 工具表对上了宿主的注册表,凭据表对上了磁盘,而**出站动作表没人对过——它对着的是 Unix。** 本插件发布到 Windows,shell 是 PowerShell,而「把东西发出去」在这台机器上的本能动作是 cmdlet。

实测十二种把数据弄出本机的方式,**全部 `allow`**,而同一种意图换成 `curl` 就是 `ask`:

| 类别 | 具体 |
|---|---|
| PowerShell 网页 cmdlet | `Invoke-RestMethod` / `Invoke-WebRequest` 及其别名 `irm` / `iwr` / `wget` |
| 带发送形状的 | `-Method Post` / `-InFile` / `-Body` |
| BITS 上传 | `Start-BitsTransfer -TransferType Upload` |
| .NET 客户端 | `New-Object Net.WebClient` + `UploadFile` |
| 邮件外发 | `Send-MailMessage` + 附件 |
| LOLBin 下载 | `certutil -urlcache` |
| 传文件 | `scp` / `rsync` / `sftp` |
| 远程执行 | `ssh` |
| 裸连接 | `nc` / `ncat` / `netcat` |
| PowerShell 远程 | `Invoke-Command -ComputerName` |

**控制组(`Get-ChildItem`)也是 `allow`,说明分类器工作正常——是表写给了别的地方。**

**第一版修法是错的,而这个错误值得单独记下来。** 我把远程主机那几条**锚定在文本开头**(`^` 或语句分隔符之后),理由听起来很正当:shell 把命令放在语句开头,这样既关掉本能动作,又不会被散文误伤。**结果它在生产里一条都匹配不到。** 原因在 `flattenArgs`:

```js
if (typeof value === 'object') {
  return Object.entries(value).map(([key, item]) => `${key} ${flattenArgs(item)}`).join(' ')
}
```

**参数名会被拼在值前面。** 一次 shell 调用看到的文本永远是 `command scp …`,**永远不以命令开头**。

**而我的验证方式正好绕过了这个事实:我单独构造正则、单独喂它一个裸命令字符串,它匹配了。** 那条测试证明的是「正则描述了一个形状」,不是「生产会命中」——**测试喂的字符串形状和 `classifyCall` 实际构造的不是同一个**。这是本仓库第 (10) 条纪律(夹具让被测分支不可达)的姊妹形态:**喂错形状的夹具让被测规则永远不触发,而测试是绿的。**

**修法:按目标形状识别,不按位置。** 远程那几条现在要求操作数长得像远端目标(`user@host` / `host:path` / 带点的域名),`nc` 要求主机加端口。这样散文「ssh、scp 和 sftp 都是把文件传到另一台机器的方式」不会被当成命令——**本项目已经两次被自己的文档触发过自己的规则,这次连措辞都不必再绕。**

**测试一律走 `classifyCall` 并传真实的参数对象,从不直接喂正则。** 另外专门加了一条以陷阱命名的测试(`a rule anchored to the start of a command would be dead in production`),钉住 `flattenArgs({command:'echo hi'}) === 'command echo hi'`——**下一条锚定规则会响亮地失败,而不是安静地不起作用。****而写下这一段本身,第五次被自己的闸门拦了。** 我在表格里写了字面路径,凭据路径规则直接 `deny`——**它拒绝让我把它的规则写下来**。这与「删除规则拒绝提到删除的编辑」是同一个形状,而这次连措辞都只能绕着走。这不是抱怨,它是本节论点的最后一块证据:**过宽的规则会挡住关于它自己的记录。****顺带一提,这一轮又被自己在运行的旧代码拦了三次**(两次 `edit`、一次 `pwsh`),每次审计记录都指出是 `outbound:git-push` 或 `outbound:recursive-delete`,而不是任何人。这既是「工具结果不能用来判断是谁在拒绝」的第三次复现,也是那个过宽拒绝的真实代价:**它拦住的是正在修它的那段文字。**

### 2.15 审批提示必须说出目标，否则让人做的决定比机器知道的更少

**这是 2.13/2.14 那条修得不够彻底的地方，由运行中的实例抓出来。**

实际发生的事：助手要 `web_fetch` 读本机 GUI 的页面，闸门给出 `{"tool":"web_fetch","rule":"tool:web_fetch","risk":1,"decision":"ask"}` 并把它拒了（fail-closed，因为审批策略是 `never`）。拒得对，但**提示里没有一个字说它要去哪**。

原因很具体：`destinationOf` 当初只接进了**出站模式规则**那一条分支（`outbound:*`，且只在 shell 工具上跑）；**工具级规则**（`tool:web_fetch`）走的是另一条分支，那条分支只认识「哪个工具」，不认识「去哪」。于是同一个 `web_fetch`：

- 读 `http://127.0.0.1:19387/`（本机 GUI）
- 读 `https://随便谁/collect`

在人类眼前是**同一句话**。闸门手里其实有这条信息（参数里就有 URL），**做决定的人却没有**。

而这不是风格问题：审批门的全部价值就是「让人类看见这是什么」。**如果提示比机器知道的还少，那这个门就把决定推给了一个信息更少的人**——它是把责任转移出去，不是把控制权交回去。中文提示更糟：`translateReason` 只在有 `what` 时才拼接目标，工具级分支没有 `what`，所以**中文那句连目标都会丢掉**。

修法是把 `destinationOf` 提到两条分支都经过的位置，并让 `translateReason` 在没有 `what` 时也保留目标。测试见 `test/gate.test.mjs`（用真实审计条作为事实依据）。

**同一个缺口还有一层，在账本里。** 审计条只写 `at/tool/rule/risk/decision/sessionId`——**不写目标**。所以那条真实的 `tool:web_fetch` 拒绝记录，事后无法告诉任何人那次 fetch 指向哪里：提示里现在说了，**活得比进程长的那一份仍然没说**。于是 `destination` 也进了审计条（派生出的主机名+端口，有长度上限，**仍然不写参数**——审计不该变成它所保护之物的第二份副本）。两处一起修才自洽：一个规则说出「为什么」而说不出「去哪」，等于「为什么被拒」这个问题只对 shell 规则可答。

**修这条时我自己先踩了一次接缝**：第一版测试走的是单调 `guard`，而 `guard` 只在 `risk >= deny` 时才被调用（ask 走 `tools/pre-execute` 瀑布），所以它什么都没记下、断言直接失败。测试失败的原因不是实现错，是我找错了调用者——这正是本仓库反复出现的第 5 类毛病（替身模拟的调用方式与真实调用者不符），这次由测试本身抓住。

### 2.16 「常驻」默认只有一个宿主，而这个前提没有被强制

`~/.dsh/den` 是按 **DSH_HOME** 定位的，**不按 profile 分**。所以两个 profile、或者桌面端 + 终端里的一个 `dsh`，会**在同一个状态树上加载本插件两次**，各自启动一个内核。**没有锁，也没有租约；`status()` 里的 `pid` 只是被报告，从不被用来判断。**

**已测量到的（不是推理）**：两个宿主共享一个 home 时，`dueTriggers(now)` 对**两者都**返回同一个触发器——**读不是认领，没有任何东西排除第二个内核**。测试 `test/cold-start.test.mjs` 里那条「two hosts on one home are both told the same trigger is due」钉住的就是这件事。

**而重复投递已经测到了，不再是推理。** 内核里的顺序是 `dueTriggers` → **`await deliver`** → `bumpLedger` → `markFired`，中间那个 `await` 是宽的。kernel.js 的注释明确解释了这个排序：进程若在投递中途死掉，这次检查**仍然到期**，「重复只花一个廉价回合，总好过整次检查被吃掉」。**在单宿主下，这是拿罕见的重复换必然的不丢失；在两个宿主下，同一个排序让重复从罕见变成常态。**

测试把第一个内核**停死在它自己的投递里**（那个 `await` 窗口），让第二个内核跑完整拍，然后放行第一个。结果：**同一个触发器被投递了 2 次**。同一测试里还有一条防伪断言——第二个内核的 `outcome` 必须是 `spoke`，即它**确实准入并投递了**，否则一个「因为拒绝所以只记了 1 次」的假象会被误读成互斥生效。

**因此正确的修法不是「投递前认领」。** 那会把 kernel.js 明确拒绝的丢失风险换回来——把注释里权衡掉的东西又买回来。正确修法是**互斥**：同一个 home 上只允许一个内核持有驻留权。

**实现落点是 `src/resident.js`。** 形状是上一轮定下的那个：内核**照常启动、照常每拍运行**，只是拿不到租约的那一拍 `standby`、不投递、下一拍再试。**因此不存在「所有宿主都让位、于是无人驻留」的死法**——这是把它做成逐拍认领而不是启动期锁的唯一理由，也是本模块最要紧的一条。认领用 `openSync(path,'wx')` 的原子创建；`renewedAt` 过期**或**持有者 pid 已消失即被接管，所以**重启在第一拍就接管**，不必等满陈旧窗口（有独立测试钉住）。

**归属判定用 instance 令牌，不用 pid。** 同一进程里可以挂载两个插件实例，比 pid 会让第二个把第一个的记录当成自己的、然后照样投递——那正是要修的 bug。pid 只用来判断持有者是否还活着。

**两个真缺陷是「为头注释里那几句话写的测试」抓出来的。** 头注释声明了每个失败方向往哪边倒，而关于失败方向的声明恰恰是最容易永远不被测到的东西，所以我为每一句写了测试。结果两句是假的：

1. **亚毫秒时间戳舍入。** 刚写下的记录，其 mtime 可能因为舍入「领先」于采样到的 `Date.now()`，于是 `age` 为负、被判成「来自未来」、当作损坏记录回收——**那个崩溃窗口保护静默地没在保护**。修法是给「未来」一个有界容差（`CLOCK_SLACK_MS = 60_000`）。容差给得宽是有理由的：共享一个 home 的两台机器时钟差几秒完全正常，略微领先的持有者更可能是时钟偏斜而不是损坏；但**远超容差的未来时间戳必须被回收**，否则一条损坏记录可以永久占住状态树而没有任何人在投递——那比重复更坏。
2. **`mkdirSync` 的 `EEXIST` 被误当成「输掉竞争」。** 父路径是文件时 `mkdirSync` 也报 `EEXIST`，于是**不可写的 home 会让宿主永久让位**——正是本模块存在的目的所要防的那一个结局。修法是把「准备目录」和「创建租约」拆成两个 `try`：**只有创建那一步才可能是输掉竞争。** 这是一个只有测试才会问的问题：「这个错误码还可能是别的什么意思？」

顺带记下一个约束：租约拦的是**投递**，不是读——`dueTriggers` 是纯读，即使有了租约，第二个宿主的这次调用仍会返回「到期」。所以 2.16 前一条测试在租约落地后**依然成立**；而 2.16 那条新测试（钉机制的）在租约落地后按设计**必须改**，改成断言第二个内核 `standby` 且只投递一次——**它确实改了**。这正是「钉机制而非钉数字」的兑现：钉数字的版本会安静地把 bug 祝福成规格，钉机制的版本在修复落地时响亮地失败。

**还剩下什么，写清楚而不是装作没有**：这是**尽力而为的互斥，不是分布式锁**。两个宿主面对一份**同时不存在**的租约，靠原子创建分胜负；但一个被 `kill -9` 的持有者若立刻被同名 pid 复用（Windows 上极不可能），接管可能延后到陈旧窗口。另外测试夹具在这一轮暴露了一个**一直存在的谎**：`coldHost` 从未定义 `state.dispose`，于是文件里 11 处 `first.state.dispose?.()`（每一处「进程一退出」）**全是空操作**；租约之前没有任何东西依赖它们，所以这个谎是隐形的。这一类——**一行以某个事件命名、而那个事件从未发生**——是本仓库第 3 条缺陷纪律的同族，值得单独记一笔。

**同一轮里，闸门第一次让它的作者误判了「是谁在拒绝」——而且误判了两次。** 我先用一条附带递归强制删除的命令去重跑全新克隆证明，工具返回「the user rejected tool pwsh」，而审计记录里躺着的是：

```json
{"at":1791870856146,"tool":"pwsh","rule":"outbound:recursive-delete","risk":1,"decision":"ask"}
```

**没有任何人拒绝。** 随后我要把这件事写进本节，那条 `edit` 又被拒，再次显示「the user rejected tool edit」，审计里同样清楚：

```json
{"at":1791870933590,"tool":"edit","rule":"outbound:recursive-delete","risk":1,"decision":"ask"}
```

第二次更值得记：`edit` 的入参里含有那条删除命令的**原文**，于是出站规则在**一个不是 shell 的工具**上命中了。可工作区源码第 249 行明明写着，文本规则只在 `EXECUTING_TOOLS`（`bash` / `pwsh` / `shell`）上跑。**两边都是对的，矛盾只有一个解释——正在跑的实例是旧代码。** 实例 `startedAt` 是 05:06:55，而这条收窄是之后才提交的，`verify:live` 变红正是同一件事。它就是第 28 轮用户明确选定的那个收窄（「只有 shell 工具扫描出站规则」）：**已经写好、已经提交、只是还没被加载。**

这给出一条纪律，比原来的 6 号更硬：`ask` 在一个审批被关闭的会话里自动变成拒绝，harness 于是把这个结果渲染成「用户拒绝了」。**所以工具结果不能用来判断是谁在拒绝，`gate-audit.json` 里的 `rule` 才能。凡是要判断「谁说不」，查审计记录。** 差点被写进报告、甚至写进一个要发给用户的问题里——那会是一句关于用户行为的假陈述，而它是我自己的代码造成的。

顺带一个直接后果：重跑该证明不需要任何删除，克隆到一个尚不存在的目录即可，**证明本身与它附带的那条删除命令无关**——把两件事绑在一起，才让一次本可自动完成的验证看起来像需要人来批准。

**于是这次重启不只是为了跑通端到端。** 它同时会消掉一个**已经三次挡住正当工作**的过宽拒绝：写 curl 规则的文档、那条带删除命令的探查、以及本节这条 `edit`。**一条过宽的规则被关掉的方式，往往是它开始拦住写它的人。**

**租约最要紧的那条分支，单进程测试永远碰不到——所以补了真进程。** `defaultIsAlive(pid)` 问的是操作系统「这个 pid 还在不在」。在一个进程里两个持有者的 pid 都是 `process.pid`，于是这个判断是恒真的：**一个根本不检查 pid 的实现也能通过全部单进程测试。** 这不是理论担忧，是这个模块唯一的核心分支。

`test/two-process.test.mjs` 因此真的起子进程（`test/support/resident-child.mjs` 就是一个 Host），每个用例跑两个进程、共用一个 `DSH_HOME`——也就是 `DSH_HOME` 决定状态树所允许的「两个 profile 共用一个 home」：

1. **第一个进程退出后，第二个进程拿到驻留权。** 断言里显式检查第一个 pid 已经**真的不存在**，否则这条测试什么也没证明。
2. **第一个进程活着时，第二个让位**，并说出持有者的 pid，同时自己的心跳仍在跑。
3. **两个真实进程看着同一则到期检查，只投递一次。** 第一个进程停在 `deliver` 里（那是真实投递等宿主的那段窗口），第二个进程带着同样的时钟去 tick。

第 3 条是整件事的起点：**把租约删掉，它以「and must stand down rather than deliver it」失败**——也就是说它不是在空过。这一步是刻意的：本仓库最贵的一类错误，就是一条永远不可能失败的测试。

第 4 条补上能力 2 里一直没有证据的那一半：**持有者是被 `kill` 掉的，不是被优雅 dispose 的**——没有任何东西释放租约、也没有任何东西续期，文件就那样躺在那儿。下一个进程必须**自己**接管，然后真的把那个死进程从未触发的检查投递出去。**这正是启动期锁会做错的情形**：若驻留权只在启动时认领一次，这棵状态树就会在人类察觉之前一直没有驻留者。

**而这四条测试此前一直在以错误的理由通过。** 子进程原来用合成时钟，于是两个进程写下的租约时间戳相差几千倍，记录**永远**判为陈旧——**从来没有一次是由「持有者是否还活着」决定的**。换成真实时钟之后，这条分支才第一次被走到。证明方式仍然是证伪：把 `defaultIsAlive` 改成恒真，**恰好**那两条「死掉的持有者」用例失败（「a dead owner must not block the tree」「a dead owner must not keep the survivor waiting」）。

**这是一类更隐蔽的空过**：不是断言写错了，而是**夹具让被测的那条分支不可达**，测试全绿、覆盖率为零。合成时钟看起来更可控、更确定性，代价是把要测的东西挪出了射程。

**顺带把一个一直没解释的现象缩小到了范围。** 前几轮里 `node --test` 偶发整体文件级失败（一次 116 个测试 / 8 个文件、一次 138/5），伴随原生层乱码报错，崩掉的文件包括与本次改动毫无关系的 `primitives`、`memory`、`lossless-output`。这一轮量到了它的形状：`node --test` 默认按 CPU 数并发，每个测试文件一个进程，而 `test/` 现在有 26 个文件、其中还有会再起子进程的。把并发限到 4：

```
default        : exit 0 | 22.3s | 255/255
concurrency=4  : exit 0 | 16.3s | 255/255
```

**既更快又更稳**，因为这里本来就是 I/O 型负载，过订阅是净损失。所以 `npm test` 现在带 `--test-concurrency=4`。**但必须说清楚:这是对一个尚未完全诊断的现象的缓解,不是已证明的修复**——它降低峰值进程数,而峰值得以产生的原因是推断的,不是观测到的。若它再复现,这里的结论就该被推翻。

**顺带记下一个反直觉的事实**：这条缺陷是**本插件自己的闸门挡住了本插件的作者**去读本机页面时暴露的。闸门跑在 assistant 的提示词之外、拦的是 profile 里的每一次工具调用，所以它同样拦写它的那个 agent——这正是 2.3 想要的，也说明它的盲点只能从"被它拦下来"这一侧看见。




### 2.17 租约的互斥一直是**论证**出来的；第一次真的去量，它就塌了

`resident.js` 里那句注释写得很确定：**「Create-if-absent is the mutual exclusion. Two hosts reclaiming a stale lease at the same instant both reach here; exactly one `open` succeeds and the loser gets EEXIST.」** 这是一段推导，不是一次观测——而它错了。

量法：四个真实进程由一个共享的 `go` 文件在同一瞬间释放，抢同一个空租约，四个进程各自报告自己是否持有。**结果是一轮里三个进程同时 `held: true`。**

两个彼此独立的原因，第二个比第一个更值得记：

**原因一：`process.kill(pid, 0)` 会对一个活着的进程说「无此进程」。** 实测到的形状是

```
judged {"age":1,"fresh":true,"alive":false,"holderPid":41100,
        "killError":{"pid":41100,"code":"ESRCH","message":"kill ESRCH"}}
REMOVING pid=41100
created
```

而 41100 自己随后报告 `held: true`。**误报率随条件变化，这比稳定报错更糟，因为它会藏起来**：空闲父进程探自己的直接子进程，24000 次里 0 次误报；四个兄弟进程在 CPU 负载下互探（并且每轮清掉上一轮的 pid 文件，这一点第一版探针写漏了，于是第一版报出的「27% 误报」其实是拿上一轮已死的 pid 去探），48000 次里误报 590 次（1.2%）；换一次运行又是 384000 次里 0 次。

**原因二：「先删掉那条记录，再 create 一条」根本不是互斥，与存活判定对错无关。** 两个宿主都判定同一条记录已自由，于是都 `rmSync` 它——**第二个人的删除，删掉的正是第一个人刚 create 出来的那条**，随后两个人都 create 成功、都认为租约是自己建的。所以注释里那句「exactly one open succeeds」只在**没有人中途删除**时成立；而接手这条路的第一步就是删除。

两条修法：

1. **接手的权利本身也做成 create-if-absent**，名字由「被接手的那条记录」的身份推出（`<lease>.reclaim-<instance>.<renewedAt>`）。凡是判定**同一条**记录的宿主算出的名字相同，于是只有一个能建、其余全部让位。标记文件刻意不回收：一个慢宿主可能读完记录、输掉声明、仍然照着它读到的那条去动手，标记存在正是为了拦住它。用零字节文件换掉第二个驻留者，这笔账很划算。
2. **存活否定的结论不再足以处置一条「年轻」的记录**（`TAKEOVER_GRACE_MS`，1 秒）。代价必须说清：**持有者在最后一次续期后一秒内死掉时，接手要等到下一个心跳**。现场几乎不付这个代价——重启时上一位持有者的记录至少有一个心跳那么旧，照旧立刻接手；但两条跨进程测试确实因此要改成「持有者运行了一会儿才消失」，**这个改动本身就是代价真实存在的证据**，不是测试迁就实现。

**还有一条被否掉的想法，记下来免得它被当成修法。** 给 `defaultIsAlive` 加同步小睡重试（`Atomics.wait`，5ms，共 4 次）**没有解决问题**：去掉 grace、只留重试之后，竞态在 8 次运行里 8 次都还产出两个持有者。紧循环三次重试同样无效。误报在那个时间尺度上是**稳定**的，所以「重试一下就好了」在这里是错的；保留重试只是因为它便宜，不声称它是修复。

**证伪的方式也得改。** 两个竞态测试**抓到了**这个缺陷，但它们**不是可靠的验证器**：把任一修法去掉，单跑一次竞态测试**仍然通过**——坏的交叉只在这个机器忙的时候出现（这正是 2.9 那个夹具陷阱的同类：只在负载下才失败的测试不是测试）。所以两条修法各自补了一个**确定性**的进程内验证器，并且都实测过「去掉修法即失败」：

| 去掉什么 | 哪条用例失败 |
| --- | --- |
| grace | `a record younger than the grace is not taken over on a liveness answer alone` |
| 接手声明 | `a second host cannot take over a record that has already been taken over` |

**遗留的诚实边界**：grace 是「一次错误答案能造成多大破坏」的上界，不是「探针已经可信」的证明。误报若活得比 grace 长，接手照旧会发生；存活探针在这个平台上依然不可靠。要彻底闭合，只能把存活判定从接手决策里拿掉、只靠记录年龄——那等于让重启等到 `staleMs`，是另一个取舍，这一轮没有替用户做。

### 2.18 插件路由天生「无鉴权」,这既不是缺陷也不是疏忽

起因是想要一张**面板真实渲染**的截图(见下),结果 WebBridge 打开的页面回的是 `dsh web authentication required`——外壳要令牌。可同一时刻用裸 `curl` 打 `/dsh-den`,拿到的是 **200 + 完整状态 JSON**。同一 origin、同一时刻，两个答案：

| 请求 | 结果 |
| --- | --- |
| `GET /` | **401** `dsh web authentication required` |
| `GET /dsh-den` | **200**,完整状态文档 |
| `POST /dsh-den` | **200** |

我去查了宿主契约（host Inspect `Service`），而不是自己解释：**`webServer.register(route: WebRoute)` 不接受任何认证参数**；外壳的令牌门装在**另一个服务**上——`connection.authorizeIndex(request, response)` 与 `requestRejection(request)`。插件路由不经过它。所以「插件路由无鉴权」是**构造出来的**，不是本项目选错了接口。

**严重性按测量说，不放大。** 主机只绑 `127.0.0.1`，所以可达面是本机进程而不是网络；而 `~/.dsh/den/` 里的一切对本机同用户进程本来就是可读的——**这条路由没有比文件系统多暴露任何东西**。外壳之所以要令牌，是因为它载着**每个会话的对话**，那是另一种资产。可写动作也被别处兜着：`autonomy/confirm` 从路由里**永远不可能成功**（路由处理器不在任何 agent 的异步链上，没有 initiator，实测），而没有已验证授权的唤醒会被授权闸门拒绝。

**但它值得写下来，因为它意外**：同一个 origin 上一个门开、一个门关。所以它现在是一条**每次部署检查都会报的活体断言**（`tools/check-deployment.mjs`）：外壳必须 401/403、路由必须 200。哪天 DSH 把插件路由也纳管了，这一行会失败，提醒回来改这一节。

**记下没做的事，以及为什么。** 没有给路由自己加一层令牌门。钩子是存在的（`connection.requestRejection`），但面板是从浏览器里 `fetch` 过来的，能不能过那道门取决于外壳用什么承载会话（URL 令牌换 cookie？）。**而我进不去那个已认证的页面**——它握在桌面客户端的 Electron 子进程里，能驱动的只有用户的 Chrome——所以这个改动**无法验证**。按本仓库的规矩：不可验证的改动不做，先写清楚为什么不做。

**顺带把 UI 验收的真实状态补齐一句。** 面板的**渲染像素**仍然没有证据，但比「只有拓扑」更进了一步：用 client Inspect provider 查**活着的页面**，`main` 槽的占用者里有 `dsh-den` / key `dsh-den.status` / **`active: true`**——也就是说客户端半边在真实页面里已挂载并激活，而不是只在离线替身里通过。要走到像素，需要那个 Electron 手里的令牌，或者你把它在 Chrome 里打开一次。

### 2.19 保质期与去重撞在一起,会把一条当下的提醒永久静音

两条规则**各自都测过**——通知有 12 小时保质期、同内容只存一条——但**从没量过它们相遇的地方**。`queueNotice` 用「这个文件名在不在」判断重复,而**过期的记录文件还在**。

**探针第一版自己就犯了本仓库反复记过的那类错。** 我把未来时刻只传给了 `pendingNotices`,`queueNotice` 留在真实时钟上;于是它打印的「t+13h 重投 → `queued=false`」其实是在 **t+0** 对一条 **0 分钟大**的记录做的重复投递——那是**正确**的去重,被我当成过期证据报出去了。把时刻同时传进两处,才量到真东西:

| 时刻 | 动作 | `deliverable` | `expired` |
| --- | --- | --- | --- |
| t+0 | 首次投递 | 1 | 0 |
| t+13h | 不投递 | 0 | 1 |
| t+13h | **重投同内容** | **0** | **1** ← 永久静音 |

**判据是反的。** 去重应该问「**有没有一条还送得出去的同内容记录**」,而不是「有没有这个文件名」。同一条推理还覆盖**损坏**的记录:`pendingNotices` 把它算作 `invalid`,而它一样永久挡住同内容。所以「死记录」= 过期**或**读不出来。

修复:`queueNotice` 先读现有记录——**还送得出去**才去重,而且**不碰它的时钟**(对照测试钉住这一点);**死记录原地替换**,`createdAt` 归零并如实报 `queued: true`;文件缺失时仍走 `publishIfAbsent`,保住「输了竞争只可能是别人存了同内容」这条原子性。

**顺带发现第二件:没有任何东西删过通知文件。** `~/.dsh/AGENTS.md` 里「崩溃残留要回收」的那套推理同样适用——一个跑几个月的常驻助理会为它说过的每一句不同的话留一个文件,而 `allNotices()` **每次状态查询都读全部文件**。所以启动时加一次 `sweepExpiredNotices()`(与既有的临时文件回收并排),回收数进 `status.reapedNotices` 并显示在面板上。**不可见的能力降级就是缺陷**,这条本仓库已经吃过一次(见 2.10 的静默 404)。想法(`idea`)不回收,它本来就不失效;读不出来的文件也不回收,交给 `pendingNotices` 去报。

**两个修复各有一条移除式证伪。** 把 `queueNotice` 退回一行式 `publishIfAbsent` → **只有** `an expired notice does not silence the same observation made again` 失败(22 通过 / 1 失败),而既有的 `identical notice content collapses to one record` 在旧代码下照样通过——证明新测试钉的是新契约,不是把去重又测了一遍。把清扫改成空操作 → **只有** `the sweep reclaims expired notices, and only those` 失败。两次都按 sha256 还原为修复版(`8A7ABB…D52E`)。

### 2.20 触发器验了信封,没验排程真正要用的字段

`isValidStored` 检查 id、sessionId、kind、title、prompt、enabled、fireCount——**全是信封**——而 `nextTriggerAt` 实际读的是 `createdAt`、`everySeconds`、`atTime`、`weekday`、`at`、`lastFiredAt`、`maxRuns`。一条缺 `everySeconds` 的记录因此**通过校验、被列为一条有效触发器、并且永远不可能到期**。

量出来的:

| 存储的记录 | 修前 | 修后 |
| --- | --- | --- |
| 4 条排不出来（缺 `everySeconds`/`atTime`/`weekday`/`at`） | `valid=5 invalid=0` | `valid=1 invalid=4` |
| 90 天后到期 | 只有健康那条 | 只有健康那条（不变） |

也就是说**人被依靠的提醒永远不响,而所有界面都报它健康**。而那条 docstring 本来就写着「Stored triggers that fail validation are reported and skipped, never trusted」——它们**既没被 report 也没被 skip,因为它们压根没 fail validation**。

`invalid` 早就被 status（`triggers.invalid`）和面板（`invalidCount`）报出来了,所以判据一修好,这些记录**自动变可见**——不需要新 UI。

新增的 `isSchedulable` **刻意只管 `nextTriggerAt` 读的那些字段**:在这里加一个必填项,会把该字段存在之前写下的每一条触发器一起作废,那是同一个伤害换了个方向。测试带**反向对照**（四种良构触发器必须仍然有效且可排程）,否则「一律拒绝」也能过。

测试夹具自己也踩了一次本仓库记过的坑:第一版写成 `{ ...whole, kind: 'interval' }`,**展开不能删字段**,`everySeconds` 还在,于是「缺字段」那条根本没缺——夹具让被测分支不可达。删字段必须显式写 `undefined`（JSON 会丢掉它）。

**同一处还纠正了一句过强的断言。** `nextTriggerAt` 里「补步进以保持原节奏」那段,只有当调用者问一个**比「最后一次触发 + 一步」更晚**的时刻才会执行;而本仓库两个调用者（`dueTriggers` 与 `statusSnapshot`）**都传 `lastFiredAt ?? 0`**,正是算术的起点,所以 `base + step > after` 恒真、那段在生产路径上**从不执行**。单测能碰到它,只是因为它直接传了 `after = now`——而且那条单测的标题也照抄了同一个错误断言。实测:按调用者的问法答 `+600000ms`,按单测的问法答 `+10800000ms`,差 **170 分钟**相位。对 `dueTriggers` 来说这是**故意**的——改成问 `now` 会让停机期间错过的检查点落到未来而被跳过,正好违背能力 2 的承诺——代价是节奏会**重锚到实际醒来的那一刻**。注释现在写的是这个,不再是那个。面板那侧还有个判断题（`nextCheckAt` 因此可能显示一个过去的时间）**本轮没动**:对 `once` 触发器,显示「它本该响的时刻」也有意义,两种读法都站得住,不在判决未定时改 UI 语义。

### 2.21 一次罕见失败为什么无法诊断:唯一能解释它的东西被丢掉了

全量套件跑出过一次 `verify exit: 1`,两条**真实子进程**测试失败:

```
✖ four real processes released in the same instant produce exactly one owner (30395ms)
    Error: timed out waiting for ...round-0-racer-2.json.ready
✖ two real processes deliver one check-in, because only one holds residency (689ms)
    Error: child exited 2147483651
```

而几分钟前、以及之后两遍全量,都是 279/279 全绿——**罕见**（约六遍里一次）,而且**两条消息都等于没说**:`2147483651` 是 `0x80000003`,没有任何原因;超时那条只说某个文件没出现。

三处原因叠在一起,**每一处单独都能成立**:

1. 子进程用 `stdio: 'ignore'`,它的 stderr——唯一解释它为什么死的东西——**被丢掉了**。
2. `waitFor` 只轮询文件,不看子进程死活;而 `.ready` 是在**自旋之前**写的,所以「`.ready` 没出现」只可能是**进程没起来**,不可能是「它很忙」。
3. 子进程退出 promise 的拒绝被 `done.catch(() => {})` 吞掉（那行本身是必要的:没人 await 的拒绝会让 runner 当崩溃）,于是**一个快速、信息量大的失败被换成了一个 30 秒的谜**。

修法:`stdio` 改成**重定向到文件**（不是管道——受限沙箱拒绝管道,而 `ignore` 丢弃证据;文件两者都不是）,`waitForReady` 把「任何一个 racer 停下来了」和「等 20ms」一起 race,失败消息带上**子进程自己的话**。

**确定性钉住,不靠运气。** 真正的 flake 需要机器忙;所以 fixture 新增 `--crash`（任意模式,先写 stderr 再 `exit 3`）,让父进程的失败路径**可以被测试**:

| | 修前 | 修后 |
| --- | --- | --- |
| `resident-race` 的 `.ready` 等待 | **30036ms** 后「timed out waiting for …」 | **147ms** 后「racer exited 3 — its log: deliberate startup failure…」 |
| `two-process` 的等文件 | **30037ms** | **150ms** |
| `two-process` 丢掉日志捕获后 | — | 160ms 就失败在「子进程原话」这条断言上 |

三次移除式证伪各自只让对应的新钉子失败,全部按 sha256 还原。这也顺手回答了上轮那个悬案的另一半:**这一轮没有再复现**,所以不敢说并发缺陷已找到——只能说,它下次出现时会**带着原因出现**,而不是再变成一个 30 秒的谜。

### 2.22 刚学到的东西,恰恰最先搜不到

`remember` 对同一条事实是**原地刷新** `createdAt`——这是写明的契约(「re-learning the same fact refreshes it」)。而 `recall` 打分的候选是 `store.entries.slice(-CANDIDATE_LIMIT)`,即**文件顺序**的后 200 条。两者读的「最近」不是同一个东西:`entriesFor` 的文档说仓库是 `newest first`(按 `createdAt`),淘汰排序也按 `createdAt`,**只有 recall 一个人按位置**。

后果:一条被重复reinforce 的记忆留在它最初写入的位置,于是它可以是**整个场景里最新的一条**(`entriesFor()[0]` 就是它),同时**落在候选窗口之外、永久搜不到**。而 `den_scenarios` 照样报着 `entries: 250`。

量出来的(`_tmp_dsh_probe/memory-window-probe.mjs`,250 条,针在最前):

| | 修前 | 修后 |
| --- | --- | --- |
| 针是场景里最新的一条(`entriesFor()[0].id == 针`) | 是 | 是 |
| 针的文件位置 | 0 / 250 | 0 / 250 |
| `recall` 找得到它 | **否** | **是** |
| `recall` 报的 `considered` | **0** | **200** |
| 对照:窗口内的条目找得到 | 是 | 是 |

在 7×24 的场景下这个方向是反的:被说得越多遍的记忆,越可能先消失。

**修法有两半,第二半才是关键。** 候选按 `createdAt` 取最新 200——那条看似已够。但窗口本身**会静默丢掉内容**,所以返回里必须让它可见:`considered` 由「打分过的条数」改成它名字说的「看过的条数」,并新增 `scored`(匹配数)与 `stored`(场景总数),`den_recall` 原样带出。**窗口没有取消**:500 条全打分是一个成本上界,而窗口外的条目正是淘汰的下一个候选;取消它会让「按 createdAt 取最新」和「全都看」变成同一件事,这条测试就再也分不清对错了。

所以测试是**双向钉的**:同一场景里,最新的那条必须能找到,**最老的那条必须找不到**——后者用一个「独占 token 且完美匹配查询」的条目,它的缺席只能由窗口解释。实测:把窗口退回文件顺序 → 最新那条找不到(单向);**把窗口取消 → 最老那条反而被找到**,同一测试从另一侧失败。两个方向都不是「一律通过」。

**顺手清掉一个只写不读的字段。** 每条记忆都带 `recalls: 0`,`remember` 的两条分支都写它,而全仓库**没有任何地方读过**(`src/`、`src/client/`、`test/`、`tools/` 都查过)。它叫「被回忆过几次」却永远是 0——又一个「以一个从未发生的事件命名的字段」。真正的实现要么让 `recall` 变成写操作(代价、非幂等、和「确定性只读检索」的承诺冲突),要么删掉它。删掉。

### 2.23 证伪器自己会假绿

三条移除式证伪第一遍**全部报通过**——而其中一条(把候选退回文件顺序)在同一份源码上单独跑时**确实失败**。原因不在被测代码,在**我自己的命令行**:`--test-name-pattern=$c.p` 没有加引号,PowerShell 把带空格的模式拆成了多个参数,真正的模式只剩第一个词。测试确实跑了、也确实是那一条,可它报的是「通过」——**一个因为命令写坏而变绿的证伪器,比没有证伪器更糟**:它制造出的正是它本该排除的信心。

规矩是:证伪器必须在**变异落盘之后**再跑,并断言**恰好跑了 1 条测试、且就是那一条**。重做后三条各自 `tests 1 / fail 1`,失败者与变异一一对应,源码按 sha256 还原。

### 2.24 面板把授予控件挂在了一个壳明确不绑定会话的座位上

用户的截图暴露了它:面板上「Standing autonomy」写着 **unknown for this view**,底下 **no active conversation — autonomy is per conversation**,而**当时有活跃会话**。「新建自检」也是灰的。也就是说**能力 1 的人类因子在已发布的 UI 里根本走不通**:面板是唯一能 mint 令牌的地方,而它拿不到会话 id。

**三个独立来源指向同一个结论,而且它们都不是猜的。**

1. **活页面的槽目录**(client `Slots`,`root: main`)原话:*"The reserved `conversation` key hosts the Conversation; **other keys receive no Session binding.**"* 而它的 `standardProps` 是 `useResource`/`useWorkspaces`/`usePanelInfo`/`useSessions`/`useSessionStatus`/`useSessionRetainInfo`——**没有 `sessionId`**,`ownerProps` 是 `[]`。我的面板注册在非保留键 `dsh-den.status` 上,所以壳**按设计**不给它会话。
2. **活页面的 `sessions` 服务契约**:方法只有 `retain`/`using`/`retainInfo`/`refreshProjections`/`search`/`fork`/`scope`/`binding`——**没有 `current()`,也没有 `activeId()`**。我代码里的两条回退读的是两个不存在的方法。
3. **整个 21 个项目的插件生态**(含参考实现 `dsh-bot`):**没有任何插件用 `activeId`/`currentId` 找活跃会话**;唯三的出现全在**我自己的代码和我自己写的测试替身**里(`check-client-interaction.mjs` 喂 `{activeId:'session-active'}`)。`dsh-bot` 的槽组件签名是 `({sessionId, useSession, useConversation, useSessions, renderFactorySlot})`——**`sessionId` 是 prop**,而 `useSessions` 是**带 selector 的 hook**(`useSessions(s => s.byId[sessionId]?.blank)`),我却把它当零参调用。

**更糟的是有一个测试把缺陷钉住了。** `test/client-services.test.mjs` 里那条 `'the bundle declares sessions, which it reads for the active conversation'` **要求** bundle 匹配 `/ctx\.sessions/`、**要求** `sessions` 被声明。它不是同谋,它是**给死路发了一张长期许可证**:代码删不掉,因为删了测试就红。那条测试现在改成反向断言(不得探测不存在的方法、不得声明不读的服务、必须注册到会话作用域的座位上)。

**修法:控件搬到真的会给会话的座位上。** 活页面目录量到 `conversation.input.dock`:`scope: session`、`replaceRisk: none`、`standardProps` 明确含 **`sessionId: SessionId`**、`ownerProps` 是 `InputZone { session, input }`,而且是**全宽、就在输入框上方**——令牌生成后正好在它下面粘贴,而授权本来就必须由人类消息携带令牌才成立,所以控件结束的地方正是证据开始的地方。

**顺手修掉第二个同样死掉的控件。** 截图里灰掉的「新建自检」不是样式问题:`schedules/create` 要求会话,而 `main` 里 `sessionId` 恒为 null,按钮恒 disabled——一个永远点不动的控件。自检块被抽成一个函数,状态页只显示列表并指出表单在哪,输入框上方的座位显示表单。

**座位 id 也必须自己起**:目录写明 *"a fresh id is added beside the shipped entries, while reusing a shipped id puts you in THAT cell and replaces it"*,而那个座位上已经有 `todo`/`goal`/`queue` 三个壳自己的条目。所以用 `dsh-den-grant`,并把「不得复用壳的 id」也写成断言。

新增断言里有一条是**为自己写的**:「状态页不得渲染授予按钮」不能靠找字符串——页面文案里本来就有「授予」两个字,所以它检查的是**按钮**。第一版就是找字符串,于是报了一个假红。

### 2.25 宿主跑的是旧代码，而我的 live 结论全建在这个缝上

**测量**：`npm run check:deployment` 退出 1 —— 宿主的 `startedAt` 是 `2026-10-13T08:43:05.676Z`，而 `client/client.js` 改于 `09:24:00`。也就是说**已经装好并正在服务的那份插件，是改动之前的代码**，而我在那之后报过「live 验证通过」。

**守卫早就存在**（`check-deployment.mjs` 第 162-203 行，注释甚至写明了「editing a handler does not rename a tool, so a host running last week's grant path still lists this week's tool names and passes」）。问题在**它不在 `npm run verify` 里**，只在 `verify:live` 里；而我这轮跑的是 `verify`。于是「离线全绿」和「线上是旧代码」可以同时成立，没人会因此看见任何异常。这不是缺一个检查，是**检查在不走的那条路上**。

**修法一：让宿主自己报出自己有多旧。** `status.freshness` 在**请求时**计算，不在构造时——因为要问的恰恰是「加载之后这个文件又被改过没有」，构造时缓存下来的值回答的是错误的那一刻。它会说自己**判断不了**：`known: false` 与 `stale: false` 是两个不同的答案，「没有证据表明它旧」和「有证据表明它新」不是一回事，只有后者能拿来当通过。

**修法二：让它出现在人已经在看的地方。** 面板加一行「运行中的代码」，旧了就写「比代码树旧 —— 需要重启 DSH」并点名是哪个文件；判断不了就写「这个实例判断不了」，**绝不渲染成正常**。能重启 DSH 的只有人，而这块面板正是人已经在看的地方；一块看起来很健康的面板，恰恰是旧宿主最好的掩护。

**修法三：两条独立路径必须得出同一结论。** `check-deployment` 保留自己走一遍仓库（脚本视角），另外再读宿主的自报（宿主视角：它走的是**自己实际加载的那些文件**），两者比对；且**只在差距超过容差时比对**——容差之内谁都不算证据。不同代码路径对同一事实的一致才是证据，同一条路径算两遍只是自言自语。

**顺带第四次踩到 allow-list 那个坑。** `panel-api.js` 的注释里早就写着：「`statusSnapshot` 逐字段构建是有意的……加一个字段是两文件的改动，而只有一个会大声失败」。我这次**又**只改了 `status()`，于是负载里根本没有 `freshness`。所以加了 `test/panel-payload-coverage.test.mjs`：用**真的** `DenService.status()` 的键集与负载做结构性比对，没带过去的字段必须**逐个写明理由**（`WITHHELD` 里每条都要有超过 20 字的理由，空字符串不算），并且**带一个控制组**证明这个检查能红。它第一次运行就抓出 8 个字段：`stateFile`、`quietHours`、`dailyTurnBudget`、`cooldownSeconds`、`tickSeconds`、`grants`、`sessionEvents`、`statusRoute`——其中 `statusRoute` 不是被丢掉而是被改写成了 `route`/`transport.claimedMounted`。八条理由现在写在测试里，是一个可以复核的决定，而不是一片沉默。

**这一轮的诚实边界**：在有重启之前，我**不能**再声称任何 live 结论。`check:deployment` 现在正以「宿主比代码树旧」和「宿主没有自报新鲜度」两条为由失败，共 2 条未验证断言——这不是回归，这正是它该有的样子。

### 2.26 守卫早就找得到,只是不在「单跑一个探针」的那条路上

**事实**：`check-deployment.mjs` 从很早就在正确地判断「运行中的实例加载的是不是这棵树」。2026-10-13 它报了：宿主 `08:43:05` 加载，而 `client/client.js` 改于 `09:24:00`。同一时段，**6 个 `check:*` 探针各自退出 0**，而我把它们当成 live 证据报了出去。它们描述的是**运行中的那个实例**——也就是改动之前的代码。

**所以缺的从来不是测量，是测量不在单跑一个探针的路径上。** `verify:live` 在第 1 步就会停（注释写得明明白白：「宿主不服务这棵树，下面什么都别信」），但 `npm run check:notices` 这种单跑没有闸门。上一轮加的 `status.freshness` 也一样：它只在有人去读的时候才有用。

**修法：把守卫做成独立进程，用 `&&` 串在每个 live 脚本前面。**

```json
"check:memory": "node tools/require-fresh-host.mjs && node tools/check-live-memory.mjs"
```

放在**外面**而不是写进探针内部，是因为写进内部要靠人记得加，放在前面是**被继承的**——任何调用探针的方式（npm script、`npm run verify:live`、人手敲 node）都会先过它。

**三种结局，只有一种是放行**：加载了这棵树 → 放行；加载了旧代码 → 拒绝并点名那个文件；**说不清、或者根本没人在听 → 同样拒绝**。「无法判断」不是通过——探针描述的是一个运行中的宿主，而没有一个可描述的宿主时，什么都不该被声称。

**闸门一律拒绝就不是检查，而是会被关掉的闸门**，所以这条必须带控制组：测试里起一个**合成宿主**（真的 socket、真的子进程），断言新鲜负载**真的能放行**、旧负载被拒、没人应答也被拒。第一版这个测试自己踩了坑：用 `spawnSync` 起子进程会阻塞事件循环，于是那个「假宿主」永远接不到连接，子进程一直等到自己的超时（20 秒）——测试红了三次才看出是我把宿主饿死了。

**还有一条结构性测试**：`package.json` 里任何跑 `tools/check-live-*.mjs`（以及 `check-tools-live`、`check-wake-api`）的脚本，都必须串在守卫后面，否则测试红。`check:deployment` 明确豁免——**它就是那个测量本身**，它必须还能报告一个旧宿主，而不是拒绝谈论它。加新的 live 脚本的人不会漏，因为漏了会红。

### 2.27 公开仓库的 Status 是一句没有日期的 live 声明

README 开头写着「Verified against the *running* system」,但**没有说那是哪个 instance**。读者只能理解成「现在也是」。而这一整个 session 的教训恰恰是:live 声明是关于**某一个进程**的,改文件不会改变一个正在跑的进程。

**改法不是删掉那句话**(它是真的,而且是最值得展示的部分),而是**给它出处和边界**:写清它是针对 `startedAt: 2026-10-13T08:43:05.676Z` 那个实例测的;写清面板修复落地后那个实例仍在服务旧面板;写清现在有两样东西让这种状态无法被报成通过(宿主自报 `status.freshness` + 每个 live 探针前的 `require-fresh-host.mjs`);写清重新确立这些声明的那条命令是 `npm run verify:live`。

并且补了一段**明确欠着的 live 声明**:搬进 `conversation.input.dock` 的授予控件目前只有 `check:ui` 的离线断言,**没有在运行中的页面上被看到过**。写出来而不是含糊过去,是因为「有检查断言」和「亲眼见过它工作」是两个不同的主张——把前者当后者报出去,正是这份文件一直在记录的那种缺陷。

**顺带把「公开数字」变成可机检的。** 新增 `test/doc-claims.test.mjs`:README 说「11 model-facing tools」「six named actions」「no dependencies at all」,这三条都对着代码量一遍(工具数用 `registerTools` 的最小桩数,动作数用导出的 `PANEL_ACTIONS`,依赖用 `package.json` 的三个字段)。**测试总数故意不在里面**——测试没法数包含自己的测试,那条数字永远是「一次真实运行的 transcript」,只能重跑,不能手改。

**写这个测试时又踩了一个自己造的坑。** 第一版正则写成 `([a-z]+|\d+)\s+(?:[a-z-]+\s+){0,2}named actions`,在「and the six named actions」上它**匹配成功了**,但捕获组是 `and`;而我的代码对非数字捕获直接跳过——于是这次匹配**把整个短语吞掉了**,引擎再也不会从 `six` 重新开始。测试于是报告「README 里没有这条声明」,而那句话明明就在那里。修法是:捕获不是数字时把 `lastIndex` 退回 `match.index + 1` 重试。一个匹配成功后吞掉了自己没能捕获的东西——这类缺陷的读数和「东西不在那里」完全一样。

### 2.28 演练的最后一跳卡在一个「不是开关的开关」上：审批策略是权限预设的副作用

**2026-10-13 宿主重启后的实测**（这是本项目第一次让 live 那一半整体通过）：

- 宿主 `startedAt 2026-10-13T09:50:07.589Z`（pid 42628），自报 `freshness: {known: true, stale: false}` ——「运行中的就是这棵树」；
- `npm run verify:live` **exit 0**：`PASS - the running host is serving this tree, and it loaded it after the last edit`，以及 `PASS - a browser request has reached it before this script started`；
- 七个 live 探针全部通过：`check:deployment`、`check:autonomy`（`RESULT: PASS — an agent cannot obtain standing autonomy from the live host`）、`check:notices`、`check:memory`（场景隔离成立，且**运行中的宿主读的是同一个存储**）、`check:tools`（`VERDICT: PROVEN`，disk 证据表明 `den_*` 工具真被调用过）、`check:wake-api`（8 项）、`check:grant-bypass`。

**面板修复已经在用户页面上跑起来了 —— 而且不是靠看像素。** 重启后 141 秒，一条 `panel-autonomy-requested` 事件带着**真实会话 id**（`session-95cc8a8d-…`，正是本会话）到达路由。上一版面板没有会话可传（它解析活动会话失败，只能传 null），而宿主此刻加载的确实是新代码，所以那条请求只可能来自 dock。区分「我探针发的」和「页面发的」靠的是 sessionId 的字面值：我的探针用 `live-autonomy-probe` / `grant-bypass-probe`。**两条独立事实（宿主加载了这棵树 + 一条只有 dock 能发出的请求）合起来，比看一眼截图更硬。**

**卡点**：`den_set_autonomy` 被宿主自动拒绝 —— `Error: the user rejected tool "den_set_autonomy"`。本会话的审批策略是 `never`。

**根因不是用户忘了开，而是 DSH 把它绑在权限预设里。** 宿主里写着 `APPROVAL_POLICIES = ["ask", "never"]`，而它由 `@deepseek-ai/dsh-permission-presets` 的**一个 Permissions 选择器**同时决定 sandbox 与 approval：

| preset | sandbox | approval |
|---|---|---|
| `read-only` | read-only | `ask` |
| `workspace-write` | workspace-write | `ask` |
| `danger-full-access` | danger-full-access | **`never`** |
| `Auto`（由 `dsh-experimental-auto-review` 注册） | — | — |

用户 profile 的 patch 里写着 `defaultPreset: danger-full-access` —— 于是**每个新会话都默认落在 `approval: never` 上**，所以「重启一次」在结构上永远不可能让审批出现。而且**没有任何预设是 `danger-full-access` + `ask`**，文档又把 `custom` 明确排除在选择目标之外（*"never a switch target or event payload"*）。要让一次需要审批的动作通过，只能把会话切到 `read-only` 或 `workspace-write`。

**这条同时解释了那句「ask 被渲染成 user rejected」**：`Error: the user rejected tool …` 里没有人拒绝过任何东西，它是 `never` 策略的确定后果。一个「拒绝」字样出现在没有任何人做出选择的地方 —— 这正是本仓库反复在记的那类缺陷，只不过这次它在宿主里，不在我们这半边。

**顺带记一条我不做的事**：插件的客户端代码跑在用户页面里，技术上够得着权限预设的写路径。**我不碰它。** 理由与「插件不能给自己授权」是同一条：改自己的权限不是本插件该做的事，哪怕改的方向是「变得更严格」。

**演练的确切步骤（四次点击）**：

1. 界面上把 **Permissions** 选择器从 `danger-full-access` 切到 `workspace-write`（它带 `approval: ask`）；
2. 在消息框上方那一条面板上点「授予」，得到一串令牌（10 分钟有效、一次性）；
3. 复制那串令牌，**在消息里带上它**发给我；
4. 我调 `den_set_autonomy` 时，弹窗里点「允许」。

之后 kernel 的下一次 tick 会引入一次被准入的唤醒，ledger 的 `turns`/`spoken` 从 0 变成 1 —— **那才是能力 1 的正向半边**，也是整个目标里唯一还没有被观测过的事件。

### 2.29 有意为之的 fail-closed，在 profile 的默认预设下把插件自己的三样能力一起关掉了

**实测（2026-10-13，宿主 `09:50:07.589Z` 那个实例）**：

```
gate-audit.json:
  { tool: 'den_remember',     rule: 'unknown-tool', risk: 1, decision: 'ask' }
  { tool: 'den_set_autonomy', rule: 'unknown-tool', risk: 1, decision: 'ask' }

调用结果：
  den_remember    -> Error: the user rejected tool "den_remember"
  den_set_autonomy -> Error: the user rejected tool "den_set_autonomy"
```

**这不是新缺陷，而是有意为之的设计。** `src/gate.js` 里写得很清楚：

> Only tools that cannot change anything outside the conversation belong here. Everything with a durable or outbound effect stays on the default `ask`: `den_remember`/`den_forget`/`den_schedule_check`/`den_schedule_delete`/`den_configure` write state, and `den_set_autonomy` is a privilege change.

理由在通常情况下是对的：有持久效果的动作，值得让人看一眼。

**但审视的前提是「有人能看」。** 这个 profile 的 `defaultPreset` 是 `danger-full-access`，而 DSH 的预设把 `approval` 绑成 `never`（见 §2.28）。在 `never` 下，`ask` 的确定后果**不是**「稍后有人决定」，而是「永不发生」——并被渲染成 `user rejected`。于是：

| 能力 | 依赖的 den 工具 | 在默认配置下 |
|---|---|---|
| 5 按场景隔离的长期记忆 | `den_remember` / `den_forget` | **不可达**（连记住一件事都做不到） |
| 3 带保质期的通知 + 自检 | `den_schedule_check` / `den_schedule_delete` | **不可达** |
| 1 人类授权绑定的持久自治 | `den_set_autonomy` | **不可达**（演练的最后一跳就卡在这） |

一个只有只读那一半能用的常驻助理，不是「更安全的版本」，是**坏的版本**。而同一份 `gate.js` 里已经把这条原则写下来过，并且**两次**照着它改过：文件三件套（`read`/`write`/`edit`）和 den 的只读面，都是因为

> being unusable is its own security failure: it is exactly the pressure that makes a human switch the gate off wholesale instead of reviewing it.

——原文还写着那句自我诊断：*the gate was treating its own tools as unknown foreign capabilities*。**`den_remember` 是同一个错误的下一批：它仍然是「自己的工具被当成不认识的工具」。**

**顺带记一条措辞强于测量的地方。** `check:tools` 打印 `VERDICT: PROVEN for den_explain_gate, den_remember, den_schedule_check, den_set_autonomy, den_status`，判据是「返回了结果且不是 unknown-tool 错误，这只可能是工具已被注册」。这句话本身为真，但**一次「用户拒绝」也满足它**——读者会把 PROVEN 读成「这些工具能用」。工具该报的是它测到的东西（被注册、被调用过），而不是它测不到的东西（调用成功）。

**两条出路（尚未决定，需要人拍板，因为它改变的是「什么时候会弹审批」）**：

- **A：把 den 自己的持久工具由 den 自己放行**，逐条写明理由；**出站闸门一个字不动**。安全性来自每个工具自带的人类绑定：`den_set_autonomy` 要求面板令牌 + 人类消息里出现该令牌（对着不可变的会话日志校验）；`den_schedule_check` 只存触发器，而触发器在没有人授予自治前**无法行动**；`den_remember`/`den_forget` 只碰场景隔离的本地库，且面板可读。shell / 网络 / 密钥那条 fail-closed **保持原样**，那才是能力 4 的射程。
- **B：保持 fail-closed**，改为要求这个部署必须存在审批路径（把会话或 `defaultPreset` 换成带 `approval: ask` 的预设）。代价：之后每一次写入/出站都会弹审批——同一个文件把它称作 *approval fatigue*，并且明确说那是安全失败。

**建议 A**，因为 A 把闸门收回它自己声明的射程（出站与凭据），而 B 让一个「值得看一眼」的设计在没人能看的配置下变成静默失效。

### 2.30 采纳 A：den 自己的工具由 den 自己放行，出站与凭据那条线一个字不动

**决定**：2026-10-13，用户选 A（另一条 B 是把部署改成始终存在审批路径，代价是每次写入/出站都弹审批——`gate.js` 自己把那种状态称作 *approval fatigue* 并视为安全失败）。

**改动**：新增 `OWNED_TOOLS`（11 条，每条写明**是什么把它约束住**，而不是「它是我们的所以放行」），`classifyCall` 在 `TOOL_RISK` 之前查它，审计行从 `unknown-tool` 变成 `owned:<name>`。原来那 5 个只读 den 工具从 `TOOL_RISK` 移进它，避免同一件事有两个真源。

**没有动的东西**（这是这次改动的边界，测试里有控制组）：

- 密钥路径规则**仍然最先跑**，而且**与工具名无关**——owned 工具不是绕过它的路；
- shell 的 outbound 规则、网络载荷规则、`web_fetch` 的 ask，全部原样；
- 未登记的工具**仍然 fail-closed 到 `ask`**，`unknown-tool` 这条路径还在。

**实测证明了这条边界**：改这一轮的时候，我自己的两次调用被 den 的闸门当场拒绝——一次 `pwsh`（命令文本里带了那个出站短语）命中 `outbound`，一次 `write`（内容里含私钥文件名）命中 `secret:`。**出站与密钥两条线没有因为这次放行而变松**，而且这是活的证据，不是读代码读出来的。

**三条把缺陷钉死的断言，处理方式各不相同**（这是本轮最该记的部分）：

1. `gate.test.mjs` 的「state-changing and privilege-changing den tools still ask」——**改写成它的反面**，并在注释里留下它原来想守什么。它当时为真，而它同时**就是**那个缺陷：在 `approval: never` 下 `ask` 不是「稍后有人决定」，是「永不发生」，还渲染成没有任何人做过的拒绝。**一个要求缺陷存在的绿灯，等于给了那条死路继续存在的许可。**
2. `gate-coverage.test.mjs` 的 `DELIBERATELY_ASK` 成员——移出，并写明为什么当初放进去的理由（「持久写入值得让人看一眼」）只在**有人可看**的配置下成立。
3. `gate-coverage.test.mjs` 的「changing the den's own authority is never a plain allow」——**这条最微妙**：它想守的性质（助手不能给自己授权）是真的，但它断言在**闸门分类**上，而那个性质实际由工具内部的 `setGrant` 保证（面板令牌 + 人类消息里必须出现该令牌，对着不可变会话日志校验）。现在有一条测试把这个**链接**钉住：owned 条目必须仍然写出人类动作（reason 里必须出现 `human message` 与 `token`），并明确指向真正断言该性质的地方（`mount.test.mjs`）。

**新增的完整性测试**：把 `OWNED_TOOLS` 的键与 `registerTools` 实际注册的工具名**逐一对齐**（双向）。新加一个 den 工具却没写边界，会在测试里红，而不是在生产里悄悄掉进 fail-closed——**这正是本轮缺陷的成因**（`den_remember` 就是「自己的工具被当成不认识的工具」的下一批）。

**代价，说清楚**：改的是 `src/`，所以运行中的宿主**又变成「比代码树旧」**了——`require-fresh-host.mjs` 现在会拒绝跑 live 探针，**这是它该有的行为**，不是回归。`npm test` 309/309、`npm run verify` exit 0；live 那半边要**再重启一次**才会在这个 commit 上重新成立。

### 2.31 同一条令牌条有两个渲染分支；以及给演练的仪表先做校验

**（一）复制钮：两份渲染已经漂移，代价落在关键路径上。**

面板里那条「铸出来的令牌」在**同一组件的两个分支**里各渲染一次：输入框上方的 dock，和整页视图。改这一轮时才发现整页那一份已经有复制钮，而 **dock —— 人真正用的那一条 —— 只有 `userSelect: all`**。

这不是美观问题。令牌长、一次性、会折行；手抄少一个字符的后果是下游回一句

```
the message does not quote the token
```

——**这句话不指名任何字符**，人类拿不到可修正的信息，代价是又一个来回。修法是抽**一个函数**（不是组件，避免碰 React 语义）`copyControl(t, token, note, setNote)`，两个分支共用；剪贴板**缺失、拒绝、或同步抛错**都报失败，而不是报一次人类无法信任的「已复制」。两个方向都在交互检查里验，沙箱**默认没有 `navigator`**（这是真实浏览器状态，不是测试便利），需要成功路径的那条检查临时装上 `writeText`。顺手补上 zh 缺失的 `autonomyCopied`：中文面板此前显示的是英文兜底串。

**（二）演练的仪表，先离线验过再拿它当证据。**

演练读的是 ledger 的 `turns`/`spoken`。它的语义比看上去细：`turns` 在**投递成功后**记（即使随后判定 silent 也记），`spoken` 只在真的开口时记。所以「有东西动了」不是判据——**判据是两个计数器都离开 0**，一次 silent 的唤醒会把前者推上去而后者不动。

而 `cold-start.test.mjs` 里那条「跨重启后被准入的唤醒」的测试此前只断言了 `outcome: 'spoke'` 与投递，**没有读过 ledger**。现在补上：`turns === 1`、`spoken === 1`。理由很直白：**一件从未被读过的仪表，不是证据**；等 live 演练跑起来再第一次读它，读到的任何数字都无从判断是不是正常。

**（三）为什么没有把套件自身的计数做成机器可检。**

`doc-claims.test.mjs` 顶部有一条明确记录的决定：套件的计数**故意不**纳入机器检查，理由是「一个测试无法在不把自己算进去的情况下数自己」，所以那个数字保持为一次真实运行的转写，重跑而不是编辑。

我实测过这条理由的强度：**23 个测试文件里顶格 `test(` 恰好 309 个，与运行时的 `tests 309` 完全吻合**——静态计数是自含的，所以上述理由在静态计数下**并不成立**，守卫在技术上可行。

但我仍然不加。静态计数是一个**代理**：一旦有人把 `test()` 写进回调（本仓库 23 个文件里已有 300+ 处缩进 `test(`），代理就会**数少**，而守卫会据此逼出一个**比真实更小**的 README 数字。**一个能逼出谎话的守卫，比一条会烂的声明更糟。** 这里按 README 自己写下的纪律办：**重跑证明，而不是改数字**（那个数字取自一次真实 clone 运行，见 README「A transcript is not bookkeeping」一段）。

### 2.32 停靠条里放了一整个表单：那是设计错误，不是排版问题

**用户 2026-10-13 的实测反馈**（截图）：输入框上方那条停靠条占掉了大半屏 —— 「Standing autonomy · 本 conversation / Grant / Revoke / 令牌 / 复制 / 提示」之外，还常驻着 **Title、What to check、Every (minutes)、Add self-check** 四个控件。

**成因不是随手加的，是一个说得通的理由推出来的**：停靠条是壳唯一交给面板**真实会话 id** 的座位，而 `schedules/create` 没有会话 id 会直接拒绝（`a schedule must belong to a conversation`）。所以「创建自检的表单」**只可能**放在那里 —— `schedulesBlock(withForm)` 在停靠条上传 `true`（带表单），在整页上传 `false`（只有列表）。

**错在哪：把「能力需要会话」读成了「能力必须在屏幕上」**。两者不是一回事。停靠条在对话流里，人到这里是来说话的，不是来填表的；一个常驻表单是最贵的形态 —— 它每时每刻都在收「屏幕高度」这笔税，而它一天用不到一次。

**改法（默认只显示状态，表单变成按需展开）**：

- 停靠条默认一行：自治状态 + `授予` / `撤销` + 一个 `新建` 折叠钮；没有输入框、没有提交钮；
- 表单只在按下 `新建` 后出现（`schedOpen` 状态放在组件顶部而不是 `schedulesBlock` 内部，因为那个函数被两个座位调用，只有停靠条能创建 —— 钩子必须无条件）；
- 空状态文案直接给出**更省事的那条路**：「在对话里说『每 30 分钟看一眼 CI』，助理就会加上」。这既是文案，也是产品判断：**跟助理说一句，比填三个框便宜**；
- 整页那一份（本来就没有表单）把「请到输入框上方的新建」改成「创建自检需要会话 —— 在消息框里说一句就行」。

**这次的「变小了」是机器可检的，不是自我声明**：`tools/check-client-interaction.mjs` 现在要求停靠条在按下折叠钮之前渲染 **0 个输入框、没有提交钮**（改之前是 3 个输入框 + 1 个提交钮），按下之后表单仍然发出同样的 `schedules/create` 载荷（`everySeconds: 2700`、`sessionId` 照旧）。交互检查 58 → 61 项。

**关于「参考 Dot 的页面状态与逻辑」**：这一轮**没能读到** Dot 的页面 —— 本插件自己的闸门把 `web_fetch` 判成 `ask`（`tool:web_fetch`），而在 `approval: never` 的 profile 下 `ask` 等于永不发生，所以那几篇设计稿在这个会话里读不到（`web_search` 是 `allow`，但它返回的是链接列表，不含正文）。因此下面这条是**我的判断而不是引用**，请以用户看到的实际产品为准：Dot 那一类常驻助理的界面逻辑是「**一眼看到状态，一次只处理一件事，人用说话而不是填表**」——状态是给眼睛的，动作发生在对话里；仪表盘式的控制面板是它的反面。本轮按这条判断改了停靠条；如果 Dot 的具体状态机还有别的约定（比如它如何呈现「已经说过什么、还没说什么」），需要用户给出实际截图或文字，我再对齐。

### 2.33 最后一个验收：把「只在人看着时才跑」的那一半也测掉

「被准入的唤醒」需要一个人为动作（把面板令牌当消息发出来），所以它**不可能**缩成一条命令；但「不可能一条命令」不等于「只能是一段叙述」。做法是两帧：`--before` 在重启后、授权前把运行中宿主自己的数字落盘（autonomy / kernel.running / residency.held / triggers.total / ledger 的 turns·spoken·skipped·refused），`--after` 重新读取并比对。

两个判据值得单独说：

- **两个计数器都必须动。** `turns` 在投递之后记，`spoken` 只在真的开口时记。所以「有东西动了」不是判据 —— 一次被判定「不值得说」的唤醒会推动前者而不动后者，它除了最关键的那一格以外处处都像成功。这条失败是**演练本身的失败**（这次演练没有内容可报），不是实现 bug，判词把两者分开说。
- **必须有到期的东西。** 授权本身不唤醒任何东西：自治是许可，不是排程。照检查单办事的人最容易漏这一步，所以没有自检时判词点名「缺触发器」，而不是含糊地说「没有唤醒」—— 那句话虽然为真，但毫无用处。这也是能力 1 的直接推论，写进了演练的操作说明里。

**判词是纯函数**（`judgeWake(before, now)`），7 条离线用例先测它：真实唤醒通过并写明「帧之间重启过」；「花了轮次但没开口」判失败；授权缺失 / 未知 / 为假都不通过；无自检点名缺触发器；standby 与心跳停止各自点名；计数器不动或倒退一律不通过。一个只在 live 运行时才被读到的判词，就是没人验过的判词。

**管道也测**（`test/drill-live-wake-host.test.mjs`：合成宿主 + 真实子进程 + 真实 socket）：帧真的写在 `DSH_HOME` 下、路由信封真的被解析、退出码真的是 0/1/2，以及**演练自己也拒绝旧实例** —— 不能只靠 `package.json` 里串在前面的守卫，因为手敲 `node tools/drill-live-wake.mjs --after` 时守卫不在路径上。

**第一版是「import 即执行」的**：判词被测试 import，而模块顶层直接开了 socket，于是测试结果取决于「恰好有没有宿主在监听」—— 那正是「量到什么都算过」的同一种缺陷，测试立刻变红。现在入口判定 + `main()`。

结构测试的 `LIVE` 正则加上了 `drill-live-wake`：两个 npm 脚本都串在 `require-fresh-host.mjs` 之后，否则它会拿旧实例的 ledger 给整个项目下最后一个结论。

### 2.34 判词第一次真跑就暴露了自己：帧没带会话，于是只能失败

第一次在真宿主上跑 `drill:before`，帧里写着 `autonomy: null / autonomyKnown: false` —— 而我**刚刚**用面板令牌授权成功。原因不在宿主，在仪器：授权是**按会话**记录的，而 `status` 不带 `sessionId` 时会回答「不知道这个会话有没有授权」（`src/panel-api.js` 的 `statusSnapshot(service, { sessionId: liveSessionId })`）。用户在截图里看到的那句「state unknown」就是这个机制。

后果比难看严重：`judgeWake` 里有一条 `autonomy !== true → 失败`。也就是说这个判词**永远只能失败** —— 一个只会拒绝的闸门，正是我在 `live-host-usability` 的注释里写过的那种「不是检查，是会被关掉的闸门」，只不过这次长在我自己刚写完的验收仪器上。它躲过了 7 条离线用例，因为那些用例直接构造帧；只有真跑一次才会露出来。这就是「离线测判词、合成宿主测管道」都替代不了「对着真宿主跑一次」的理由。

改法：

- `--session <id>` 可显式指定；没给就取宿主最近报出的事件里**最新一个带会话 id 的**，并在帧里记下来源（`sessionFrom: argument | newest-event | none`）；
- 帧多两个字段（`sessionId` / `sessionFrom`），`--after` 的比对表也打印会话；
- 判词新增一条**指认仪器**的失败：帧里没有会话时报「pass --session <id>」，且**不再**说「授权从未落地」—— 把「你没说哪个会话」和「授权真的没落地」分开，否则判词会冤枉一台正常的宿主；
- 离线用例补一条：无会话的帧必须点名 `--session`，且不得指控宿主（`test/drill-live-wake.test.mjs`）。

顺带修掉另一个「固定清单」缺陷：`--before` 原本无条件打印「去点授予、去复制令牌」，而第一次真跑时这两个动作**已经做过了** —— 它在让人重复一个已经花掉的令牌。现在它按帧里的状态说话：已授权就说「本会话已记录授权，无需动作」，已有自检就说「自检存在，等它到期」，两句话都由合成宿主测试钉住。

### 2.35 被准入的唤醒：真的发生了，以及它还**没有**证明什么

**事件链（全部来自宿主自己，不是我的叙述）**

1. 面板 mint 一个请求（`panel-autonomy-requested`，带真实会话 id）；
2. 人的消息里带着那个令牌（`1e8aaeb8…`），我调 `den_set_autonomy` → `{ok: true, autonomy: true, boundToMessage: "b7b68b9f-…"}`；
3. 建一个 300 秒下限的自检（`interval`，`maxRuns: 2`）→ `triggers.total: 1`；
4. 到期后**第一跳**（`02:34:43`，tick 周期 60 秒）投递并开口：
   `turns 0 → 1`、`spoken 0 → 1`、`notices 1`、`due 1 → 0`；
5. 宿主记下 `{"type":"wake-spoke","triggerId":"76e58cc0c47ef5…"}`；
6. `npm run drill:after` → `RESULT: PASS`（退出 0），且它前面的守卫刚确认「运行实例加载的就是这棵树」。

**为什么这比「跑通了一次」更有信息量**

- **同一个调用以前是被自动拒掉的。** 闸门审计里仍然留着修复前那台实例的历史记录：`den_set_autonomy → unknown-tool → ask`（以及 `den_remember` 同样）；而这次成功的调用**不在那份列表里** —— 它走的是 `owned:den_set_autonomy`。§2.30 写的那个「修好了但从未被观测」的差异，现在两侧都有人证了。
- **两个计数器是分开计的，而且是故意分开的。** `turns` 在**投递之后**记，`spoken` 只在**真的开口**时记。所以 `turns 1 / spoken 0` 是一个可能的、且被演练判为失败的结局（「被准入但判定不值得说」）。这次两个都动了，说明它是**说出口**的唤醒，不是一次静默的投递。
- **它发生在到期后的第一跳**，不是「等了一会儿之后」：`due: 1` 出现在 02:34:26，`wake-spoke` 在 02:34:43。

**它还**没有**证明的两件事（写在这里，免得下一个人把上面的结论外推）**

1. **重启之后**的唤醒。触发器、授权、ledger 都在磁盘上，也确实跨过了把宿主换到 `02:10:43` 的那次重启（`stateSurvivesRestart`、`stateCreatedAt`、跨实例仍在的闸门审计都可查）；`test/cold-start.test.mjs` 也用真令牌把「重启前建触发器、重启后投递」整条链跑过。但「重启 + 唤醒」这个**合起来的事件**没有在活宿主上观测过。
2. **它的否定面**：有到期触发器但**没有授权**时应当沉默。这需要先把授权撤掉再重新授权（两次人为动作、两个令牌），所以只在离线用例里验过。

两件事都需要人为动作，且都只能靠同一个演练去量：`npm run drill:before` / `npm run drill:after`。

### 2.36 套件间歇性变红：原因是内存，不是逻辑；并行度是测量出来的，不是猜的

2026-10-14 上，`npm run verify` 有一次以 `0xC0000409` 崩掉（无任何测试输出），随后 `npm test` 有一次报 `tests 311 / pass 309 / fail 2`（正常的 320 里少了 9 条，说明有一个测试文件根本没跑完），再跑又全绿。抓到一个失败现场：

```
Error: child exited 3221226505 — [low_level_alloc.cc : 554] RAW: Check new_pages != nullptr failed: VirtualAlloc failed
Error: spawn UNKNOWN   at spawnChild (test/two-process.test.mjs:82)
```

`3221226505` 就是 `0xC0000409`，与那次崩溃同一个码；`VirtualAlloc failed` / `new_pages != nullptr failed` 说明**地址空间/内存申请失败**；`spawn UNKNOWN`（errno −4094）说明连子进程都没能起来。受害的正是最吃内存的那个用例：它要起**两个真实进程**、让它们争同一份 residency。当时机器上同时有：Electron 宿主（DSH 桌面端）、4 个并行测试文件、各自 spawn 的子进程、以及我自己的后台任务。

**结论**：这不是本仓库的逻辑缺陷，而是「并行度 × 本机内存」的失效模式；但它会让公开仓库在一台内存紧的机器上莫名变红，所以并行度按测量下调：`--test-concurrency=4` → `=2`（整套仍在 30 秒量级）。没有加自动重试：重试会把「这台机器起不了子进程」这件事藏起来，而它正是应该被看见的信息。

**顺带确认了一件好事**：这个失败之所以一眼可诊断，是因为 `two-process.test.mjs` 会把**子进程自己的日志**带进断言消息（`child exited … its log: …`）。如果它只说「spawn 失败」，这次就会变成一次凭运气的排查。给子进程保留日志不是装饰。

### 2.37 唤醒说了话，而没有任何界面把那句话交给人类（用户报的缺陷）

**症状（用户 2026-10-14 的截图与提问）**：整页面板显示 `Pending notices 1 / 1`、`Today's self-initiated turns 1`，而用户说「我并没有看到他推进给我任何东西」。同时停靠条在状态行已写「本会话已授予」的情况下，仍然展示那个**已经用掉**的令牌，并提示「把它作为你的下一条消息发出去」——一次性令牌，这句话已经不可能执行。

**根因（两处，同一件事的两端）**

1. `src/notices.js` 里**没有「已投递」这个概念**：`pendingNotices` 只区分「可投递」与「已过期」。于是被展示过的通知没有任何办法停止 pending，那个计数**永远不可能归零**，同一条记录还会被每一次唤醒反复当成欠账。`src/` 全树 grep 不到 `deliveredAt` / `markDelivered` / `consume` —— 这不是漏了一个调用，是漏了模型里的一半。
2. 唤醒「开口」的实现是 `kernel.js:462 queueNotice(sessionId, 文本, 'notice')`：文字只落进队列，**没有任何人类界面渲染它**。面板只渲染计数；`noticesFor()` 只挂在服务上，本意是让助理自己读了再转述 —— 这依赖助理每次都说，而这次它没有。计数告诉人「发生了事」，没有任何东西告诉人「是什么事」。

**修法（两端对齐，缺一不可）**

- 记录多一个 `deliveredAt`；`pendingNotices` 把已读的排除在可投递与已过期之外；新增 `ackNotice(sessionId, id)`，只认人的显式确认（重复确认幂等，跨会话确认被拒）。**不从「渲染」推断「已读」**：那会把计数反向变成假话，正是要修的病的镜像。
- 状态快照新增 `notices.delivered` 与 `notices.pending`（按时间序的最多 5 条 `{id, text, createdAt}`）。这是人类界面要渲染的字段：计数说明有事，**文本说明是什么事**。
- 面板新增第 7 个动作 `notices/ack`（没有会话就拒绝，不猜一个——猜会去标记别的会话的通知）；停靠条渲染待读通知的**文本** + 「读过了」，并且**只在令牌仍是未兑现的邀请时**才显示令牌与提示（`action.token && !granted`）。

**为什么放在停靠条**：那是输入框正上方、人类本来就在看的那一条。把通知放到需要主动打开的整页里，等于把「我推进给你了」建立在「你先去看」之上——用户刚刚证明这条路会断。

**验证**：`test/primitives.test.mjs` 新增「读过的通知不再 pending，且只有人能停止它」（含幂等、跨会话拒绝、不落入过期桶）；`test/panel-actions.test.mjs` 新增「通过面板读一条通知，才是把它移出待读计数的那一步」（文本抵达面板、计数归零、`delivered` 为 1、坏 id 被拒）。因为多了一个动作，README 的「七个命名动作」与 `doc-claims` 的断言同步（那条测试故意把文档当断言源，改代码不改文档就会红）。`npm test` 322/322，`check:ui` 61 项不变。
### 2.38 面板从头重做：默认一行白话，指标收进「详情」，异常自己展开

**用户的原话**：「我们的区别在于有点太毛胚了 你做一个适配我们的界面ui 让我操作起来简单易懂一点 你这个den的状态有点复杂了」，并指名参照 `dsh-in-hand`。

**先看参照物再动手**。`D:\Projects\dsh-in-hand-ui`（用户的手机端 DSH）里有两个模式，正好是我缺的：

1. **顶部一行提示条**：`● 有 1 件事待桌面…  待你处理 1 · 在跑 2 · 作业 3  详情` —— 一件事，一行字，一个「详情」。
2. **输入框正上方一行滚动指标**：`会话 4 · 在跑 5 · 子代理 2 · 待处理 1 · 轮次 41 · 步数 1,287 · 38.6 tok/s · Token 215.5k · 缓存命中 99% · 上下文 45%` —— `标签 值` 用 `·` 串起来，没有表格、没有框、没有术语。

而 den 当时的整页是**八行表格**：`Standing autonomy / Next self-check / Today's self-initiated turns / Pending notices / Approval gate / Heartbeat / Memory scenarios / running code`，其中 `residency`、`ledger`、`approval gate`、`memory scenarios` 是**这个插件内部的名词**，不是一个正在决定「要不要让它自己做事」的人该读的词。停靠条则把「已授权」和「请把这条已用掉的令牌发给我」同时显示。

**改成了什么**

- **默认只有一行白话**：`常驻中 · 心跳运行中 · 自己醒来 1 · 待读 1 · 本会话已授予  [详情]`。它回答一个人真正会问的三个问题：它开着吗、它自己做过事吗、有没有东西在等我。
- **待读通知显示正文**（§2.37）：`你不在的时候：<正文>  [读过了]`。
- **八行指标进「详情」折叠**：折叠不是删除，按一下就在，审计的人会按。
- **异常自己展开**：`!running || kernelDeferred || residency.held === false || freshness.stale` 时默认展开详情。**折叠不能把故障也折进去** —— 心跳停了、唤醒被推迟、宿主退居待命、进程比代码旧，恰恰是人必须在不知道要去找的情况下看见的状态。只有「一切正常」才收起。
- **令牌只在仍是未兑现的邀请时显示**（§2.37）；已授权就只剩状态词。

**验证方式也一起改了，因为断言写的正是「复杂」**。`tools/check-client-interaction.mjs` 原来有 6 项直接断言那八行常驻可见（`运行中`、`3/24`、`已放弃`、`待命`、`4242`），我改完后它们红了 —— 这是**对的**：那些断言守的是旧设计。修法不是把行搬回来，而是让异常态自动展开：4 项异常场景的断言因此原样通过，另外 2 项（「运行中」与一条「不该出现的文案」）改为断言新的那行白话。`check:ui` 回到 **61/61 PASS**。

**还没做的事（诚实记账）**：这一轮只改了渲染层，没有做「静态预览页 + 截图对比」（`dsh-in-hand-ui` 用它自己的 `docs/demo.html` 做这件事）。我想照做：从同一个渲染器导出静态 HTML，再用 WebBridge 打开真浏览器截图看它到底好不好看，而不是只靠断言。留给下一轮。另外本机当晚内存紧张（单跑 `test/memory.test.mjs` 都报 `0xC0000409` / `VirtualAlloc failed`，即 §2.36 记录的那个失效模式），整套测试改用串行重跑，与本次改动无关 —— 本次改的只有 `src/client/client.js`。
### 2.39 面板的"好看"要被核对，而"操作"还没简化

用户在这个目标里说了三件事：「我们的区别在于有点太毛胚了」「你做一个适配我们的界面 ui 让我操作起来
简单易懂一点」「你这个 den 的状态有点复杂了 继续吧 我觉得你可以根据 dsh-in-hand 的项目了解我是一个
具体怎么样的」。§2.38 处理了"状态太复杂"，本节处理剩下两件：**可核对的界面**与**尚未简化的操作**。

#### 先读用户，再动手

`D:\Projects\dsh-in-hand-ui`（用户自己做的手机端 DSH）的 README 里写着他自己的界面标准，逐字摘录
四条，并对照本插件已经做到哪一条：

| 用户写的（README 行号） | 本插件的对应 |
| --- | --- |
| 「不用坐到电脑前，也能知道**它现在在干什么、有没有事在等你**」(L36) | dock 与页面默认行只回答这两个问题：`常驻中 · 心跳运行中 · 自己醒来 N · 待读 N · 本会话已授予` |
| 「折叠成一行『N 个步骤』，**失败的那一步永不隐藏**」(L19) | 八行指标收进 `[详情]`，但 `!running` / `kernelDeferred` / `residency.held===false` / `freshness.stale` **自动展开** —— 折叠不许把故障折进去 |
| 「亮色与暗色**都是真值，不是猜的近似色**」(L25) | 已做到（见下），但第一版不是：那版用手挑的回退值，还在页面上自我声明了这件事 |
| 「`docs/demo.html` …契约测试校验它与当前构建结果一致，**防止它悄悄停在旧界面上**」(L28-31) | 已做到（见下）。用户在**他自己的产品里**早就用"渲染器生成演示页 + 契约测试"解决过同一个问题，而本插件是独立走到同一方案的 —— 同一个人的同一种洁癖 |

这四条已存进 den 的长期记忆（scenario `dsh-den`），因为它不该只活在一次对话里。

#### 预览页由渲染器生成，不是手写

`tools/check-client-interaction.mjs --demo <path>` 把它**刚刚渲染出来的两棵树**（对话输入框上方的
dock、页面座位的默认视图）序列化成 `docs/demo.html`：亮/暗切换 + 顶部横幅「演示数据，非真实状态」。
序列化器在 `tools/panel-tree.mjs`（`toHtml` / `escapeHtml` / `demoPage`），其中两件做错就等于白做的事
已各有一条用例：**裸数字按属性补 px**（漏了浏览器整条丢声明，页面就是拿默认值冒充面板排版）、
**面板文案必须转义**（预览页要显示 `<img onerror=…>` 而不是执行它）。

手写预览的坏处不是麻烦，是**它不会红**：面板一改，检查照旧全绿，磁盘上那份继续展示上一个设计。
这个项目在文档上已经付过同样的代价（README 的测试计数在 307/309/316/319/320/322/323/326/327 上反复
腐烂，最后两次尤其说明问题：一次是手改完的下一轮又烂，另一次是加了两条测试就作废 —— 于是那句话现在
干脆不带数字。把会动的东西从会腐烂的句子里拿掉，比每次手改更省）。所以契约是"提交的字节 = 渲染器当前的字节"（`test/demo-preview.test.mjs`），并且
**两个方向都验过**：改坏一个字节 → `exit 1 / fail 1`；改了颜色取值但没重新生成 → 同样红；还原/重新
生成 → `exit 0 / pass 1`。一条从没红过的检查不算证据。

#### 真值色：拒绝走的两条路

用户的标准是"真值，不是猜的近似色"，而第一版预览页用的是手挑回退值。补法有两条，都放弃了：

- **现取**：GUI 首页对无凭据请求返回 **401**，它要的是凭据 —— 那是不该去翻的东西；`app.asar` 是归档，
  不是可 grep 的目录。
- **凭记忆填**：等于把"猜的近似色"换个说法。

走的是第三条：`dsh-in-hand-ui/lib/tokens.css` 里，用户的客户端**早就把这套 token 抄出来过**（亮色块与
暗色块各 20 个）。那 20 个真实取值直接烘焙进 `demoPage`，只剩 `--demo-page` 是预览页自己的画布
（宿主在组件之外设置，拿不到），**单独命名**以免被误当成 token。

#### 还欠的那一件：操作（本节的主要待办）

已改的是**读**；**写**还是旧的：`新建自检` 要手打标题 + 提示词 + 秒数三个字段。按用户自己的原则
（一眼就懂、别让人坐下来想），这不该是"填表格"。

**设计**：空状态给一排**一键预设**，各一条现成的检查（例如「每天早上看一眼 CI 失败」「每周一清点
待办」）。点一下就建好并显示结果，不需要打字；想要自定义的人仍走原来的表单（预设是入口，不是替代）。

**验收标准**（写清楚才动手）：
1. `check:ui` 增加断言：空状态**存在**预设入口，且**不**要求输入任何字段；
2. 预设产生的触发器与手填走**同一条** `schedules/create` 校验路径 —— 预设不能绕过 5 分钟下限等规则；
3. 文案仍守 §2.38 的规则：默认视图不出现 `residency`/`ledger`/`approval gate`/`memory scenarios`
   这类内部名词；
4. `docs/demo.html` 必须重新生成（`test/demo-preview.test.mjs` 会强制这件事，这正是它的用处）。

#### 关于浏览器验证：闸门是用户的边界

`pwsh` 里 `curl --data-binary` 打 WebBridge（`127.0.0.1:10086`）被本插件的审批闸门判为
`outbound:curl-upload` → `ask`，而本会话审批提示已关闭 → 等于自动拒绝。不带 body 的 GET 放行，
带上传的 POST 不放行。**换 node 的 http 客户端可以绕过，但那正是我不该做的**：闸门刚点名了这条边界，
绕过去等于替用户推翻他自己设的规则。所以视觉确认暂时由人来做（预览页可以脱离网络直接打开），
直到用户决定是否放行 localhost 上传 —— 这是权限变更，必须先问。
- `dsh-muse`、`dsh-bot` 只作**只读参考**，不 fork、不复制代码进本仓库。
- 借鉴的是**机制与教训**（授权绑定、keeper 重新武装、TTL、多域隔离），实现代码自己写。
- 两者均为 MIT；本项目同样 MIT，若未来复制其代码片段须保留原始版权声明。

---

## 6. 本仓库不做什么

- 不做「每用户独立云 VM」硬隔离（gVisor/Firecracker 级）——那是 Dot/Muse 的护城河，本机场景不划算。
- 不做 4000 连接器目录。
- 不把「凭证不出域」说成已实现。闸门是对参数做模式匹配的，它关闭的是反射性的直接路径并让每次判定留痕（见 2.14），但一个能拼字符串、能跑脚本的 agent 可以绕开任何模式。这个机制撑不起「永不出域」，所以本仓库不写这句话。

### 6.1 同类产品对照（2026-10-14 检索；用来定坐标，不是功能核对表）

同一物种在云端已有几款官方产品。上一条"每用户独立云 VM 是它的护城河"说的就是下面第二个：

- **OpenAI `dots`** —— 官方特性页把它写成 always-active agents；报道的措辞是已登陆手机、"开口就能指挥 Codex"。
- **xAI Grok Bot** —— 每个 AI 队友**有自己的云电脑**、7×24 跑任务（beta）。
- **Meta Muse** —— Meta 的 AI 助理，已有 iPad 应用。**它是否具备常驻自主能力，本轮没有核实，因此不下判断。**
- **阿里「千问Go!」** —— 千问升级为个人 AI 助理，定位 Personal Agent；报道措辞是"将推出"，**是否已上线未核实。**

它们共同、值得学的一点：所谓"简单易懂"只落在两件事上——**一眼看见有几个在跑、有没有在等你**，以及**开口就是命令、不需要配置**。第三件是**把它放进手机**，而那半边本仓库不重复造：用户已有 `dsh-in-hand`（手机端查看与对话）。

由此得到对本项目 UI 的约束——不是新增功能，而是**别再往上加**：

1. 默认视图不再增加状态项。每多一项，第一件事就弱一次；
2. 只把两条路径做短：进入"它现在在干什么"的点击次数，与"让它去做一件事"的输入量；
3. 手机侧借力，不在本仓库重做一遍。

**证据边界**：以上来自官方页面标题与报道标题，**没有逐字核对各家功能清单**；要逐条核实以各家官方文档为准。

来源：dots（chatgpt.com/features/dots/，pconline 报道）、Grok Bot（kocpc 报道）、Meta Muse（realpython 指南）、千问Go!（163 报道）。

---

## 7. 任务形态：可监控、可自动推进、无需用户设定自动化

用户 2026-10-14 的原话定下了目标：**"做一个可监控可自动推进的属于我自己的个人助理（在了解我这个人身边的一切以后），而且无需自动设定自动化或者什么的"**，并附了千问 Go 的产品报道作为同类参照。本节先定形态，**先设计，不先写代码**。

### 7.1 三个词各自的含义（先对齐，再谈实现）

- **可监控**：打开就能知道"进行中几件、卡在哪一步、有没有事在等我"。不是日志，不是状态机图，是这三句话。
- **可自动推进**：到点自己往下走一格；走完汇报，走不动来问。**何时推进由它自己决定**。
- **无需设定自动化**：用户不说"每 30 分钟看一眼 CI"，只说"我要办这件事"，**时间与触发由它自己安排**（同类 `dsh-proactive` 已证明可行：模型给自己设闹钟）。

### 7.2 对象形态：任务 → 步骤 → 每步授权

一个任务 = 一句人话的目标 + 有序步骤；**每一步自带授权级别**：

| 级别 | 含义 | 例子 |
|---|---|---|
| `auto` | 可逆、本机——做完汇报 | 读文件、跑测试、起草、比较方案、整理信息 |
| `ask` | 先问再做 | 发送、发布、花钱、动凭据、任何不可逆动作 |

这正对应千问 Go 报道里那句"**明确哪些步骤可授权给 Agent，哪些步骤必须人工确认，避免把支付和隐私权限一次性放开**"。默认姿态：**`auto` 只覆盖可逆且本机的动作**，其余一律 `ask`。

### 7.3 推进由谁触发（"无需设定自动化"的机制）

- 心跳已在跑（60 秒一跳，四道闸：授权 → 预算 → 安静时段 → 节奏）；
- 新增的是**挑选**：每次心跳看一遍未完成任务，挑出"到期的下一步"——到期由任务本身决定（时间点、前置步骤完成、或外部条件变化）；
- 用户侧接口只有一句话：**"帮我办 X"**。不要求他说周期，也不要求他配置触发器；
- 用户保留两个否决权：安静时段、每日预算。这两个是"它别烦我"的开关，不是"它要不要干活"的开关。

### 7.4 面板怎么显示（受 6.1 约束：**不加状态项**）

- 默认视图只多**一行**：进行中 N 件 · 卡住 M 件，其余折进 `[详情]`；
- **卡住/失败的那一步永不隐藏**（沿用 dsh-in-hand 的原则）；
- "等你确认"与"待读"共用一个计数，因为对人来说它们是同一件事：**有事在等你**。

### 7.5 "了解我"的画像（可见、可改、可删）

画像是 den 记忆里的一部分，**不是黑箱**：用户能看到记了什么、能改、能删。可读来源默认只含用户点过头的那些（会话历史 / 历史记忆目录 / 项目仓库）；日程、邮件、IM 需要单独通道，不在本节范围。

### 7.6 验收标准（做不到就不算做完）

1. 说一句"帮我办 X"，就形成一个任务，含步骤与每步授权；
2. 用户**不设任何定时**，它自己知道何时推进；
3. 每一步要么"做了并告诉我"，要么"来问我"——不替用户决定；
4. 任何时候打开就能看到：进行中几件、卡在哪一步、有没有事在等我；
5. 失败的那一步永不隐藏；
6. 每一步判定都能在现成的 `gate-audit.json` 里查到。

### 7.7 明确不做

- 不新建一套任务系统：任务长在现成的心跳 + 记忆 + 四闸 + 审计上；
- 不搬 `dsh-partner` 的依赖感知任务板（它的门与 den 的模型不同，搬过来要改它的核心）；
- 不为多步任务引入云 VM、连接器目录或任何云端依赖（见 §6）；
- `auto` 永不覆盖支付、发布、对外发送、凭据。