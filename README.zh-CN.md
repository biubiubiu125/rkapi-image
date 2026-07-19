# RKAPI Image

<p align="right"><a href="./README.md">English</a> | <strong>简体中文</strong></p>

RKAPI Image 是一个固定 RKAPI 网关的自托管 AI 图片工作台，支持任务队列、模型配置和浏览器端设置保存。

## 默认模型

| 类型 | 显示名称 | 内部 ID | 默认模型 ID | Base URL |
| --- | --- | --- | --- | --- |
| 图片模型 | RKAPI-逆向 | `rkapi-reverse-image` | `gpt-image-2` | `https://api.rkai6.com` |
| 图片模型 | RKAPI-4k | `rkapi-4k-image` | `gpt-image-2` | `https://api.rkai6.com` |
| 文本/反推模型 | RKAPI | `rkapi-text` | `gpt-5.6-sol` | `https://api.rkai6.com` |

## 模型规则

- 显示名称和 Base URL 固定为 RKAPI，不允许用户改成其它网关。
- 模型 ID 仍然可以在设置页按实际上游 ID 修改。
- 文生图默认使用 `RKAPI-4k`，图生图默认使用 `RKAPI-逆向`。
- 反推、Agent、提示词优化和图片描述默认使用 `RKAPI` 文本模型。
- 图片模型还没填写 API Key 时，只要文本模型完整，也可以先保存设置。

## 部署

默认部署目录为 `/opt/rkapi-image`。

```bash
sudo mkdir -p /opt
sudo git clone https://github.com/biubiubiu125/rkapi-image.git /opt/rkapi-image
cd /opt/rkapi-image
sudo mkdir -p data
sudo cp backend/.env.example data/.env
sudo docker compose pull
sudo docker compose up -d
```

Compose 默认把数据和运行期配置文件保存到 `/opt/rkapi-image/data/`。队列、Base URL 改写、品牌、默认模型和提示词广场配置请修改 `/opt/rkapi-image/data/.env`；这些运行期配置由后端刷新读取，不需要重新构建镜像。

容器使用：

```yaml
RKAPI_IMAGE_TASK_DB: /app/backend/data/rkapi-tasks.sqlite
RKAPI_IMAGE_IMAGE_DIR: /app/backend/data/rkapi-images
```

## 运行配置

- `RKAPI_IMAGE_BASE_URL_REWRITE_MAP`：后端出站请求的 Base URL 改写表。
- `RKAPI_IMAGE_DEFAULT_IMAGE_MODEL_MODEL_ID`：新用户图片模型默认模型 ID。
- `RKAPI_IMAGE_DEFAULT_IMAGE_MODEL_SUPPORTS_ADVANCED_PARAMS`：默认 GPT Image 2 高级参数开关。
- `RKAPI_IMAGE_DEFAULT_IMAGE_MODEL_STREAM_IMAGES`：默认流式图片请求开关。

## 使用方法

1. 打开设置页。
2. 给 `RKAPI-逆向`、`RKAPI-4k` 和 `RKAPI` 填入 API Key。
3. 如果网关实际模型 ID 不同，再修改对应模型 ID。
4. 保存设置后，即可使用生图、反推、Agent 和提示词优化等工作流。

## 排障

如果公网网关需要改写到 Docker 内网服务，前端保存的模型 Base URL 仍保持 `https://api.rkai6.com`，后端通过 `RKAPI_IMAGE_BASE_URL_REWRITE_MAP` 配置实际出站地址。

## 许可证

AGPL-3.0。
