# RKAPI Image 使用与搭建说明

## 项目简介

RKAPI Image 是一个自托管的图片生成工作台。部署后，用户在浏览器里填写自己的密钥和模型编号，就可以使用文生图、图生图、提示词反推、提示词优化、智能助手、动图生成、无限画布、素材库和提示词广场等功能。

项目由两部分组成：

- 前端工作台：浏览器页面，负责操作界面、本地设置、任务历史、素材库、备份恢复和图片预览。
- 后端服务：负责接收生成任务、排队、限流、调用上游模型、保存生成结果、提供健康检查和任务读取接口。

默认网关固定为 `https://api.rkai6.com`。如果部署方需要把这个公网地址改写到内网服务，可以在后端运行配置里设置地址改写规则。

## 适合谁使用

- 想自己部署一个图片生成网页的用户。
- 想给团队或客户提供统一图片生成入口的部署者。
- 已经有 RKAPI 或兼容上游密钥，希望统一管理文生图、图生图、反推和提示词优化流程的用户。

## 主要功能

- 文生图：输入提示词，选择模型、比例、分辨率和生成数量后提交任务。
- 图生图：上传或导入参考图，再输入修改要求生成新图片。
- 多图生成：一次提交多个生成任务，并可为每张图填写单独要求。
- 智能助手：通过对话整理需求，生成或修改图片。
- 反推提示词：上传图片后生成可复用的中文提示词。
- 提示词优化：把用户原始描述优化成更适合生图模型的提示词。
- 动图生成：生成网格帧图，并在浏览器本地切片合成动图。
- 无限画布：整理参考图、配置节点和生成节点，适合复杂创作流程。
- 我的素材：保存图片和提示词素材，后续可再次作为参考图或提示词使用。
- 提示词广场：展示内置提示词，可按部署配置常驻、私密或关闭。
- 数据备份：在设置页导出或恢复浏览器本地数据。

## 默认模型

| 用途 | 默认显示名称 | 默认模型编号 | 说明 |
| --- | --- | --- | --- |
| 文生图 | `RKAPI-4k` | `gpt-image-2` | 默认用于纯文字生成图片 |
| 图生图 | `RKAPI-逆向` | `gpt-image-2` | 默认用于参考图改图 |
| 文本能力 | `RKAPI` | `gpt-5.6-sol` | 用于反推、智能助手、提示词优化和图片描述 |

模型的显示名称和网关地址在页面中固定，用户只需要填写密钥，并按实际上游情况调整模型编号。

## 快速部署

默认部署目录建议使用 `/opt/rkapi-image`。

```bash
sudo mkdir -p /opt
sudo git clone https://github.com/biubiubiu125/rkapi-image.git /opt/rkapi-image
cd /opt/rkapi-image
sudo mkdir -p data
sudo cp backend/.env.example data/.env
sudo docker compose pull
sudo docker compose up -d
```

启动后访问服务器的 `3001` 端口即可打开页面。如果前面还有反向代理，请把代理目标指向容器的 `3001` 端口。

## 数据保存位置

使用默认容器部署时，数据会保存到项目目录下的 `data` 文件夹。

| 内容 | 默认位置 |
| --- | --- |
| 运行配置 | `/opt/rkapi-image/data/.env` |
| 任务数据库 | `/opt/rkapi-image/data/rkapi-tasks.sqlite` |
| 生成图片 | `/opt/rkapi-image/data/rkapi-images` |

浏览器里的模型配置、任务历史、素材库和部分界面设置也会保存在当前浏览器本地。更换浏览器或设备时，可以在设置页使用全量备份和恢复。

## 常用配置

运行配置文件是 `/opt/rkapi-image/data/.env`。修改大多数运行配置后，后端会自动刷新读取，不需要重新构建镜像。

