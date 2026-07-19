# RKAPI Image

<p align="right"><strong>English</strong> | <a href="./README.zh-CN.md">简体中文</a></p>

RKAPI Image is a self-hosted AI image workspace with a fixed RKAPI gateway, task queueing, and browser-side model configuration.

## Default models

| Type | Display name | Internal ID | Default model ID | Base URL |
| --- | --- | --- | --- | --- |
| Image | RKAPI-逆向 | `rkapi-reverse-image` | `gpt-image-2` | `https://api.rkai6.com` |
| Image | RKAPI-4k | `rkapi-4k-image` | `gpt-image-2` | `https://api.rkai6.com` |
| Text / reverse prompt | RKAPI | `rkapi-text` | `gpt-5.6-sol` | `https://api.rkai6.com` |

## Model rules

- Display names and Base URL are fixed to RKAPI values.
- Users can still edit model IDs in Settings.
- Image generation uses `RKAPI-4k` by default for text-to-image and `RKAPI-逆向` by default for image-to-image.
- Reverse prompt, Agent, prompt optimization, and image description use the `RKAPI` text model.
- A complete text model can be saved before image model API keys are filled.

## Deployment

The default deployment directory is `/opt/rkapi-image`.

```bash
sudo mkdir -p /opt
sudo git clone https://github.com/biubiubiu125/rkapi-image.git /opt/rkapi-image
cd /opt/rkapi-image
sudo mkdir -p data
sudo cp backend/.env.example data/.env
sudo docker compose pull
sudo docker compose up -d
```

The compose file persists data and the runtime config file under `/opt/rkapi-image/data/`. Edit `/opt/rkapi-image/data/.env` for queue, rewrite, branding, model-default, and Prompt Gallery settings; these runtime settings are refreshed by the backend without rebuilding the image.

The container uses:

```yaml
RKAPI_IMAGE_TASK_DB: /app/backend/data/rkapi-tasks.sqlite
RKAPI_IMAGE_IMAGE_DIR: /app/backend/data/rkapi-images
```

## Runtime variables

- `RKAPI_IMAGE_BASE_URL_REWRITE_MAP`: server-side outbound rewrite map for the fixed RKAPI gateway.
- `RKAPI_IMAGE_DEFAULT_IMAGE_MODEL_MODEL_ID`: deployment default image model ID.
- `RKAPI_IMAGE_DEFAULT_IMAGE_MODEL_SUPPORTS_ADVANCED_PARAMS`: default GPT Image 2 advanced controls.
- `RKAPI_IMAGE_DEFAULT_IMAGE_MODEL_STREAM_IMAGES`: default streaming image requests.

## Quick Use

1. Open Settings.
2. Fill API Key for `RKAPI-逆向`, `RKAPI-4k`, and `RKAPI`.
3. Adjust model IDs only if your gateway uses different upstream IDs.
4. Save settings, then use image generation, reverse prompt, Agent, or prompt optimization workflows.

## Troubleshooting

If a public gateway URL must be rewritten to an internal Docker service, keep the saved model Base URL as `https://api.rkai6.com` and configure `RKAPI_IMAGE_BASE_URL_REWRITE_MAP` on the backend.

## License

AGPL-3.0.
