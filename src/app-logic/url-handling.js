/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
import queryString from 'query-string';
import {
  stringifyCommittedRanges,
  parseCommittedRanges,
} from '../profile-logic/committed-ranges';
import {
  stringifyTransforms,
  parseTransforms,
} from '../profile-logic/transforms';
import { assertExhaustiveCheck, toValidTabSlug } from '../utils/flow';
import { oneLine } from 'common-tags';
import type { UrlState } from '../types/state';
import type { DataSource } from '../types/actions';
import type { Pid } from '../types/profile';
import type { TrackIndex } from '../types/profile-derived';

export const CURRENT_URL_VERSION = 3;

function getDataSourceDirs(
  urlState: UrlState
): [] | [DataSource] | [DataSource, string] {
  const { dataSource } = urlState;
  switch (dataSource) {
    case 'from-addon':
      return ['from-addon'];
    case 'from-file':
      return ['from-file'];
    case 'local':
      return ['local', urlState.hash];
    case 'public':
      return ['public', urlState.hash];
    case 'from-url':
      return ['from-url', encodeURIComponent(urlState.profileUrl)];
    case 'compare':
      return ['compare'];
    case 'none':
      return [];
    default:
      throw assertExhaustiveCheck(dataSource);
  }
}

// "null | void" in the query objects are flags which map to true for null, and false
// for void. False flags do not show up the URL.
type BaseQuery = {|
  range?: string, //
  thread?: string, // "3"
  globalTrackOrder?: string, // "3-2-0-1"
  hiddenGlobalTracks?: string, // "0-1"
  hiddenLocalTracksByPid?: string,
  localTrackOrderByPid?: string,
  file?: string, // Path into a zip file.
  react_perf?: null, // Flag to activate react's UserTimings profiler.
  transforms?: string,
  timelineType?: string,
  // The following values are legacy, and will be converted to track-based values. These
  // value can't be upgraded using the typical URL upgrading process, as the full profile
  // must be fetched to compute the tracks.
  threadOrder?: string, // "3-2-0-1"
  hiddenThreads?: string, // "0-1"
  profiles?: string[],
|};

type CallTreeQuery = {|
  ...BaseQuery,
  search?: string, // "js::RunScript"
  invertCallstack?: null | void,
  implementation?: string,
|};

type MarkersQuery = {|
  ...BaseQuery,
  markerSearch?: string, // "DOMEvent"
|};

type StackChartQuery = {|
  ...BaseQuery,
  search?: string, // "js::RunScript"
  invertCallstack?: null | void,
  implementation?: string,
|};

type JsTracerQuery = {|
  ...BaseQuery,
  summary?: null | void,
|};

// Use object type spread in the definition of Query rather than unions, so that they
// are really easy to manipulate. This permissive definition makes it easy to not have
// to refine the type down to the individual query types when working with them.
type Query = {
  ...CallTreeQuery,
  ...MarkersQuery,
  ...StackChartQuery,
  ...JsTracerQuery,
};

type UrlObject = {|
  pathParts: string[],
  query: Query,
|};

/**
 * Take the UrlState and map it into a serializable UrlObject, that represents the
 * target URL.
 */
