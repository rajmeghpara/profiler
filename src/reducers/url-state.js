/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
import { combineReducers } from 'redux';

import type { ThreadIndex, Pid } from '../types/profile';
import type { TrackIndex } from '../types/profile-derived';
import type { StartEndRange } from '../types/units';
import type { TransformStacksPerThread } from '../types/transforms';
import type {
  DataSource,
  ImplementationFilter,
  TimelineType,
} from '../types/actions';
import type { UrlState, Reducer } from '../types/state';
import type { TabSlug } from '../app-logic/tabs-handling';

/*
 * This state file governs the state that comes from, and alters, the window
 * location. The location itself is changed in `src/components/app/UrlManager`,
 * and the computations are handled in `src/app-logic/url-handling`.
 *
 * All reducers in this state can be circumvented and the state reset
 * completely using the action `UPDATE_URL_STATE`. This action is dispatched
 * from the URL, either at the first load or when it changes when the user
 * navigates.
 * That's why the individual reducers might look incomplete at times.
 * See below the function `wrapReducerInResetter`.
 */

const dataSource: Reducer<DataSource> = (state = 'none', action) => {
  switch (action.type) {
    case 'WAITING_FOR_PROFILE_FROM_FILE':
      return 'from-file';
    case 'PROFILE_PUBLISHED':
      return 'public';
    case 'TRIGGER_LOADING_FROM_URL':
      return 'from-url';
    default:
      return state;
  }
};

const hash: Reducer<string> = (state = '', action) => {
  switch (action.type) {
    case 'PROFILE_PUBLISHED':
      return action.hash;
    default:
      return state;
  }
};

const profileUrl: Reducer<string> = (state = '', action) => {
  switch (action.type) {
    case 'TRIGGER_LOADING_FROM_URL':
      return action.profileUrl;
    default:
      return state;
  }
};

const profilesToCompare: Reducer<string[] | null> = (state = null, action) => {
  switch (action.type) {
    case 'CHANGE_PROFILES_TO_COMPARE':
      return action.profiles;
    default:
      return state;
  }
};

const selectedTab: Reducer<TabSlug> = (state = 'calltree', action) => {
  switch (action.type) {
    case 'CHANGE_SELECTED_TAB':
    case 'SELECT_TRACK':
      return action.selectedTab;
    default:
      return state;
  }
};

const committedRanges: Reducer<StartEndRange[]> = (state = [], action) => {
  switch (action.type) {
    case 'COMMIT_RANGE': {
      const { start, end } = action;
      return [...state, { start, end }];
    }
    case 'POP_COMMITTED_RANGES':
      return state.slice(0, action.firstPoppedFilterIndex);
    default:
      return state;
  }
};

const selectedThread: Reducer<ThreadIndex | null> = (state = null, action) => {
  switch (action.type) {
    case 'CHANGE_SELECTED_THREAD':
    case 'SELECT_TRACK':
    case 'VIEW_PROFILE':
    case 'ISOLATE_PROCESS':
    case 'ISOLATE_PROCESS_MAIN_THREAD':
    case 'HIDE_GLOBAL_TRACK':
    case 'HIDE_LOCAL_TRACK':
    case 'ISOLATE_LOCAL_TRACK':
      // Only switch to non-null selected threads.
      return (action.selectedThreadIndex: ThreadIndex);
    default:
      return state;
  }
};

const callTreeSearchString: Reducer<string> = (state = '', action) => {
  switch (action.type) {
    case 'CHANGE_CALL_TREE_SEARCH_STRING':
      return action.searchString;
    default:
      return state;
  }
};

const markersSearchString: Reducer<string> = (state = '', action) => {
  switch (action.type) {
    case 'CHANGE_MARKER_SEARCH_STRING':
      return action.searchString;
    default:
      return state;
  }
};

const networkSearchString: Reducer<string> = (state = '', action) => {
  switch (action.type) {
    case 'CHANGE_NETWORK_SEARCH_STRING':
      return action.searchString;
    default:
      return state;
  }
};

