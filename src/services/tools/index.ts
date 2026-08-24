import ToolRegistry from '../ToolRegistry';
import type { Tool } from './types';

import { advancedTools } from './advanced';
import { autonomyTools } from './autonomy';
import { brainCloudTools } from './brainCloud';
import { browserAutomationTools } from './browserAutomation';
import { buildTools } from './build';
import { calendarTools } from './calendar';
import { cameraTools } from './camera';
import { clipboardTools } from './clipboard';
import { connectorTools } from './connectors';
import { controlTools } from './controls';
import { codeTools } from './code';
import { coreTools } from './core';
import { createPdfTool } from './createPdf';
import { customInstructionTools } from './customInstructions';
import { databaseTools } from './database';
import { deviceTools } from './device';
import { deviceIntegrationTools } from './deviceIntegration';
import { documentTools } from './documents';
import { emailTools } from './email';
import { filegenTools } from './filegen';
import { filesystemTools } from './filesystem';
import { fileTools } from './filetool';
import { gatewayTools } from './gateway';
import { gatewayDaemonTools } from './gatewayDaemon';
import { geolocationTools } from './geolocation';
import { hapticsTools } from './haptics';
import { identityTools } from './identity';
import { intelligenceTools } from './intelligence';
import { locationTools } from './location';
import { longRunningTools } from './longRunning';
import { mcpTools } from './mcp';
import { mediaAccessTools } from './mediaAccess';
import { memoryTools } from './memory';
import { messagingTools } from './messaging';
import { networkTools } from './network';
import { neuraTools } from './neura';
import { noteTools } from './notes';
import { notificationTools } from './notifications';
import { personalEnhancedTools } from './personalEnhanced';
import { personalTools } from './personal';
import { pluginTools } from './plugin';
import { powerTools } from './powerTools';
import { providerHealthTools } from './providerHealth';
import { ragTools } from './rag';
import { pdfTools } from './readPdf';
import { requestApiKeyTools } from './requestApiKey';
import { sandboxTools } from './sandbox';
import { scheduledTaskTools } from './scheduledTasks';
import { securityTools } from './security';
import { sessionTools } from './session';
import { shareTools } from './share';
import { skillTools } from './skills';
import { smartHomeTools } from './smartHome';
import { socialMediaTools } from './socialMedia';
import { sshTools } from './ssh';
import { taskTools } from './tasks';
import { telegramTools } from './telegram';
import { terminalTools } from './terminal';
import { webSearchTools } from './webSearch';
import { websocketTools } from './websocket';
import { whatsAppBridgeTools } from './whatsappBridge';
import { systemControlTools } from './systemControl';
import { unimindTools } from './unimind';

export function registerAllTools(): void {
  const allToolsLists: (Tool | Tool[])[] = [
    advancedTools,
    autonomyTools,
    brainCloudTools,
    browserAutomationTools,
    buildTools,
    calendarTools,
    cameraTools,
    clipboardTools,
    connectorTools,
    controlTools,
    codeTools,
    coreTools,
    createPdfTool,
    customInstructionTools,
    databaseTools,
    deviceTools,
    deviceIntegrationTools,
    documentTools,
    emailTools,
    filegenTools,
    filesystemTools,
    fileTools,
    gatewayTools,
    gatewayDaemonTools,
    geolocationTools,
    hapticsTools,
    identityTools,
    intelligenceTools,
    locationTools,
    longRunningTools,
    mcpTools,
    mediaAccessTools,
    memoryTools,
    messagingTools,
    networkTools,
    neuraTools,
    noteTools,
    notificationTools,
    personalEnhancedTools,
    personalTools,
    pluginTools,
    powerTools,
    providerHealthTools,
    ragTools,
    pdfTools,
    requestApiKeyTools,
    sandboxTools,
    scheduledTaskTools,
    securityTools,
    sessionTools,
    shareTools,
    skillTools,
    smartHomeTools,
    socialMediaTools,
    sshTools,
    taskTools,
    telegramTools,
    terminalTools,
    webSearchTools,
    websocketTools,
    whatsAppBridgeTools,
    systemControlTools,
    unimindTools,
  ];

  for (const item of allToolsLists) {
    if (Array.isArray(item)) {
      for (const tool of item) {
        if (tool && tool.id) {
          ToolRegistry.register(tool);
        }
      }
    } else if (item && item.id) {
      ToolRegistry.register(item);
    }
  }

}
