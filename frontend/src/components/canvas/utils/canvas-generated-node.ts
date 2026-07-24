import type { CanvasNodeData, CanvasNodeMetadata } from "../types";
import { fitNodeSize } from "./canvas-node-size";

export type CanvasStoredGeneratedImage = {
  storageKey: string;
  url: string;
  width: number;
  height: number;
  mimeType: string;
  bytes: number;
};

export type GeneratedImageNodeApplyResult = {
  updated: boolean;
  nodes: CanvasNodeData[];
};

function toGeneratedImageMetadata(
  image: CanvasStoredGeneratedImage,
  extra?: Partial<CanvasNodeMetadata>,
): CanvasNodeMetadata {
  return {
    status: "success",
    content: image.url,
    storageKey: image.storageKey,
    mimeType: image.mimeType,
    naturalWidth: image.width,
    naturalHeight: image.height,
    bytes: image.bytes,
    ...extra,
  };
}

export function applyGeneratedImageToCanvasNodes(
  nodes: CanvasNodeData[],
  nodeId: string,
  image: CanvasStoredGeneratedImage,
  extra?: Partial<CanvasNodeMetadata>,
): GeneratedImageNodeApplyResult {
  let updated = false;
  const size = fitNodeSize(image.width, image.height, 360, 360);
  const nextNodes = nodes.map((node) => {
    if (node.id !== nodeId) return node;
    updated = true;
    return {
      ...node,
      width: size.width,
      height: size.height,
      metadata: {
        ...node.metadata,
        ...toGeneratedImageMetadata(image, extra),
        generationTaskId: node.metadata?.generationTaskId,
        generationTaskReadToken: node.metadata?.generationTaskReadToken,
        generationStartedAt: node.metadata?.generationStartedAt,
      },
    };
  });

  return updated ? { updated, nodes: nextNodes } : { updated, nodes };
}
