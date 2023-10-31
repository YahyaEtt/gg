import namedQueue from 'named-queue';
import * as options from './options.js';
import * as realdebrid from './realdebrid.js';
import * as premiumize from './premiumize.js';
import * as alldebrid from './alldebrid.js';
import * as debridlink from './debridlink.js';
import * as offcloud from './offcloud.js';
import * as putio from './putio.js';
import StaticResponse from './static.js';
import { cacheWrapResolvedUrl } from '../lib/cache.js';
import { timeout } from '../lib/promises.js';
import { BadTokenError, streamFilename, AccessDeniedError, enrichMeta } from './mochHelper.js';
import { isStaticUrl } from './static.js';

const RESOLVE_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const MIN_API_KEY_SYMBOLS = 15;
const TOKEN_BLACKLIST = [];
export const MochOptions = {
  realdebrid: {
    key: 'realdebrid',
    instance: realdebrid,
    name: "RealDebrid",
    shortName: 'RD',
    catalog: true
  },
  premiumize: {
    key: 'premiumize',
    instance: premiumize,
    name: 'Premiumize',
    shortName: 'PM',
    catalog: true
  },
  alldebrid: {
    key: 'alldebrid',
    instance: alldebrid,
    name: 'AllDebrid',
    shortName: 'AD',
    catalog: true
  },
  debridlink: {
    key: 'debridlink',
    instance: debridlink,
    name: 'DebridLink',
    shortName: 'DL',
    catalog: true
  },
  offcloud: {
    key: 'offcloud',
    instance: offcloud,
    name: 'Offcloud',
    shortName: 'OC',
    catalog: true
  },
  putio: {
    key: 'putio',
    instance: putio,
    name: 'Put.io',
    shortName: 'Putio',
    catalog: false
  }
};

const unrestrictQueue = new namedQueue((task, callback) => task.method()
    .then(result => callback(false, result))
    .catch((error => callback(error))), 20);

export function hasMochConfigured(config) {
  return Object.keys(MochOptions).find(moch => config?.[moch])
}

export async function applyMochs(streams, config) {
  if (!streams?.length || !hasMochConfigured(config)) {
    return streams;
  }
  return Promise.all(Object.keys(config)
      .filter(configKey => MochOptions[configKey])
      .map(configKey => MochOptions[configKey])
      .map(moch => {
        if (isInvalidToken(config[moch.key], moch.key)) {
          return { moch, error: BadTokenError };
        }
        return moch.instance.getCachedStreams(streams, config[moch.key])
            .then(mochStreams => ({ moch, mochStreams }))
            .catch(error => {
              if (error === BadTokenError) {
                blackListToken(config[moch.key], moch.key);
              }
              return { moch, error };
            })
      }))
      .then(results => processMochResults(streams, config, results));
}

export async function resolve(parameters) {
  const moch = MochOptions[parameters.mochKey];
  if (!moch) {
    return Promise.reject(new Error(`Not a valid moch provider: ${parameters.mochKey}`));
  }

  if (!parameters.apiKey || !parameters.infoHash || !parameters.cachedEntryInfo) {
    return Promise.reject(new Error("No valid parameters passed"));
  }
  const id = `${parameters.ip}_${parameters.mochKey}_${parameters.apiKey}_${parameters.infoHash}_${parameters.fileIndex}`;
  const method = () => timeout(RESOLVE_TIMEOUT, cacheWrapResolvedUrl(id, () => moch.instance.resolve(parameters)))
      .catch(error => {
        console.warn(error);
        return StaticResponse.FAILED_UNEXPECTED;
      })
      .then(url => isStaticUrl(url) ? `${parameters.host}/${url}` : url);
  return new Promise(((resolve, reject) => {
    unrestrictQueue.push({ id, method }, (error, result) => result ? resolve(result) : reject(error));
  }));
}

export async function getMochCatalog(mochKey, config) {
  const moch = MochOptions[mochKey];
  if (!moch) {
    return Promise.reject(new Error(`Not a valid moch provider: ${mochKey}`));
  }
  if (isInvalidToken(config[mochKey], mochKey)) {
    return Promise.reject(new Error(`Invalid API key for moch provider: ${mochKey}`));
  }
  return moch.instance.getCatalog(config[moch.key], config.skip, config.ip);
}