| 配置项 | 作用 |
| --- | --- |
| `PORT` | 后端监听端口，默认 `3001` |
| `HOSTNAME` | 绑定地址，默认 `0.0.0.0` |
| `RKAPI_IMAGE_TASK_CONCURRENCY` | 最大并发生成数量 |
| `RKAPI_IMAGE_MAX_QUEUE_SIZE` | 全局最大待处理任务数 |
| `RKAPI_IMAGE_RATE_LIMIT_MAX_REQUESTS_PER_IP` | 单个访问地址在限流窗口内可创建的任务数 |
| `RKAPI_IMAGE_RATE_LIMIT_MAX_REQUESTS_PER_API_KEY` | 单个密钥在限流窗口内可创建的任务数 |
| `RKAPI_IMAGE_MAX_PENDING_TASKS_PER_IP` | 单个访问地址最多同时拥有的待处理任务数 |
| `RKAPI_IMAGE_MAX_PENDING_TASKS_PER_API_KEY` | 单个密钥最多同时拥有的待处理任务数 |
| `RKAPI_IMAGE_BASE_URL_REWRITE_MAP` | 把固定网关地址改写为实际内网地址 |
| `RKAPI_IMAGE_OUTBOUND_USER_AGENT` | 后端请求上游时携带的服务标识 |
| `RKAPI_IMAGE_PLATFORM_NAME` | 页面和安装应用显示名称 |
| `PROMPT_GALLERY_MODE` | 提示词广场模式：`1` 常驻、`2` 私密、`3` 关闭 |
| `PROMPT_GALLERY_PASSWORD` | 私密模式下的提示词广场密码 |

如果上游服务在同一个容器网络内，可以这样改写网关地址：

```env
RKAPI_IMAGE_BASE_URL_REWRITE_MAP={"https://api.rkai6.com":"http://new-api:3000"}
```

## 首次使用流程

1. 打开网页，进入设置。
2. 在模型配置里填写图片模型密钥和文本模型密钥。
3. 如果上游模型编号不同，修改对应的模型编号。
4. 保存设置。
5. 在默认模型区域确认文生图、图生图、反推、智能助手、提示词优化和图片描述使用的模型。
6. 回到工作台，输入提示词或上传参考图后提交任务。

只做文生图或图生图时，至少需要配置一个完整的图片模型。需要反推、智能助手、提示词优化或图片描述时，还需要配置完整的文本模型。

## 上传和请求限制

- 单张上传图片会先在浏览器内压缩，压缩后仍超过 `10MB` 时不会加入参考图。
- 一次文生图或图生图任务的请求体上限约为 `50MB`。
- 参考图会以文本形式放入请求体，实际可上传的原始图片总大小会低于 `50MB`。
- 默认后端最多支持 `16` 张参考图，具体可用数量还会受所选模型配置影响。
- 如果前面有反向代理、面板网关或云防护，也要把外层请求体限制放到不低于 `50m`，否则请求可能在到达后端前被拒绝。

## 运行和更新

查看容器状态：

```bash
cd /opt/rkapi-image
sudo docker compose ps
```

查看后端日志：

```bash
cd /opt/rkapi-image
sudo docker compose logs -f rkapi-image
```

更新到最新镜像：

```bash
cd /opt/rkapi-image
sudo docker compose pull
sudo docker compose up -d
```

健康检查地址：

```text
http://服务器地址:3001/api/flyreq/health
```

## 常见问题

### 页面提示缺少密钥

进入设置页，为图片模型或文本模型填写密钥并保存。文生图和图生图需要图片模型密钥；反推、智能助手和提示词优化需要文本模型密钥。

### 任务一直排队

先查看容器日志和队列配置。常见原因是并发数过低、上游响应慢、队列已满、访问地址或密钥触发限流。

### 请求返回过大或无法上传

先确认单张图片压缩后是否超过 `10MB`，再确认整次任务请求体是否超过约 `50MB`。如果部署了反向代理，还要检查外层请求体限制。

### 上游地址在浏览器里不能改

这是项目设计。页面里的网关地址固定为 `https://api.rkai6.com`，部署方需要通过后端的 `RKAPI_IMAGE_BASE_URL_REWRITE_MAP` 做实际出站地址改写。

### 更换设备后看不到历史

模型配置、历史记录和素材主要保存在浏览器本地。请先在旧设备设置页导出全量备份，再到新设备导入。

## 本地开发

本地调试前先安装依赖：

```bash
npm run install:all
```

常用命令：

```bash
npm run dev
npm run dev:frontend
npm run dev:backend
npm run build
npm run lint
npm run test:run
```

生产启动命令：

```bash
npm run start
```

## 许可

本项目使用 `AGPL-3.0` 许可。
