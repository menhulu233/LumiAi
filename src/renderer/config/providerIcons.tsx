import React from 'react';
import {
  OpenAIIcon,
  DeepSeekIcon,
  GeminiIcon,
  AnthropicIcon,
  MoonshotIcon,
  ZhipuIcon,
  MiniMaxIcon,
  YouDaoZhiYunIcon,
  QwenIcon,
  XiaomiIcon,
  StepfunIcon,
  VolcengineIcon,
  OpenRouterIcon,
  OllamaIcon,
  CustomProviderIcon,
} from '../components/icons/providers';
import type { ProviderType } from './providerMeta';

export const ProviderIcons: Record<ProviderType, React.ReactNode> = {
  openai: <OpenAIIcon />,
  deepseek: <DeepSeekIcon />,
  gemini: <GeminiIcon />,
  anthropic: <AnthropicIcon />,
  moonshot: <MoonshotIcon />,
  zhipu: <ZhipuIcon />,
  minimax: <MiniMaxIcon />,
  volcengine: <VolcengineIcon />,
  qwen: <QwenIcon />,
  youdaozhiyun: <YouDaoZhiYunIcon />,
  stepfun: <StepfunIcon />,
  xiaomi: <XiaomiIcon />,
  openrouter: <OpenRouterIcon />,
  ollama: <OllamaIcon />,
  custom: <CustomProviderIcon />,
};
