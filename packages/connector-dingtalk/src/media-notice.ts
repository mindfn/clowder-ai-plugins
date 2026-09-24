import {
  isMediaUnavailableMessageElement,
  isMediaWarningMessageElement,
} from '@clowder-ai/plugin-sdk';

const MEDIA_TYPE_LABEL = {
  image: '图片',
  file: '文件',
  audio: '音频',
  video: '视频',
} as const;

const UNAVAILABLE_REASON_LABEL = {
  source_expired: '来源已过期',
  timeout: '处理超时',
  unavailable: '暂时不可用',
} as const;

const WARNING_STAGE_LABEL = {
  transcription: '转写',
  preview: '预览',
} as const;

const WARNING_REASON_LABEL = {
  timeout: '超时',
  processing_failed: '处理失败',
} as const;

export function renderTypedMediaNotice(element: unknown): string | undefined {
  if (isMediaUnavailableMessageElement(element)) {
    const label = element.payload.fileName ?? MEDIA_TYPE_LABEL[element.payload.type];
    return `⚠️ 媒体不可用：${label}（${UNAVAILABLE_REASON_LABEL[element.payload.reason]}）`;
  }
  if (isMediaWarningMessageElement(element)) {
    return `⚠️ 媒体处理警告：${WARNING_STAGE_LABEL[element.payload.stage]}${WARNING_REASON_LABEL[element.payload.reason]}`;
  }
  return undefined;
}
