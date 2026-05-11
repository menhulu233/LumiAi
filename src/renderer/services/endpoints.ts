/**
 * 集中管理所有业务 API 端点。
 * 后续新增的业务接口也应在此文件中配置。
 */

import { configService } from './config';

const isTestMode = () => {
  return configService.getConfig().app?.testMode === true;
};

// 自动更新
export const getUpdateCheckUrl = () => isTestMode()
  ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lumiai/test/update'
  : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lumiai/prod/update';

export const getFallbackDownloadUrl = () => isTestMode()
  ? 'https://lumiai.inner.youdao.com/#/download-list'
  : 'https://lumiai.youdao.com/#/download-list';

// Skill 商店
export const getSkillStoreUrl = () => isTestMode()
  ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lumiai/test/skill-store'
  : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lumiai/prod/skill-store';