export function urlStateToUrlObject(urlState: UrlState): UrlObject {
  const { dataSource } = urlState;
  if (dataSource === 'none') {
    return {
      pathParts: [],
      query: {},
    };
  }

  // Special handling for CompareHome: we shouldn't append the default
  // parameters when the user is on the comparison form.
  if (dataSource === 'compare' && urlState.profilesToCompare === null) {
    return {
      pathParts: ['compare'],
      query: {},
    };
  }

  const dataSourceDirs = getDataSourceDirs(urlState);
  const pathParts = [...dataSourceDirs, urlState.selectedTab];
  const { selectedThread } = urlState.profileSpecific;

  // Start with the query parameters that are shown regardless of the active tab.
  const query: Object = {
    range:
      stringifyCommittedRanges(urlState.profileSpecific.committedRanges) ||
      undefined,
    thread: selectedThread === null ? undefined : selectedThread,
    globalTrackOrder:
      urlState.profileSpecific.globalTrackOrder.join('-') || undefined,
    file: urlState.pathInZipFile || undefined,
    profiles: urlState.profilesToCompare || undefined,
    v: CURRENT_URL_VERSION,
  };

  // Add the parameter hiddenGlobalTracks only when needed.
  if (urlState.profileSpecific.hiddenGlobalTracks.size > 0) {
    query.hiddenGlobalTracks = [
      ...urlState.profileSpecific.hiddenGlobalTracks,
    ].join('-');
  }

  let hiddenLocalTracksByPid = '';
  for (const [pid, tracks] of urlState.profileSpecific.hiddenLocalTracksByPid) {
    if (tracks.size > 0) {
      hiddenLocalTracksByPid += [pid, ...tracks].join('-') + '~';
    }
  }
  if (hiddenLocalTracksByPid.length > 0) {
    // Only add to the query string if something was actually hidden.
    // Also, slice off the last '~'.
    query.hiddenLocalTracksByPid = hiddenLocalTracksByPid.slice(0, -1);
  }

  if (urlState.profileSpecific.timelineType === 'stack') {
    // The default is the category view, so only add it to the URL if it's the
    // stack view.
    query.timelineType = 'stack';
  }

  const localTrackOrderByPid = '';
  for (const [pid, trackOrder] of urlState.profileSpecific
    .localTrackOrderByPid) {
    if (trackOrder.length > 0) {
      query.localTrackOrderByPid +=
        `${String(pid)}-` + trackOrder.join('-') + '~';
    }
  }
  query.localTrackOrderByPid = localTrackOrderByPid || undefined;

  // Depending on which tab is active, also show tab-specific query parameters.
  const selectedTab = urlState.selectedTab;
  switch (selectedTab) {
    case 'stack-chart':
    case 'flame-graph':
    case 'calltree': {
      query.search = urlState.profileSpecific.callTreeSearchString || undefined;
      query.invertCallstack = urlState.profileSpecific.invertCallstack
        ? null
        : undefined;
      query.implementation =
        urlState.profileSpecific.implementation === 'combined'
          ? undefined
          : urlState.profileSpecific.implementation;
      if (selectedThread !== null) {
        query.transforms =
          stringifyTransforms(
            urlState.profileSpecific.transforms[selectedThread]
          ) || undefined;
      }
      break;
    }
    case 'marker-table':
    case 'marker-chart':
      query.markerSearch =
        urlState.profileSpecific.markersSearchString || undefined;
      break;
    case 'network-chart':
      query.networkSearch =
        urlState.profileSpecific.networkSearchString || undefined;
      break;
    case 'js-tracer':
      // `null` adds the parameter to the query, while `undefined` doesn't.
      query.summary = urlState.profileSpecific.showJsTracerSummary
        ? null
        : undefined;
      break;
    default:
      assertExhaustiveCheck(selectedTab);
  }
  return { query, pathParts };
}

export function urlFromState(urlState: UrlState): string {
  const { pathParts, query } = urlStateToUrlObject(urlState);
  const { dataSource } = urlState;
  if (dataSource === 'none') {
    return '/';
  }
  const pathname =
    pathParts.length === 0 ? '/' : '/' + pathParts.join('/') + '/';

  const qString = queryString.stringify(query, {
    arrayFormat: 'bracket', // This uses parameters with brackets for arrays.
  });
  return pathname + (qString ? '?' + qString : '');
}

function getDataSourceFromPathParts(pathParts: string[]): DataSource {
  const str = pathParts[0] || 'none';
  // With this switch, flow is able to understand that we return a valid value
  switch (str) {
    case 'none':
    case 'from-addon':
    case 'from-file':
    case 'local':
    case 'public':
    case 'from-url':
    case 'compare':
      return str;
    default:
      throw new Error(`Unexpected data source ${str}`);
  }
}

/**
 * Define only the properties of the window.location object that the function uses
 * so that it can be mocked in tests.
 */
type Location = {
  pathname: string,
  search: string,
  hash: string,
};

