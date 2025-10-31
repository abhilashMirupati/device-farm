import getPort from 'get-port';
import { ISessionCapability } from './interfaces/ISessionCapability';
import _ from 'lodash';
import { IDevice } from './interfaces/IDevice';
import { prisma } from './prisma';
import { DevicePlugin } from './plugin';
import log from './logger';
import { updatedAllocatedDevice } from './data-service/device-service';
import { getFreePort } from './helpers';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';

export enum DEVICE_FARM_CAPABILITIES {
  BUILD_NAME = 'build',
  SESSION_NAME = 'name',
  VIDEO_RECORDING = 'recordVideo',
  VIDEO_RESOLUTION = 'videoResolution',
  VIDEO_TIME_LIMIT = 'videoTimeLimit',
  LIVE_VIDEO = 'liveVideo',
  SCREENSHOT_ON_FAILURE = 'screenshotOnFailure',
  SCREENSHOT_ON_ALL = 'screenshotOnAll',
  DEVICE_FARM_OPTIONS = 'df:options',
  DEVICE_TIMEOUT = 'deviceAvailabilityTimeout',
  DEVICE_QUERY_INTERVAL = 'deviceRetryInterval',
  iPHONEONLY = 'iPhoneOnly',
  iPADONLY = 'iPadOnly',
  UDIDS = 'udids',
  MIN_SDK = 'minSDK',
  MAX_SDK = 'maxSDK',
  FILTER_BY_HOST = 'filterByHost',
  SAVE_DEVICE_LOGS = 'saveDeviceLogs',
  TAGS = 'tags',
}

function isCapabilityAlreadyPresent(caps: ISessionCapability, capabilityName: string) {
  return _.has(caps.alwaysMatch, capabilityName) || _.has(caps.firstMatch[0], capabilityName);
}

function deleteAlwaysMatch(caps: ISessionCapability, capabilityName: string) {
  if (_.has(caps.alwaysMatch, capabilityName)) delete caps.alwaysMatch[capabilityName];
}

async function findAppPath(caps: any) {
  const mergedCaps = Object.assign({}, caps.firstMatch ? caps.firstMatch[0] : {}, caps.alwaysMatch);
  const fileName = mergedCaps['appium:app'];
  if (fileName?.startsWith('file')) {
    const appInfo: any = await prisma.appInformation.findFirst({
      where: { uploadedFileName: fileName as string },
    });
    return `${DevicePlugin.serverUrl}${appInfo?.path}`;
  } else {
    return fileName;
  }
}
export async function androidCapabilities(
  caps: ISessionCapability,
  freeDevice: IDevice,
  options: { liveVideo: boolean; portRange?: string },
) {
  caps.firstMatch[0] = caps.firstMatch[0] || {};
  caps.firstMatch[0]['appium:app'] = await findAppPath(caps);
  caps.firstMatch[0]['appium:udid'] = freeDevice.udid;
  caps.firstMatch[0]['appium:systemPort'] = await getFreePort(options.portRange);
  caps.firstMatch[0]['appium:chromeDriverPort'] = await getPort();
  caps.firstMatch[0]['appium:adbRemoteHost'] = freeDevice.adbRemoteHost;
  caps.firstMatch[0]['appium:adbPort'] = freeDevice.adbPort;
  if (freeDevice.chromeDriverPath)
    caps.firstMatch[0]['appium:chromedriverExecutable'] = freeDevice.chromeDriverPath;
  if (!isCapabilityAlreadyPresent(caps, 'appium:mjpegServerPort')) {
    caps.firstMatch[0]['appium:mjpegServerPort'] = options.liveVideo
      ? await getFreePort(options.portRange)
      : undefined;
  }
  if (!options.liveVideo) {
    deleteAlwaysMatch(caps, 'appium:mjpegServerPort');
  }
  deleteAlwaysMatch(caps, 'appium:udid');
  deleteAlwaysMatch(caps, 'appium:systemPort');
  deleteAlwaysMatch(caps, 'appium:chromeDriverPort');
  deleteAlwaysMatch(caps, 'appium:adbRemoteHost');
  deleteAlwaysMatch(caps, 'appium:adbPort');
  deleteAlwaysMatch(caps, 'appium:app');
}

