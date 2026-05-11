export interface ImageAttachment {
  name: string;
  mimeType: string;
  base64Data: string;
}

export interface IPCHandlers {
  // Store
  'store:get': {
    request: string;
    response: unknown;
  };
  'store:set': {
    request: { key: string; value: unknown };
    response: void;
  };
  'store:remove': {
    request: string;
    response: void;
  };

  // Window
  'window-minimize': {
    request: void;
    response: void;
  };
  'window-maximize': {
    request: void;
    response: void;
  };
  'window-close': {
    request: void;
    response: void;
  };
  'window:isMaximized': {
    request: void;
    response: boolean;
  };
  'window:showSystemMenu': {
    request: { x?: number; y?: number };
    response: void;
  };

  // Cowork Session
  'cowork:session:start': {
    request: {
      prompt: string;
      cwd?: string;
      systemPrompt?: string;
      title?: string;
      activeSkillIds?: string[];
      imageAttachments?: ImageAttachment[];
    };
    response: { success: boolean; session?: any; error?: string };
  };
  'cowork:session:continue': {
    request: {
      sessionId: string;
      prompt: string;
      systemPrompt?: string;
      activeSkillIds?: string[];
      imageAttachments?: ImageAttachment[];
    };
    response: { success: boolean; session?: any; error?: string };
  };
  'cowork:session:stop': {
    request: string;
    response: { success: boolean; error?: string };
  };
  'cowork:session:delete': {
    request: string;
    response: { success: boolean; error?: string };
  };
  'cowork:session:deleteBatch': {
    request: string[];
    response: { success: boolean; error?: string };
  };
  'cowork:session:pin': {
    request: { sessionId: string; pinned: boolean };
    response: { success: boolean; error?: string };
  };
  'cowork:session:rename': {
    request: { sessionId: string; title: string };
    response: { success: boolean; error?: string };
  };
  'cowork:session:get': {
    request: string;
    response: { success: boolean; session?: any; error?: string };
  };
  'cowork:session:list': {
    request: void;
    response: { success: boolean; sessions?: any[]; error?: string };
  };
  'cowork:session:exportResultImage': {
    request: {
      rect: { x: number; y: number; width: number; height: number };
      defaultFileName?: string;
    };
    response: { success: boolean; canceled?: boolean; path?: string; error?: string };
  };
  'cowork:session:captureImageChunk': {
    request: {
      rect: { x: number; y: number; width: number; height: number };
    };
    response: { success: boolean; width?: number; height?: number; pngBase64?: string; error?: string };
  };
  'cowork:session:saveResultImage': {
    request: { pngBase64: string; defaultFileName?: string };
    response: { success: boolean; canceled?: boolean; path?: string; error?: string };
  };

  // Cowork Permission
  'cowork:permission:respond': {
    request: { requestId: string; result: any };
    response: { success: boolean; error?: string };
  };

  // Cowork Config
  'cowork:config:get': {
    request: void;
    response: { success: boolean; config?: any; error?: string };
  };
  'cowork:config:set': {
    request: any;
    response: { success: boolean; error?: string };
  };

  // Cowork Memory
  'cowork:memory:listEntries': {
    request: any;
    response: { success: boolean; entries?: any[]; error?: string };
  };
  'cowork:memory:createEntry': {
    request: { text: string; confidence?: number; isExplicit?: boolean };
    response: { success: boolean; entry?: any; error?: string };
  };
  'cowork:memory:updateEntry': {
    request: any;
    response: { success: boolean; entry?: any; error?: string };
  };
  'cowork:memory:deleteEntry': {
    request: { id: string };
    response: { success: boolean; error?: string };
  };
  'cowork:memory:getStats': {
    request: void;
    response: { success: boolean; stats?: any; error?: string };
  };

  // Cowork Sandbox
  'cowork:sandbox:status': {
    request: void;
    response: any;
  };
  'cowork:sandbox:install': {
    request: void;
    response: { success: boolean; status?: any; error?: string };
  };

  // Skills
  'skills:list': {
    request: void;
    response: { success: boolean; skills?: any[]; error?: string };
  };
  'skills:setEnabled': {
    request: { id: string; enabled: boolean };
    response: { success: boolean; skills?: any[]; error?: string };
  };
  'skills:delete': {
    request: string;
    response: { success: boolean; skills?: any[]; error?: string };
  };
  'skills:download': {
    request: string;
    response: { success: boolean; skills?: any[]; error?: string };
  };
  'skills:getRoot': {
    request: void;
    response: { success: boolean; path?: string; error?: string };
  };
  'skills:autoRoutingPrompt': {
    request: void;
    response: { success: boolean; prompt?: string; error?: string };
  };
  'skills:getConfig': {
    request: string;
    response: any;
  };
  'skills:setConfig': {
    request: { skillId: string; config: Record<string, string> };
    response: any;
  };
  'skills:testEmailConnectivity': {
    request: { skillId: string; config: Record<string, string> };
    response: any;
  };

  // MCP
  'mcp:list': {
    request: void;
    response: { success: boolean; servers?: any[]; error?: string };
  };
  'mcp:create': {
    request: any;
    response: { success: boolean; servers?: any[]; error?: string };
  };
  'mcp:update': {
    request: { id: string; data: any };
    response: { success: boolean; servers?: any[]; error?: string };
  };
  'mcp:delete': {
    request: string;
    response: { success: boolean; servers?: any[]; error?: string };
  };
  'mcp:setEnabled': {
    request: { id: string; enabled: boolean };
    response: { success: boolean; servers?: any[]; error?: string };
  };
  'mcp:fetchMarketplace': {
    request: void;
    response: { success: boolean; data?: any; error?: string };
  };