export function stateFromLocation(location: Location): UrlState {
  const { pathname, query } = upgradeLocationToCurrentVersion({
    pathname: location.pathname,
    hash: location.hash,
    query: queryString.parse(location.search.substr(1), {
      arrayFormat: 'bracket', // This uses parameters with brackets for arrays.
    }),
  });

  const pathParts = pathname.split('/').filter(d => d);
  const dataSource = getDataSourceFromPathParts(pathParts);
  const selectedThread = query.thread !== undefined ? +query.thread : null;

  // https://profiler.firefox.com/public/{hash}/calltree/
  const hasProfileHash = ['local', 'public'].includes(dataSource);

  // https://profiler.firefox.com/from-url/{url}/calltree/
  const hasProfileUrl = ['from-url'].includes(dataSource);

  // The selected tab is the last path part in the URL.
  const selectedTabPathPart = hasProfileHash || hasProfileUrl ? 2 : 1;

  let implementation = 'combined';
  // Don't trust the implementation values from the user. Make sure it conforms
  // to known values.
  if (query.implementation === 'js' || query.implementation === 'cpp') {
    implementation = query.implementation;
  }

  const transforms = {};
  if (selectedThread !== null) {
    transforms[selectedThread] = query.transforms
      ? parseTransforms(query.transforms)
      : [];
  }

  return {
    dataSource,
    hash: hasProfileHash ? pathParts[1] : '',
    profileUrl: hasProfileUrl ? decodeURIComponent(pathParts[1]) : '',
    profilesToCompare: query.profiles || null,
    selectedTab: toValidTabSlug(pathParts[selectedTabPathPart]) || 'calltree',
    pathInZipFile: query.file || null,
    profileSpecific: {
      implementation,
      invertCallstack: query.invertCallstack !== undefined,
      showJsTracerSummary: query.summary !== undefined,
      committedRanges: query.range ? parseCommittedRanges(query.range) : [],
      selectedThread: selectedThread,
      callTreeSearchString: query.search || '',
      globalTrackOrder: query.globalTrackOrder
        ? query.globalTrackOrder.split('-').map(index => Number(index))
        : [],
      hiddenGlobalTracks: query.hiddenGlobalTracks
        ? new Set(
            query.hiddenGlobalTracks.split('-').map(index => Number(index))
          )
        : new Set(),
      hiddenLocalTracksByPid: query.hiddenLocalTracksByPid
        ? parseHiddenTracks(query.hiddenLocalTracksByPid)
        : new Map(),
      localTrackOrderByPid: query.localTrackOrderByPid
        ? parseLocalTrackOrder(query.localTrackOrderByPid)
        : new Map(),
      markersSearchString: query.markerSearch || '',
      networkSearchString: query.networkSearch || '',
      transforms,
      timelineType: query.timelineType === 'stack' ? 'stack' : 'category',
      legacyThreadOrder: query.threadOrder
        ? query.threadOrder.split('-').map(index => Number(index))
        : null,
      legacyHiddenThreads: query.hiddenThreads
        ? query.hiddenThreads.split('-').map(index => Number(index))
        : null,
    },
  };
}

/**
 * Hidden tracks must have the track indexes plus the associated PID.
 *
 * Syntax: Pid-TrackIndex-TrackIndex~Pid-TrackIndex
 * Example: 124553-0-3~124554-1
 */
function parseHiddenTracks(rawText: string): Map<Pid, Set<TrackIndex>> {
  const hiddenLocalTracksByPid = new Map();

  for (const stringPart of rawText.split('~')) {
    const [pidString, ...indexStrings] = stringPart.split('-');
    if (indexStrings.length === 0) {
      continue;
    }
    const pid = Number(pidString);
    const indexes = indexStrings.map(string => Number(string));
    if (!isNaN(pid) && indexes.every(n => !isNaN(n))) {
      hiddenLocalTracksByPid.set(pid, new Set(indexes));
    }
  }
  return hiddenLocalTracksByPid;
}

/**
 * Local tracks must have their track order associated by PID.
 *
 * Syntax: Pid-TrackIndex-TrackIndex~Pid-TrackIndex
 * Example: 124553-0-3~124554-1
 */
function parseLocalTrackOrder(rawText: string): Map<Pid, TrackIndex[]> {
  const localTrackOrderByPid = new Map();

  for (const stringPart of rawText.split('~')) {
    const [pidString, ...indexStrings] = stringPart.split('-');
    if (indexStrings.length <= 1) {
      // There is no order to determine, let the URL validation create the
      // default value.
      continue;
    }
    const pid = Number(pidString);
    const indexes = indexStrings.map(string => Number(string));
    if (!isNaN(pid) && indexes.every(n => !isNaN(n))) {
      localTrackOrderByPid.set(pid, indexes);
    }
  }

  return localTrackOrderByPid;
}

type ProcessedLocation = {|
  pathname: string,
  hash: string,
  query: Query,
|};

type ProcessedLocationBeforeUpgrade = {|
  ...ProcessedLocation,
  query: Object,
|};

