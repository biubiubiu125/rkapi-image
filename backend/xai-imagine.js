function getXaiImagineEndpoint(mode) {
  return mode === 'image-to-image'
    ? '/v1/images/edits'
    : '/v1/images/generations';
}

function createXaiImagineRequestInit(apiKey, request, options = {}) {
  const payload = {
    model: request.model,
    prompt: request.prompt,
    n: 1,
    aspect_ratio: request.aspectRatio,
    resolution: request.outputSize.toLowerCase(),
    ...(request.mode === 'image-to-image' && request.images[0] ? {
      image: {
        type: 'image_url',
        url: `data:${request.images[0].mimeType || 'image/png'};base64,${request.images[0].data}`,
      },
    } : {}),
  };

  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  };
}

module.exports = {
  createXaiImagineRequestInit,
  getXaiImagineEndpoint,
};