  // Scheduled Tasks
  'scheduledTask:list': {
    request: void;
    response: { success: boolean; tasks?: any[]; error?: string };
  };
  'scheduledTask:get': {
    request: string;
    response: { success: boolean; task?: any; error?: string };
  };
  'scheduledTask:create': {
    request: any;
    response: { success: boolean; task?: any; error?: string };
  };
  'scheduledTask:update': {
    request: { id: string; input: any };
    response: { success: boolean; task?: any; error?: string };
  };
  'scheduledTask:delete': {
    request: string;
    response: { success: boolean; result?: any; error?: string };
  };
  'scheduledTask:toggle': {
    request: { id: string; enabled: boolean };
    response: { success: boolean; task?: any; warning?: string; error?: string };
  };
  'scheduledTask:runManually': {
    request: string;
    response: { success: boolean; error?: string };
  };
  'scheduledTask:stop': {
    request: string;
    response: { success: boolean; result?: any; error?: string };
  };
  'scheduledTask:listRuns': {
    request: { taskId: string; limit?: number; offset?: number };
    response: { success: boolean; runs?: any[]; error?: string };
  };
  'scheduledTask:countRuns': {
    request: string;
    response: { success: boolean; count?: number; error?: string };
  };
  'scheduledTask:listAllRuns': {
    request: { limit?: number; offset?: number };
    response: { success: boolean; runs?: any[]; error?: string };
  };

  // IM
  'im:config:get': {
    request: void;
    response: { success: boolean; config?: any; error?: string };
  };
  'im:config:set': {
    request: any;
    response: { success: boolean; error?: string };
  };
  'im:gateway:start': {
    request: string;
    response: { success: boolean; error?: string };
  };
  'im:gateway:stop': {
    request: string;
    response: { success: boolean; error?: string };
  };
  'im:gateway:test': {
    request: { platform: string; configOverride?: any };
    response: { success: boolean; result?: any; error?: string };
  };
  'im:status:get': {
    request: void;
    response: { success: boolean; status?: any; error?: string };
  };

  // Permissions
  'permissions:checkCalendar': {
    request: void;
    response: { success: boolean; status?: string; autoRequested?: boolean; error?: string };
  };
  'permissions:requestCalendar': {
    request: void;
    response: { success: boolean; granted?: boolean; status?: string; error?: string };
  };

  // Dialog
  'dialog:selectDirectory': {
    request: void;
    response: { success: boolean; path: string | null };
  };
  'dialog:selectFile': {
    request: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    };
    response: { success: boolean; path: string | null };
  };
  'dialog:selectFiles': {
    request: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    };
    response: { success: boolean; paths: string[] };
  };
  'dialog:saveInlineFile': {
    request: {
      dataBase64?: string;
      fileName?: string;
      mimeType?: string;
      cwd?: string;
    };
    response: { success: boolean; path: string | null; error?: string };
  };
  'dialog:readFileAsDataUrl': {
    request: string;
    response: { success: boolean; dataUrl?: string; error?: string };
  };

  // Shell
  'shell:openPath': {
    request: string;
    response: { success: boolean; error?: string };
  };
  'shell:showItemInFolder': {
    request: string;
    response: { success: boolean; error?: string };
  };
  'shell:openExternal': {
    request: string;
    response: { success: boolean; error?: string };
  };

  // App
  'app:getAutoLaunch': {
    request: void;
    response: { enabled: boolean };
  };
  'app:setAutoLaunch': {
    request: boolean;
    response: { success: boolean; error?: string };
  };
  'app:getVersion': {
    request: void;
    response: string;
  };
  'app:getSystemLocale': {
    request: void;
    response: string;
  };

  // App Update
  'appUpdate:download': {
    request: string;
    response: { success: boolean; filePath?: string; error?: string };
  };
  'appUpdate:cancelDownload': {
    request: void;
    response: { success: boolean };
  };
  'appUpdate:install': {
    request: string;
    response: { success: boolean; error?: string };
  };

  // Log
  'log:getPath': {
    request: void;
    response: string;
  };
  'log:openFolder': {
    request: void;
    response: void;
  };
  'log:exportZip': {
    request: void;
    response: { success: boolean; canceled?: boolean; path?: string; missingEntries?: string[]; error?: string };
  };

  // API
  'get-api-config': {
    request: void;
    response: any;
  };
  'check-api-config': {
    request: { probeModel?: boolean };
    response: any;
  };
  'save-api-config': {
    request: {
      apiKey: string;
      baseURL: string;
      model: string;
      apiType?: 'anthropic' | 'openai';
    };
    response: { success: boolean; error?: string };
  };
  'generate-session-title': {
    request: string | null;
    response: any;
  };
  'get-recent-cwds': {
    request: number;
    response: string[];
  };

  // API Proxy
  'api:fetch': {
    request: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    };
    response: any;
  };
  'api:stream': {
    request: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      requestId: string;
    };
    response: any;
  };
  'api:stream:cancel': {
    request: string;
    response: boolean;
  };
}

export type IPCChannel = keyof IPCHandlers;