export async function iOSCapabilities(
  caps: ISessionCapability,
  freeDevice: IDevice,
  options: {
    liveVideo: boolean;
    portRange?: string;
  },
) {
  if (!process.env.GO_IOS) {
    freeDevice.mjpegServerPort = options.liveVideo
      ? await getFreePort(options.portRange)
      : undefined;
  }

  caps.firstMatch[0] = caps.firstMatch[0] || {};
  caps.firstMatch[0]['appium:app'] = await findAppPath(caps);
  caps.firstMatch[0]['appium:udid'] = freeDevice.udid;
  caps.firstMatch[0]['appium:deviceName'] = freeDevice.name;
  caps.firstMatch[0]['appium:platformVersion'] = freeDevice.sdk;
  caps.firstMatch[0]['appium:mjpegServerPort'] = freeDevice.mjpegServerPort;
  caps.firstMatch[0]['appium:wdaLocalPort'] = freeDevice.wdaLocalPort = await getFreePort(
    options.portRange,
  );
  if (freeDevice.realDevice && !caps.firstMatch[0]['df:skipReport']) {
    log.info(
      `[WDA Setup] Starting WDA setup for device: ${freeDevice.udid}, platform: ${freeDevice.platform}, skipReport=${Boolean(
        caps.firstMatch[0]['df:skipReport'],
      )}`,
    );

    const hasCustomWDAUrl = Boolean(
      caps.alwaysMatch?.['appium:webDriverAgentUrl'] || caps.firstMatch[0]['appium:webDriverAgentUrl'],
    );
    const derivedDataPath =
      caps.alwaysMatch?.['appium:derivedDataPath'] ?? caps.firstMatch[0]['appium:derivedDataPath'];

    if (derivedDataPath) {
      freeDevice.derivedDataPath = derivedDataPath;
      log.info(`[WDA Setup] Using derivedDataPath from capabilities: ${derivedDataPath}`);
    } else {
      log.debug('[WDA Setup] No derivedDataPath capability provided; xcuitest will use the default location.');
    }

    const goIOSRaw = process.env.GO_IOS?.trim();
    const goIOSPath = goIOSRaw?.length ? goIOSRaw : undefined;
    let goIOSAvailable = false;

    if (goIOSPath) {
      if (existsSync(goIOSPath)) {
        goIOSAvailable = true;
        log.info('[WDA Setup] GO_IOS environment variable detected and path validated.');
        log.debug(`[WDA Setup] GO_IOS path: ${goIOSPath}`);
      } else {
        log.error(`[WDA Setup] GO_IOS path invalid: ${goIOSPath}.`);
        log.warn('[WDA Setup] GO_IOS will be ignored for this session. Falling back to database or dynamic WDA build.');
      }
    } else {
      log.debug('[WDA Setup] GO_IOS environment variable not set.');
    }

    const wdaFileName = freeDevice.platform === 'tvos' ? 'wda-resign_tvos.ipa' : 'wda-resign.ipa';
    let wdaInfo: { appBundleId: string } | null = null;

    try {
      if (goIOSAvailable) {
        log.debug('[WDA Setup] Skipping WDA database lookup because GO_IOS mode is active.');
      } else {
        log.debug(`[WDA Setup] Looking for WDA file: ${wdaFileName} in database`);
        wdaInfo = await prisma.appInformation.findFirst({
          where: { fileName: wdaFileName },
        });
        log.info(`[WDA Setup] Database lookup result: ${wdaInfo ? 'Found' : 'Not found'}`);
      }

      if (goIOSAvailable && !hasCustomWDAUrl) {
        log.info(`[WDA Setup] Using GO_IOS mode - Setting webDriverAgentUrl for device ${freeDevice.udid}`);
        log.debug(
          `[WDA Setup] webDriverAgentHost: ${freeDevice.webDriverAgentHost}, wdaLocalPort: ${freeDevice.wdaLocalPort}`,
        );

        caps.firstMatch[0]['appium:webDriverAgentUrl'] =
          freeDevice.webDriverAgentUrl = `${freeDevice.webDriverAgentHost}:${freeDevice.wdaLocalPort}`;
        delete caps.firstMatch[0]['appium:wdaLocalPort'];
        delete caps.firstMatch[0]['appium:usePreinstalledWDA'];
        delete caps.firstMatch[0]['appium:updatedWDABundleId'];
        delete caps.firstMatch[0]['appium:updatedWDABundleIdSuffix'];

        log.info(`[WDA Setup] Successfully set webDriverAgentUrl: ${freeDevice.webDriverAgentUrl}`);
      } else if (goIOSAvailable && hasCustomWDAUrl) {
        log.info('[WDA Setup] GO_IOS is configured but webDriverAgentUrl capability already provided. Leaving it untouched.');
      } else if (wdaInfo) {
        log.info(`[WDA Setup] Using prebuilt WDA mode for device ${freeDevice.udid}`);
        log.debug(`[WDA Setup] Bundle ID: ${wdaInfo.appBundleId}`);

        caps.firstMatch[0]['appium:usePreinstalledWDA'] = true;
        caps.firstMatch[0]['appium:updatedWDABundleId'] = wdaInfo.appBundleId;
        caps.firstMatch[0]['appium:updatedWDABundleIdSuffix'] = '';

        log.info(`[WDA Setup] Successfully configured preinstalled WDA with bundleId: ${wdaInfo.appBundleId}`);
      } else {
        const derivedDataMessage = derivedDataPath
          ? `WDA will be built inside: ${derivedDataPath}`
          : 'WDA will be built using Xcode\'s default DerivedData location.';
        log.warn(
          `[WDA Setup] Warning: no WDA preconfiguration available - wdaInfo: ${wdaInfo ? 'exists' : 'null'}, GO_IOS: ${
            goIOSAvailable ? 'configured' : 'not set'
          }, custom URL: ${hasCustomWDAUrl ? 'provided' : 'not provided'}.`,
        );
        log.info(`[WDA Setup] ${derivedDataMessage}`);

        const xcodeCheck = checkXcodeAvailability();
        if (xcodeCheck.available) {
          log.info(`[WDA Setup] Xcode detected. Derived data base path: ${xcodeCheck.message}`);
        } else {
          log.warn(
            `[WDA Setup] ${xcodeCheck.message}. Install Xcode (with command line tools) or configure GO_IOS to avoid build failures.`,
          );
        }
      }
    } catch (error: any) {
      log.error(`[WDA Setup] Error during WDA setup for device ${freeDevice.udid}:`);
      log.error(`[WDA Setup] Error message: ${error.message}`);
      log.error(`[WDA Setup] Error stack: ${error.stack}`);
      throw error; // Re-throw to ensure error is not silently swallowed
    }
  }

  const deleteMatch = [
    'appium:derivedDataPath',
    'appium:platformVersion',
    'appium:wdaLocalPort',
    'appium:mjpegServerPort',
    'appium:udid',
    'appium:deviceName',
    'appium:app',
  ];

  deleteMatch.push('appium:usePreinstalledWDA', 'appium:updatedWDABundleId', 'appium:updatedWDABundleIdSuffix');

  if (!options.liveVideo) {
    deleteMatch.push('appium:mjpegServerPort');
  }
  deleteMatch.forEach((value) => deleteAlwaysMatch(caps, value));
  await updatedAllocatedDevice(freeDevice, {
    wdaLocalPort: freeDevice.wdaLocalPort,
    mjpegServerPort: freeDevice.mjpegServerPort,
    webDriverAgentUrl: freeDevice.webDriverAgentUrl,
  });
}

