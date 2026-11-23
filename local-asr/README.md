# 本地语音识别兜底（SenseVoiceSmall）

线上 ASR 线路（硅基流动等）全部不可用时，录音转写自动落到这台机器上跑，
不依赖网络、不消耗额度，录音也不出本机。

## 它是怎么接进系统的

```
浏览器录音(webm) → POST /api/asr → 号池按优先级依次尝试
                                     ├─ 硅基流动 SenseVoiceSmall   ← 线上主线路
                                     ├─ XingChenASR               ← 线上备用
                                     └─ 本地 SenseVoice（兜底）    ← 本服务 127.0.0.1:8108
```

号池把本地服务当成一条普通线路，所以「线上全挂才走本地」不需要额外判断——
它是优先级最低的那条，前面的线路失败（连不上 / 额度用尽 / Key 失效）才会轮到它。

本地线路由应用自己管：启动时把线路补进号池（已存在则跳过），需要时用
`/health` 探活，没在跑就拉起 `local-asr/server.py`。**不需要额外配置开机自启。**

## 一次性安装

```bash
npm run asr:setup        # 建 venv + 装 torch/FunASR + 下载模型（约 900MB）
```

安装完不需要手动启动，直接跑应用即可：第一次走到兜底线路时会自动拉起服务。

想手动确认能不能用：

```bash
npm run asr:start        # 前台运行，Ctrl+C 停止
npm run asr:health       # 另开终端，应输出 {"status":"ok",...}
```

## 内存与速度（重要）

这台机器 8GB，模型常驻要 **1.5GB 左右**，所以默认策略是「用到才加载、空闲 10 分钟释放」：

| 状态 | 内存 | 单次识别耗时 |
|---|---|---|
| 待命（模型已释放） | ~60MB | — |
| 首次识别（要加载模型） | 1.5GB | 20-60 秒（机器繁忙时更久） |
| 模型已驻留、内存充裕 | 1.5GB | 约 2 秒 |
| 模型已驻留、但系统在换页 | 1.5GB | 20 秒以上 |

也就是说：**兜底可用，但不要在录音前把内存占满**。若系统交换区吃紧，识别会被拖慢十倍。
把 Chrome 之类的大户关掉，速度就回到 2 秒级。

## 接口

OpenAI 兼容，和号池里那条线路用同样的参数：

```bash
curl http://127.0.0.1:8108/v1/audio/transcriptions \
  -F file=@sample.webm -F model=SenseVoiceSmall -F language=ja
# {"text":"これは日本語の音声認識テストです。"}
```

`language` 支持 `zh / en / ja / ko / yue / auto`；请求里的 `prompt`、`temperature`
是号池通用字段，本地忽略。

## 状态怎么查

`GET /health` 除了探活，还回传设置页要展示的实时状态：

```json
{"status":"ok","loaded":true,"loading":false,"model":"SenseVoiceSmall","device":"cpu",
 "idleUnloadSec":600,"idleSec":2,"uptimeSec":33,"loadMs":14775,
 "total":1,"failed":0,
 "last":{"atMs":1795347151885,"elapsedMs":1156,"language":"ja","chars":44,"bytes":36810,"coldStart":true},
 "error":null}
```

- `loaded`：模型此刻是否驻留内存（`false` + `idleSec:null` 表示已按空闲策略释放）；
- `last`：最近一次识别耗时 / 语种 / 字数，`coldStart` 表示那一次顺带加载了模型；
- `loadMs`：上一次模型加载耗时，用来解释「为什么这次特别慢」。

设置页【音色与朗读 → 语音识别号池】里的「本地兜底服务」卡片每 6 秒读一次
`GET /api/settings/asr/local`（服务端转发到上面的 `/health`），并带「启动服务 / 刷新」按钮；
接口在 `server/src/services/localAsr.ts` 的 `localAsrStatus()`。

## 可调环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ASR_LOCAL_PORT` | `8108` | 监听端口（只绑 127.0.0.1） |
| `ASR_THREADS` | `2` | torch 推理线程数，调大更快但更吃 CPU |
| `ASR_IDLE_UNLOAD_SEC` | `600` | 空闲多少秒后释放模型；设 `0` 表示永不释放 |
| `ASR_PRELOAD` | `0` | 设 `1` 则进程启动即加载模型（吃 1.5GB，但第一次识别快） |
| `ASR_DEVICE` | `cpu` | 想试 MPS 可设 `mps`，默认 CPU 更稳 |
| `ASR_MODEL_DIR` | `local-asr/models/SenseVoiceSmall` | 模型目录 |

## 常见问题

- **`ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` 不匹配**：`better-sqlite3` 是按 Node 24
  编译的，用 Node 22 跑应用会加载失败。换回 Node 24（`/usr/local/bin/node`）再启动。
- **转写中途断开**：开发态 `tsx watch` 会在源码变动时重启 API，长请求会被打断。
  `local-asr/**` 已加入监听排除，但改动 `server/src/**` 仍会重启——生产模式（`npm start`）没有这个问题。
- **端口被占**：`lsof -nP -iTCP:8108 -sTCP:LISTEN` 看是谁，或改 `ASR_LOCAL_PORT`。
- **模型下载失败**：`npm run asr:setup` 重跑即可续传。
- **识别为空**：录音过短或几乎无声。号池遇到「空文本」不会判定线路故障，会继续试下一条。
- **`ffmpeg` 缺失**：`brew install ffmpeg`，服务用它把 webm/opus 统一转成 16k wav。
- **想让它开机自启**：`npm run asr:agent`（注册 LaunchAgent）。部分受限终端里
  launchctl 会被系统拒绝（`Bootstrap failed: 5`），此时不必强求——应用会自己拉起。