const transforms: Reducer<TransformStacksPerThread> = (state = {}, action) => {
  switch (action.type) {
    case 'VIEW_PROFILE':
      return action.transformStacks || state;
    case 'ADD_TRANSFORM_TO_STACK': {
      const { threadIndex, transform } = action;
      const transforms = state[threadIndex] || [];
      return Object.assign({}, state, {
        [threadIndex]: [...transforms, transform],
      });
    }
    case 'POP_TRANSFORMS_FROM_STACK': {
      const { threadIndex, firstPoppedFilterIndex } = action;
      const transforms = state[threadIndex] || [];
      return Object.assign({}, state, {
        [threadIndex]: transforms.slice(0, firstPoppedFilterIndex),
      });
    }
    default:
      return state;
  }
};

const timelineType: Reducer<TimelineType> = (state = 'category', action) => {
  switch (action.type) {
    case 'CHANGE_TIMELINE_TYPE':
      return action.timelineType;
    default:
      return state;
  }
};

/**
 * Represents the current filter applied to the stack frames, where it will show
 * frames only by implementation.
 */
const implementation: Reducer<ImplementationFilter> = (
  state = 'combined',
  action
) => {
  switch (action.type) {
    case 'VIEW_PROFILE':
      return action.implementationFilter || state;
    case 'CHANGE_IMPLEMENTATION_FILTER':
      return action.implementation;
    default:
      return state;
  }
};

const invertCallstack: Reducer<boolean> = (state = false, action) => {
  switch (action.type) {
    case 'CHANGE_INVERT_CALLSTACK':
      return action.invertCallstack;
    default:
      return state;
  }
};

/**
 * This state controls whether or not to show a summary view of self time, or the full
 * stack-based view of the JS tracer data.
 */
const showJsTracerSummary: Reducer<boolean> = (state = false, action) => {
  switch (action.type) {
    case 'CHANGE_SHOW_JS_TRACER_SUMMARY':
      return action.showSummary;
    default:
      return state;
  }
};

const globalTrackOrder: Reducer<TrackIndex[]> = (state = [], action) => {
  switch (action.type) {
    case 'VIEW_PROFILE':
    case 'CHANGE_GLOBAL_TRACK_ORDER':
      return action.globalTrackOrder;
    default:
      return state;
  }
};

const hiddenGlobalTracks: Reducer<Set<TrackIndex>> = (
  state = new Set(),
  action
) => {
  switch (action.type) {
    case 'VIEW_PROFILE':
    case 'ISOLATE_LOCAL_TRACK':
    case 'ISOLATE_PROCESS':
    case 'ISOLATE_PROCESS_MAIN_THREAD':
      return action.hiddenGlobalTracks;
    case 'HIDE_GLOBAL_TRACK': {
      const hiddenGlobalTracks = new Set(state);
      hiddenGlobalTracks.add(action.trackIndex);
      return hiddenGlobalTracks;
    }
    case 'SHOW_GLOBAL_TRACK': {
      const hiddenGlobalTracks = new Set(state);
      hiddenGlobalTracks.delete(action.trackIndex);
      return hiddenGlobalTracks;
    }
    default:
      return state;
  }
};