function checkXcodeAvailability(): { available: boolean; message: string } {
  if (process.platform !== 'darwin') {
    return {
      available: false,
      message: `Xcode not detected on ${process.platform}. macOS with Xcode is required for dynamic WDA builds`,
    };
  }

  try {
    const result = spawnSync('xcode-select', ['-p'], { encoding: 'utf-8' });
    if (result.status === 0) {
      const location = (result.stdout || result.stderr || '').trim();
      return {
        available: true,
        message: location || 'xcode-select reported an empty developer directory',
      };
    }
    const errorText = (result.stderr || result.stdout || '').trim();
    return {
      available: false,
      message: errorText || 'xcode-select -p exited with a non-zero status',
    };
  } catch (error: any) {
    return {
      available: false,
      message: `xcode-select check failed: ${error.message}`,
    };
  }
}

export function getDeviceFarmCapabilities(caps: ISessionCapability) {
  const mergedCapabilites = Object.assign({}, caps.firstMatch[0], caps.alwaysMatch);
  const deviceFarmOptions = mergedCapabilites[DEVICE_FARM_CAPABILITIES.DEVICE_FARM_OPTIONS] || {};

  // Pick all capabilities that starts with df: and store it as a separate object
  const individualCapabilities = Object.keys(mergedCapabilites)
    .filter((key) => key.toLowerCase().trim().startsWith('df:'))
    .reduce(
      (acc: Record<string, any>, originalkey: string) => {
        const strippedKey = originalkey.split(':')[1];
        acc[strippedKey] = mergedCapabilites[originalkey];
        return acc;
      },
      {} as Record<string, any>,
    );
  return _.merge(deviceFarmOptions, individualCapabilities);
}