export function upgradeLocationToCurrentVersion(
  processedLocation: ProcessedLocationBeforeUpgrade
): ProcessedLocation {
  const urlVersion = +processedLocation.query.v || 0;
  if (urlVersion === CURRENT_URL_VERSION) {
    return processedLocation;
  }

  if (urlVersion > CURRENT_URL_VERSION) {
    throw new Error(
      `Unable to parse a url of version ${urlVersion}, most likely profiler.firefox.com needs to be refreshed. ` +
        `The most recent version understood by this version of profiler.firefox.com is version ${CURRENT_URL_VERSION}.\n` +
        'You can try refreshing this page in case profiler.firefox.com has updated in the meantime.'
    );
  }
  // Convert to CURRENT_URL_VERSION, one step at a time.
  for (
    let destVersion = urlVersion;
    destVersion <= CURRENT_URL_VERSION;
    destVersion++
  ) {
    if (destVersion in _upgraders) {
      _upgraders[destVersion](processedLocation);
    }
  }

  processedLocation.query.v = CURRENT_URL_VERSION;
  return processedLocation;
}

// _upgraders[i] converts from version i - 1 to version i.
// Every "upgrader" takes the processedLocation as its single argument and mutates it.
/* eslint-disable no-useless-computed-key */
const _upgraders = {
  [0]: (processedLocation: ProcessedLocationBeforeUpgrade) => {
    // Version 1 is the first versioned url.

    // If the pathname is '/', this could be a very old URL that has its information
    // stored in the hash.
    if (processedLocation.pathname === '/') {
      const legacyQuery = Object.assign(
        {},
        processedLocation.query,
        queryString.parse(processedLocation.hash)
      );
      if ('report' in legacyQuery) {
        // Put the report into the pathname.
        processedLocation.pathname = `/public/${legacyQuery.report}/calltree/`;
        processedLocation.hash = '';
        processedLocation.query = {};
      }
    }

    // Instead of implementation filters, we used to have jsOnly flags.
    if (processedLocation.query.jsOnly !== undefined) {
      // Support the old URL structure that had a jsOnly flag.
      delete processedLocation.query.jsOnly;
      processedLocation.query.implementation = 'js';
    }
  },
  [1]: (processedLocation: ProcessedLocationBeforeUpgrade) => {
    // The transform stack was added. Convert the callTreeFilters into the new
    // transforms format.
    if (processedLocation.query.callTreeFilters) {
      // Before: "callTreeFilters=prefix-0KV4KV5KV61KV7KV8K~postfixjs-xFFpUMl"
      // After: "transforms=f-combined-0KV4KV5KV61KV7KV8K~f-js-xFFpUMl-i"
      processedLocation.query.transforms = processedLocation.query.callTreeFilters
        .split('~')
        .map(s => {
          const [type, val] = s.split('-');
          switch (type) {
            case 'prefix':
              return `f-combined-${val}`;
            case 'prefixjs':
              return `f-js-${val}`;
            case 'postfix':
              return `f-combined-${val}-i`;
            case 'postfixjs':
              return `f-js-${val}-i`;
            default:
              return undefined;
          }
        })
        .filter(f => f)
        .join('~');
      delete processedLocation.query.callTreeFilters;
    }
  },
  [2]: (processedLocation: ProcessedLocationBeforeUpgrade) => {
    // Map the tab "timeline" to "stack-chart".
    // Map the tab "markers" to "marker-table".
    processedLocation.pathname = processedLocation.pathname
      // Given:    /public/e71ce9584da34298627fb66ac7f2f245ba5edbf5/timeline/
      // Matches:  $1^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
      .replace(/^(\/[^/]+\/[^/]+)\/timeline\/?/, '$1/stack-chart/')
      // Given:    /public/e71ce9584da34298627fb66ac7f2f245ba5edbf5/markers/
      // Matches:  $1^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
      .replace(/^(\/[^/]+\/[^/]+)\/markers\/?/, '$1/marker-table/');
  },
  [3]: (processedLocation: ProcessedLocationBeforeUpgrade) => {
    const { query } = processedLocation;
    // Removed "Hide platform details" checkbox from the stack chart.
    if ('hidePlatformDetails' in query) {
      delete query.hidePlatformDetails;
      query.implementation = 'js';
    }
  },
};

if (Object.keys(_upgraders).length - 1 !== CURRENT_URL_VERSION) {
  throw new Error(oneLine`
    CURRENT_URL_VERSION does not match the number of URL upgraders. If you added a
    new upgrader, make sure and bump the CURRENT_URL_VERSION variable.
  `);
}