const hiddenLocalTracksByPid: Reducer<Map<Pid, Set<TrackIndex>>> = (
  state = new Map(),
  action
) => {
  switch (action.type) {
    case 'VIEW_PROFILE':
      return action.hiddenLocalTracksByPid;
    case 'HIDE_LOCAL_TRACK': {
      const hiddenLocalTracksByPid = new Map(state);
      const hiddenLocalTracks = new Set(hiddenLocalTracksByPid.get(action.pid));
      hiddenLocalTracks.add(action.trackIndex);
      hiddenLocalTracksByPid.set(action.pid, hiddenLocalTracks);
      return hiddenLocalTracksByPid;
    }
    case 'SHOW_LOCAL_TRACK': {
      const hiddenLocalTracksByPid = new Map(state);
      const hiddenLocalTracks = new Set(hiddenLocalTracksByPid.get(action.pid));
      hiddenLocalTracks.delete(action.trackIndex);
      hiddenLocalTracksByPid.set(action.pid, hiddenLocalTracks);
      return hiddenLocalTracksByPid;
    }
    case 'ISOLATE_PROCESS_MAIN_THREAD':
    case 'ISOLATE_LOCAL_TRACK': {
      const hiddenLocalTracksByPid = new Map(state);
      hiddenLocalTracksByPid.set(action.pid, action.hiddenLocalTracks);
      return hiddenLocalTracksByPid;
    }
    default:
      return state;
  }
};

const localTrackOrderByPid: Reducer<Map<Pid, TrackIndex[]>> = (
  state = new Map(),
  action
) => {
  switch (action.type) {
    case 'VIEW_PROFILE':
      return action.localTrackOrderByPid;
    case 'CHANGE_LOCAL_TRACK_ORDER': {
      const localTrackOrderByPid = new Map(state);
      localTrackOrderByPid.set(action.pid, action.localTrackOrder);
      return localTrackOrderByPid;
    }
    default:
      return state;
  }
};

const pathInZipFile: Reducer<string | null> = (state = null, action) => {
  switch (action.type) {
    // Update the URL the moment the zip file is starting to be
    // processed, not when it is viewed. The processing is async.
    case 'PROCESS_PROFILE_FROM_ZIP_FILE':
      return action.pathInZipFile ? action.pathInZipFile : null;
    case 'RETURN_TO_ZIP_FILE_LIST':
      return null;
    default:
      return state;
  }
};

/**
 * These values are specific to an individual profile.
 */
const profileSpecific = combineReducers({
  selectedThread,
  globalTrackOrder,
  hiddenGlobalTracks,
  hiddenLocalTracksByPid,
  localTrackOrderByPid,
  implementation,
  invertCallstack,
  showJsTracerSummary,
  committedRanges,
  callTreeSearchString,
  markersSearchString,
  networkSearchString,
  transforms,
  timelineType,
  // The timeline tracks used to be hidden and sorted by thread indexes, rather than
  // track indexes. The only way to migrate this information to tracks-based data is to
  // first retrieve the profile, so they can't be upgraded by the normal url upgrading
  // process. These value are only set by the locationToState function.
  legacyThreadOrder: (state: ThreadIndex[] | null = null) => state,
  legacyHiddenThreads: (state: ThreadIndex[] | null = null) => state,
});

/**
 * Provide a mechanism to wrap the UrlState reducer in a special function that can swap
 * out the entire UrlState with a new one coming from the History API. Also provide a
 * way to invalidate sections of the state based off of looking at multiple profiles.
 */
const wrapReducerInResetter = (
  regularUrlStateReducer: Reducer<UrlState>
): Reducer<UrlState> => {
  return (state, action) => {
    switch (action.type) {
      case 'UPDATE_URL_STATE':
        // A new URL came in because of a browser action, discard the current UrlState
        // and use the new one, which was probably serialized from the URL, or stored
        // in the history API.
        return action.newUrlState
          ? action.newUrlState
          : regularUrlStateReducer(undefined, action);
      case 'RETURN_TO_ZIP_FILE_LIST':
        // Invalidate all information that would be specific to an individual profile.
        return {
          ...regularUrlStateReducer(state, action),
          profileSpecific: profileSpecific(undefined, state),
        };
      default:
        return regularUrlStateReducer(state, action);
    }
  };
};

const urlStateReducer: Reducer<UrlState> = wrapReducerInResetter(
  combineReducers({
    dataSource,
    hash,
    profileUrl,
    profilesToCompare,
    selectedTab,
    pathInZipFile,
    profileSpecific,
  })
);

export default urlStateReducer;