export async function getMochItemMeta(mochKey, itemId, config) {
  const moch = MochOptions[mochKey];
  if (!moch) {
    return Promise.reject(new Error(`Not a valid moch provider: ${mochKey}`));
  }

  return moch.instance.getItemMeta(itemId, config[moch.key], config.ip)
      .then(meta => enrichMeta(meta))
      .then(meta => {
        meta.videos
            .map(video => video.streams)
            .reduce((a, b) => a.concat(b), [])
            .filter(stream => !stream.url.startsWith('http'))
            .forEach(stream => stream.url = `${config.host}/${moch.key}/${stream.url}`)
        return meta;
      });
}

function processMochResults(streams, config, results) {
  const errorResults = results
      .map(result => errorStreamResponse(result.moch.key, result.error, config))
      .filter(errorResponse => errorResponse);
  if (errorResults.length) {
    return errorResults;
  }

  const includeTorrentLinks = options.includeTorrentLinks(config);
  const excludeDownloadLinks = options.excludeDownloadLinks(config);
  const mochResults = results.filter(result => result?.mochStreams);

  const cachedStreams = mochResults
      .reduce((resultStreams, mochResult) => populateCachedLinks(resultStreams, mochResult, config), streams);
  const resultStreams = excludeDownloadLinks ? cachedStreams : populateDownloadLinks(cachedStreams, mochResults, config);
  return includeTorrentLinks ? resultStreams : resultStreams.filter(stream => stream.url);
}

function populateCachedLinks(streams, mochResult, config) {
  return streams.map(stream => {
    const cachedEntry = stream.infoHash && mochResult.mochStreams[stream.infoHash];
    if (cachedEntry?.cached) {
      return {
        name: `[${mochResult.moch.shortName}+] ${stream.name}`,
        title: stream.title,
        url: `${config.host}/${mochResult.moch.key}/${cachedEntry.url}/${streamFilename(stream)}`,
        behaviorHints: stream.behaviorHints
      };
    }
    return stream;
  });
}

function populateDownloadLinks(streams, mochResults, config) {
  const torrentStreams = streams.filter(stream => stream.infoHash);
  const seededStreams = streams.filter(stream => !stream.title.includes('👤 0'));
  torrentStreams.forEach(stream => mochResults.forEach(mochResult => {
    const cachedEntry = mochResult.mochStreams[stream.infoHash];
    const isCached = cachedEntry?.cached;
    if (!isCached && isHealthyStreamForDebrid(seededStreams, stream)) {
      streams.push({
        name: `[${mochResult.moch.shortName} download] ${stream.name}`,
        title: stream.title,
        url: `${config.host}/${mochResult.moch.key}/${cachedEntry.url}/${streamFilename(stream)}`,
        behaviorHints: stream.behaviorHints
      })
    }
  }));
  return streams;
}

function isHealthyStreamForDebrid(streams, stream) {
  const isZeroSeeders = stream.title.includes('👤 0');
  const is4kStream = stream.name.includes('4k');
  const isNotEnoughOptions = streams.length <= 5;
  return !isZeroSeeders || is4kStream || isNotEnoughOptions;
}

function isInvalidToken(token, mochKey) {
  return token.length < MIN_API_KEY_SYMBOLS || TOKEN_BLACKLIST.includes(`${mochKey}|${token}`);
}

function blackListToken(token, mochKey) {
  const tokenKey = `${mochKey}|${token}`;
  console.log(`Blacklisting invalid token: ${tokenKey}`)
  TOKEN_BLACKLIST.push(tokenKey);
}

function errorStreamResponse(mochKey, error, config) {
  if (error === BadTokenError) {
    return {
      name: `Torrentio\n${MochOptions[mochKey].shortName} error`,
      title: `Invalid ${MochOptions[mochKey].name} ApiKey/Token!`,
      url: `${config.host}/${StaticResponse.FAILED_ACCESS}`
    };
  }
  if (error === AccessDeniedError) {
    return {
      name: `Torrentio\n${MochOptions[mochKey].shortName} error`,
      title: `Expired/invalid ${MochOptions[mochKey].name} subscription!`,
      url: `${config.host}/${StaticResponse.FAILED_ACCESS}`
    };
  }
  return undefined;
}
